"""Best-effort OpenTelemetry trace finalization activity.

This activity records the workflow's trace linkage through workflow-data. It
does not call MLflow or any trace backend directly; spans should already export
through the normal OpenTelemetry pipeline.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from activities.workflow_data_client import workflow_data_api_mode, workflow_data_client
from tracing import set_current_span_attrs

logger = logging.getLogger(__name__)

SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

_database_url: str | None = None


def _get_database_url() -> str:
    global _database_url
    if _database_url is not None:
        return _database_url

    env_url = os.environ.get("DATABASE_URL")
    if env_url:
        _database_url = env_url
        return env_url

    from dapr.clients import DaprClient

    with DaprClient() as client:
        secret = client.get_secret(store_name=SECRET_STORE_NAME, key=SECRET_NAME)
        db_url = secret.secret.get("DATABASE_URL")

    if not db_url:
        raise RuntimeError(
            f"DATABASE_URL not found in secret '{SECRET_NAME}' "
            f"from store '{SECRET_STORE_NAME}'"
        )

    _database_url = db_url
    return db_url


def _normalize_trace_id(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    normalized = raw.removeprefix("tr-").replace("-", "")
    if len(normalized) != 32 or any(c not in "0123456789abcdef" for c in normalized):
        return None
    return normalized


def _api_target_to_local(target: dict[str, Any]) -> dict[str, str | None] | None:
    entity_type = str(target.get("entityType") or target.get("entity_type") or "").strip()
    entity_id = str(target.get("entityId") or target.get("entity_id") or "").strip()
    if entity_type not in {"workflow_execution", "session"} or not entity_id:
        return None
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "project_id": target.get("projectId") or target.get("project_id"),
        "external_run_id": target.get("externalRunId") or target.get("external_run_id"),
        "external_experiment_id": (
            target.get("externalExperimentId") or target.get("external_experiment_id")
        ),
    }


def _local_target_to_api(target: dict[str, str | None]) -> dict[str, str | None]:
    return {
        "entityType": target.get("entity_type"),
        "entityId": target.get("entity_id"),
        "projectId": target.get("project_id"),
        "externalRunId": target.get("external_run_id"),
        "externalExperimentId": target.get("external_experiment_id"),
    }


def _fetch_trace_targets(db_execution_id: str | None) -> list[dict[str, str | None]]:
    if not db_execution_id:
        return []
    api_mode = workflow_data_api_mode()
    if api_mode != "postgres":
        try:
            return [
                target
                for target in (
                    _api_target_to_local(item)
                    for item in workflow_data_client.get_trace_targets(str(db_execution_id))
                )
                if target is not None
            ]
        except Exception as exc:  # noqa: BLE001 - trace linkage is best effort
            logger.warning(
                "[OTel Trace Finalize] workflow-data failed to load trace targets for %s: %s",
                db_execution_id,
                exc,
            )
            if api_mode == "http":
                return []

    return _fetch_trace_targets_from_postgres(str(db_execution_id))


def _fetch_trace_targets_from_postgres(db_execution_id: str) -> list[dict[str, str | None]]:
    targets: list[dict[str, str | None]] = []
    conn = None
    try:
        import psycopg2

        conn = psycopg2.connect(_get_database_url(), connect_timeout=3)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, project_id, mlflow_experiment_id, mlflow_run_id
                FROM workflow_executions
                WHERE id = %s
                """,
                (db_execution_id,),
            )
            row = cur.fetchone()
            if row:
                targets.append({
                    "entity_type": "workflow_execution",
                    "entity_id": str(row[0]),
                    "project_id": row[1],
                    "external_experiment_id": row[2],
                    "external_run_id": row[3],
                })

            cur.execute(
                """
                SELECT id, project_id, mlflow_experiment_id, mlflow_run_id
                FROM sessions
                WHERE workflow_execution_id = %s
                """,
                (db_execution_id,),
            )
            for session_row in cur.fetchall():
                targets.append({
                    "entity_type": "session",
                    "entity_id": str(session_row[0]),
                    "project_id": session_row[1],
                    "external_experiment_id": session_row[2],
                    "external_run_id": session_row[3],
                })
    except Exception as exc:  # noqa: BLE001 - trace linkage is best effort
        logger.warning(
            "[OTel Trace Finalize] failed to load trace targets for %s: %s",
            db_execution_id,
            exc,
        )
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    deduped: list[dict[str, str | None]] = []
    seen: set[tuple[str | None, str | None]] = set()
    for target in targets:
        key = (target.get("entity_type"), target.get("entity_id"))
        if not key[0] or not key[1] or key in seen:
            continue
        seen.add(key)
        deduped.append(target)
    return deduped


def _record_lineage_links(
    *,
    trace_id: str,
    targets: list[dict[str, str | None]],
    source: str = "primary",
    attrs: dict[str, str] | None = None,
) -> dict[str, Any]:
    if not targets:
        return {"recorded": 0, "sourceKeys": []}
    api_mode = workflow_data_api_mode()
    if api_mode == "postgres":
        logger.warning(
            "[OTel Trace Finalize] Postgres mode has no direct lineage fallback"
        )
        return {"recorded": 0, "sourceKeys": []}
    api_targets = [
        _local_target_to_api(target)
        for target in targets
        if target.get("entity_type") and target.get("entity_id")
    ]
    if not api_targets:
        return {"recorded": 0, "sourceKeys": []}
    return workflow_data_client.upsert_trace_lineage(
        {
            "traceId": trace_id,
            "targets": api_targets,
            "source": source,
            "attrs": attrs or {},
        }
    )


def finalize_otel_trace_root(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Record trace linkage for a completed workflow."""
    _ = ctx
    input_data = input_data or {}
    trace_id = _normalize_trace_id(input_data.get("traceId"))
    db_execution_id = input_data.get("dbExecutionId")

    set_current_span_attrs({
        "workflow.id": input_data.get("workflowId"),
        "workflow.name": input_data.get("workflowName"),
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.execution.db_id": db_execution_id,
        "workflow.instance_id": input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId"),
        "workflow.status": input_data.get("status") or input_data.get("statusCode"),
        "workflow.duration_ms": input_data.get("durationMs"),
        "otel.trace_id": trace_id,
        "otel.trace_name": input_data.get("traceName"),
    })

    if not trace_id:
        return {"success": True, "skipped": True, "reason": "missing_or_invalid_trace_id"}

    targets = _fetch_trace_targets(str(db_execution_id) if db_execution_id else None)
    if not targets:
        return {"success": True, "traceId": trace_id, "linked": False, "reason": "no_trace_targets"}

    try:
        result = _record_lineage_links(
            trace_id=trace_id,
            targets=targets,
            source="primary",
            attrs={
                "service.name": "workflow-orchestrator",
                "workflow.status": str(input_data.get("status") or input_data.get("statusCode") or ""),
            },
        )
        set_current_span_attrs({
            "otel.trace_link.success": bool(result.get("recorded")),
            "otel.trace_link.recorded": result.get("recorded"),
        })
        return {
            "success": True,
            "traceId": trace_id,
            "linked": bool(result.get("recorded")),
            **result,
        }
    except Exception as exc:  # noqa: BLE001 - best effort
        logger.warning("[OTel Trace Finalize] lineage recording failed: %s", exc)
        set_current_span_attrs({
            "otel.trace_link.success": False,
            "otel.trace_link.error": str(exc)[:500],
        })
        return {"success": False, "traceId": trace_id, "error": str(exc)}
