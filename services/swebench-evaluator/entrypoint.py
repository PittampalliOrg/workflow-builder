from __future__ import annotations

import json
import os
import pathlib
import sys
import time
from typing import Any

import requests


PIPELINERUN_GROUP = "tekton.dev"
PIPELINERUN_VERSION = "v1"
PIPELINERUN_PLURAL = "pipelineruns"


def main() -> int:
    dataset_name = required_env("DATASET_NAME")
    predictions_path = required_env("PREDICTIONS_PATH")
    run_id = required_env("RUN_ID")
    instance_ids = [s for s in os.environ.get("INSTANCE_IDS", "").split() if s]
    if not instance_ids:
        raise RuntimeError("INSTANCE_IDS env var is required (space-separated)")
    split = os.environ.get("DATASET_SPLIT", "test")
    image_map = parse_instance_image_map(os.environ.get("INSTANCE_IMAGE_MAP_JSON", ""), instance_ids)
    artifacts_root = pathlib.Path(os.environ.get("SWEBENCH_ARTIFACT_ROOT", "/artifacts"))
    log_dir = artifacts_root / run_id / "harness"
    log_dir.mkdir(parents=True, exist_ok=True)

    namespace = os.environ.get("SWEBENCH_PIPELINE_NAMESPACE", "workflow-builder")
    pipeline_ref = os.environ.get("SWEBENCH_PIPELINE_REF", "swebench-eval")
    pvc_name = os.environ.get("SWEBENCH_ARTIFACTS_PVC", "swebench-artifacts")
    swebench_pkg = os.environ.get(
        "SWEBENCH_PACKAGE_REF",
        "git+https://github.com/PittampalliOrg/SWE-bench.git@main",
    )
    timeout_seconds = evaluation_timeout_seconds()
    pipelinerun_name = pipelinerun_name_for(run_id)

    pipelinerun = build_pipelinerun(
        name=pipelinerun_name,
        namespace=namespace,
        pipeline_ref=pipeline_ref,
        pvc_name=pvc_name,
        run_id=run_id,
        dataset_name=dataset_name,
        dataset_split=split,
        predictions_path=predictions_path,
        instance_ids=instance_ids,
        instance_image_map=image_map,
        swebench_package_ref=swebench_pkg,
        timeout_seconds=timeout_seconds,
        workflow_builder_url=os.environ.get("WORKFLOW_BUILDER_URL", ""),
    )

    api = load_custom_objects_api()
    create_pipelinerun(api, namespace, pipelinerun)
    print(f"[swebench-evaluator] dispatched PipelineRun {namespace}/{pipelinerun_name}")

    overall_deadline = max(timeout_seconds + 1200, 1800)
    final = wait_for_pipelinerun(api, namespace, pipelinerun_name, overall_deadline)
    succeeded = pipelinerun_succeeded(final)
    failure_message = pipelinerun_failure_reason(final) if not succeeded else None

    run_dir = artifacts_root / run_id
    run_report = read_json(run_dir / "run-report.json")
    results = collect_results(run_dir, instance_ids)

    log_mlflow_evaluation(run_id, results, log_dir, failure_message)
    post_results(run_id, results, error=failure_message)
    return 0 if succeeded else 1


