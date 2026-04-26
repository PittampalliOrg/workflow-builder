from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import requests
from dapr.ext import workflow as wf
from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

try:
    from dapr.ext.workflow import when_all as wf_when_all
except Exception:  # pragma: no cover - depends on dapr-ext-workflow version
    wf_when_all = None

logger = logging.getLogger("evaluation-coordinator")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL",
    "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
).rstrip("/")
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
DEFAULT_ITEM_TIMEOUT_SECONDS = int(os.environ.get("EVALUATION_ITEM_TIMEOUT_SECONDS", "7200"))
DEFAULT_POLL_SECONDS = int(os.environ.get("EVALUATION_ITEM_POLL_SECONDS", "10"))
MAX_CONCURRENCY = int(os.environ.get("EVALUATION_MAX_CONCURRENCY", "32"))

wfr = wf.WorkflowRuntime()

ITEM_TERMINAL_STATUSES = {"passed", "failed", "error", "cancelled", "skipped"}


class StartRunRequest(BaseModel):
    runId: str


class CancelRunRequest(BaseModel):
    reason: str | None = None


def _require_internal(request: Request) -> None:
    token = request.headers.get("x-internal-token") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ")
    if not INTERNAL_API_TOKEN or token != INTERNAL_API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing internal token")


def _bff(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: int = 60,
) -> Any:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError("INTERNAL_API_TOKEN is required")
    res = requests.request(
        method,
        f"{WORKFLOW_BUILDER_URL}{path}",
        headers={
            "X-Internal-Token": INTERNAL_API_TOKEN,
            "Content-Type": "application/json",
        },
        json=json_body,
        timeout=timeout,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"BFF {method} {path} failed ({res.status_code}): {res.text[:800]}")
    if not res.text:
        return {}
    return res.json()


