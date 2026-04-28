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

        result = subprocess.run(cmd, cwd=str(log_dir), text=True, capture_output=True)
        (log_dir / "stdout.log").write_text(result.stdout, encoding="utf-8")
        (log_dir / "stderr.log").write_text(result.stderr, encoding="utf-8")
        parsed_results = parse_results(log_dir, instance_ids)
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


def parse_results(log_dir: pathlib.Path, instance_ids: list[str]) -> list[dict[str, Any]]:
    candidates = list(log_dir.rglob("*.json"))
    by_instance: dict[str, dict[str, Any]] = {}
    for path in candidates:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        visit_aggregate_report(payload, path, by_instance)
        visit_result_payload(payload, path, by_instance)
    results: list[dict[str, Any]] = []
    for instance_id in instance_ids:
        result = by_instance.get(instance_id)
        if result is None:
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


def visit_aggregate_report(payload: Any, path: pathlib.Path, out: dict[str, dict[str, Any]]) -> None:
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
    for instance_id in sorted(error_ids | incomplete_ids):
        error = "Evaluation did not complete" if instance_id in incomplete_ids else "Harness error"
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


def post_results(run_id: str, results: list[dict[str, Any]], error: str | None = None) -> None:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not base or not token:
        return
    body: dict[str, Any] = {"results": results}
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
