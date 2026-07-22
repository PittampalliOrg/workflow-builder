"""Deterministic LIFECYCLE workflow for the `interactive-cli` runtime family.

For direct UI sessions, the user drives the CLI TUI through the web terminal and
the workflow wraps the session lifecycle. For SW 1.0 ``durable/run`` sessions,
the BFF sets ``autoTerminateAfterEndTurn=true`` and provides the kickoff prompt;
this workflow starts the same CLI, waits for the adapter hook that emits
``turn.completed``, then cooperatively closes the pane and returns the standard
durable/run result contract.

History is bounded via ``ctx.continue_as_new`` every ~CLI_LIFECYCLE_MAX_ITERATIONS
when_any cycles, carrying {turnCount, lastAssistantText, paneRef, seeded: true}.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from collections import Counter
from datetime import timedelta
from pathlib import Path
from typing import Any, Generator, Mapping

from dapr.ext.workflow import DaprWorkflowContext, RetryPolicy, when_any as wf_when_any

from src.cancellation import TERMINAL_CONTROL_EVENT_TYPES, check_cancellation_activity
from src.browser_video_sync import sync_browser_video_activity
from src.workspace_diff_sync import sync_workspace_diff_activity
from src.workspace_diff_sync import sync_source_bundle_activity
from src.cli_batch import cli_batch_enabled, run_cli_once_activity
from src.cli_lifecycle import probe_cli_activity, start_cli_activity, stop_cli_activity
from src.event_publisher import publish_session_event
from src.output_sync import sync_output_activity
from src.runtime_start_authority import authorize_session_runtime_start
from src.seed import seed_session_activity
from src.taskhub import LIFECYCLE_EVENT_NAME

logger = logging.getLogger(__name__)

_START_AUTHORITY_PENDING_DELAYS_SECONDS = (1, 2, 4, 8, 15, 30) + (60,) * 14

# Idle-probe interval. Doubles as the cooperative-cancel backstop: each tick
# checks the session-cancel flag (persisted by the raise-event endpoint on a
# terminal control event) and the live CLI state, so a terminate that was missed
# or buffered mid-turn still ends the session within this window. Kept modest
# (was 600s) so goal-complete termination is responsive even on the backstop path.
CLI_IDLE_PROBE_SECONDS = int(os.environ.get("CLI_IDLE_PROBE_SECONDS", "120"))
CLI_LIFECYCLE_MAX_ITERATIONS = int(os.environ.get("CLI_LIFECYCLE_MAX_ITERATIONS", "50"))
# Durable-timer ceilings for the post-loop cleanup activities. Every blocking
# await in the cleanup phase is bounded by a timer (Dapr best practice) so a
# hung activity (e.g. a finished TUI's dead herdr socket) can never wedge the
# parent durable/run — the workflow abandons the activity and returns.
CLI_STOP_TIMEOUT_SECONDS = int(os.environ.get("CLI_STOP_TIMEOUT_SECONDS", "120"))
CLI_OUTPUT_SYNC_TIMEOUT_SECONDS = int(
    os.environ.get("CLI_OUTPUT_SYNC_TIMEOUT_SECONDS", "900")
)
CLI_BROWSER_VIDEO_SYNC_TIMEOUT_SECONDS = int(
    os.environ.get("CLI_BROWSER_VIDEO_SYNC_TIMEOUT_SECONDS", "180")
)
CLI_WORKSPACE_DIFF_SYNC_TIMEOUT_SECONDS = int(
    os.environ.get("CLI_WORKSPACE_DIFF_SYNC_TIMEOUT_SECONDS", "180")
)
CLI_PATCH_TIMEOUT_SECONDS = int(os.environ.get("CLI_PATCH_TIMEOUT_SECONDS", "300"))
_SWEBENCH_PATCH_EXCLUDE_PATHS = (
    ":(exclude)**/tests/**",
    ":(exclude)tests/**",
    ":(exclude)test/**",
    ":(exclude)testing/**",
    ":(exclude)**/test_*.py",
    ":(exclude)**/*_test.py",
    ":(exclude)**/conftest.py",
    ":(exclude)**/fixtures/**",
)

_SEED_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=3,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)
_START_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=2,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)

# Stable module-level sentinel (deterministic across replays) returned by
# _yield_bounded when the durable timer wins (the activity is abandoned).
_ACTIVITY_TIMED_OUT = object()


def _yield_bounded(ctx, activity, *, input, timeout_seconds, retry_policy=None):
    """Run an activity bounded by a durable timer so a hung activity can't block
    the orchestration forever. Returns the activity result, or _ACTIVITY_TIMED_OUT
    if the timer fired first. Use via ``r = yield from _yield_bounded(...)``."""
    act = (
        ctx.call_activity(activity, input=input, retry_policy=retry_policy)
        if retry_policy is not None
        else ctx.call_activity(activity, input=input)
    )
    timer = ctx.create_timer(timedelta(seconds=timeout_seconds))
    winner = yield wf_when_any([act, timer])
    if winner is act:
        return act.get_result()
    return _ACTIVITY_TIMED_OUT


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _session_id(input_data: Mapping[str, Any]) -> str | None:
    return _clean_string(input_data.get("sessionId"))


def _extract_seed_user_message(input_data: Mapping[str, Any]) -> str | None:
    """The kickoff prompt — the first ``user.message`` the BFF stamps into
    ``childInput.initialEvents`` at session create (mirrors claude-agent-py).
    Falls back to the ``x-workflow-builder.input`` block for canvas-launched
    runs. Returned to start_cli, which arms the readiness-gated injection."""
    initial_events = input_data.get("initialEvents")
    if isinstance(initial_events, list):
        for event in initial_events:
            if not isinstance(event, Mapping) or event.get("type") != "user.message":
                continue
            content = event.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, str) and item.strip():
                        parts.append(item.strip())
                    elif isinstance(item, Mapping):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                if parts:
                    return "\n".join(parts)
    with_block = _record(input_data.get("with"))
    wb = _record(with_block.get("x-workflow-builder"))
    return _clean_string(wb.get("input"))


def _agent_runtime(input_data: Mapping[str, Any]) -> str:
    agent_config = _record(input_data.get("agentConfig"))
    for value in (
        input_data.get("agentRuntime"),
        input_data.get("runtime"),
        agent_config.get("runtime"),
        agent_config.get("agentRuntime"),
    ):
        picked = _clean_string(value)
        if picked:
            return picked
    adapter = _clean_string(agent_config.get("cliAdapter"))
    if adapter == "codex":
        return "codex-cli"
    if adapter == "antigravity":
        return "agy-cli"
    return "claude-code-cli"


def _scope_label(value: Any) -> str | None:
    if value is None:
        return None
    enum_name = getattr(value, "name", None)
    if isinstance(enum_name, str) and enum_name.strip():
        return _scope_label(enum_name)
    text = str(value).strip()
    if not text:
        return None
    compact = text.replace("_", "").replace("-", "").replace(" ", "").lower()
    if compact == "none":
        return "none"
    if compact == "ownhistory":
        return "ownHistory"
    if compact == "lineage":
        return "lineage"
    return text


def _requested_history_scope(input_data: Mapping[str, Any]) -> str:
    propagation = _record(input_data.get("workflowHistoryPropagation"))
    return (
        _scope_label(
            propagation.get("requestedScope")
            or propagation.get("scope")
            or input_data.get("historyPropagation")
        )
        or "none"
    )


_HISTORY_EVENT_FIELDS = (
    "executionStarted",
    "executionCompleted",
    "executionTerminated",
    "executionSuspended",
    "executionResumed",
    "executionStalled",
    "orchestratorStarted",
    "orchestratorCompleted",
    "taskScheduled",
    "taskCompleted",
    "taskFailed",
    "timerCreated",
    "timerFired",
    "eventSent",
    "eventRaised",
    "childWorkflowInstanceCreated",
    "childWorkflowInstanceCompleted",
    "childWorkflowInstanceFailed",
    "subOrchestrationInstanceCreated",
    "subOrchestrationInstanceCompleted",
    "subOrchestrationInstanceFailed",
    "continueAsNew",
)


def _propagated_history_events(history: Any) -> list[Any]:
    events = getattr(history, "events", None)
    if events is None:
        return []
    if isinstance(events, list):
        return events
    try:
        return list(events)
    except TypeError:
        return []


def _history_event_type(event: Any) -> str:
    if isinstance(event, Mapping):
        for key in ("eventType", "type", "kind"):
            value = _clean_string(event.get(key))
            if value:
                return value

    which_oneof = getattr(event, "WhichOneof", None)
    if callable(which_oneof):
        for group_name in ("eventType", "event_type"):
            try:
                selected = _clean_string(which_oneof(group_name))
            except Exception:
                selected = None
            if selected:
                return selected

    has_field = getattr(event, "HasField", None)
    if callable(has_field):
        for field_name in _HISTORY_EVENT_FIELDS:
            try:
                if has_field(field_name):
                    return field_name
            except Exception:
                continue

    for field_name in _HISTORY_EVENT_FIELDS:
        value = getattr(event, field_name, None)
        if value:
            return field_name

    return event.__class__.__name__


def _workflow_history_provenance(
    ctx: DaprWorkflowContext,
    input_data: Mapping[str, Any],
    agent_runtime: str,
) -> dict[str, Any]:
    requested_scope = _requested_history_scope(input_data)
    history = None
    get_history = getattr(ctx, "get_propagated_history", None)
    if callable(get_history):
        try:
            history = get_history()
        except Exception:
            history = None

    events = _propagated_history_events(history)
    event_type_counts = Counter(_history_event_type(event) for event in events)
    metadata = _record(input_data.get("_message_metadata"))
    return {
        "workflowHistoryPropagation": {
            "scope": _scope_label(getattr(history, "scope", None)) or requested_scope,
            "available": bool(events),
            "eventCount": len(events),
            "eventTypeCounts": dict(sorted(event_type_counts.items())),
        },
        "workflowContext": {
            "workflowId": input_data.get("workflowId") or metadata.get("workflowId"),
            "workflowExecutionId": input_data.get("workflowExecutionId")
            or input_data.get("dbExecutionId")
            or input_data.get("executionId")
            or metadata.get("workflowExecutionId")
            or metadata.get("executionId"),
            "nodeId": input_data.get("nodeId") or metadata.get("nodeId"),
            "agentRuntime": agent_runtime,
        },
    }


def _event_batch(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, Mapping):
        events = payload.get("events")
        if isinstance(events, list):
            return [dict(event) for event in events if isinstance(event, Mapping)]
        return [dict(payload)]
    return []


def _swebench_environment(input_data: Mapping[str, Any]) -> dict[str, Any]:
    environment_config = _record(input_data.get("environmentConfig"))
    swebench = _record(environment_config.get("swebenchInferenceEnvironment"))
    if swebench:
        return swebench
    return _record(input_data.get("swebenchInferenceEnvironment"))


def _swebench_patch_request(input_data: Mapping[str, Any]) -> dict[str, Any] | None:
    environment = _swebench_environment(input_data)
    base_commit = _clean_string(environment.get("baseCommit"))
    if not base_commit:
        return None
    workspace_root = (
        _clean_string(environment.get("workspaceRoot"))
        or _clean_string(input_data.get("cwd"))
        or "/sandbox/repo"
    )
    return {
        "baseCommit": base_commit,
        "workspaceRoot": workspace_root,
        "excludePaths": list(_SWEBENCH_PATCH_EXCLUDE_PATHS),
    }


def _swebench_workspace_request(input_data: Mapping[str, Any]) -> dict[str, Any] | None:
    environment = _swebench_environment(input_data)
    repo = _clean_string(environment.get("repo"))
    base_commit = _clean_string(environment.get("baseCommit"))
    if not repo or not base_commit:
        return None
    workspace_root = (
        _clean_string(environment.get("workspaceRoot"))
        or _clean_string(input_data.get("cwd"))
        or "/sandbox/repo"
    )
    return {
        "repo": repo,
        "baseCommit": base_commit,
        "workspaceRoot": workspace_root,
    }


def _workspace_under_local_root(
    workspace_root: str,
) -> tuple[Path, Path] | dict[str, Any]:
    repo = Path(workspace_root).resolve()
    local_root = Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")).resolve()
    try:
        repo.relative_to(local_root)
    except ValueError:
        return {
            "ok": False,
            "error": f"workspaceRoot must be under {local_root}: {workspace_root}",
        }
    return repo, local_root


def _swebench_repo_url(repo_slug: str) -> str:
    template = os.environ.get(
        "CLI_SWEBENCH_REPO_URL_TEMPLATE", "https://github.com/{repo}.git"
    )
    return template.format(repo=repo_slug)


def _run_command(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 300,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(args)} failed with exit {result.returncode}: "
            f"{(result.stderr or result.stdout)[-2000:]}"
        )
    return result


def prepare_swebench_workspace_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Clone the SWE-bench repo into the CLI-owned sandbox before the TUI starts.

    The parent workflow's OpenShell workspace is a separate pod/volume from the
    CLI agent-host pod. This activity makes the CLI-owned `/sandbox/repo` match
    the prompt contract without doing filesystem or network work in workflow
    replay code.
    """
    payload = input_data if input_data is not None else _ctx_or_input
    request = _record(payload)
    repo_slug = _clean_string(request.get("repo"))
    base_commit = _clean_string(request.get("baseCommit"))
    workspace_root = _clean_string(request.get("workspaceRoot")) or "/sandbox/repo"
    if not repo_slug or not base_commit:
        return {"ok": True, "prepared": False, "reason": "missing_repo_or_base_commit"}
    if repo_slug.startswith("-") or ".." in repo_slug.split("/"):
        return {"ok": False, "prepared": False, "error": f"invalid repo: {repo_slug}"}

    resolved = _workspace_under_local_root(workspace_root)
    if isinstance(resolved, dict):
        return {"prepared": False, **resolved}
    repo_path, _local_root = resolved
    repo_url = _swebench_repo_url(repo_slug)
    repo_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        if (repo_path / ".git").exists():
            head = _run_command(
                ["git", "rev-parse", "HEAD"],
                cwd=repo_path,
                timeout=30,
                check=False,
            )
            if head.returncode == 0 and head.stdout.strip() == base_commit:
                _run_command(["git", "reset", "--hard", base_commit], cwd=repo_path)
                _run_command(["git", "clean", "-fdx"], cwd=repo_path)
                return {
                    "ok": True,
                    "prepared": True,
                    "alreadyPresent": True,
                    "workspaceRoot": str(repo_path),
                    "baseCommit": base_commit,
                    "repo": repo_slug,
                }

        tmp_path = repo_path.parent / f".{repo_path.name}.checkout.{os.getpid()}"
        if tmp_path.exists():
            shutil.rmtree(tmp_path)
        if repo_path.exists():
            shutil.rmtree(repo_path)

        tmp_path.mkdir(parents=True, exist_ok=True)
        _run_command(["git", "init", "-q"], cwd=tmp_path)
        _run_command(["git", "remote", "add", "origin", repo_url], cwd=tmp_path)
        fetch = _run_command(
            [
                "git",
                "-c",
                "protocol.version=2",
                "fetch",
                "--depth=1",
                "origin",
                base_commit,
            ],
            cwd=tmp_path,
            timeout=300,
            check=False,
        )
        if fetch.returncode != 0:
            fetch = _run_command(
                ["git", "fetch", "origin", base_commit],
                cwd=tmp_path,
                timeout=600,
                check=False,
            )
        if fetch.returncode != 0:
            raise RuntimeError(
                f"git fetch {base_commit} failed: {(fetch.stderr or fetch.stdout)[-2000:]}"
            )
        _run_command(["git", "checkout", "--force", "FETCH_HEAD"], cwd=tmp_path)
        tmp_path.rename(repo_path)
    except Exception as exc:  # noqa: BLE001
        try:
            if "tmp_path" in locals() and tmp_path.exists():
                shutil.rmtree(tmp_path)
        except Exception:
            pass
        return {
            "ok": False,
            "prepared": False,
            "error": str(exc),
            "workspaceRoot": str(repo_path),
            "baseCommit": base_commit,
            "repo": repo_slug,
        }

    return {
        "ok": True,
        "prepared": True,
        "alreadyPresent": False,
        "workspaceRoot": str(repo_path),
        "baseCommit": base_commit,
        "repo": repo_slug,
    }


