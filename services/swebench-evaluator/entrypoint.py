from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
import time
from typing import Any
from urllib.parse import quote

import requests


TEKTON_GROUP = "tekton.dev"
TEKTON_VERSION = "v1"
TASKRUN_PLURAL = "taskruns"
DEFAULT_EVAL_MAX_PARALLEL = 24
MAX_EVAL_MAX_PARALLEL = 128
DEFAULT_TEKTON_IMAGE_PULL_SECRETS = "ghcr-pull-credentials"


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--prepare-task":
        return prepare_task(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--finalize-task":
        return finalize_task(sys.argv[2:])

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
    artifact_mode = evaluator_artifact_mode()

    api = load_custom_objects_api()

    # Phase 1: prepare — single TaskRun fans patches out per-instance.
    prep_name = taskrun_name(run_id, "prepare")
    prep_body = build_prepare_taskrun(
        name=prep_name,
        namespace=namespace,
        pvc_name=pvc_name,
        artifact_mode=artifact_mode,
        run_id=run_id,
        predictions_path=predictions_path,
        instance_ids=instance_ids,
        swebench_package_ref=swebench_pkg,
        workflow_builder_url=workflow_builder_url,
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
        artifact_mode=artifact_mode,
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
        artifact_mode=artifact_mode,
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
    if artifact_mode == "object":
        materialize_reports_from_bff(run_id, instance_ids, artifacts_root)
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


def evaluator_artifact_mode() -> str:
    raw = os.environ.get("SWEBENCH_EVALUATOR_ARTIFACT_MODE", "pvc").strip().lower()
    return "object" if raw in {"object", "object-api", "api", "blob"} else "pvc"


def evaluator_task_image() -> str:
    return (
        os.environ.get("SWEBENCH_EVALUATOR_TASK_IMAGE", "").strip()
        or os.environ.get("SWEBENCH_EVALUATOR_IMAGE", "").strip()
        or "ghcr.io/pittampalliorg/swebench-evaluator:latest"
    )


def prepare_task(instance_ids: list[str]) -> int:
    from swebench.harness.dapr_native import validate_predictions_jsonl
    from swebench.harness.test_spec.test_spec import make_test_spec

    run_id = required_env("RUN_ID")
    preds_path = required_env("PREDICTIONS_PATH")
    object_mode = os.environ.get("ARTIFACT_MODE", "").lower() in {
        "object",
        "object-api",
        "api",
        "blob",
    }
    out_dir = pathlib.Path(f"/workspace/artifacts/{run_id}")
    patches_dir = out_dir / "patches"
    patches_dir.mkdir(parents=True, exist_ok=True)

    if not os.path.exists(preds_path):
        workspace_path = preds_path.replace("/artifacts/", "/workspace/artifacts/", 1)
        if os.path.exists(workspace_path):
            preds_path = workspace_path

    if object_mode:
        download_task_artifact(run_id, "predictions.jsonl", out_dir / "predictions.jsonl")
        download_task_artifact(run_id, "dataset.jsonl", out_dir / "dataset.jsonl")
        preds_path = str(out_dir / "predictions.jsonl")

    validation = validate_predictions_jsonl(
        preds_path,
        selected_instance_ids=instance_ids or None,
        allow_extra_instances=True,
    )
    if validation.issues:
        print(f"validation issues ({len(validation.issues)}):", file=sys.stderr)
        for issue in validation.issues:
            print(f"  - {issue.code.value}: {issue.message}", file=sys.stderr)

    dataset_path = out_dir / "dataset.jsonl"
    if not dataset_path.exists():
        raise RuntimeError(f"dataset.jsonl missing at {dataset_path}")

    rows_by_iid: dict[str, dict[str, Any]] = {}
    with dataset_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            iid = row.get("instance_id") if isinstance(row, dict) else None
            if isinstance(iid, str) and iid:
                rows_by_iid[iid] = row

    preds_by_iid: dict[str, dict[str, Any]] = {}
    with open(preds_path, "r", encoding="utf-8") as handle:
        for line in handle:
            try:
                pred = json.loads(line)
            except json.JSONDecodeError:
                continue
            iid = pred.get("instance_id") if isinstance(pred, dict) else None
            if isinstance(iid, str) and iid:
                preds_by_iid[iid] = pred

    statuses: dict[str, str] = {}
    selected_ids = instance_ids or list(preds_by_iid)
    for iid in selected_ids:
        inst_dir = out_dir / iid
        inst_dir.mkdir(parents=True, exist_ok=True)
        patch_dir = patches_dir / iid
        patch_dir.mkdir(parents=True, exist_ok=True)

        pred = preds_by_iid.get(iid, {})
        patch = pred.get("model_patch") or ""
        patch_path = patch_dir / "model_patch.diff"
        patch_path.write_text(patch, encoding="utf-8")
        upload_task_artifact(
            run_id,
            f"patches/{iid}/model_patch.diff",
            patch_path,
            kind="model_patch",
            instance_id=iid,
            content_type="text/x-diff; charset=utf-8",
        )

        row = rows_by_iid.get(iid)
        if row is None:
            statuses[iid] = "missing_row"
            continue
        spec = make_test_spec(row)
        eval_path = inst_dir / "eval.sh"
        eval_path.write_text(spec.eval_script, encoding="utf-8")
        eval_path.chmod(0o755)
        row_path = inst_dir / "dataset_row.json"
        pred_path = inst_dir / "prediction.json"
        row_path.write_text(json.dumps(row, sort_keys=True), encoding="utf-8")
        pred_path.write_text(json.dumps(pred, sort_keys=True), encoding="utf-8")
        upload_task_artifact(
            run_id,
            f"{iid}/eval.sh",
            eval_path,
            instance_id=iid,
            content_type="text/x-shellscript; charset=utf-8",
        )
        upload_task_artifact(
            run_id,
            f"{iid}/dataset_row.json",
            row_path,
            instance_id=iid,
            content_type="application/json; charset=utf-8",
        )
        upload_task_artifact(
            run_id,
            f"{iid}/prediction.json",
            pred_path,
            instance_id=iid,
            content_type="application/json; charset=utf-8",
        )
        statuses[iid] = "empty_patch" if not patch.strip() else "ready"

    status_path = out_dir / "prepare-status.json"
    status_path.write_text(
        json.dumps(
            {"run_id": run_id, "instance_statuses": statuses},
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    upload_task_artifact(
        run_id,
        "prepare-status.json",
        status_path,
        content_type="application/json; charset=utf-8",
    )
    print(f"prepared {len(statuses)} instances; statuses={statuses}")
    return 0


def finalize_task(instance_ids: list[str]) -> int:
    from swebench.harness.grading import get_eval_report
    from swebench.harness.test_spec.test_spec import make_test_spec

    run_id = required_env("RUN_ID")
    run_dir = pathlib.Path(f"/workspace/artifacts/{run_id}")
    object_mode = os.environ.get("ARTIFACT_MODE", "").lower() in {
        "object",
        "object-api",
        "api",
        "blob",
    }
    if not instance_ids and run_dir.exists():
        instance_ids = sorted(
            p.name
            for p in run_dir.iterdir()
            if p.is_dir() and p.name not in {"patches", "harness"}
        )

    if object_mode:
        for iid in instance_ids:
            inst_dir = run_dir / iid
            download_task_artifact(
                run_id, f"{iid}/.status", inst_dir / ".status", required=False
            )
            download_task_artifact(
                run_id,
                f"{iid}/test_output.txt",
                inst_dir / "test_output.txt",
                required=False,
            )
            download_task_artifact(
                run_id, f"{iid}/dataset_row.json", inst_dir / "dataset_row.json"
            )
            download_task_artifact(
                run_id, f"{iid}/prediction.json", inst_dir / "prediction.json"
            )

    results: list[dict[str, Any]] = []
    summary = {
        "resolved": 0,
        "unresolved": 0,
        "empty_patch": 0,
        "patch_failed": 0,
        "eval_failed": 0,
        "error": 0,
    }

    for iid in instance_ids:
        inst_dir = run_dir / iid
        status_file = inst_dir / ".status"
        status = (
            status_file.read_text(encoding="utf-8").strip()
            if status_file.exists()
            else "ready"
        )

        if status in {"empty_patch", "patch_failed", "eval_failed"}:
            report, inst_report = terminal_harness_report(iid, inst_dir, status)
            result: dict[str, Any] = {
                "instance_id": iid,
                "resolved": False,
                "status": status,
                "logs_path": str(inst_dir),
                "harness_result": inst_report,
            }
            if status == "eval_failed":
                result["error"] = (
                    inst_report.get("message")
                    or "evaluation failed before grading completed"
                )
            results.append(result)
            summary[status] = summary.get(status, 0) + 1
            write_instance_report(run_id, iid, inst_dir, report)
            continue

        log_path = inst_dir / "test_output.txt"
        row_path = inst_dir / "dataset_row.json"
        pred_path = inst_dir / "prediction.json"
        if not log_path.exists():
            record_finalize_error(
                run_id,
                results,
                summary,
                iid,
                inst_dir,
                "test_output.txt missing; run-instance TaskRun did not produce harness output",
            )
            continue
        if not row_path.exists() or not pred_path.exists():
            record_finalize_error(
                run_id,
                results,
                summary,
                iid,
                inst_dir,
                "dataset_row or prediction missing in artifacts",
            )
            continue

        row = json.loads(row_path.read_text(encoding="utf-8"))
        pred = json.loads(pred_path.read_text(encoding="utf-8"))
        try:
            report = get_eval_report(
                test_spec=make_test_spec(row),
                prediction=pred,
                test_log_path=str(log_path),
                include_tests_status=True,
            )
        except Exception as exc:
            import traceback

            print(f"[finalize] ERROR for {iid}: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            record_finalize_error(
                run_id,
                results,
                summary,
                iid,
                inst_dir,
                f"grading raised: {exc.__class__.__name__}: {exc}",
            )
            continue

        write_instance_report(run_id, iid, inst_dir, report)
        inst_report = report.get(iid) or next(iter(report.values()))
        resolved = bool(inst_report.get("resolved"))
        results.append(
            {
                "instance_id": iid,
                "resolved": resolved,
                "status": "resolved" if resolved else "unresolved",
                "logs_path": str(inst_dir),
                "harness_result": inst_report,
            }
        )
        summary["resolved" if resolved else "unresolved"] += 1

    aggregate = {
        "run_id": run_id,
        "total_instances": len(instance_ids),
        "submitted_instances": len(instance_ids),
        "completed_instances": sum(
            1 for result in results if result.get("status") in {"resolved", "unresolved"}
        ),
        "resolved_instances": summary["resolved"],
        "unresolved_instances": summary["unresolved"],
        "empty_patch_instances": summary["empty_patch"],
        "error_instances": summary["error"]
        + summary["patch_failed"]
        + summary["eval_failed"],
        "resolved_ids": sorted(
            result["instance_id"] for result in results if result.get("resolved")
        ),
        "unresolved_ids": sorted(
            result["instance_id"]
            for result in results
            if result.get("status") == "unresolved"
        ),
        "empty_patch_ids": sorted(
            result["instance_id"]
            for result in results
            if result.get("status") == "empty_patch"
        ),
        "error_ids": sorted(
            result["instance_id"]
            for result in results
            if result.get("status") in {"error", "patch_failed", "eval_failed"}
        ),
    }
    run_report_path = run_dir / "run-report.json"
    run_report_path.write_text(
        json.dumps(aggregate, indent=2, sort_keys=True), encoding="utf-8"
    )
    upload_task_artifact(
        run_id,
        "run-report.json",
        run_report_path,
        kind="harness_result",
        content_type="application/json; charset=utf-8",
    )
    post_results_summary(run_id, results, aggregate)
    print(json.dumps(aggregate, indent=2, sort_keys=True))
    return 0


def task_artifact_url(run_id: str, rel_path: str) -> str:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("object artifact mode requires WORKFLOW_BUILDER_URL")
    encoded = quote(rel_path.strip("/"), safe="/")
    return f"{base}/api/internal/benchmarks/runs/{run_id}/artifacts/{encoded}"


def download_task_artifact(
    run_id: str, rel_path: str, destination: pathlib.Path, *, required: bool = True
) -> bool:
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not token:
        raise RuntimeError("object artifact mode requires INTERNAL_API_TOKEN")
    response = requests.get(
        task_artifact_url(run_id, rel_path),
        headers={"X-Internal-Token": token},
        timeout=120,
    )
    if response.status_code == 404 and not required:
        return False
    response.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(response.content)
    return True


def upload_task_artifact(
    run_id: str,
    rel_path: str,
    source: pathlib.Path,
    *,
    kind: str | None = None,
    instance_id: str | None = None,
    content_type: str = "application/octet-stream",
) -> None:
    object_mode = os.environ.get("ARTIFACT_MODE", "").lower() in {
        "object",
        "object-api",
        "api",
        "blob",
    }
    if not object_mode or not source.exists():
        return
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not token:
        raise RuntimeError("object artifact mode requires INTERNAL_API_TOKEN")
    headers = {"X-Internal-Token": token, "Content-Type": content_type}
    if kind:
        headers["X-Benchmark-Artifact-Kind"] = kind
    if instance_id:
        headers["X-Benchmark-Instance-Id"] = instance_id
    response = requests.put(
        task_artifact_url(run_id, rel_path),
        headers=headers,
        data=source.read_bytes(),
        timeout=120,
    )
    response.raise_for_status()


def write_instance_report(
    run_id: str, instance_id: str, inst_dir: pathlib.Path, report: dict[str, Any]
) -> None:
    report_path = inst_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    upload_task_artifact(
        run_id,
        f"{instance_id}/report.json",
        report_path,
        kind="harness_result",
        instance_id=instance_id,
        content_type="application/json; charset=utf-8",
    )


def record_finalize_error(
    run_id: str,
    results: list[dict[str, Any]],
    summary: dict[str, int],
    instance_id: str,
    inst_dir: pathlib.Path,
    error: str,
) -> None:
    inst_dir.mkdir(parents=True, exist_ok=True)
    results.append(
        {
            "instance_id": instance_id,
            "resolved": False,
            "status": "error",
            "error": error,
            "logs_path": str(inst_dir),
        }
    )
    summary["error"] += 1
    write_instance_report(
        run_id,
        instance_id,
        inst_dir,
        {
            instance_id: {
                "resolved": False,
                "error": error,
                "patch_successfully_applied": False,
            }
        },
    )


def terminal_harness_report(
    instance_id: str, inst_dir: pathlib.Path, status: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    report_path = inst_dir / "report.json"
    if report_path.exists():
        try:
            existing = json.loads(report_path.read_text(encoding="utf-8"))
            inst_report = existing.get(instance_id) if isinstance(existing, dict) else None
            if not isinstance(inst_report, dict) and isinstance(existing, dict):
                first = next(iter(existing.values()), None)
                inst_report = first if isinstance(first, dict) else None
            if isinstance(inst_report, dict):
                return existing, inst_report
        except Exception as exc:
            print(
                f"[finalize] ignoring invalid report.json for {instance_id}: {exc}",
                file=sys.stderr,
            )

    messages = {
        "empty_patch": "model produced an empty patch",
        "patch_failed": "model patch failed to apply before tests could run",
        "eval_failed": "evaluation failed before grading completed",
    }
    patch_applied = False if status in {"empty_patch", "patch_failed"} else None
    inst_report = {
        "resolved": False,
        "status": status,
        "message": messages.get(status, status),
        "patch_is_None": status == "empty_patch",
        "patch_exists": status != "empty_patch",
        "patch_successfully_applied": patch_applied,
    }
    return {instance_id: inst_report}, inst_report


def post_results_summary(
    run_id: str, results: list[dict[str, Any]], summary: dict[str, Any]
) -> None:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not base or not token:
        print("WORKFLOW_BUILDER_URL or INTERNAL_API_TOKEN missing - skipping POST")
        return
    response = requests.post(
        f"{base}/api/internal/benchmarks/runs/{run_id}/evaluation-results",
        headers={"X-Internal-Token": token, "Content-Type": "application/json"},
        json={"results": results, "summary": summary},
        timeout=120,
    )
    try:
        response.raise_for_status()
        print(f"posted {len(results)} results to BFF (status={response.status_code})")
    except Exception as exc:
        print(
            f"BFF POST failed (status={response.status_code}): {exc}; "
            f"body={response.text[:400]}",
            file=sys.stderr,
        )


def bounded_int_env(name: str, *, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return min(maximum, max(minimum, value))


def dispatch_run_instance_taskruns(
    *,
    api: Any,
    namespace: str,
    pvc_name: str,
    artifact_mode: str,
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
    pending = list(instance_ids)
    active: dict[str, dict[str, str | None]] = {}
    launched = 0
    deadline_at = time.monotonic() + max(1, deadline_seconds)

    def launch_next() -> bool:
        nonlocal launched
        if not pending:
            return False
        iid = pending.pop(0)
        holder_id = acquire_evaluator_slot(run_id, iid)
        if holder_id is None and benchmark_leases_url(run_id):
            pending.insert(0, iid)
            return False
        name = taskrun_name(run_id, "run", iid)
        try:
            body = build_run_instance_taskrun(
                name=name,
                namespace=namespace,
                pvc_name=pvc_name,
                artifact_mode=artifact_mode,
                run_id=run_id,
                instance_id=iid,
                instance_image=image_map[iid],
                timeout_seconds=timeout_seconds,
            )
            create_taskrun(api, namespace, body)
        except Exception:
            release_evaluator_slot(run_id, iid, holder_id, "TaskRun create failed")
            raise
        active[name] = {"instance_id": iid, "holder_id": holder_id}
        launched += 1
        print(
            "[swebench-evaluator] dispatched run-instance TaskRun "
            f"{launched} of {total} (active={len(active)}, max_parallel={max_parallel})"
        )
        return True

    while pending or active:
        while pending and len(active) < max_parallel:
            if not launch_next():
                break

        if not active:
            time.sleep(
                bounded_int_env(
                    "SWEBENCH_EVALUATOR_LEASE_RETRY_SECONDS",
                    default=10,
                    minimum=1,
                    maximum=300,
                )
            )
            continue

        try:
            name, taskrun = wait_for_next_taskrun(
                api,
                namespace,
                list(active),
                deadline_at=deadline_at,
            )
        except TimeoutError:
            print(
                "[swebench-evaluator] run-instance dispatch deadline reached; "
                f"recording {len(active)} active TaskRuns and stopping launch"
            )
            for name, meta in list(active.items()):
                final[name] = api.get_namespaced_custom_object(
                    group=TEKTON_GROUP,
                    version=TEKTON_VERSION,
                    namespace=namespace,
                    plural=TASKRUN_PLURAL,
                    name=name,
                )
                release_evaluator_slot(
                    run_id,
                    str(meta["instance_id"]),
                    meta.get("holder_id"),
                    "run-instance TaskRun deadline reached",
                )
                del active[name]
            break

        meta = active.pop(name)
        final[name] = taskrun
        release_evaluator_slot(
            run_id,
            str(meta["instance_id"]),
            meta.get("holder_id"),
            "run-instance TaskRun completed",
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


def artifact_api_url(run_id: str, artifact_path: str) -> str | None:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    if not base:
        return None
    encoded_path = quote(artifact_path.strip("/"), safe="/")
    return f"{base}/api/internal/benchmarks/runs/{run_id}/artifacts/{encoded_path}"


def artifact_api_headers(content_type: str | None = None) -> dict[str, str]:
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    headers = {"X-Internal-Token": token}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def download_bff_artifact(run_id: str, artifact_path: str, destination: pathlib.Path) -> bool:
    url = artifact_api_url(run_id, artifact_path)
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not url or not token:
        return False
    response = requests.get(url, headers=artifact_api_headers(), timeout=120)
    if response.status_code == 404:
        return False
    response.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(response.content)
    return True


def materialize_reports_from_bff(
    run_id: str, instance_ids: list[str], artifacts_root: pathlib.Path
) -> None:
    run_dir = artifacts_root / run_id
    for iid in instance_ids:
        download_bff_artifact(run_id, f"{iid}/report.json", run_dir / iid / "report.json")
    download_bff_artifact(run_id, "run-report.json", run_dir / "run-report.json")


def benchmark_leases_url(run_id: str) -> str | None:
    base = os.environ.get("WORKFLOW_BUILDER_URL", "").rstrip("/")
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not base or not token:
        return None
    return f"{base}/api/internal/benchmarks/runs/{run_id}/leases"


def acquire_evaluator_slot(run_id: str, instance_id: str) -> str | None:
    url = benchmark_leases_url(run_id)
    if not url:
        return None
    retry_default = bounded_int_env(
        "SWEBENCH_EVALUATOR_LEASE_RETRY_SECONDS", default=10, minimum=1, maximum=300
    )
    response = requests.post(
        url,
        headers=artifact_api_headers("application/json"),
        json={
            "action": "acquire",
            "instanceId": instance_id,
            "phase": "evaluation",
            "resources": ["evaluator_slot"],
            "metadata": {"source": "swebench-evaluator"},
        },
        timeout=60,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("admitted"):
        holder_id = payload.get("holderId")
        return holder_id if isinstance(holder_id, str) else None
    retry_after = payload.get("retryAfterSeconds")
    try:
        delay = max(1, int(retry_after or retry_default))
    except (TypeError, ValueError):
        delay = retry_default
    print(
        "[swebench-evaluator] evaluator_slot blocked for "
        f"{instance_id}; will retry after active TaskRuns are polled or in {delay}s"
    )
    return None


def release_evaluator_slot(
    run_id: str, instance_id: str, holder_id: str | None, reason: str
) -> None:
    url = benchmark_leases_url(run_id)
    if not url:
        return
    try:
        response = requests.post(
            url,
            headers=artifact_api_headers("application/json"),
            json={
                "action": "release",
                "instanceId": instance_id,
                "holderId": holder_id,
                "phase": "evaluation",
                "resources": ["evaluator_slot"],
                "reason": reason,
            },
            timeout=60,
        )
        response.raise_for_status()
    except Exception as exc:
        print(
            f"[swebench-evaluator] best-effort evaluator_slot release failed for {instance_id}: {exc}",
            file=sys.stderr,
        )


def taskrun_name(run_id: str, phase: str, instance_id: str | None = None) -> str:
    safe_run = (
        "".join(ch.lower() if ch.isalnum() else "-" for ch in run_id).strip("-")[:30]
        or "run"
    )
    if instance_id:
        safe_inst = "".join(
            ch.lower() if ch.isalnum() else "-" for ch in instance_id
        ).strip("-")
        return safe_kubernetes_name(
            f"swebench-{phase}-{safe_run}-{safe_inst}",
            unique_key=f"{run_id}:{phase}:{instance_id}",
        )
    suffix = format(int(time.time() * 100) % 100000, "05d")
    return safe_kubernetes_name(
        f"swebench-{phase}-{safe_run}-{suffix}",
        unique_key=f"{run_id}:{phase}:{suffix}",
    )


def safe_kubernetes_name(base: str, *, unique_key: str, max_length: int = 63) -> str:
    safe_base = "".join(ch.lower() if ch.isalnum() else "-" for ch in base).strip("-")
    if not safe_base:
        safe_base = "tr"
    if len(safe_base) <= max_length:
        return safe_base
    digest = hashlib.sha256(unique_key.encode("utf-8")).hexdigest()[:10]
    prefix_length = max_length - len(digest) - 1
    return f"{safe_base[:prefix_length].rstrip('-')}-{digest}" or digest


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


def _taskrun_artifacts_workspace(pvc_name: str, artifact_mode: str) -> dict[str, Any]:
    if artifact_mode == "object":
        return {"name": "artifacts", "emptyDir": {}}
    return _artifacts_workspace(pvc_name)


def taskrun_execution_spec() -> dict[str, Any]:
    spec: dict[str, Any] = {}
    service_account = os.environ.get("SWEBENCH_TEKTON_SERVICE_ACCOUNT", "").strip()
    if service_account:
        spec["serviceAccountName"] = service_account

    pod_template: dict[str, Any] = {}

    raw_pull_secrets = os.environ.get(
        "SWEBENCH_TEKTON_IMAGE_PULL_SECRETS",
        DEFAULT_TEKTON_IMAGE_PULL_SECRETS,
    )
    pull_secret_names = [
        name.strip() for name in raw_pull_secrets.split(",") if name.strip()
    ]
    if pull_secret_names:
        pod_template["imagePullSecrets"] = [
            {"name": name} for name in pull_secret_names
        ]

    # Kueue admission control for the eval TaskRun pods. run-instance runs a
    # full pytest suite inside a multi-GB image up to SWEBENCH_EVAL_MAX_PARALLEL
    # concurrently; without admission gating those can OOM nodes. Kueue's pod
    # integration manages any pod carrying the queue-name label — the same
    # mechanism agent-host sandbox pods use (sandbox-execution-api
    # KUEUE_QUEUE_LABEL / build_agent_workflow_host_sandbox_manifest).
    kueue_queue = os.environ.get("SWEBENCH_TEKTON_KUEUE_QUEUE_NAME", "").strip()
    if kueue_queue:
        kueue_labels = {"kueue.x-k8s.io/queue-name": kueue_queue}
        kueue_priority = os.environ.get(
            "SWEBENCH_TEKTON_KUEUE_PRIORITY_CLASS", ""
        ).strip()
        if kueue_priority:
            kueue_labels["kueue.x-k8s.io/priority-class"] = kueue_priority
        pod_template["metadata"] = {"labels": kueue_labels}

    if pod_template:
        spec["podTemplate"] = pod_template
    return spec


def build_prepare_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    artifact_mode: str,
    run_id: str,
    predictions_path: str,
    instance_ids: list[str],
    swebench_package_ref: str,
    workflow_builder_url: str,
) -> dict[str, Any]:
    params: list[dict[str, Any]] = [
        {"name": "run_id", "value": run_id},
        {"name": "predictions_path", "value": predictions_path},
        {"name": "instance_ids", "value": list(instance_ids)},
        {"name": "swebench_package_ref", "value": swebench_package_ref},
        {"name": "artifact_mode", "value": artifact_mode},
    ]
    if workflow_builder_url:
        params.append({"name": "workflow_builder_url", "value": workflow_builder_url})
    return {
        "apiVersion": f"{TEKTON_GROUP}/{TEKTON_VERSION}",
        "kind": "TaskRun",
        "metadata": _common_metadata(name, namespace, run_id, "prepare"),
        "spec": {
            **taskrun_execution_spec(),
            "taskSpec": {
                "params": [
                    {"name": "run_id", "type": "string"},
                    {"name": "predictions_path", "type": "string"},
                    {"name": "instance_ids", "type": "array"},
                    {
                        "name": "swebench_package_ref",
                        "type": "string",
                        "default": "git+https://github.com/PittampalliOrg/SWE-bench.git@main",
                    },
                    {"name": "artifact_mode", "type": "string", "default": "pvc"},
                    {"name": "workflow_builder_url", "type": "string", "default": ""},
                    {
                        "name": "internal_api_secret_name",
                        "type": "string",
                        "default": "workflow-builder-secrets",
                    },
                    {
                        "name": "internal_api_secret_key",
                        "type": "string",
                        "default": "INTERNAL_API_TOKEN",
                    },
                ],
                "steps": [
                    {
                        "name": "validate-and-fanout",
                        "image": evaluator_task_image(),
                        "args": ["--prepare-task", "$(params.instance_ids[*])"],
                        "computeResources": {
                            "requests": {"cpu": "250m", "memory": "256Mi"},
                            "limits": {"cpu": "1", "memory": "2Gi"},
                        },
                        "env": [
                            {
                                "name": "PREDICTIONS_PATH",
                                "value": "$(params.predictions_path)",
                            },
                            {"name": "RUN_ID", "value": "$(params.run_id)"},
                            {
                                "name": "ARTIFACT_MODE",
                                "value": "$(params.artifact_mode)",
                            },
                            {
                                "name": "WORKFLOW_BUILDER_URL",
                                "value": "$(params.workflow_builder_url)",
                            },
                            {
                                "name": "INTERNAL_API_TOKEN",
                                "valueFrom": {
                                    "secretKeyRef": {
                                        "name": "$(params.internal_api_secret_name)",
                                        "key": "$(params.internal_api_secret_key)",
                                    }
                                },
                            },
                        ],
                    }
                ],
                "workspaces": [{"name": "artifacts"}],
            },
            "params": params,
            "workspaces": [_taskrun_artifacts_workspace(pvc_name, artifact_mode)],
            "timeout": "10m",
        },
    }


def build_run_instance_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    artifact_mode: str,
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
                {"name": "artifact_mode", "value": artifact_mode},
                {
                    "name": "workflow_builder_url",
                    "value": os.environ.get("WORKFLOW_BUILDER_URL", ""),
                },
            ],
            "workspaces": [_taskrun_artifacts_workspace(pvc_name, artifact_mode)],
            "timeout": f"{max(timeout_seconds + 300, 1800)}s",
        },
    }


def build_finalize_taskrun(
    *,
    name: str,
    namespace: str,
    pvc_name: str,
    artifact_mode: str,
    run_id: str,
    instance_ids: list[str],
    swebench_package_ref: str,
    workflow_builder_url: str,
) -> dict[str, Any]:
    params: list[dict[str, Any]] = [
        {"name": "run_id", "value": run_id},
        {"name": "instance_ids", "value": list(instance_ids)},
        {"name": "swebench_package_ref", "value": swebench_package_ref},
        {"name": "artifact_mode", "value": artifact_mode},
    ]
    if workflow_builder_url:
        params.append({"name": "workflow_builder_url", "value": workflow_builder_url})
    return {
        "apiVersion": f"{TEKTON_GROUP}/{TEKTON_VERSION}",
        "kind": "TaskRun",
        "metadata": _common_metadata(name, namespace, run_id, "finalize"),
        "spec": {
            **taskrun_execution_spec(),
            "taskSpec": {
                "params": [
                    {"name": "run_id", "type": "string"},
                    {"name": "instance_ids", "type": "array"},
                    {"name": "workflow_builder_url", "type": "string", "default": ""},
                    {
                        "name": "internal_api_secret_name",
                        "type": "string",
                        "default": "workflow-builder-secrets",
                    },
                    {
                        "name": "internal_api_secret_key",
                        "type": "string",
                        "default": "INTERNAL_API_TOKEN",
                    },
                    {
                        "name": "swebench_package_ref",
                        "type": "string",
                        "default": "git+https://github.com/PittampalliOrg/SWE-bench.git@main",
                    },
                    {"name": "artifact_mode", "type": "string", "default": "pvc"},
                ],
                "steps": [
                    {
                        "name": "grade-and-post",
                        "image": evaluator_task_image(),
                        "args": ["--finalize-task", "$(params.instance_ids[*])"],
                        "computeResources": {
                            "requests": {"cpu": "250m", "memory": "256Mi"},
                            "limits": {"cpu": "1", "memory": "2Gi"},
                        },
                        "env": [
                            {"name": "RUN_ID", "value": "$(params.run_id)"},
                            {
                                "name": "WORKFLOW_BUILDER_URL",
                                "value": "$(params.workflow_builder_url)",
                            },
                            {
                                "name": "INTERNAL_API_TOKEN",
                                "valueFrom": {
                                    "secretKeyRef": {
                                        "name": "$(params.internal_api_secret_name)",
                                        "key": "$(params.internal_api_secret_key)",
                                    }
                                },
                            },
                            {
                                "name": "ARTIFACT_MODE",
                                "value": "$(params.artifact_mode)",
                            },
                        ],
                    }
                ],
                "workspaces": [{"name": "artifacts"}],
            },
            "params": params,
            "workspaces": [_taskrun_artifacts_workspace(pvc_name, artifact_mode)],
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


def wait_for_next_taskrun(
    api,
    namespace: str,
    names: list[str],
    *,
    deadline_at: float,
) -> tuple[str, dict[str, Any]]:
    poll_interval = max(2, int(os.environ.get("SWEBENCH_POLL_INTERVAL_SECONDS", "10")))
    while names and time.monotonic() < deadline_at:
        for name in names:
            tr = api.get_namespaced_custom_object(
                group=TEKTON_GROUP,
                version=TEKTON_VERSION,
                namespace=namespace,
                plural=TASKRUN_PLURAL,
                name=name,
            )
            cond = succeeded_condition(tr)
            if cond and cond.get("status") in {"True", "False"}:
                return name, tr
        time.sleep(min(poll_interval, max(0.1, deadline_at - time.monotonic())))
    raise TimeoutError("Timed out waiting for the next SWE-bench run-instance TaskRun")


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
    attempts = bounded_int_env("SWEBENCH_BFF_MAX_RETRIES", default=6, minimum=1, maximum=20)
    delay_seconds = bounded_float_env(
        "SWEBENCH_BFF_RETRY_DELAY_SECONDS", default=10.0, minimum=0.1, maximum=120.0
    )
    url = f"{base}/api/internal/benchmarks/runs/{run_id}/evaluation-results"
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.post(
                url,
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
                json=body,
                timeout=60,
            )
            response.raise_for_status()
            return
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts:
                break
            print(
                f"[swebench-evaluator] BFF result POST failed on attempt {attempt}/{attempts}; retrying in {delay_seconds:.1f}s: {exc}",
                file=sys.stderr,
            )
            time.sleep(delay_seconds)
    raise last_exc or RuntimeError("BFF result POST failed")


def bounded_float_env(
    name: str, *, default: float, minimum: float, maximum: float
) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return min(maximum, max(minimum, value))


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _emit_crash_terminal_results(exc: BaseException) -> None:
    """Last-resort durability: persist *why* the evaluator died.

    main() has several paths that exit non-zero without ever calling
    post_results() — most notably dispatch_run_instance_taskruns ->
    _wait_for_next_completion raising TimeoutError, and any unhandled error
    before the finalize TaskRun POSTs. When that happens the benchmark run
    fails with only the coordinator's generic "Job has reached the specified
    backoff limit" and no provenance/harness artifacts, because backoff_limit=0
    gives no retry, the coordinator does not capture this pod's logs, and the
    Job/TaskRuns are TTL/cron-deleted within ~15-60 min. Always post a terminal
    failure callback carrying the real reason so it lands durably in
    benchmark_run_instances.evaluation_error.
    """
    import traceback

    traceback.print_exc()
    run_id = os.environ.get("RUN_ID", "").strip()
    instance_ids = [s for s in os.environ.get("INSTANCE_IDS", "").split() if s]
    if not run_id or not instance_ids:
        return
    artifacts_root = pathlib.Path(
        os.environ.get("SWEBENCH_ARTIFACT_ROOT", "/artifacts")
    )
    log_dir = artifacts_root / run_id / "harness"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    error = (
        f"swebench-evaluator crashed: {type(exc).__name__}: {exc}\n"
        + traceback.format_exc()
    )[:1800]
    _post_terminal_results(
        run_id,
        instance_ids,
        artifacts_root,
        log_dir,
        error=error,
        succeeded=False,
    )


if __name__ == "__main__":
    # The --prepare-task / --finalize-task subcommands run inside Tekton
    # TaskRuns; their failures are already surfaced to the orchestrator via
    # taskrun_failure_reason(). Only the orchestrator pod's silent death
    # destroys all evidence, so scope the rescue callback to that mode.
    _is_subcommand = len(sys.argv) > 1 and sys.argv[1] in {
        "--prepare-task",
        "--finalize-task",
    }
    try:
        _exit_code = main()
    except SystemExit:
        raise
    except BaseException as _exc:  # noqa: BLE001 - last-resort durability
        print(
            f"[swebench-evaluator] fatal: {type(_exc).__name__}: {_exc}",
            file=sys.stderr,
        )
        if not _is_subcommand:
            try:
                _emit_crash_terminal_results(_exc)
            except Exception as _post_exc:  # noqa: BLE001
                print(
                    "[swebench-evaluator] failed to post terminal failure "
                    f"callback: {_post_exc}",
                    file=sys.stderr,
                )
        raise SystemExit(1)
    raise SystemExit(_exit_code)
