from __future__ import annotations

import json
import os
import pathlib
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

import requests


def main() -> int:
    dataset_name = required_env("DATASET_NAME")
    predictions_path = required_env("PREDICTIONS_PATH")
    run_id = required_env("RUN_ID")
    instance_ids = os.environ.get("INSTANCE_IDS", "").split()
    split = os.environ.get("DATASET_SPLIT", "test")
    max_workers = os.environ.get("SWEBENCH_MAX_WORKERS", "1")
    image_namespace = os.environ.get("SWEBENCH_IMAGE_NAMESPACE", "swebench")
    log_dir = pathlib.Path(os.environ.get("SWEBENCH_LOG_DIR", f"/artifacts/{run_id}/harness"))
    log_dir.mkdir(parents=True, exist_ok=True)
    wait_for_docker()

    try:
        cmd = [
            sys.executable,
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            dataset_name,
            "--split",
            split,
            "--predictions_path",
            predictions_path,
            "--run_id",
            run_id,
            "--report_dir",
            str(log_dir),
            "--max_workers",
            max_workers,
            "--namespace",
            image_namespace,
        ]
        if instance_ids:
            cmd.extend(["--instance_ids", *instance_ids])

        timeout_seconds = evaluation_timeout_seconds()
        try:
            result = subprocess.run(
                cmd,
                cwd=str(log_dir),
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            timeout_message = f"SWE-bench harness timed out after {timeout_seconds} seconds"
            (log_dir / "stdout.log").write_text(output_text(exc.stdout), encoding="utf-8")
            (log_dir / "stderr.log").write_text(
                output_text(exc.stderr, suffix=f"\n{timeout_message}\n"),
                encoding="utf-8",
            )
            parsed_results = parse_results(
                log_dir,
                instance_ids,
                include_missing=False,
                include_incomplete=False,
            )
            timeout_results = make_timeout_results(
                missing_result_instance_ids(instance_ids, parsed_results),
                log_dir,
                timeout_message,
            )
            log_mlflow_evaluation(run_id, [*parsed_results, *timeout_results], log_dir, timeout_message)
            post_results(
                run_id,
                [*parsed_results, *timeout_results],
                error=timeout_message,
            )
            return 124

        (log_dir / "stdout.log").write_text(result.stdout, encoding="utf-8")
        (log_dir / "stderr.log").write_text(result.stderr, encoding="utf-8")
        parsed_results = parse_results(log_dir, instance_ids)
        log_mlflow_evaluation(
            run_id,
            parsed_results,
            log_dir,
            None if result.returncode == 0 else result.stderr[-4000:],
        )
        post_results(
            run_id,
            parsed_results if result.returncode == 0 else parsed_results,
            error=None if result.returncode == 0 else result.stderr[-4000:],
        )
        return result.returncode
    finally:
        stop_docker_sidecar()


def wait_for_docker() -> None:
    deadline = int(os.environ.get("DOCKER_WAIT_SECONDS", "180"))
    if deadline <= 0:
        return
    import time

    start = time.monotonic()
    while True:
        if docker_api_ready():
            return
        if time.monotonic() - start >= deadline:
            raise RuntimeError("Docker daemon did not become ready")
        time.sleep(2)


def docker_api_ready() -> bool:
    docker_host = os.environ.get("DOCKER_HOST", "tcp://localhost:2375").strip()
    if docker_host.startswith("tcp://"):
        url = "http://" + docker_host.removeprefix("tcp://").rstrip("/") + "/_ping"
    elif docker_host.startswith("http://") or docker_host.startswith("https://"):
        url = docker_host.rstrip("/") + "/_ping"
    else:
        return subprocess.run(
            ["docker", "info"],
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status == 200 and response.read().strip() == b"OK"
    except (OSError, urllib.error.URLError):
        return False


def evaluation_timeout_seconds() -> int:
    raw = os.environ.get("SWEBENCH_EVALUATION_TIMEOUT_SECONDS", "7200").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 7200
    return max(60, value)


def output_text(value: Any, *, suffix: str = "") -> str:
    if value is None:
        text = ""
    elif isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = str(value)
    return text + suffix


def make_timeout_results(
    instance_ids: list[str],
    log_dir: pathlib.Path,
    message: str,
) -> list[dict[str, Any]]:
    return [
        {
            "instance_id": instance_id,
            "resolved": False,
            "status": "timeout",
            "error": message,
            "logs_path": str(log_dir),
            "harness_result": {"timeout": True, "message": message},
        }
        for instance_id in instance_ids
    ]


def stop_docker_sidecar() -> None:
    enabled = os.environ.get("SWEBENCH_STOP_DOCKER_SIDECAR", "true").lower()
    if enabled in {"0", "false", "no", "off"}:
        return

    current_pid = os.getpid()
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        pid = int(proc.name)
        if pid == current_pid:
            continue
        try:
            comm = (proc / "comm").read_text(encoding="utf-8", errors="ignore").strip()
            cmdline = (
                (proc / "cmdline")
                .read_bytes()
                .replace(b"\x00", b" ")
                .decode("utf-8", errors="ignore")
            )
        except OSError:
            continue
        if "dockerd" not in f"{comm} {cmdline}":
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue


def parse_results(
    log_dir: pathlib.Path,
    instance_ids: list[str],
    *,
    include_missing: bool = True,
    include_incomplete: bool = True,
) -> list[dict[str, Any]]:
    candidates = list(log_dir.rglob("*.json"))
    by_instance: dict[str, dict[str, Any]] = {}
    for path in candidates:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        visit_aggregate_report(payload, path, by_instance, include_incomplete=include_incomplete)
        visit_result_payload(payload, path, by_instance)
    results: list[dict[str, Any]] = []
    for instance_id in instance_ids:
        result = by_instance.get(instance_id)
        if result is None:
            if not include_missing:
                continue
            result = {
                "instance_id": instance_id,
                "status": "error",
                "error": "No harness result JSON found for instance",
                "logs_path": str(log_dir),
            }
        results.append(result)
    if not instance_ids:
        results.extend(by_instance.values())
    return results


def missing_result_instance_ids(
    instance_ids: list[str],
    results: list[dict[str, Any]],
) -> list[str]:
    parsed_ids = {
        result.get("instance_id") or result.get("instanceId")
        for result in results
        if isinstance(result.get("instance_id") or result.get("instanceId"), str)
    }
    return [instance_id for instance_id in instance_ids if instance_id not in parsed_ids]


def visit_aggregate_report(
    payload: Any,
    path: pathlib.Path,
    out: dict[str, dict[str, Any]],
    *,
    include_incomplete: bool = True,
) -> None:
    if not isinstance(payload, dict):
        return

    resolved_ids = string_set(payload.get("resolved_ids"))
    unresolved_ids = string_set(payload.get("unresolved_ids"))
    error_ids = string_set(payload.get("error_ids"))
    empty_patch_ids = string_set(payload.get("empty_patch_ids"))
    incomplete_ids = string_set(payload.get("incomplete_ids"))
    if not any((resolved_ids, unresolved_ids, error_ids, empty_patch_ids, incomplete_ids)):
        return

    summary = summarize_aggregate_report(payload)
    for instance_id in sorted(resolved_ids):
        out[instance_id] = make_result(
            instance_id=instance_id,
            resolved=True,
            status="resolved",
            path=path,
            payload=payload,
            test_output_summary=summary,
        )
    for instance_id in sorted(unresolved_ids):
        out[instance_id] = make_result(
            instance_id=instance_id,
            resolved=False,
            status="unresolved",
            path=path,
            payload=payload,
            test_output_summary=summary,
        )
    for instance_id in sorted(empty_patch_ids):
        out[instance_id] = make_result(
            instance_id=instance_id,
            resolved=False,
            status="empty_patch",
            path=path,
            payload=payload,
            error="Empty patch",
            test_output_summary=summary,
        )
    incomplete_status_ids = incomplete_ids if include_incomplete else set()
    for instance_id in sorted(error_ids | incomplete_status_ids):
        error = "Evaluation did not complete" if instance_id in incomplete_status_ids else "Harness error"
        out[instance_id] = make_result(
            instance_id=instance_id,
            resolved=False,
            status="error",
            path=path,
            payload=payload,
            error=error,
            test_output_summary=summary,
        )


def visit_result_payload(payload: Any, path: pathlib.Path, out: dict[str, dict[str, Any]]) -> None:
    if isinstance(payload, dict):
        instance_id = payload.get("instance_id") or payload.get("instanceId")
        if isinstance(instance_id, str):
            resolved = payload.get("resolved")
            if resolved is None and isinstance(payload.get(instance_id), dict):
                resolved = payload[instance_id].get("resolved")
            out[instance_id] = make_result(
                instance_id=instance_id,
                resolved=bool(resolved),
                status="resolved" if resolved else "failed",
                path=path,
                payload=payload,
            )
        for key, value in payload.items():
            if isinstance(key, str) and "__" in key and isinstance(value, dict):
                resolved = value.get("resolved")
                if resolved is not None:
                    out[key] = make_result(
                        instance_id=key,
                        resolved=bool(resolved),
                        status="resolved" if resolved else "failed",
                        path=path,
                        payload=value,
                    )
        for value in payload.values():
            visit_result_payload(value, path, out)
    elif isinstance(payload, list):
        for value in payload:
            visit_result_payload(value, path, out)


def make_result(
    *,
    instance_id: str,
    resolved: bool,
    status: str,
    path: pathlib.Path,
    payload: dict[str, Any],
    error: str | None = None,
    test_output_summary: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "instance_id": instance_id,
        "resolved": resolved,
        "status": status,
        "logs_path": str(path),
        "harness_result": payload,
    }
    if error:
        result["error"] = error
    if test_output_summary:
        result["test_output_summary"] = test_output_summary
    return result


def string_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {item for item in value if isinstance(item, str)}


def summarize_aggregate_report(payload: dict[str, Any]) -> str:
    fields = [
        ("total", "total_instances"),
        ("submitted", "submitted_instances"),
        ("completed", "completed_instances"),
        ("resolved", "resolved_instances"),
        ("unresolved", "unresolved_instances"),
        ("empty_patches", "empty_patch_instances"),
        ("errors", "error_instances"),
    ]
    parts = [f"{label}={payload[key]}" for label, key in fields if key in payload]
    return "SWE-bench report: " + ", ".join(parts) if parts else "SWE-bench report"


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
            mlflow.set_tag("workflow_builder.evaluator_job_name", os.environ.get("SWEBENCH_EVALUATOR_JOB_NAME", ""))
            mlflow.set_tag("workflow_builder.evaluator_error", error or "")
            mlflow.log_metric("harness_result_count", len(results))
            mlflow.log_metric("harness_resolved_count", sum(1 for r in results if r.get("resolved") is True))
            mlflow.log_metric("harness_unresolved_count", sum(1 for r in results if r.get("status") in {"failed", "unresolved"}))
            mlflow.log_metric("harness_empty_patch_count", sum(1 for r in results if r.get("status") == "empty_patch"))
            mlflow.log_metric("harness_error_count", sum(1 for r in results if r.get("status") == "error"))
            mlflow.log_metric("harness_timeout_count", sum(1 for r in results if r.get("status") == "timeout"))
            for artifact in sorted(log_dir.glob("*.log")):
                mlflow.log_artifact(str(artifact), artifact_path="harness")
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
                harness_result = result.get("harness_result")
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
