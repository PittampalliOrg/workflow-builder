from __future__ import annotations

import json
import logging
import os
import pathlib
import time
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import psycopg2
import requests
from dapr.ext import workflow as wf
from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

try:
    from dapr.ext.workflow import when_all as wf_when_all
except Exception:  # pragma: no cover - depends on dapr-ext-workflow version
    wf_when_all = None

try:
    from datasets import load_dataset
except Exception:  # pragma: no cover - optional until the image is built
    load_dataset = None

logger = logging.getLogger("swebench-coordinator")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL",
    "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
).rstrip("/")
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
ARTIFACT_ROOT = pathlib.Path(os.environ.get("SWEBENCH_ARTIFACT_ROOT", "/artifacts"))
EVALUATOR_NAMESPACE = os.environ.get("SWEBENCH_EVALUATOR_NAMESPACE", "workflow-builder")
EVALUATOR_IMAGE = os.environ.get("SWEBENCH_EVALUATOR_IMAGE", "ghcr.io/pittampalliorg/swebench-evaluator:latest")
DOCKER_DIND_IMAGE = os.environ.get("SWEBENCH_DOCKER_DIND_IMAGE", "docker.io/library/docker:27-dind")

wfr = wf.WorkflowRuntime()


class StartRunRequest(BaseModel):
    runId: str


class CancelRunRequest(BaseModel):
    reason: str | None = None


def _require_internal(request: Request) -> None:
    token = request.headers.get("x-internal-token") or request.headers.get("authorization", "").removeprefix("Bearer ")
    if not INTERNAL_API_TOKEN or token != INTERNAL_API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing internal token")


