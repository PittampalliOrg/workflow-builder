from __future__ import annotations

import json
import os
import pathlib
import sys
import time
from typing import Any

import requests


TEKTON_GROUP = "tekton.dev"
TEKTON_VERSION = "v1"
TASKRUN_PLURAL = "taskruns"
DEFAULT_EVAL_MAX_PARALLEL = 24
MAX_EVAL_MAX_PARALLEL = 128
DEFAULT_TEKTON_IMAGE_PULL_SECRETS = "ghcr-pull-credentials"


def main() -> int:
    required_env("DATASET_NAME")
    predictions_path = required_env("PREDICTIONS_PATH")
    run_id = required_env("RUN_ID")
    instance_ids = [s for s in os.environ.get("INSTANCE_IDS", "").split() if s]
    if not instance_ids:
        raise RuntimeError("INSTANCE_IDS env var is required (space-separated)")
    image_map = parse_instance_image_map(
        os.environ.get("INSTANCE_IMAGE_MAP_JSON", ""), instance_ids
    )
    artifacts_root = pathlib.Path(
        os.environ.get("SWEBENCH_ARTIFACT_ROOT", "/artifacts")
    )
    log_dir = artifacts_root / run_id / "harness"
    log_dir.mkdir(parents=True, exist_ok=True)

    namespace = os.environ.get("SWEBENCH_PIPELINE_NAMESPACE", "workflow-builder")
    pvc_name = os.environ.get("SWEBENCH_ARTIFACTS_PVC", "swebench-artifacts")
    swebench_pkg = os.environ.get(
        "SWEBENCH_PACKAGE_REF",
        "git+https://github.com/PittampalliOrg/SWE-bench.git@main",
    )
    timeout_seconds = evaluation_timeout_seconds()
    max_parallel = evaluation_max_parallel()
    workflow_builder_url = os.environ.get("WORKFLOW_BUILDER_URL", "")

    api = load_custom_objects_api()

    # Phase 1: prepare — single TaskRun fans patches out per-instance.
    prep_name = taskrun_name(run_id, "prepare")
    prep_body = build_prepare_taskrun(
        name=prep_name,
        namespace=namespace,
        pvc_name=pvc_name,
        run_id=run_id,
        predictions_path=predictions_path,
        instance_ids=instance_ids,
        swebench_package_ref=swebench_pkg,
    )
    create_taskrun(api, namespace, prep_body)
    print(f"[swebench-evaluator] dispatched prepare TaskRun {namespace}/{prep_name}")
    prep_final = wait_for_taskruns(api, namespace, [prep_name], deadline_seconds=600)
    if not all(taskrun_succeeded(tr) for tr in prep_final.values()):
        msg = taskrun_failure_reason(prep_final[prep_name])
        print(f"[swebench-evaluator] prepare failed: {msg}")
        return _post_terminal_results(
            run_id, instance_ids, artifacts_root, log_dir, error=msg, succeeded=False
        )

    # Phase 2: run-instance — one TaskRun per instance, launched in bounded
    # batches so evaluation has its own Kubernetes-native concurrency cap.
    run_deadline = max(timeout_seconds + 600, 1800)
    run_final = dispatch_run_instance_taskruns(
        api=api,
        namespace=namespace,
        pvc_name=pvc_name,
        run_id=run_id,
        instance_ids=instance_ids,
        image_map=image_map,
        timeout_seconds=timeout_seconds,
        max_parallel=max_parallel,
        deadline_seconds=run_deadline,
    )

    # Phase 3: finalize — aggregate per-instance reports and POST to BFF.
    fin_name = taskrun_name(run_id, "finalize")
    fin_body = build_finalize_taskrun(
        name=fin_name,
        namespace=namespace,
        pvc_name=pvc_name,
        run_id=run_id,
        instance_ids=instance_ids,
        swebench_package_ref=swebench_pkg,
        workflow_builder_url=workflow_builder_url,
    )
    create_taskrun(api, namespace, fin_body)
    print(f"[swebench-evaluator] dispatched finalize TaskRun {namespace}/{fin_name}")
    fin_final = wait_for_taskruns(api, namespace, [fin_name], deadline_seconds=600)

    failure_messages: list[str] = []
    for name, tr in run_final.items():
        if not taskrun_succeeded(tr):
            failure_messages.append(f"{name}: {taskrun_failure_reason(tr)}")
    if not taskrun_succeeded(fin_final[fin_name]):
        failure_messages.append(
            f"{fin_name}: {taskrun_failure_reason(fin_final[fin_name])}"
        )
    succeeded = not failure_messages
    failure_message = "; ".join(failure_messages)[:500] if failure_messages else None

    # finalize already POSTed graded results to the BFF in the proper shape;
    # the dispatcher's collect_results would re-POST raw harness reports that
    # the BFF can't decode without a flatten step. Skip the dispatcher POST
    # and only do MLflow logging here (which lives outside the TaskRun).
    run_dir = artifacts_root / run_id
    results = collect_results(run_dir, instance_ids)
    log_mlflow_evaluation(run_id, results, log_dir, failure_message)
    return 0 if succeeded else 1