def parse_instance_image_map(raw: str, instance_ids: list[str]) -> dict[str, str]:
    if not raw.strip():
        raise RuntimeError(
            "INSTANCE_IMAGE_MAP_JSON env var is required: a JSON object mapping "
            "instance_id -> instance image ref"
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"INSTANCE_IMAGE_MAP_JSON is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("INSTANCE_IMAGE_MAP_JSON must decode to an object")
    missing = [iid for iid in instance_ids if not isinstance(parsed.get(iid), str) or not parsed[iid]]
    if missing:
        raise RuntimeError(f"INSTANCE_IMAGE_MAP_JSON missing image refs for: {missing}")
    return {iid: parsed[iid] for iid in instance_ids}


def pipelinerun_name_for(run_id: str) -> str:
    safe = "".join(ch.lower() if ch.isalnum() else "-" for ch in run_id).strip("-")[:40] or "run"
    suffix = format(int(time.time()) % 100000, "05d")
    return f"swebench-eval-{safe}-{suffix}"


def build_pipelinerun(
    *,
    name: str,
    namespace: str,
    pipeline_ref: str,
    pvc_name: str,
    run_id: str,
    dataset_name: str,
    dataset_split: str,
    predictions_path: str,
    instance_ids: list[str],
    instance_image_map: dict[str, str],
    swebench_package_ref: str,
    timeout_seconds: int,
    workflow_builder_url: str,
) -> dict[str, Any]:
    output_dir = f"/workspace/artifacts/{run_id}"
    params: list[dict[str, Any]] = [
        {"name": "run_id", "value": run_id},
        {"name": "dataset_name", "value": dataset_name},
        {"name": "dataset_split", "value": dataset_split},
        {"name": "predictions_path", "value": predictions_path},
        {"name": "output_dir", "value": output_dir},
        {"name": "instance_ids", "value": list(instance_ids)},
        {
            "name": "instance_image_map_json",
            "value": json.dumps(instance_image_map, sort_keys=True),
        },
        {"name": "swebench_package_ref", "value": swebench_package_ref},
        {"name": "timeout_seconds", "value": str(timeout_seconds)},
    ]
    if workflow_builder_url:
        params.append({"name": "workflow_builder_url", "value": workflow_builder_url})

    pipeline_budget = max(timeout_seconds * 2 + 600, 1800)
    return {
        "apiVersion": f"{PIPELINERUN_GROUP}/{PIPELINERUN_VERSION}",
        "kind": "PipelineRun",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "app.kubernetes.io/part-of": "swebench-evaluator",
                "swebench.benchmark-run-id": safe_label_value(run_id),
            },
        },
        "spec": {
            "pipelineRef": {"name": pipeline_ref},
            "params": params,
            "workspaces": [
                {
                    "name": "artifacts",
                    "persistentVolumeClaim": {"claimName": pvc_name},
                },
            ],
            "timeouts": {"pipeline": f"{pipeline_budget}s"},
        },
    }


def safe_label_value(value: str) -> str:
    sanitized = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in value)
    sanitized = sanitized.strip("-_.")
    return sanitized[:63] or "run"


def load_custom_objects_api():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()
    return client.CustomObjectsApi()


def create_pipelinerun(api, namespace: str, body: dict[str, Any]) -> None:
    from kubernetes.client.rest import ApiException

    try:
        api.create_namespaced_custom_object(
            group=PIPELINERUN_GROUP,
            version=PIPELINERUN_VERSION,
            namespace=namespace,
            plural=PIPELINERUN_PLURAL,
            body=body,
        )
    except ApiException as exc:
        if getattr(exc, "status", None) == 409:
            return
        raise


def wait_for_pipelinerun(api, namespace: str, name: str, deadline_seconds: int) -> dict[str, Any]:
    poll_interval = max(2, int(os.environ.get("SWEBENCH_POLL_INTERVAL_SECONDS", "10")))
    start = time.monotonic()
    while True:
        pr = api.get_namespaced_custom_object(
            group=PIPELINERUN_GROUP,
            version=PIPELINERUN_VERSION,
            namespace=namespace,
            plural=PIPELINERUN_PLURAL,
            name=name,
        )
        cond = succeeded_condition(pr)
        if cond and cond.get("status") in {"True", "False"}:
            return pr
        if time.monotonic() - start >= deadline_seconds:
            return pr
        time.sleep(poll_interval)


def succeeded_condition(pr: dict[str, Any]) -> dict[str, Any] | None:
    for cond in (pr.get("status") or {}).get("conditions") or []:
        if isinstance(cond, dict) and cond.get("type") == "Succeeded":
            return cond
    return None


def pipelinerun_succeeded(pr: dict[str, Any]) -> bool:
    cond = succeeded_condition(pr)
    return bool(cond and cond.get("status") == "True")


def pipelinerun_failure_reason(pr: dict[str, Any]) -> str:
    cond = succeeded_condition(pr) or {}
    reason = str(cond.get("reason") or "")
    message = str(cond.get("message") or "")
    parts = [p for p in (reason, message) if p]
    return ": ".join(parts) or "PipelineRun did not complete successfully"


