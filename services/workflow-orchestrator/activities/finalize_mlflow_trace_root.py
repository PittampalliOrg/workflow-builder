"""Best-effort MLflow trace finalization activity."""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

import requests

from tracing import emit_mlflow_trace_root_span, set_current_span_attrs

logger = logging.getLogger(__name__)

SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

_database_url: str | None = None


def _mlflow_enabled() -> bool:
    raw = os.environ.get("MLFLOW_ENABLED", "").strip().lower()
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
    return raw not in {"", "0", "false", "no", "off"} and bool(tracking_uri)


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


def _normalize_mlflow_trace_id(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    normalized = raw.removeprefix("tr-").replace("-", "")
    if len(normalized) != 32 or any(c not in "0123456789abcdef" for c in normalized):
        return None
    return f"tr-{normalized}"


def _fetch_mlflow_run_targets(db_execution_id: str | None) -> list[dict[str, str | None]]:
    if not db_execution_id:
        return []

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
            if row and row[3]:
                targets.append({
                    "entity_type": "workflow_execution",
                    "entity_id": str(row[0]),
                    "project_id": row[1],
                    "experiment_id": row[2],
                    "run_id": row[3],
                })

            cur.execute(
                """
                SELECT id, project_id, mlflow_experiment_id, mlflow_run_id
                FROM sessions
                WHERE workflow_execution_id = %s
                  AND mlflow_run_id IS NOT NULL
                """,
                (db_execution_id,),
            )
            for session_row in cur.fetchall():
                targets.append({
                    "entity_type": "session",
                    "entity_id": str(session_row[0]),
                    "project_id": session_row[1],
                    "experiment_id": session_row[2],
                    "run_id": session_row[3],
                })
    except Exception as exc:  # noqa: BLE001 - lineage is best effort
        logger.warning(
            "[MLflow Finalize] failed to load MLflow run targets for %s: %s",
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
    seen: set[str] = set()
    for target in targets:
        run_id = str(target.get("run_id") or "").strip()
        if not run_id or run_id in seen:
            continue
        seen.add(run_id)
        deduped.append(target)
    return deduped


def _link_trace_to_run(trace_id: str, run_id: str) -> bool:
    if not _mlflow_enabled():
        return False
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip().rstrip("/")
    try:
        response = requests.post(
            f"{tracking_uri}/api/2.0/mlflow/traces/link-to-run",
            json={"trace_ids": [trace_id], "run_id": run_id},
            timeout=5,
        )
        if response.status_code >= 400:
            logger.warning(
                "[MLflow Finalize] trace link failed trace=%s run=%s: HTTP %s %s",
                trace_id,
                run_id,
                response.status_code,
                response.text[:300],
            )
            return False
        return True
    except Exception as exc:  # noqa: BLE001 - MLflow is best effort
        logger.warning(
            "[MLflow Finalize] trace link failed trace=%s run=%s: %s",
            trace_id,
            run_id,
            exc,
        )
        return False


def _record_lineage_links(
    *,
    trace_id: str,
    targets: list[dict[str, str | None]],
) -> None:
    if not targets:
        return
    conn = None
    try:
        import psycopg2

        conn = psycopg2.connect(_get_database_url(), connect_timeout=3)
        with conn.cursor() as cur:
            for target in targets:
                entity_type = target.get("entity_type")
                entity_id = target.get("entity_id")
                run_id = target.get("run_id")
                if not entity_type or not entity_id or not run_id:
                    continue
                source_key = f"{entity_type}:{entity_id}:mlflow_trace:{trace_id}:run:{run_id}"
                cur.execute(
                    """
                    INSERT INTO mlflow_lineage_links (
                        id,
                        source_key,
                        entity_type,
                        entity_id,
                        project_id,
                        mlflow_entity_type,
                        mlflow_experiment_id,
                        mlflow_run_id,
                        mlflow_trace_id,
                        tags,
                        metadata,
                        created_at,
                        updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, 'trace', %s, %s, %s, '{}'::jsonb, '{}'::jsonb, now(), now())
                    ON CONFLICT (source_key) DO UPDATE SET
                        project_id = EXCLUDED.project_id,
                        mlflow_experiment_id = EXCLUDED.mlflow_experiment_id,
                        mlflow_run_id = EXCLUDED.mlflow_run_id,
                        mlflow_trace_id = EXCLUDED.mlflow_trace_id,
                        updated_at = now()
                    """,
                    (
                        uuid.uuid4().hex,
                        source_key,
                        entity_type,
                        entity_id,
                        target.get("project_id"),
                        target.get("experiment_id"),
                        run_id,
                        trace_id,
                    ),
                )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - lineage is best effort
        logger.warning("[MLflow Finalize] lineage link recording failed: %s", exc)
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _link_trace_to_workflow_runs(input_data: dict[str, Any]) -> dict[str, Any]:
    trace_id = _normalize_mlflow_trace_id(input_data.get("traceId"))
    if not trace_id:
        return {"linked": False, "reason": "missing_or_invalid_trace_id"}
    if not _mlflow_enabled():
        return {"linked": False, "reason": "mlflow_disabled"}

    targets = _fetch_mlflow_run_targets(input_data.get("dbExecutionId"))
    if not targets:
        return {"linked": False, "reason": "no_mlflow_run_targets", "traceId": trace_id}

    linked_targets: list[dict[str, str | None]] = []
    failed_run_ids: list[str] = []
    for target in targets:
        run_id = str(target.get("run_id") or "").strip()
        if not run_id:
            continue
        if _link_trace_to_run(trace_id, run_id):
            linked_targets.append(target)
        else:
            failed_run_ids.append(run_id)

    _record_lineage_links(trace_id=trace_id, targets=linked_targets)
    return {
        "linked": bool(linked_targets),
        "traceId": trace_id,
        "linkedRunIds": [target.get("run_id") for target in linked_targets],
        "failedRunIds": failed_run_ids,
    }


def finalize_mlflow_trace_root(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit a synthetic OTLP root span for the workflow's existing trace ID."""
    _ = ctx
    input_data = input_data or {}

    set_current_span_attrs({
        "workflow.id": input_data.get("workflowId"),
        "workflow.name": input_data.get("workflowName"),
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.execution.db_id": input_data.get("dbExecutionId"),
        "workflow.instance_id": input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId"),
        "workflow.status": input_data.get("status") or input_data.get("statusCode"),
        "workflow.duration_ms": input_data.get("durationMs"),
        "mlflow.trace_id": input_data.get("traceId"),
        "mlflow.trace_name": input_data.get("traceName"),
    })

    try:
        result = emit_mlflow_trace_root_span(input_data)
        link_result = _link_trace_to_workflow_runs(input_data)
        set_current_span_attrs({
            "mlflow.finalize.success": bool(result.get("success")),
            "mlflow.finalize.skipped": bool(result.get("skipped")),
            "mlflow.finalize.skip_reason": result.get("reason"),
            "mlflow.finalize.error": (result.get("error") or "")[:500] if result.get("error") else None,
            "mlflow.trace_link.success": bool(link_result.get("linked")),
            "mlflow.trace_link.reason": link_result.get("reason"),
            "mlflow.trace_link.run_count": len(link_result.get("linkedRunIds") or []),
        })
        if not result.get("success") and not result.get("skipped"):
            logger.warning(
                "[MLflow Finalize] root span export failed: %s",
                result.get("error") or result,
            )
        return {**result, "traceLink": link_result}
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MLflow Finalize] unexpected failure: %s", exc)
        set_current_span_attrs({
            "mlflow.finalize.success": False,
            "mlflow.finalize.error": str(exc)[:500],
        })
        return {"success": False, "error": str(exc)}