def _bff_with_retry(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: int = 60,
    attempts: int = 3,
    delay_seconds: float = 10,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _bff(method, path, json_body=json_body, timeout=timeout)
        except Exception as exc:
            last_error = exc
            if attempt >= attempts:
                break
            logger.warning(
                "BFF %s %s failed on attempt %s/%s; retrying in %.1fs: %s",
                method,
                path,
                attempt,
                attempts,
                delay_seconds,
                exc,
            )
            time.sleep(delay_seconds)
    raise last_error or RuntimeError(f"BFF {method} {path} failed")


def _load_run(run_id: str) -> dict[str, Any]:
    return _bff("GET", f"/api/internal/evaluations/runs/{run_id}/status")["run"]


def _load_run_activity(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _load_run(data["runId"])


def _mark_run_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    payload: dict[str, Any] = {"status": data["status"]}
    for key in ("error", "coordinatorExecutionId"):
        if data.get(key) is not None:
            payload[key] = data[key]
    return _bff("POST", f"/api/internal/evaluations/runs/{run_id}/status", json_body=payload)


def _start_item(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _bff_with_retry(
        "POST",
        f"/api/internal/evaluations/runs/{data['runId']}/items/{data['itemId']}/start",
        json_body={},
        timeout=90,
        attempts=3,
        delay_seconds=15,
    )


def _sync_item(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _bff(
        "POST",
        f"/api/internal/evaluations/runs/{data['runId']}/items/{data['itemId']}/sync",
        json_body={},
        timeout=90,
    )


def _mark_item_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    payload = {"status": data["status"]}
    if data.get("error") is not None:
        payload["error"] = data["error"]
    return _bff(
        "POST",
        f"/api/internal/evaluations/runs/{data['runId']}/items/{data['itemId']}/status",
        json_body=payload,
    )


def _run_execution_config(run: dict[str, Any]) -> dict[str, Any]:
    config = run.get("executionConfig") or {}
    return config if isinstance(config, dict) else {}


def _configured_int(config: dict[str, Any], key: str, fallback: int) -> int:
    try:
        value = int(config.get(key) or fallback)
    except Exception:
        return fallback
    return max(1, value)


def evaluation_item_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    item_id = data["itemId"]
    timeout_seconds = int(data.get("timeoutSeconds") or DEFAULT_ITEM_TIMEOUT_SECONDS)
    poll_seconds = int(data.get("pollSeconds") or DEFAULT_POLL_SECONDS)
    try:
        yield ctx.call_activity(_start_item, input={"runId": run_id, "itemId": item_id})
        deadline = ctx.current_utc_datetime + timedelta(seconds=timeout_seconds + 300)
        while ctx.current_utc_datetime < deadline:
            sync = yield ctx.call_activity(_sync_item, input={"runId": run_id, "itemId": item_id})
            item = sync.get("item") if isinstance(sync, dict) else {}
            status = item.get("status") if isinstance(item, dict) else None
            if status in ITEM_TERMINAL_STATUSES:
                return item
            yield ctx.create_timer(timedelta(seconds=poll_seconds))
        marked = yield ctx.call_activity(
            _mark_item_status,
            input={
                "runId": run_id,
                "itemId": item_id,
                "status": "error",
                "error": f"Evaluation item timed out after {timeout_seconds} seconds",
            },
        )
        return marked.get("item") if isinstance(marked, dict) else marked
    except Exception as exc:
        marked = yield ctx.call_activity(
            _mark_item_status,
            input={
                "runId": run_id,
                "itemId": item_id,
                "status": "error",
                "error": str(exc),
            },
        )
        return marked.get("item") if isinstance(marked, dict) else marked


def evaluation_run_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    try:
        yield ctx.call_activity(_mark_run_status, input={"runId": run_id, "status": "running"})
        run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
        config = _run_execution_config(run)
        concurrency = min(_configured_int(config, "concurrency", 1), MAX_CONCURRENCY)
        timeout_seconds = _configured_int(config, "timeoutSeconds", DEFAULT_ITEM_TIMEOUT_SECONDS)
        poll_seconds = _configured_int(config, "pollSeconds", DEFAULT_POLL_SECONDS)
        items = list(run.get("items") or [])
        results: list[Any] = []
        for offset in range(0, len(items), concurrency):
            chunk = items[offset : offset + concurrency]
            tasks = [
                ctx.call_child_workflow(
                    "evaluation_item_workflow",
                    input={
                        "runId": run_id,
                        "itemId": item["id"],
                        "timeoutSeconds": timeout_seconds,
                        "pollSeconds": poll_seconds,
                    },
                    instance_id=f"eval-item-{run_id}-{item['id']}"[:100],
                )
                for item in chunk
                if isinstance(item, dict) and item.get("id")
            ]
            if wf_when_all is not None:
                results.extend((yield wf_when_all(tasks)))
            else:
                for task in tasks:
                    results.append((yield task))
        final_run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
        summary = final_run.get("summary") if isinstance(final_run, dict) else None
        yield ctx.call_activity(
            _mark_run_status,
            input={"runId": run_id, "status": "completed"},
        )
        return {"success": True, "items": len(results), "summary": summary}
    except Exception as exc:
        yield ctx.call_activity(
            _mark_run_status,
            input={"runId": run_id, "status": "failed", "error": str(exc)},
        )
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    wfr.register_workflow(evaluation_run_workflow)
    wfr.register_workflow(evaluation_item_workflow)
    for activity in (
        _mark_run_status,
        _load_run_activity,
        _start_item,
        _sync_item,
        _mark_item_status,
    ):
        wfr.register_activity(activity)
    wfr.start()
    logger.info("Evaluation coordinator workflow runtime started")
    yield
    wfr.shutdown()


app = FastAPI(title="evaluation-coordinator", lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/v1/evaluation-runs")
def start_evaluation_run(body: StartRunRequest, request: Request):
    _require_internal(request)
    instance_id = f"evaluation-run-{body.runId}"
    try:
        DaprWorkflowClient().schedule_new_workflow(
            workflow=evaluation_run_workflow,
            input={"runId": body.runId, "requestedAt": time.time()},
            instance_id=instance_id,
        )
    except Exception as exc:
        logger.exception("Failed to schedule evaluation run workflow %s", instance_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "executionId": instance_id}


@app.post("/api/v1/evaluation-runs/{run_id}/cancel")
def cancel_evaluation_run(
    run_id: str,
    request: Request,
    body: CancelRunRequest = CancelRunRequest(),
):
    _require_internal(request)
    instance_id = f"evaluation-run-{run_id}"
    reason = body.reason if body else "cancelled"
    DaprWorkflowClient().terminate_workflow(instance_id=instance_id, output=reason)
    return {"success": True, "executionId": instance_id}