def _post_terminal_results(
    run_id: str,
    instance_ids: list[str],
    artifacts_root: pathlib.Path,
    log_dir: pathlib.Path,
    *,
    error: str,
    succeeded: bool,
) -> int:
    run_dir = artifacts_root / run_id
    results = collect_results(run_dir, instance_ids)
    log_mlflow_evaluation(run_id, results, log_dir, error)
    post_results(run_id, results, error=error)
    return 0 if succeeded else 1


def evaluation_max_parallel() -> int:
    raw = os.environ.get("SWEBENCH_EVAL_MAX_PARALLEL") or os.environ.get(
        "SWEBENCH_MAX_WORKERS"
    )
    try:
        parsed = int(raw or DEFAULT_EVAL_MAX_PARALLEL)
    except (TypeError, ValueError):
        parsed = DEFAULT_EVAL_MAX_PARALLEL
    return max(1, min(parsed, MAX_EVAL_MAX_PARALLEL))


def dispatch_run_instance_taskruns(
    *,
    api: Any,
    namespace: str,
    pvc_name: str,
    run_id: str,
    instance_ids: list[str],
    image_map: dict[str, str],
    timeout_seconds: int,
    max_parallel: int,
    deadline_seconds: int,
) -> dict[str, dict[str, Any]]:
    final: dict[str, dict[str, Any]] = {}
    total = len(instance_ids)
    max_parallel = max(1, max_parallel)
    for offset in range(0, total, max_parallel):
        chunk = instance_ids[offset : offset + max_parallel]
        run_names: list[str] = []
        for iid in chunk:
            name = taskrun_name(run_id, "run", iid)
            body = build_run_instance_taskrun(
                name=name,
                namespace=namespace,
                pvc_name=pvc_name,
                run_id=run_id,
                instance_id=iid,
                instance_image=image_map[iid],
                timeout_seconds=timeout_seconds,
            )
            create_taskrun(api, namespace, body)
            run_names.append(name)
        print(
            "[swebench-evaluator] dispatched run-instance TaskRuns "
            f"{offset + 1}-{offset + len(chunk)} of {total} "
            f"(batch size={len(chunk)}, max_parallel={max_parallel})"
        )
        final.update(
            wait_for_taskruns(
                api,
                namespace,
                run_names,
                deadline_seconds=deadline_seconds,
            )
        )
    return final


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
    missing = [
        iid
        for iid in instance_ids
        if not isinstance(parsed.get(iid), str) or not parsed[iid]
    ]
    if missing:
        raise RuntimeError(f"INSTANCE_IMAGE_MAP_JSON missing image refs for: {missing}")
    return {iid: parsed[iid] for iid in instance_ids}


