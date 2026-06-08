"""
Persist Results to DB Activity

Writes the final workflow output to the workflow_executions table in PostgreSQL.
This is the belt-and-suspenders approach: even if the UI never polls (e.g., user
closes browser), results are saved directly by the orchestrator.

Fetches DATABASE_URL from the Dapr kubernetes-secrets store.
"""

from __future__ import annotations

import json
import logging
import os
import base64
import tempfile
from datetime import datetime, timezone
from typing import Any

import psycopg2
import requests
from dapr.clients import DaprClient

from core.config import config
from core.output_summary import SUMMARY_OUTPUT_KEYS, extract_summary_fields_from_outputs
from tracing import extract_otel_trace_id, set_current_span_attrs, start_activity_span

logger = logging.getLogger(__name__)

SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

# Cached connection string (fetched once from Dapr secrets)
_database_url: str | None = None


def _mlflow_enabled() -> bool:
    raw = os.environ.get("MLFLOW_ENABLED", "").strip().lower()
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
    return raw not in {"", "0", "false", "no", "off"} and bool(tracking_uri)


def _finish_mlflow_run(run_id: str | None, status: str) -> None:
    if not run_id or not _mlflow_enabled():
        return
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip().rstrip("/")
    try:
        response = requests.post(
            f"{tracking_uri}/api/2.0/mlflow/runs/update",
            json={
                "run_id": run_id,
                "status": status,
                "end_time": int(datetime.now(timezone.utc).timestamp() * 1000),
            },
            timeout=5,
        )
        if response.status_code >= 400:
            logger.warning(
                "[Persist Results] MLflow run update failed for %s: HTTP %s %s",
                run_id,
                response.status_code,
                response.text[:300],
            )
    except Exception as exc:  # noqa: BLE001 - MLflow is best effort
        logger.warning("[Persist Results] MLflow run update failed for %s: %s", run_id, exc)


def _string_value(value: Any, max_len: int = 5000) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            text = json.dumps(value, default=str, sort_keys=True)
        except Exception:
            text = str(value)
    else:
        text = str(value)
    return text[:max_len]