def extract_model_patch_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return the authoritative patch from the CLI-owned git workspace.

    This runs as an activity because filesystem and subprocess access are
    nondeterministic and must not happen in the workflow replay function.
    """
    payload = input_data if input_data is not None else _ctx_or_input
    request = _record(payload)
    base_commit = _clean_string(request.get("baseCommit"))
    workspace_root = _clean_string(request.get("workspaceRoot")) or "/sandbox/repo"
    if not base_commit:
        return {"ok": True, "modelPatch": "", "reason": "missing_base_commit"}

    resolved = _workspace_under_local_root(workspace_root)
    if isinstance(resolved, dict):
        return {"modelPatch": "", **resolved}
    repo, _local_root = resolved
    if not repo.exists():
        return {
            "ok": True,
            "modelPatch": "",
            "reason": "workspace_missing",
            "workspaceRoot": str(repo),
        }

    exclude_paths = request.get("excludePaths")
    if not isinstance(exclude_paths, list):
        exclude_paths = list(_SWEBENCH_PATCH_EXCLUDE_PATHS)
    pathspecs = [
        str(path) for path in exclude_paths if isinstance(path, str) and path.strip()
    ]
    diff_cmd = ["git", "diff", "--binary", base_commit, "--", ".", *pathspecs]
    name_cmd = ["git", "diff", "--name-only", base_commit, "--", ".", *pathspecs]
    try:
        diff = subprocess.run(
            diff_cmd,
            cwd=repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        names = subprocess.run(
            name_cmd,
            cwd=repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "modelPatch": "", "error": str(exc)}

    if diff.returncode != 0:
        return {
            "ok": False,
            "modelPatch": "",
            "exitCode": diff.returncode,
            "stderr": diff.stderr[-2000:],
            "workspaceRoot": str(repo),
        }
    model_patch = diff.stdout or ""
    files_touched = [
        line.strip() for line in (names.stdout or "").splitlines() if line.strip()
    ]
    return {
        "ok": True,
        "modelPatch": model_patch,
        "patchBytes": len(model_patch.encode("utf-8")),
        "patchFilesTouched": files_touched,
        "workspaceRoot": str(repo),
    }


def _result_contract(
    *,
    ctx: DaprWorkflowContext,
    session_id: str | None,
    status: str,
    last_assistant_text: str,
    turn_count: int,
    agent_runtime: str,
    provenance: Mapping[str, Any],
    output_sync: Mapping[str, Any] | None = None,
    patch_result: Mapping[str, Any] | None = None,
    structured_output: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "success": status not in ("failed",),
        "status": status,
        "output": last_assistant_text or "",
        "content": last_assistant_text or "",
        "sessionId": session_id,
        "agentRuntime": agent_runtime,
        "childWorkflowName": "session_workflow",
        "daprInstanceId": ctx.instance_id,
        "turnCount": turn_count,
        "provenance": dict(provenance),
    }
    if output_sync is not None:
        result["outputSync"] = dict(output_sync)
    if structured_output is not None:
        result["structuredOutput"] = dict(structured_output)
    if patch_result is not None:
        patch = _record(patch_result)
        result["modelPatch"] = patch.get("modelPatch") or ""
        result["patchBytes"] = patch.get("patchBytes") or 0
        result["patchFilesTouched"] = (
            patch.get("patchFilesTouched")
            if isinstance(patch.get("patchFilesTouched"), list)
            else []
        )
        result["patchExtraction"] = {
            key: value for key, value in patch.items() if key not in {"modelPatch"}
        }
    return result


def _terminal_stop_reason(status: str | None, reason: str | None) -> dict[str, str]:
    if status == "terminated":
        return {"type": "terminated"}
    if status == "failed":
        return {"type": "interrupted"}
    if reason in {"cancel_requested", "session.terminate", "terminate"}:
        return {"type": "terminated"}
    return {"type": "end_turn"}


def session_workflow(
    ctx: DaprWorkflowContext, input_data: dict[str, Any]
) -> Generator[Any, Any, dict[str, Any] | None]:
    session_id = _session_id(input_data)
    # StartInstance may be accepted before the BFF publishes this exact runtime
    # generation. Prove authority before seeding, starting a TUI, or invoking a
    # batch CLI, so a stale generation cannot run alongside its replacement.
    if bool(input_data.get("requiresStartAuthority")):
        for pending_attempt in range(len(_START_AUTHORITY_PENDING_DELAYS_SECONDS) + 1):
            start_authority = yield ctx.call_activity(
                authorize_session_runtime_start,
                input={
                    "sessionId": session_id,
                    "workflowMcpSessionToken": input_data.get(
                        "workflowMcpSessionToken"
                    ),
                    "runtimeAppId": input_data.get("runtimeAppId")
                    or input_data.get("agentAppId"),
                    "runtimeInstanceId": ctx.instance_id,
                },
            )
            if isinstance(start_authority, Mapping) and start_authority.get(
                "authorized"
            ):
                break
            retryable_pending = bool(
                isinstance(start_authority, Mapping)
                and start_authority.get("retryable") is True
                and start_authority.get("code")
                in {"team_pending", "runtime_unpublished"}
            )
            if not retryable_pending or pending_attempt >= len(
                _START_AUTHORITY_PENDING_DELAYS_SECONDS
            ):
                return {
                    "success": False,
                    "cancelled": True,
                    "status": "cancelled",
                    "content": "",
                    "sessionId": session_id,
                    "error": (
                        "session start authority remained pending"
                        if retryable_pending
                        else "session start was not authorized"
                    ),
                }
            yield ctx.create_timer(
                timedelta(
                    seconds=_START_AUTHORITY_PENDING_DELAYS_SECONDS[pending_attempt]
                )
            )
    auto_terminate = bool(input_data.get("autoTerminateAfterEndTurn"))
    agent_runtime = _agent_runtime(input_data)
    provenance = _workflow_history_provenance(ctx, input_data, agent_runtime)
    carried = _record(input_data.get("_carried"))
    carried_provenance = carried.get("provenance")
    if (
        isinstance(carried_provenance, Mapping)
        and not provenance["workflowHistoryPropagation"]["available"]
    ):
        provenance = dict(carried_provenance)
    seeded = bool(carried.get("seeded"))
    turn_count = int(carried.get("turnCount") or 0)
    last_assistant_text = str(carried.get("lastAssistantText") or "")
    last_structured_output = (
        dict(carried.get("structuredOutput"))
        if isinstance(carried.get("structuredOutput"), Mapping)
        else None
    )
    pane_ref = _clean_string(carried.get("paneRef"))
    batch_run = False
    status: str | None = None
    reason: str | None = None

    if not seeded:
        if session_id and not ctx.is_replaying:
            publish_session_event(session_id, "session.status_starting", {})
        seed_result = yield ctx.call_activity(
            seed_session_activity,
            input=dict(input_data),
            retry_policy=_SEED_RETRY_POLICY,
        )
        workspace_request = _swebench_workspace_request(input_data)
        if workspace_request is not None:
            workspace_prepare = yield ctx.call_activity(
                prepare_swebench_workspace_activity,
                input=workspace_request,
                retry_policy=_SEED_RETRY_POLICY,
            )
            if not isinstance(workspace_prepare, Mapping) or not workspace_prepare.get(
                "ok"
            ):
                status = "failed"
                reason = "swebench_workspace_prepare_failed"
                error_text = (
                    _clean_string(
                        _record(workspace_prepare).get("error")
                        if isinstance(workspace_prepare, Mapping)
                        else None
                    )
                    or "SWE-bench workspace preparation failed"
                )
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {
                            "reason": reason,
                            "stop_reason": {"type": "interrupted"},
                            "status": status,
                            "success": False,
                            "turnCount": turn_count,
                            "agentRuntime": agent_runtime,
                            "workflowInstanceId": ctx.instance_id,
                            "error": error_text,
                        },
                    )
                return _result_contract(
                    ctx=ctx,
                    session_id=session_id,
                    status=status,
                    last_assistant_text=error_text,
                    turn_count=turn_count,
                    agent_runtime=agent_runtime,
                    provenance=provenance,
                )
        start_input = {
            "sessionId": session_id,
            "instanceId": ctx.instance_id,
            "agentConfig": _record(input_data.get("agentConfig")),
            "autoTerminateAfterEndTurn": auto_terminate,
            "seed": _record(seed_result),
            "seedUserMessage": _extract_seed_user_message(input_data),
            "workspaceRef": input_data.get("workspaceRef"),
            "sandboxName": input_data.get("sandboxName"),
        }
        if cli_batch_enabled(start_input):
            batch_result = yield ctx.call_activity(
                run_cli_once_activity,
                input=start_input,
            )
            batch_data = _record(batch_result)
            batch_run = True
            status = _clean_string(batch_data.get("status")) or "failed"
            reason = _clean_string(batch_data.get("reason")) or "batch_completed"
            batch_turns = batch_data.get("turnCount")
            if isinstance(batch_turns, int) and not isinstance(batch_turns, bool):
                turn_count += max(0, batch_turns)
            else:
                turn_count += 1
            text = _clean_string(batch_data.get("lastAssistantText"))
            if text:
                last_assistant_text = text
            raw_structured = batch_data.get("structuredOutput")
            if isinstance(raw_structured, Mapping):
                last_structured_output = dict(raw_structured)
            if session_id and not ctx.is_replaying:
                turn_id = f"{ctx.instance_id}:turn:{turn_count}"
                if status == "failed":
                    publish_session_event(
                        session_id,
                        "session.status_errored",
                        {
                            "stop_reason": {
                                "type": "error",
                                "message": last_assistant_text or reason,
                            },
                            "turn": turn_count,
                            "turnId": turn_id,
                            "workflowInstanceId": ctx.instance_id,
                            "agentRuntime": agent_runtime,
                        },
                        source_event_id=f"{turn_id}:errored",
                        blocking=True,
                    )
                else:
                    publish_session_event(
                        session_id,
                        "session.turn_completed",
                        {
                            "turn": turn_count,
                            "turnId": turn_id,
                            "workflowInstanceId": ctx.instance_id,
                            "agentRuntime": agent_runtime,
                            "reason": "turn_completed",
                            "hasOutput": bool(last_assistant_text),
                            "output_preview": last_assistant_text[:500],
                        },
                        source_event_id=f"{turn_id}:completed",
                        blocking=True,
                    )
        else:
            start_result = yield ctx.call_activity(
                start_cli_activity,
                input=start_input,
                retry_policy=_START_RETRY_POLICY,
            )
            pane_ref = _clean_string(_record(start_result).get("paneRef"))

    iterations = 0
    # Instrumentation (data only): the NON-terminal background-task count the
    # hooks layer stamped on the last turn.completed edge, if any. Carried so the
    # terminal status can also surface it (relevant for auto-terminate runs, which
    # emit no idle event). None = no data; never affects control flow.
    last_background_task_count: int | None = None
    # Subscribe to the lifecycle external-event lane ONCE and reuse the same task
    # across idle-probe iterations, re-arming only after an event is consumed.
    # Recreating wait_for_external_event every loop (the prior bug) leaked a fresh
    # pending subscription per probe cycle; durabletask delivers a raised event to
    # the OLDEST pending subscription, so on a long turn (many idle-probe cycles)
    # the eventually-raised turn.completed matched a STALE subscription instead of
    # the current when_any — the loop never saw completion and the run hung
    # (observed on codex's long unified_exec build turn; short turns like `plan`
    # finished in 1-2 cycles and matched by luck). The timer is fire-and-forget.
    event_task = ctx.wait_for_external_event(LIFECYCLE_EVENT_NAME)
    while status is None:
        iterations += 1
        if iterations > CLI_LIFECYCLE_MAX_ITERATIONS:
            ctx.continue_as_new(
                {
                    **input_data,
                    "_carried": {
                        "seeded": True,
                        "turnCount": turn_count,
                        "lastAssistantText": last_assistant_text,
                        "structuredOutput": last_structured_output,
                        "paneRef": pane_ref,
                        "provenance": provenance,
                    },
                }
            )
            return None

        timer_task = ctx.create_timer(timedelta(seconds=CLI_IDLE_PROBE_SECONDS))
        winner = yield wf_when_any([event_task, timer_task])

        if winner is timer_task:
            # Out-of-band liveness probe — also honors a cooperative-cancel
            # flag persisted by the raise-event endpoint in case the raised
            # terminal event was lost.
            cancellation = yield ctx.call_activity(
                check_cancellation_activity, input={"instanceId": ctx.instance_id}
            )
            if isinstance(cancellation, Mapping) and cancellation.get("cancelled"):
                status, reason = "terminated", "cancel_requested"
                break
            probe = yield ctx.call_activity(
                probe_cli_activity,
                input={
                    "paneRef": pane_ref,
                    "sessionId": session_id,
                    "instanceId": ctx.instance_id,
                },
            )
            probe_data = _record(probe)
            if probe_data.get("terminal"):
                status = _clean_string(probe_data.get("status")) or "completed"
                reason = _clean_string(probe_data.get("reason")) or "cli_exited"
                break
            continue

        events = _event_batch(event_task.get_result())
        # Re-arm the subscription for the next lifecycle event before handling
        # this batch, so a rapid follow-up event can't slip in unobserved.
        event_task = ctx.wait_for_external_event(LIFECYCLE_EVENT_NAME)
        for event in events:
            event_type = event.get("type")
            if event_type == "turn.completed":
                turn_count += 1
                text = _clean_string(
                    event.get("lastAssistantText") or event.get("content")
                )
                if text:
                    last_assistant_text = text
                raw_structured = event.get("structuredOutput")
                if isinstance(raw_structured, Mapping):
                    last_structured_output = dict(raw_structured)
                # Instrumentation (data only): the hooks layer stamps an int
                # backgroundTaskCount on the completion edge when Claude Code
                # reported background_tasks; absent = no data. Bool guard because
                # ``isinstance(True, int)`` is True. Deterministic from the event,
                # so it is replay-safe to read outside the is_replaying guard.
                raw_bg_count = event.get("backgroundTaskCount")
                if isinstance(raw_bg_count, int) and not isinstance(raw_bg_count, bool):
                    last_background_task_count = raw_bg_count
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.turn_completed",
                        {
                            "turn": turn_count,
                            "turnId": f"{ctx.instance_id}:turn:{turn_count}",
                            "workflowInstanceId": ctx.instance_id,
                            "agentRuntime": agent_runtime,
                            "reason": "turn_completed",
                            "hasOutput": bool(last_assistant_text),
                            "output_preview": last_assistant_text[:500],
                        },
                        source_event_id=(
                            f"{ctx.instance_id}:turn:{turn_count}:completed"
                        ),
                        blocking=True,
                    )
                    if not auto_terminate:
                        idle_data: dict[str, Any] = {
                            "stop_reason": {"type": "end_turn"},
                            "turn": turn_count,
                            "turnId": f"{ctx.instance_id}:turn:{turn_count}",
                            "workflowInstanceId": ctx.instance_id,
                            "agentRuntime": agent_runtime,
                        }
                        if last_background_task_count is not None:
                            idle_data["background_task_count"] = (
                                last_background_task_count
                            )
                        publish_session_event(
                            session_id,
                            "session.status_idle",
                            idle_data,
                            source_event_id=(
                                f"{ctx.instance_id}:turn:{turn_count}:idle"
                            ),
                            blocking=True,
                        )
                if auto_terminate:
                    status, reason = "completed", "turn_completed"
                    break
                continue
            if event_type == "turn.failed":
                # Authoritative turn-FAILURE edge (claude StopFailure hook →
                # hooks_api). Rides the SAME lifecycle lane as turn.completed;
                # dedup is enforced on the agent side (one edge per turn).
                turn_count += 1
                error_text = _clean_string(event.get("error")) or "the turn failed"
                # Only overwrite the last good assistant text if the failure edge
                # carried partial output — a bare failure keeps the prior answer.
                text = _clean_string(
                    event.get("lastAssistantText") or event.get("content")
                )
                if text:
                    last_assistant_text = text
                # status_errored (always) and the error-flavored status_idle
                # (interactive only) carry the SAME payload — the publisher copies
                # its data arg, so one local is safe to reuse for both.
                errored_data = {
                    "stop_reason": {"type": "error", "message": error_text},
                    "turn": turn_count,
                    "turnId": f"{ctx.instance_id}:turn:{turn_count}",
                    "workflowInstanceId": ctx.instance_id,
                    "agentRuntime": agent_runtime,
                }
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_errored",
                        errored_data,
                        source_event_id=(
                            f"{ctx.instance_id}:turn:{turn_count}:errored"
                        ),
                        blocking=True,
                    )
                if auto_terminate:
                    # One-shot workflow run: a failed turn fails the run, exactly
                    # like a non-zero cli.exited (same teardown + failed contract).
                    status, reason = "failed", "turn_failed"
                    break
                # Interactive session: the TUI is still alive, so emit an
                # error-flavored idle to un-stick the UI and keep looping — the
                # user can retry in the terminal.
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        errored_data,
                        source_event_id=(
                            f"{ctx.instance_id}:turn:{turn_count}:errored-idle"
                        ),
                        blocking=True,
                    )
                continue
            if event_type in ("cli.session_end", "cli.exited"):
                exit_code = event.get("exitCode")
                status = "completed" if exit_code in (None, 0) else "failed"
                reason = _clean_string(event.get("reason")) or str(event_type)
                break
            if event_type in TERMINAL_CONTROL_EVENT_TYPES or event_type == "terminate":
                status, reason = "terminated", str(event_type)
                break

    # Cooperative close — idempotent; tolerates the pane already being gone.
    # Bounded by a durable timer: if stop hangs on a dead herdr socket, abandon
    # it and proceed (best-effort) rather than wedge the parent.
    if not batch_run:
        yield from _yield_bounded(
            ctx,
            stop_cli_activity,
            input={
                "paneRef": pane_ref,
                "sessionId": session_id,
                "instanceId": ctx.instance_id,
                "reason": reason,
            },
            timeout_seconds=CLI_STOP_TIMEOUT_SECONDS,
        )

    output_sync_result = None
    patch_result = None
    patch_request = _swebench_patch_request(input_data)
    if patch_request is not None and status == "completed":
        patch_result = yield from _yield_bounded(
            ctx,
            extract_model_patch_activity,
            input=patch_request,
            timeout_seconds=CLI_PATCH_TIMEOUT_SECONDS,
        )
        if patch_result is _ACTIVITY_TIMED_OUT:
            patch_result = None
    # Sync workspace output on ANY non-failed end — completed OR a goal-driven
    # terminate. Gating on "completed" alone silently dropped the build whenever
    # the session ended via a terminate event (the goal-complete cooperative
    # terminate winning the race vs auto-terminate, or a custom-loop CLI which
    # always ends "terminated") → empty workspace → downstream verify/preview
    # failed. Bounded by a durable timer so a hung sync can't wedge the parent.
    if status in ("completed", "terminated") and isinstance(
        input_data.get("outputSync"), Mapping
    ):
        output_sync_result = yield from _yield_bounded(
            ctx,
            sync_output_activity,
            input={
                "outputSync": input_data.get("outputSync"),
                "sandboxName": input_data.get("sandboxName"),
                "workspaceSandboxName": input_data.get("workspaceSandboxName"),
                "workspaceRef": input_data.get("workspaceRef"),
                "sessionId": session_id,
                "instanceId": ctx.instance_id,
            },
            timeout_seconds=CLI_OUTPUT_SYNC_TIMEOUT_SECONDS,
        )
        if output_sync_result is _ACTIVITY_TIMED_OUT:
            status = "failed"
            output_sync_result = None
            last_assistant_text = (
                f"{last_assistant_text}\n\nOutput sync timed out"
                if last_assistant_text
                else "Output sync timed out"
            )
        elif isinstance(output_sync_result, Mapping) and not output_sync_result.get(
            "ok"
        ):
            status = "failed"
            error = (
                _clean_string(output_sync_result.get("error")) or "outputSync failed"
            )
            last_assistant_text = (
                f"{last_assistant_text}\n\nOutput sync failed: {error}"
                if last_assistant_text
                else f"Output sync failed: {error}"
            )

    # R1 persisted recording: push any Playwright-native .webm the critic's
    # in-pod @playwright/mcp (--save-video) wrote to /sandbox/work to the BFF
    # browser-artifacts ingest. Runs after stop+output-sync so the browser
    # context has closed and the video is flushed. STRICTLY best-effort — a
    # failure or timeout here must never fail the session.
    if status in ("completed", "terminated"):
        metadata = _record(input_data.get("_message_metadata"))
        video_result = yield from _yield_bounded(
            ctx,
            sync_browser_video_activity,
            input={
                "workflowId": input_data.get("workflowId")
                or metadata.get("workflowId"),
                "workflowExecutionId": input_data.get("workflowExecutionId")
                or input_data.get("dbExecutionId")
                or input_data.get("executionId")
                or metadata.get("workflowExecutionId")
                or metadata.get("executionId"),
                "nodeId": input_data.get("nodeId") or metadata.get("nodeId"),
                "workspaceRef": input_data.get("workspaceRef"),
                "sessionId": session_id,
            },
            timeout_seconds=CLI_BROWSER_VIDEO_SYNC_TIMEOUT_SECONDS,
        )
        if video_result is _ACTIVITY_TIMED_OUT:
            video_result = None

    # Durable per-run workspace diff: compute `git diff <baseline>..working` over
    # the CLI workspace and persist the patch as a `diff` artifact so the run's
    # file changes survive sandbox reap (no live pod, no Gitea). After output
    # sync so created files are present. STRICTLY best-effort + timer-bounded.
    if status in ("completed", "terminated"):
        metadata = _record(input_data.get("_message_metadata"))
        diff_result = yield from _yield_bounded(
            ctx,
            sync_workspace_diff_activity,
            input={
                "workflowExecutionId": input_data.get("workflowExecutionId")
                or input_data.get("dbExecutionId")
                or input_data.get("executionId")
                or metadata.get("workflowExecutionId")
                or metadata.get("executionId"),
                "nodeId": input_data.get("nodeId") or metadata.get("nodeId"),
                "repoPath": input_data.get("workspaceDir")
                or input_data.get("repoPath"),
            },
            timeout_seconds=CLI_WORKSPACE_DIFF_SYNC_TIMEOUT_SECONDS,
        )
        if diff_result is _ACTIVITY_TIMED_OUT:
            diff_result = None

        # Durable per-node SOURCE bundle (Pattern B2): a git bundle of the produced
        # source persisted to the Files API as a `source-bundle` artifact, so the
        # version survives sandbox reap and can be downloaded / Promoted → PR.
        bundle_result = yield from _yield_bounded(
            ctx,
            sync_source_bundle_activity,
            input={
                "workflowExecutionId": input_data.get("workflowExecutionId")
                or input_data.get("dbExecutionId")
                or input_data.get("executionId")
                or metadata.get("workflowExecutionId")
                or metadata.get("executionId"),
                "nodeId": input_data.get("nodeId") or metadata.get("nodeId"),
                "repoPath": input_data.get("workspaceDir")
                or input_data.get("repoPath"),
            },
            timeout_seconds=CLI_WORKSPACE_DIFF_SYNC_TIMEOUT_SECONDS,
        )
        if bundle_result is _ACTIVITY_TIMED_OUT:
            bundle_result = None

    if session_id and not ctx.is_replaying:
        terminated_data: dict[str, Any] = {
            "reason": reason or status,
            "stop_reason": _terminal_stop_reason(status, reason),
            "status": status,
            "success": status not in ("failed",),
            "turnCount": turn_count,
            "agentRuntime": agent_runtime,
            "workflowInstanceId": ctx.instance_id,
        }
        # Emit terminal status only after all bounded durable sync work has
        # completed. The workflow-builder host reaper treats this as the session
        # workflow's near-return signal; publishing it earlier can delete the
        # per-session Dapr host before the child result is committed to the parent.
        if last_background_task_count is not None:
            terminated_data["background_task_count"] = last_background_task_count
        publish_session_event(
            session_id,
            "session.status_terminated",
            terminated_data,
        )

    return _result_contract(
        ctx=ctx,
        session_id=session_id,
        status=status,
        last_assistant_text=last_assistant_text,
        turn_count=turn_count,
        agent_runtime=agent_runtime,
        provenance=provenance,
        output_sync=output_sync_result
        if isinstance(output_sync_result, Mapping)
        else None,
        patch_result=patch_result if isinstance(patch_result, Mapping) else None,
        structured_output=last_structured_output,
    )