def collect_results(run_dir: pathlib.Path, instance_ids: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for iid in instance_ids:
        report_path = run_dir / iid / "report.json"
        if not report_path.exists():
            results.append(
                {
                    "instance_id": iid,
                    "resolved": False,
                    "status": "error",
                    "error": "No report.json produced by Tekton run-instance Task",
                    "logs_path": str(run_dir / iid),
                }
            )
            continue
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except Exception as exc:
            results.append(
                {
                    "instance_id": iid,
                    "resolved": False,
                    "status": "error",
                    "error": f"Failed to parse report.json: {exc}",
                    "logs_path": str(run_dir / iid),
                }
            )
            continue
        payload.setdefault("instance_id", iid)
        payload.setdefault("logs_path", str(run_dir / iid))
        results.append(payload)
    return results


def read_json(path: pathlib.Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def evaluation_timeout_seconds() -> int:
    raw = os.environ.get("SWEBENCH_EVALUATION_TIMEOUT_SECONDS", "1800").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 1800
    return max(60, value)


def mlflow_enabled() -> bool:
    enabled = os.environ.get("MLFLOW_ENABLED", "").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return False
    return bool(os.environ.get("MLFLOW_TRACKING_URI", "").strip())


def log_mlflow_evaluation(
    run_id: str,
    results: list[dict[str, Any]],
    log_dir: pathlib.Path,
    error: str | None,
) -> None:
    if not mlflow_enabled():
        return
    parent_run_id = os.environ.get("MLFLOW_RUN_ID", "").strip()
    if not parent_run_id:
        return
    try:
        import mlflow

        mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"].strip())
        with mlflow.start_run(run_id=parent_run_id):
            mlflow.set_tag(
                "workflow_builder.evaluator_job_name",
                os.environ.get("SWEBENCH_EVALUATOR_JOB_NAME", ""),
            )
            mlflow.set_tag("workflow_builder.evaluator_error", error or "")
            mlflow.log_metric("harness_result_count", len(results))
            mlflow.log_metric(
                "harness_resolved_count",
                sum(1 for r in results if r.get("resolved") is True),
            )
            mlflow.log_metric(
                "harness_unresolved_count",
                sum(1 for r in results if r.get("status") in {"failed", "unresolved"}),
            )
            mlflow.log_metric(
                "harness_empty_patch_count",
                sum(1 for r in results if r.get("status") == "empty_patch"),
            )
            mlflow.log_metric(
                "harness_error_count",
                sum(1 for r in results if r.get("status") == "error"),
            )
            mlflow.log_metric(
                "harness_timeout_count",
                sum(1 for r in results if r.get("status") == "timeout"),
            )
            for artifact in sorted(log_dir.rglob("*.json")):
                mlflow.log_artifact(str(artifact), artifact_path="harness/results")
        instance_runs = mlflow_instance_run_map()
        for result in results:
            instance_id = result.get("instance_id") or result.get("instanceId")
            if not isinstance(instance_id, str):
                continue
            instance_run_id = instance_runs.get(instance_id)
            if not instance_run_id:
                continue
            with mlflow.start_run(run_id=instance_run_id):
                status = str(result.get("status") or "")
                mlflow.set_tag("swebench.evaluation_status", status)
                mlflow.set_tag("workflow_builder.logs_path", result.get("logs_path") or "")
                mlflow.set_tag("workflow_builder.evaluation_error", result.get("error") or "")
                mlflow.log_metric("swebench_resolved", 1 if result.get("resolved") is True else 0)
                mlflow.log_metric("swebench_empty_patch", 1 if status == "empty_patch" else 0)
                mlflow.log_metric("swebench_timeout", 1 if status == "timeout" else 0)
                mlflow.log_metric("swebench_error", 1 if status == "error" else 0)
                harness_result = result.get("harness_result") or result.get("harnessResult")
                if isinstance(harness_result, dict):
                    mlflow.log_dict(harness_result, "harness/result.json")
    except Exception as exc:
        print(f"[mlflow] best-effort evaluation logging failed: {exc}", file=sys.stderr)


def mlflow_instance_run_map() -> dict[str, str]:
    raw = os.environ.get("MLFLOW_INSTANCE_RUNS_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        str(key): value
        for key, value in parsed.items()
        if isinstance(value, str) and value
    }


def post_results(run_id: str, results: list[dict[str, Any]], error: str | None = None) -> None:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not base or not token:
        return
    body: dict[str, Any] = {"results": results}
    job_name = os.environ.get("SWEBENCH_EVALUATOR_JOB_NAME", "").strip()
    if job_name:
        body["jobName"] = job_name
    if error:
        body["error"] = error
    requests.post(
        f"{base}/api/internal/benchmarks/runs/{run_id}/evaluation-results",
        headers={"X-Internal-Token": token, "Content-Type": "application/json"},
        json=body,
        timeout=60,
    ).raise_for_status()


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