def _metric_value(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in {float("inf"), float("-inf")} else None


def _mlflow_request(method: str, path: str, **kwargs) -> requests.Response | None:
    if not _mlflow_enabled():
        return None
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip().rstrip("/")
    try:
        response = requests.request(
            method,
            f"{tracking_uri}{path}",
            timeout=kwargs.pop("timeout", 10),
            **kwargs,
        )
        if response.status_code >= 400:
            logger.warning(
                "[Persist Results] MLflow %s %s failed: HTTP %s %s",
                method,
                path,
                response.status_code,
                response.text[:500],
            )
        return response
    except Exception as exc:  # noqa: BLE001 - MLflow is best effort
        logger.warning("[Persist Results] MLflow %s %s failed: %s", method, path, exc)
        return None


def _log_mlflow_batch(
    run_id: str,
    *,
    params: list[dict[str, str]] | None = None,
    metrics: list[dict[str, Any]] | None = None,
    tags: list[dict[str, str]] | None = None,
) -> None:
    if not run_id or not _mlflow_enabled():
        return
    params = params or []
    metrics = metrics or []
    tags = tags or []
    if not params and not metrics and not tags:
        return
    _mlflow_request(
        "POST",
        "/api/2.0/mlflow/runs/log-batch",
        json={
            "run_id": run_id,
            "params": params,
            "metrics": metrics,
            "tags": tags,
        },
        timeout=5,
    )


def _log_mlflow_artifact(
    run_id: str,
    artifact_path: str,
    payload: bytes,
    content_type: str,
) -> bool:
    if not run_id or not artifact_path or not _mlflow_enabled():
        return False
    max_bytes_raw = os.environ.get("MLFLOW_WORKFLOW_ARTIFACT_MAX_BYTES", "52428800")
    try:
        max_bytes = max(1, int(max_bytes_raw))
    except ValueError:
        max_bytes = 52_428_800
    if len(payload) > max_bytes:
        logger.warning(
            "[Persist Results] skipping MLflow artifact %s for run %s: %s bytes exceeds %s",
            artifact_path,
            run_id,
            len(payload),
            max_bytes,
        )
        return False
    artifact_dir = os.path.dirname(artifact_path).strip("/") or None
    artifact_name = _safe_artifact_name(os.path.basename(artifact_path), "artifact")
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip().rstrip("/")
    try:
        # Use MLflow's artifact repository client rather than the raw
        # mlflow-artifacts proxy endpoint. Direct proxy PUTs can be
        # retrievable by URL while still not appearing in the run's artifact
        # tree in the MLflow UI.
        import mlflow  # type: ignore

        mlflow.set_tracking_uri(tracking_uri)
        client = mlflow.tracking.MlflowClient(tracking_uri=tracking_uri)
        with tempfile.TemporaryDirectory(prefix="workflow-mlflow-artifact-") as tmpdir:
            local_path = os.path.join(tmpdir, artifact_name)
            with open(local_path, "wb") as handle:
                handle.write(payload)
            client.log_artifact(run_id, local_path, artifact_path=artifact_dir)
        return True
    except Exception as exc:  # noqa: BLE001 - MLflow is best effort
        logger.warning(
            "[Persist Results] MLflow artifact log failed for %s/%s (%s): %s",
            run_id,
            artifact_path,
            content_type,
            exc,
        )
        return False


def _log_mlflow_json_artifact(run_id: str, artifact_path: str, value: Any) -> bool:
    return _log_mlflow_artifact(
        run_id,
        artifact_path,
        (json.dumps(value, default=str, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        "application/json; charset=utf-8",
    )


def _safe_artifact_name(value: Any, fallback: str = "artifact") -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = fallback
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in raw)
    return safe.strip("._-")[:180] or fallback


def _fetch_browser_artifacts(db_url: str, db_execution_id: str) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, workflow_id, node_id, workspace_ref, artifact_type,
                       artifact_version, status, manifest_json, created_at, updated_at
                FROM workflow_browser_artifacts
                WHERE workflow_execution_id = %s
                ORDER BY created_at ASC
                """,
                (db_execution_id,),
            )
            rows = cur.fetchall()
            storage_refs: set[str] = set()
            for row in rows:
                manifest = row[7]
                if isinstance(manifest, str):
                    try:
                        manifest = json.loads(manifest)
                    except Exception:
                        manifest = {}
                if not isinstance(manifest, dict):
                    manifest = {}
                artifact = {
                    "id": row[0],
                    "workflowId": row[1],
                    "nodeId": row[2],
                    "workspaceRef": row[3],
                    "artifactType": row[4],
                    "artifactVersion": row[5],
                    "status": row[6],
                    "manifestJson": manifest,
                    "createdAt": row[8].isoformat() if hasattr(row[8], "isoformat") else row[8],
                    "updatedAt": row[9].isoformat() if hasattr(row[9], "isoformat") else row[9],
                    "blobs": {},
                }
                for asset in manifest.get("assets") or []:
                    if isinstance(asset, dict) and asset.get("storageRef"):
                        storage_refs.add(str(asset["storageRef"]))
                artifacts.append(artifact)

            if storage_refs:
                for storage_ref in storage_refs:
                    cur.execute(
                        """
                        SELECT storage_ref, payload_text, content_type
                        FROM workflow_browser_artifact_blob_payloads
                        WHERE storage_ref = %s
                        """,
                        (storage_ref,),
                    )
                    blob = cur.fetchone()
                    if not blob:
                        continue
                    for artifact in artifacts:
                        assets = artifact["manifestJson"].get("assets") or []
                        if any(
                            isinstance(asset, dict)
                            and asset.get("storageRef") == blob[0]
                            for asset in assets
                        ):
                            artifact["blobs"][blob[0]] = {
                                "payloadBase64": blob[1],
                                "contentType": blob[2],
                            }
    except Exception as exc:  # noqa: BLE001 - MLflow artifact projection is best effort
        logger.warning(
            "[Persist Results] failed to fetch browser artifacts for %s: %s",
            db_execution_id,
            exc,
        )
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return artifacts


def _log_browser_artifacts_to_mlflow(
    *,
    run_id: str,
    db_url: str,
    db_execution_id: str,
) -> dict[str, int]:
    counts = {
        "browser_artifacts": 0,
        "browser_screenshots": 0,
        "browser_traces": 0,
        "browser_videos": 0,
        "browser_assets_logged": 0,
    }
    artifacts = _fetch_browser_artifacts(db_url, db_execution_id)
    counts["browser_artifacts"] = len(artifacts)
    summary: list[dict[str, Any]] = []

    for artifact in artifacts:
        artifact_id = _safe_artifact_name(artifact.get("id"), "browser-artifact")
        manifest = artifact.get("manifestJson") if isinstance(artifact.get("manifestJson"), dict) else {}
        _log_mlflow_json_artifact(run_id, f"browser/{artifact_id}/manifest.json", manifest)
        summary.append({
            key: artifact.get(key)
            for key in [
                "id",
                "workflowId",
                "nodeId",
                "workspaceRef",
                "artifactType",
                "artifactVersion",
                "status",
                "createdAt",
                "updatedAt",
            ]
        })

        blobs = artifact.get("blobs") if isinstance(artifact.get("blobs"), dict) else {}
        for index, asset in enumerate(manifest.get("assets") or []):
            if not isinstance(asset, dict):
                continue
            kind = str(asset.get("kind") or "asset")
            if kind == "screenshot":
                counts["browser_screenshots"] += 1
            elif kind == "trace":
                counts["browser_traces"] += 1
            elif kind in {"video", "video-annotated"}:
                counts["browser_videos"] += 1

            storage_ref = str(asset.get("storageRef") or "")
            blob = blobs.get(storage_ref)
            if not isinstance(blob, dict):
                continue
            payload_base64 = str(blob.get("payloadBase64") or "")
            try:
                payload = base64.b64decode(payload_base64, validate=False)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[Persist Results] failed to decode browser artifact %s: %s",
                    storage_ref,
                    exc,
                )
                continue
            filename = (
                asset.get("fileName")
                or os.path.basename(storage_ref)
                or f"{kind}-{index + 1}.bin"
            )
            safe_filename = _safe_artifact_name(filename, f"{kind}-{index + 1}.bin")
            content_type = str(
                asset.get("contentType")
                or blob.get("contentType")
                or "application/octet-stream"
            )
            if _log_mlflow_artifact(
                run_id,
                f"browser/{artifact_id}/assets/{safe_filename}",
                payload,
                content_type,
            ):
                counts["browser_assets_logged"] += 1

    if summary:
        _log_mlflow_json_artifact(run_id, "browser/artifacts.json", summary)
    return counts


def _enrich_mlflow_workflow_run(
    *,
    run_id: str | None,
    db_url: str,
    db_execution_id: str,
    workflow_id: str | None,
    project_id: str | None,
    workflow_input: Any,
    trace_id: str | None,
    final_output: dict[str, Any],
    summary_fields: dict[str, Any],
    status: str,
    duration_ms: int | None,
    outputs_size_chars: int | None,
) -> None:
    if not run_id or not _mlflow_enabled():
        return
    browser_counts = _log_browser_artifacts_to_mlflow(
        run_id=run_id,
        db_url=db_url,
        db_execution_id=db_execution_id,
    )
    _log_mlflow_json_artifact(run_id, "workflow/input.json", workflow_input or {})
    _log_mlflow_json_artifact(run_id, "workflow/output.json", final_output)
    _log_mlflow_json_artifact(run_id, "workflow/summary.json", summary_fields or {})
    _log_mlflow_json_artifact(
        run_id,
        "workflow/mlflow-projection.json",
        {
            "workflowExecutionId": db_execution_id,
            "workflowId": workflow_id,
            "projectId": project_id,
            "status": status,
            "traceId": f"tr-{trace_id}" if trace_id else None,
            "durationMs": duration_ms,
            "outputsSizeChars": outputs_size_chars,
            **browser_counts,
        },
    )

    timestamp_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    metrics: list[dict[str, Any]] = []
    for key, value in {
        "workflow.duration_ms": duration_ms,
        "workflow.outputs_size_chars": outputs_size_chars,
        "workflow.output_node_count": (
            len(final_output.get("outputs"))
            if isinstance(final_output.get("outputs"), dict)
            else None
        ),
        **browser_counts,
    }.items():
        metric = _metric_value(value)
        if metric is not None:
            metrics.append({"key": key, "value": metric, "timestamp": timestamp_ms})

    _log_mlflow_batch(
        run_id,
        params=[
            {"key": "workflow_id", "value": _string_value(workflow_id)},
            {"key": "workflow_execution_id", "value": _string_value(db_execution_id)},
            {"key": "project_id", "value": _string_value(project_id)},
            {"key": "workflow_status", "value": _string_value(status)},
            {"key": "mlflow_trace_id", "value": f"tr-{trace_id}" if trace_id else ""},
        ],
        metrics=metrics,
        tags=[
            {"key": "workflow_builder.mlflow_projection", "value": "workflow_completion_v1"},
            {"key": "workflow_builder.primary_trace_id", "value": f"tr-{trace_id}" if trace_id else ""},
            {"key": "workflow_builder.browser_artifacts_logged", "value": str(browser_counts["browser_assets_logged"])},
        ],
    )


def _coerce_duration_ms(value: Any) -> int | None:
    """Best-effort convert duration input to a non-negative integer."""
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _get_database_url() -> str:
    """Fetch DATABASE_URL from the Dapr kubernetes-secrets store (cached)."""
    global _database_url
    if _database_url is not None:
        return _database_url

    with DaprClient() as client:
        secret = client.get_secret(store_name=SECRET_STORE_NAME, key=SECRET_NAME)
        db_url = secret.secret.get("DATABASE_URL")

    if not db_url:
        raise RuntimeError(
            f"DATABASE_URL not found in secret '{SECRET_NAME}' "
            f"from store '{SECRET_STORE_NAME}'"
        )

    _database_url = db_url
    logger.info("[Persist Results] Fetched DATABASE_URL from Dapr secrets")
    return db_url


def persist_results_to_db(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Persist final workflow output to the workflow_executions table.

    Called as the last activity before the workflow returns. Skips if
    dbExecutionId is not provided (e.g., direct orchestrator API calls).

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - dbExecutionId: Database execution ID (workflow_executions.id)
            - outputs: Per-node output dict {nodeId: data, ...}
            - success: Whether the workflow succeeded
            - error: Error message (if failed)
            - durationMs: Total execution duration in milliseconds

    Returns:
        Dict with success status
    """
    db_execution_id = input_data.get("dbExecutionId")
    if not db_execution_id:
        return {"success": True, "skipped": True}

    outputs = input_data.get("outputs")
    workflow_output = input_data.get("workflowOutput")
    success = input_data.get("success", True)
    error = input_data.get("error")
    duration_ms = _coerce_duration_ms(input_data.get("durationMs"))
    otel = input_data.get("_otel") or {}
    trace_id = extract_otel_trace_id(otel if isinstance(otel, dict) else None)

    logger.info(
        f"[Persist Results] Writing output to DB for execution: {db_execution_id} "
        f"(success={success}, duration={duration_ms}ms)"
    )

    attrs = {
        "db.execution_id": db_execution_id,
        "action.type": "persist_results_to_db",
    }

    outputs_size_chars = None
    try:
        if isinstance(outputs, (dict, list)):
            import json as _json
            outputs_size_chars = len(_json.dumps(outputs, default=str))
    except Exception:
        pass

    set_current_span_attrs({
        "workflow.execution.db_id": db_execution_id,
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.success": bool(success),
        "workflow.phase": "completed" if success else "failed",
        "workflow.duration_ms": duration_ms,
        "workflow.error": (error or "")[:500] if error else None,
        "workflow.outputs.size_chars": outputs_size_chars,
        "workflow.outputs.node_count": (
            len(outputs) if isinstance(outputs, dict) else None
        ),
        "workflow.has_workflow_output": workflow_output is not None,
    })

    with start_activity_span("activity.persist_results_to_db", otel, attrs):
        try:
            summary_fields = extract_summary_fields_from_outputs(outputs)
            for key in SUMMARY_OUTPUT_KEYS:
                explicit = input_data.get(key)
                if explicit is not None:
                    summary_fields[key] = explicit

            # Build the final output object (same structure as orchestrator return)
            final_output = {
                "success": success,
                "outputs": outputs,
                "workflowOutput": workflow_output,
                "durationMs": duration_ms,
                "phase": "completed" if success else "failed",
            }
            final_output.update(summary_fields)
            if error:
                final_output["error"] = error

            status = "success" if success else "error"
            phase = "completed" if success else "failed"
            # Honor an explicit cancelled phase (durable/run user Stop): write a
            # "cancelled" status, not the success-derived "error", so a user
            # cancel isn't mislabeled as a failure. The BFF finalizeDb's
            # "cancelled" only applies to still-pending/running rows, so once the
            # orchestrator persists a terminal status it must be the right label.
            if str(input_data.get("phase") or "").lower() == "cancelled":
                status = "cancelled"
                phase = "cancelled"
                final_output["phase"] = "cancelled"
            progress = 100
            completed_at = datetime.now(timezone.utc)

            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    # Prefer wall-clock duration based on DB started_at to avoid replay artifacts.
                    cur.execute(
                        """
                        SELECT started_at, mlflow_run_id, workflow_id, project_id, input,
                               primary_trace_id, mlflow_experiment_id
                        FROM workflow_executions
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (db_execution_id,),
                    )
                    row = cur.fetchone()
                    started_at = row[0] if row else None
                    mlflow_run_id = row[1] if row and len(row) > 1 else None
                    workflow_id = row[2] if row and len(row) > 2 else None
                    project_id = row[3] if row and len(row) > 3 else None
                    workflow_input = row[4] if row and len(row) > 4 else None
                    persisted_trace_id = row[5] if row and len(row) > 5 else None
                    if started_at and getattr(started_at, "tzinfo", None) is None:
                        started_at = started_at.replace(tzinfo=timezone.utc)
                    computed_duration_ms = None
                    if started_at:
                        computed_duration_ms = max(
                            int((completed_at - started_at).total_seconds() * 1000), 0
                        )
                    persisted_duration_ms = (
                        computed_duration_ms
                        if computed_duration_ms is not None
                        else duration_ms
                    )

                    cur.execute(
                        """
                        UPDATE workflow_executions
                        SET output = %s,
                            summary_output = %s,
                            status = %s,
                            phase = %s,
                            progress = %s,
                            error = %s,
                            completed_at = %s,
                            duration = %s,
                            primary_trace_id = COALESCE(primary_trace_id, %s)
                        WHERE id = %s
                        """,
                        (
                            json.dumps(final_output),
                            json.dumps(summary_fields) if summary_fields else None,
                            status,
                            phase,
                            progress,
                            None if success else error,
                            completed_at,
                            (
                                str(persisted_duration_ms)
                                if persisted_duration_ms is not None
                                else None
                            ),
                            trace_id,
                            db_execution_id,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()

            final_trace_id = trace_id or (
                str(persisted_trace_id).removeprefix("tr-")
                if persisted_trace_id
                else None
            )
            _enrich_mlflow_workflow_run(
                run_id=mlflow_run_id if isinstance(mlflow_run_id, str) else None,
                db_url=db_url,
                db_execution_id=str(db_execution_id),
                workflow_id=str(workflow_id) if workflow_id is not None else None,
                project_id=str(project_id) if project_id is not None else None,
                workflow_input=workflow_input,
                trace_id=final_trace_id,
                final_output=final_output,
                summary_fields=summary_fields,
                status=status,
                duration_ms=persisted_duration_ms,
                outputs_size_chars=outputs_size_chars,
            )
            _finish_mlflow_run(
                mlflow_run_id if isinstance(mlflow_run_id, str) else None,
                "FINISHED" if success else "FAILED",
            )

            logger.info(
                f"[Persist Results] Successfully persisted output for: {db_execution_id}"
            )
            return {"success": True}

        except Exception as e:
            logger.error(
                f"[Persist Results] Failed to persist output for {db_execution_id}: {e}"
            )
            # Don't throw - persistence failure shouldn't break workflow execution
            return {"success": False, "error": str(e)}