def taskrun_name(run_id: str, phase: str, instance_id: str | None = None) -> str:
    safe_run = (
        "".join(ch.lower() if ch.isalnum() else "-" for ch in run_id).strip("-")[:30]
        or "run"
    )
    suffix = format(int(time.time() * 100) % 100000, "05d")
    if instance_id:
        safe_inst = "".join(
            ch.lower() if ch.isalnum() else "-" for ch in instance_id
        ).strip("-")[:25]
        return (
            f"swebench-{phase}-{safe_run}-{safe_inst}-{suffix}"[:63].rstrip("-") or "tr"
        )
    return f"swebench-{phase}-{safe_run}-{suffix}"[:63].rstrip("-") or "tr"


def _common_metadata(
    name: str, namespace: str, run_id: str, phase: str
) -> dict[str, Any]:
    return {
        "name": name,
        "namespace": namespace,
        "labels": {
            "app.kubernetes.io/part-of": "swebench-evaluator",
            "swebench.benchmark-run-id": safe_label_value(run_id),
            "swebench.phase": phase,
        },
    }


def _artifacts_workspace(pvc_name: str) -> dict[str, Any]:
    return {
        "name": "artifacts",
        "persistentVolumeClaim": {"claimName": pvc_name},
    }


def taskrun_execution_spec() -> dict[str, Any]:
    spec: dict[str, Any] = {}
    service_account = os.environ.get("SWEBENCH_TEKTON_SERVICE_ACCOUNT", "").strip()
    if service_account:
        spec["serviceAccountName"] = service_account

    raw_pull_secrets = os.environ.get(
        "SWEBENCH_TEKTON_IMAGE_PULL_SECRETS",
        DEFAULT_TEKTON_IMAGE_PULL_SECRETS,
    )
    pull_secret_names = [
        name.strip() for name in raw_pull_secrets.split(",") if name.strip()
    ]
    if pull_secret_names:
        spec["podTemplate"] = {
            "imagePullSecrets": [{"name": name} for name in pull_secret_names]
        }
    return spec


def build_prepare_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    run_id: str,
    predictions_path: str,
    instance_ids: list[str],
    swebench_package_ref: str,
) -> dict[str, Any]:
    return {
        "apiVersion": f"{TEKTON_GROUP}/{TEKTON_VERSION}",
        "kind": "TaskRun",
        "metadata": _common_metadata(name, namespace, run_id, "prepare"),
        "spec": {
            **taskrun_execution_spec(),
            "taskRef": {"name": "swebench-eval-prepare"},
            "params": [
                {"name": "run_id", "value": run_id},
                {"name": "predictions_path", "value": predictions_path},
                {"name": "instance_ids", "value": list(instance_ids)},
                {"name": "swebench_package_ref", "value": swebench_package_ref},
            ],
            "workspaces": [_artifacts_workspace(pvc_name)],
            "timeout": "10m",
        },
    }


def build_run_instance_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    run_id: str,
    instance_id: str,
    instance_image: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    return {
        "apiVersion": f"{TEKTON_GROUP}/{TEKTON_VERSION}",
        "kind": "TaskRun",
        "metadata": {
            **_common_metadata(name, namespace, run_id, "run-instance"),
            "labels": {
                **_common_metadata(name, namespace, run_id, "run-instance")["labels"],
                "swebench.instance-id": safe_label_value(instance_id),
            },
        },
        "spec": {
            **taskrun_execution_spec(),
            "taskRef": {"name": "swebench-eval-run-instance"},
            "params": [
                {"name": "run_id", "value": run_id},
                {"name": "instance_id", "value": instance_id},
                {"name": "instance_image", "value": instance_image},
                {"name": "timeout_seconds", "value": str(timeout_seconds)},
            ],
            "workspaces": [_artifacts_workspace(pvc_name)],
            "timeout": f"{max(timeout_seconds + 300, 1800)}s",
        },
    }