def _bff(method: str, path: str, *, json_body: dict[str, Any] | None = None, timeout: int = 60) -> Any:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError("INTERNAL_API_TOKEN is required")
    res = requests.request(
        method,
        f"{WORKFLOW_BUILDER_URL}{path}",
        headers={"X-Internal-Token": INTERNAL_API_TOKEN, "Content-Type": "application/json"},
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
    delay_seconds: float = 15,
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


def _connect_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required for SWE-bench metadata import")
    return psycopg2.connect(DATABASE_URL)


def _load_run(run_id: str) -> dict[str, Any]:
    return _bff("GET", f"/api/internal/benchmarks/runs/{run_id}/status")["run"]


def _load_run_activity(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _load_run(data["runId"])


def _mark_run_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    payload = {"status": data["status"]}
    for key in ("error", "evaluatorJobName", "predictionsPath"):
        if data.get(key) is not None:
            payload[key] = data[key]
    return _bff("POST", f"/api/internal/benchmarks/runs/{run_id}/status", json_body=payload)


def _ensure_instance_metadata(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    suite = run["suiteSlug"]
    dataset_name = run["suiteName"]
    dataset_path = "princeton-nlp/SWE-bench_Verified" if suite == "SWE-bench_Verified" else "princeton-nlp/SWE-bench_Lite"
    instance_ids = set(run.get("selectedInstanceIds") or [])
    if not instance_ids:
        return {"imported": 0}
    if load_dataset is None:
        raise RuntimeError("datasets is not installed; cannot load SWE-bench metadata")

    logger.info("Loading %s metadata for %d selected instances", dataset_path, len(instance_ids))
    dataset = load_dataset(dataset_path, split="test")
    rows = [item for item in dataset if item.get("instance_id") in instance_ids]
    if len(rows) != len(instance_ids):
        found = {row.get("instance_id") for row in rows}
        missing = sorted(instance_ids - found)
        raise RuntimeError(f"Missing SWE-bench metadata for instances: {', '.join(missing[:20])}")

    conn = _connect_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM benchmark_suites WHERE slug = %s LIMIT 1", (suite,))
            suite_row = cur.fetchone()
            if not suite_row:
                raise RuntimeError(f"benchmark suite {suite} is not seeded")
            suite_id = suite_row[0]
            for raw in rows:
                instance_id = str(raw["instance_id"])
                repo = raw.get("repo") or _repo_from_instance_id(instance_id)
                metadata = dict(raw)
                test_metadata = {
                    key: raw.get(key)
                    for key in ("test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "version")
                    if raw.get(key) is not None
                }
                cur.execute(
                    """
                    INSERT INTO benchmark_instances (
                        id, suite_id, instance_id, repo, base_commit,
                        problem_statement, hints_text, test_metadata,
                        gold_patch, metadata, updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, now())
                    ON CONFLICT (suite_id, instance_id) DO UPDATE SET
                        repo = EXCLUDED.repo,
                        base_commit = EXCLUDED.base_commit,
                        problem_statement = EXCLUDED.problem_statement,
                        hints_text = EXCLUDED.hints_text,
                        test_metadata = EXCLUDED.test_metadata,
                        gold_patch = EXCLUDED.gold_patch,
                        metadata = EXCLUDED.metadata,
                        updated_at = now()
                    """,
                    (
                        f"binst_{uuid.uuid4().hex}",
                        suite_id,
                        instance_id,
                        repo,
                        raw.get("base_commit"),
                        raw.get("problem_statement"),
                        raw.get("hints_text") or raw.get("hints"),
                        json.dumps(test_metadata, default=str),
                        raw.get("patch"),
                        json.dumps(metadata, default=str),
                    ),
                )
            conn.commit()
    finally:
        conn.close()
    return {"imported": len(rows), "dataset": dataset_name}


def _start_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _bff_with_retry(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/start",
        json_body={},
        timeout=90,
        attempts=3,
        delay_seconds=20,
    )


def _sync_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/sync",
        json_body={},
        timeout=90,
    )


def _write_predictions(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    path = ARTIFACT_ROOT / run["id"] / "predictions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    model_name = run["modelNameOrPath"]
    with path.open("w", encoding="utf-8") as f:
        for instance in run.get("instances") or []:
            f.write(json.dumps({
                "instance_id": instance["instanceId"],
                "model_name_or_path": model_name,
                "model_patch": instance.get("modelPatch") or "",
            }) + "\n")
    _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run['id']}/predictions-artifact",
        json_body={"path": str(path)},
    )
    return {"path": str(path), "bytes": path.stat().st_size}


def _start_evaluator_job(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    predictions_path = data["predictionsPath"]
    job_name = f"swebench-eval-{run['id'].lower().replace('_', '-')[:44]}"
    instance_ids = run.get("selectedInstanceIds") or []
    try:
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except Exception:
            config.load_kube_config()
        batch = client.BatchV1Api()
        env = [
            client.V1EnvVar(name="DATASET_NAME", value=_dataset_path(run["suiteSlug"])),
            client.V1EnvVar(name="DATASET_SPLIT", value="test"),
            client.V1EnvVar(name="PREDICTIONS_PATH", value=predictions_path),
            client.V1EnvVar(name="RUN_ID", value=run["id"]),
            client.V1EnvVar(name="INSTANCE_IDS", value=" ".join(instance_ids)),
            client.V1EnvVar(name="WORKFLOW_BUILDER_URL", value=WORKFLOW_BUILDER_URL),
            client.V1EnvVar(name="INTERNAL_API_TOKEN", value=INTERNAL_API_TOKEN),
            client.V1EnvVar(name="DOCKER_HOST", value="tcp://localhost:2375"),
            client.V1EnvVar(name="SWEBENCH_IMAGE_NAMESPACE", value="swebench"),
        ]
        container = client.V1Container(
            name="evaluator",
            image=EVALUATOR_IMAGE,
            env=env,
            resources=client.V1ResourceRequirements(
                requests={"cpu": "2", "memory": "4Gi"},
                limits={"cpu": "8", "memory": "16Gi"},
            ),
            volume_mounts=[
                client.V1VolumeMount(name="artifacts", mount_path=str(ARTIFACT_ROOT)),
            ],
        )
        docker_daemon = client.V1Container(
            name="docker-daemon",
            image=DOCKER_DIND_IMAGE,
            env=[client.V1EnvVar(name="DOCKER_TLS_CERTDIR", value="")],
            args=["--host=tcp://0.0.0.0:2375", "--host=unix:///var/run/docker.sock"],
            security_context=client.V1SecurityContext(privileged=True),
            resources=client.V1ResourceRequirements(
                requests={"cpu": "500m", "memory": "1Gi"},
                limits={"cpu": "4", "memory": "8Gi"},
            ),
            volume_mounts=[
                client.V1VolumeMount(name="docker-graph", mount_path="/var/lib/docker"),
            ],
        )
        pod = client.V1PodTemplateSpec(
            metadata=client.V1ObjectMeta(labels={"app": "swebench-evaluator", "benchmark-run-id": run["id"]}),
            spec=client.V1PodSpec(
                restart_policy="Never",
                service_account_name="swebench-coordinator",
                share_process_namespace=True,
                image_pull_secrets=[client.V1LocalObjectReference(name="ghcr-pull-credentials")],
                containers=[docker_daemon, container],
                volumes=[
                    client.V1Volume(name="artifacts", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=os.environ.get("SWEBENCH_ARTIFACTS_PVC", "swebench-artifacts"))),
                    client.V1Volume(name="docker-graph", empty_dir=client.V1EmptyDirVolumeSource()),
                ],
            ),
        )
        job = client.V1Job(
            metadata=client.V1ObjectMeta(name=job_name, labels={"app": "swebench-evaluator", "benchmark-run-id": run["id"]}),
            spec=client.V1JobSpec(backoff_limit=0, template=pod),
        )
        batch.create_namespaced_job(namespace=EVALUATOR_NAMESPACE, body=job)
        _mark_run_status(ctx, {"runId": run["id"], "status": "evaluating", "evaluatorJobName": job_name})
        return {"jobName": job_name}
    except Exception as exc:
        raise RuntimeError(f"failed to start evaluator job: {exc}") from exc


def _repo_from_instance_id(instance_id: str) -> str | None:
    if "__" not in instance_id or "-" not in instance_id:
        return None
    owner, rest = instance_id.split("__", 1)
    repo = rest.split("-", 1)[0]
    return f"{owner}/{repo}"


def _dataset_path(suite_slug: str) -> str:
    return "princeton-nlp/SWE-bench_Verified" if suite_slug == "SWE-bench_Verified" else "princeton-nlp/SWE-bench_Lite"


def swebench_instance_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    instance_id = data["instanceId"]
    yield ctx.call_activity(_start_instance, input={"runId": run_id, "instanceId": instance_id})
    deadline = ctx.current_utc_datetime + timedelta(seconds=int(data.get("timeoutSeconds") or 7200) + 300)
    while ctx.current_utc_datetime < deadline:
        sync = yield ctx.call_activity(_sync_instance, input={"runId": run_id, "instanceId": instance_id})
        instance = sync.get("instance") if isinstance(sync, dict) else {}
        status = instance.get("status") if isinstance(instance, dict) else None
        if status in ("inferred", "error", "timeout", "cancelled"):
            return instance
        yield ctx.create_timer(timedelta(seconds=30))
    final_sync = yield ctx.call_activity(_sync_instance, input={"runId": run_id, "instanceId": instance_id})
    if isinstance(final_sync, dict) and isinstance(final_sync.get("instance"), dict):
        return final_sync["instance"]
    return final_sync


def swebench_run_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    try:
        yield ctx.call_activity(_mark_run_status, input={"runId": run_id, "status": "inferencing"})
        run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
        yield ctx.call_activity(_ensure_instance_metadata, input={"runId": run_id})
        run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
        instance_ids = list(run.get("selectedInstanceIds") or [])
        concurrency = max(1, min(int(run.get("concurrency") or 1), 32))
        timeout_seconds = int(run.get("timeoutSeconds") or 7200)
        results: list[Any] = []
        for offset in range(0, len(instance_ids), concurrency):
            chunk = instance_ids[offset: offset + concurrency]
            tasks = [
                ctx.call_child_workflow(
                    "swebench_instance_workflow",
                    input={"runId": run_id, "instanceId": instance_id, "timeoutSeconds": timeout_seconds},
                    instance_id=f"swebench-{run_id}-{instance_id}".replace("/", "-")[:100],
                )
                for instance_id in chunk
            ]
            if wf_when_all is not None:
                chunk_results = yield wf_when_all(tasks)
                results.extend(chunk_results)
            else:
                for task in tasks:
                    results.append((yield task))
        failed_instances = [
            result
            for result in results
            if not isinstance(result, dict) or result.get("status") != "inferred"
        ]
        if failed_instances:
            error_message = _format_inference_failures(failed_instances)
            yield ctx.call_activity(
                _mark_run_status,
                input={"runId": run_id, "status": "failed", "error": error_message},
            )
            return {
                "success": False,
                "instances": len(results),
                "failedInstances": len(failed_instances),
                "error": error_message,
            }
        predictions = yield ctx.call_activity(_write_predictions, input={"runId": run_id})
        yield ctx.call_activity(
            _start_evaluator_job,
            input={"runId": run_id, "predictionsPath": predictions["path"]},
        )
        return {"success": True, "instances": len(results), "predictionsPath": predictions["path"]}
    except Exception as exc:
        yield ctx.call_activity(_mark_run_status, input={"runId": run_id, "status": "failed", "error": str(exc)})
        raise


def _format_inference_failures(results: list[Any]) -> str:
    summaries: list[str] = []
    for result in results[:5]:
        if not isinstance(result, dict):
            summaries.append(f"unknown instance returned {type(result).__name__}")
            continue
        instance_id = result.get("instanceId") or result.get("instance_id") or "unknown"
        status = result.get("status") or "unknown"
        error_text = str(result.get("error") or "").strip()
        if error_text:
            summaries.append(f"{instance_id}: {status}: {error_text[:300]}")
        else:
            summaries.append(f"{instance_id}: {status}")
    suffix = "" if len(results) <= 5 else f"; and {len(results) - 5} more"
    return f"Inference failed for {len(results)} SWE-bench instance(s): {'; '.join(summaries)}{suffix}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    wfr.register_workflow(swebench_run_workflow)
    wfr.register_workflow(swebench_instance_workflow)
    for activity in (
        _mark_run_status,
        _load_run_activity,
        _ensure_instance_metadata,
        _start_instance,
        _sync_instance,
        _write_predictions,
        _start_evaluator_job,
    ):
        wfr.register_activity(activity)
    wfr.start()
    logger.info("SWE-bench coordinator workflow runtime started")
    yield
    wfr.shutdown()


app = FastAPI(title="swebench-coordinator", lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/v1/benchmark-runs")
def start_benchmark_run(body: StartRunRequest, request: Request):
    _require_internal(request)
    instance_id = f"swebench-run-{body.runId}"
    try:
        DaprWorkflowClient().schedule_new_workflow(
            workflow=swebench_run_workflow,
            input={"runId": body.runId, "requestedAt": time.time()},
            instance_id=instance_id,
        )
    except Exception as exc:
        logger.exception("Failed to schedule SWE-bench run workflow %s", instance_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "executionId": instance_id}


@app.post("/api/v1/benchmark-runs/{run_id}/cancel")
def cancel_benchmark_run(run_id: str, request: Request, body: CancelRunRequest = CancelRunRequest()):
    _require_internal(request)
    instance_id = f"swebench-run-{run_id}"
    reason = body.reason if body else "cancelled"
    DaprWorkflowClient().terminate_workflow(instance_id=instance_id, output=reason)
    return {"success": True, "executionId": instance_id}