def build_finalize_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    run_id: str,
    instance_ids: list[str],
    swebench_package_ref: str,
    workflow_builder_url: str,
) -> dict[str, Any]:
    params: list[dict[str, Any]] = [
        {"name": "run_id", "value": run_id},
        {"name": "instance_ids", "value": list(instance_ids)},
        {"name": "swebench_package_ref", "value": swebench_package_ref},
    ]
    if workflow_builder_url:
        params.append({"name": "workflow_builder_url", "value": workflow_builder_url})
    return {
        "apiVersion": f"{TEKTON_GROUP}/{TEKTON_VERSION}",
        "kind": "TaskRun",
        "metadata": _common_metadata(name, namespace, run_id, "finalize"),
        "spec": {
            **taskrun_execution_spec(),
            "taskRef": {"name": "swebench-eval-finalize"},
            "params": params,
            "workspaces": [_artifacts_workspace(pvc_name)],
            "timeout": "10m",
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


def create_taskrun(api, namespace: str, body: dict[str, Any]) -> None:
    from kubernetes.client.rest import ApiException

    try:
        api.create_namespaced_custom_object(
            group=TEKTON_GROUP,
            version=TEKTON_VERSION,
            namespace=namespace,
            plural=TASKRUN_PLURAL,
            body=body,
        )
    except ApiException as exc:
        if getattr(exc, "status", None) == 409:
            return
        raise


def wait_for_taskruns(
    api,
    namespace: str,
    names: list[str],
    deadline_seconds: int,
) -> dict[str, dict[str, Any]]:
    poll_interval = max(2, int(os.environ.get("SWEBENCH_POLL_INTERVAL_SECONDS", "10")))
    start = time.monotonic()
    pending = set(names)
    final: dict[str, dict[str, Any]] = {}
    while pending and (time.monotonic() - start) < deadline_seconds:
        for name in list(pending):
            tr = api.get_namespaced_custom_object(
                group=TEKTON_GROUP,
                version=TEKTON_VERSION,
                namespace=namespace,
                plural=TASKRUN_PLURAL,
                name=name,
            )
            cond = succeeded_condition(tr)
            if cond and cond.get("status") in {"True", "False"}:
                final[name] = tr
                pending.discard(name)
        if pending:
            time.sleep(poll_interval)
    # Anything still pending after the deadline gets recorded as-is for caller logging.
    for name in pending:
        final[name] = api.get_namespaced_custom_object(
            group=TEKTON_GROUP,
            version=TEKTON_VERSION,
            namespace=namespace,
            plural=TASKRUN_PLURAL,
            name=name,
        )
    return final


def succeeded_condition(obj: dict[str, Any]) -> dict[str, Any] | None:
    for cond in (obj.get("status") or {}).get("conditions") or []:
        if isinstance(cond, dict) and cond.get("type") == "Succeeded":
            return cond
    return None


def taskrun_succeeded(tr: dict[str, Any]) -> bool:
    cond = succeeded_condition(tr)
    return bool(cond and cond.get("status") == "True")


def taskrun_failure_reason(tr: dict[str, Any]) -> str:
    cond = succeeded_condition(tr) or {}
    reason = str(cond.get("reason") or "")
    message = str(cond.get("message") or "")
    parts = [p for p in (reason, message) if p]
    return ": ".join(parts) or "TaskRun did not complete successfully"


def collect_results(
    run_dir: pathlib.Path, instance_ids: list[str]
) -> list[dict[str, Any]]:
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
                mlflow.set_tag(
                    "workflow_builder.logs_path", result.get("logs_path") or ""
                )
                mlflow.set_tag(
                    "workflow_builder.evaluation_error", result.get("error") or ""
                )
                mlflow.log_metric(
                    "swebench_resolved", 1 if result.get("resolved") is True else 0
                )
                mlflow.log_metric(
                    "swebench_empty_patch", 1 if status == "empty_patch" else 0
                )
                mlflow.log_metric("swebench_timeout", 1 if status == "timeout" else 0)
                mlflow.log_metric("swebench_error", 1 if status == "error" else 0)
                harness_result = result.get("harness_result") or result.get(
                    "harnessResult"
                )
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


def post_results(
    run_id: str, results: list[dict[str, Any]], error: str | None = None
) -> None:
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
