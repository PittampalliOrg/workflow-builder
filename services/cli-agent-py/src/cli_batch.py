"""One-shot CLI execution for workflow-launched interactive-cli runtimes.

This path is intentionally separate from the Herdr/TUI lifecycle. It is used
for ``autoTerminateAfterEndTurn`` workflow runs where no human terminal is
attached: seed artifacts are still produced by the normal adapter, but the turn
is executed through the CLI's native batch mode and returns a completed result
directly to the Dapr workflow.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping

from src.cli_adapters import get_adapter
from src.env_flags import env_bool
from src.event_publisher import publish_session_event
from src.seed import adapter_name_for
from src.structured_output import (
    STRUCTURED_OUTPUT_NUDGE,
    extract_structured_output_from_text,
    max_structured_output_nudges,
    schema_supports_structured_output,
)

logger = logging.getLogger(__name__)

CLI_BATCH_TIMEOUT_SECONDS = int(os.environ.get("CLI_BATCH_TIMEOUT_SECONDS", "1200"))
CLI_BATCH_STDIO_LIMIT_BYTES = int(
    os.environ.get("CLI_BATCH_STDIO_LIMIT_BYTES", str(256 * 1024))
)


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _sandbox_root() -> str:
    return (
        os.environ.get("CLI_SHARED_WORKSPACE_MOUNT")
        or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
    )


def cli_batch_enabled(input_data: Mapping[str, Any]) -> bool:
    """Whether this session should bypass Herdr and run as a native batch turn."""
    if env_bool("CLI_AGENT_WORKFLOW_BATCH", False) is not True:
        return False
    if not input_data.get("autoTerminateAfterEndTurn"):
        return False
    if _record(input_data.get("agentConfig")).get("continueSession"):
        return False
    return bool(_clean(input_data.get("seedUserMessage")))


def run_cli_once_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return _run_cli_once(_record(payload))


def _run_cli_once(input_data: dict[str, Any]) -> dict[str, Any]:
    session_id = _clean(input_data.get("sessionId"))
    instance_id = _clean(input_data.get("instanceId"))
    agent_config = _record(input_data.get("agentConfig"))
    seed = _record(input_data.get("seed"))
    seed_paths = {
        str(k): str(v) for k, v in _record(seed.get("paths")).items() if v is not None
    }
    prompt = _clean(input_data.get("seedUserMessage")) or ""
    adapter = get_adapter(adapter_name_for(input_data))
    env = adapter.pane_env(os.environ, session_id=session_id, agent_config=agent_config)
    cwd = _sandbox_root()

    try:
        from src.hook_exec import set_run_hooks

        set_run_hooks(agent_config.get("hooks"), project_dir=cwd)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cli-batch] portable hook install failed: %s", exc)

    try:
        adapter.on_session_started(session_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[cli-batch] on_session_started failed: %s", exc)

    schema = _structured_schema(agent_config)
    attempts = 0
    last_feedback: str | None = None
    last_text = ""
    last_stdout = ""
    last_stderr = ""
    last_exit_code: int | None = None
    structured_value: dict[str, Any] | None = None

    max_attempts = 1
    if schema is not None:
        max_attempts += max_structured_output_nudges()

    with tempfile.TemporaryDirectory(prefix="wfb-cli-batch-") as temp_dir:
        temp = Path(temp_dir)
        schema_path = temp / "response-schema.json"
        if schema is not None:
            schema_path.write_text(json.dumps(schema), encoding="utf-8")

        for attempts in range(1, max_attempts + 1):
            output_path = temp / f"last-message-{attempts}.txt"
            attempt_prompt = _batch_prompt(prompt, schema, last_feedback)
            argv = _batch_argv(
                adapter_name=adapter.name,
                agent_config=agent_config,
                seed_paths=seed_paths,
                schema=schema,
                schema_path=schema_path,
                output_path=output_path,
                prompt=attempt_prompt,
            )
            logger.info(
                "[cli-batch] running adapter=%s attempt=%d/%d cwd=%s argv=%s",
                adapter.name,
                attempts,
                max_attempts,
                cwd,
                _redacted_argv(argv),
            )
            try:
                completed = _run_subprocess(argv, cwd=cwd, env=env)
            except subprocess.TimeoutExpired as exc:
                last_exit_code = None
                last_stdout = _limit_text(exc.stdout or "")
                last_stderr = _limit_text(exc.stderr or "")
                last_text = _timeout_text(last_stdout, last_stderr)
                break
            last_exit_code = completed.returncode
            last_stdout = _limit_text(completed.stdout or "")
            last_stderr = _limit_text(completed.stderr or "")
            last_text = _extract_completion_text(
                adapter_name=adapter.name,
                stdout=completed.stdout or "",
                stderr=completed.stderr or "",
                output_path=output_path,
            )
            if completed.returncode != 0:
                break
            if schema is None:
                break
            evaluated = extract_structured_output_from_text(schema, last_text)
            if evaluated.valid and evaluated.value is not None:
                structured_value = dict(evaluated.value)
                last_text = evaluated.canonical_text or last_text
                _publish_structured_validation(
                    session_id,
                    ok=True,
                    source=_structured_source(adapter.name),
                )
                break
            last_feedback = evaluated.feedback or "invalid structured output"
            _publish_structured_validation(
                session_id,
                ok=False,
                source="assistant_text",
                feedback=last_feedback,
                attempts=attempts,
            )

    if last_exit_code is None and last_text.startswith("CLI batch process timed out"):
        status = "failed"
        reason = "cli_timeout"
        final_text = last_text
    elif last_exit_code not in (None, 0):
        status = "failed"
        reason = f"cli_exit_{last_exit_code}"
        final_text = _failure_text(last_exit_code, last_stdout, last_stderr)
    elif schema is not None and structured_value is None:
        status = "failed"
        reason = "structured_output_invalid"
        final_text = (
            "Structured output validation failed"
            + (f": {last_feedback}" if last_feedback else "")
        )
    else:
        status = "completed"
        reason = "batch_completed"
        final_text = last_text.strip()

    if session_id and final_text:
        publish_session_event(
            session_id,
            "agent.message",
            {"content": [{"type": "text", "text": final_text}]},
            source_event_id=f"batch:{instance_id or session_id}:message",
            blocking=True,
        )

    return {
        "batch": True,
        "adapter": adapter.name,
        "status": status,
        "reason": reason,
        "turnCount": 1,
        "lastAssistantText": final_text,
        "structuredOutput": structured_value,
        "attempts": attempts,
        "exitCode": last_exit_code,
        "stdoutPreview": last_stdout[-4000:],
        "stderrPreview": last_stderr[-4000:],
    }


def _structured_schema(agent_config: Mapping[str, Any]) -> dict[str, Any] | None:
    schema = agent_config.get("responseJsonSchema")
    if not schema_supports_structured_output(schema):
        return None
    return dict(schema) if isinstance(schema, Mapping) else None


def _batch_prompt(
    prompt: str,
    schema: Mapping[str, Any] | None,
    previous_feedback: str | None,
) -> str:
    if schema is None:
        return prompt
    contract = (
        "\n\n<cli-batch-output-contract>\n"
        "This run is using the CLI's non-interactive batch transport. Return the "
        "required final result as a single JSON object in your final response. "
        "If earlier instructions mention a StructuredOutput tool, treat this "
        "native batch response as the delivery transport for the same final "
        "object. Do not include prose before or after the JSON object.\n"
        f"JSON Schema:\n{json.dumps(dict(schema), sort_keys=True)}\n"
        "</cli-batch-output-contract>"
    )
    if previous_feedback:
        contract += (
            "\n\n<previous-attempt>\n"
            "Your previous output failed schema validation. Validation errors:\n"
            f"{previous_feedback}\n\n{STRUCTURED_OUTPUT_NUDGE}\n"
            "</previous-attempt>"
        )
    return prompt + contract


def _batch_argv(
    *,
    adapter_name: str,
    agent_config: Mapping[str, Any],
    seed_paths: Mapping[str, str],
    schema: Mapping[str, Any] | None,
    schema_path: Path,
    output_path: Path,
    prompt: str,
) -> list[str]:
    adapter = get_adapter(adapter_name)
    base = adapter.build_argv(agent_config, seed_paths, one_shot=True)
    if adapter_name == "codex":
        argv = [base[0], "exec", *base[1:]]
        argv += ["--skip-git-repo-check", "--output-last-message", str(output_path)]
        if schema is not None:
            argv += ["--output-schema", str(schema_path)]
        argv.append(prompt)
        return argv
    if adapter_name == "antigravity":
        argv = [base[0], "--print", "--print-timeout", f"{CLI_BATCH_TIMEOUT_SECONDS}s", *base[1:]]
        argv.append(prompt)
        return argv
    if adapter_name == "claude-code":
        argv = [base[0], "--print", "--output-format", "json", "--no-session-persistence"]
        if schema is not None:
            argv += ["--json-schema", json.dumps(dict(schema), sort_keys=True)]
        argv += _claude_batch_args(base[1:])
        # Claude Code's --mcp-config is variadic (<configs...>). Without an
        # option terminator the final prompt is parsed as another MCP config
        # path, so schema'd workflow runs fail before the model starts.
        argv += ["--", prompt]
        return argv
    raise ValueError(f"batch mode is not supported for adapter {adapter_name!r}")


def _claude_batch_args(args: list[str]) -> list[str]:
    out: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--append-system-prompt-file" and index + 1 < len(args):
            path = Path(args[index + 1])
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                text = ""
            if text.strip():
                out += ["--append-system-prompt", text]
            index += 2
            continue
        out.append(arg)
        index += 1
    return out


def _run_subprocess(
    argv: list[str], *, cwd: str, env: Mapping[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        env=dict(env),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=CLI_BATCH_TIMEOUT_SECONDS,
        check=False,
        start_new_session=True,
    )


def _extract_completion_text(
    *,
    adapter_name: str,
    stdout: str,
    stderr: str,
    output_path: Path,
) -> str:
    if adapter_name == "codex" and output_path.exists():
        try:
            text = output_path.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            pass
    if adapter_name == "claude-code":
        text = _extract_json_text(stdout)
        if text:
            return text
    if adapter_name == "codex":
        text = _extract_jsonl_text(stdout)
        if text:
            return text
    return (stdout or stderr or "").strip()


def _extract_json_text(text: str) -> str | None:
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return None
    return _text_from_value(parsed)


def _extract_jsonl_text(text: str) -> str | None:
    for line in reversed([line for line in text.splitlines() if line.strip()]):
        try:
            parsed = json.loads(line)
        except (TypeError, ValueError):
            continue
        found = _text_from_value(parsed)
        if found:
            return found
    return None


def _text_from_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts = [_text_from_value(item) for item in value]
        joined = "\n\n".join(part for part in parts if part)
        return joined or None
    if isinstance(value, Mapping):
        for key in (
            "result",
            "last_agent_message",
            "lastAssistantText",
            "finalResponse",
            "response",
            "content",
            "message",
            "text",
            "output",
        ):
            found = _text_from_value(value.get(key))
            if found:
                return found
        payload = value.get("payload")
        if isinstance(payload, Mapping):
            return _text_from_value(payload)
    return None


def _publish_structured_validation(
    session_id: str | None,
    *,
    ok: bool,
    source: str,
    feedback: str | None = None,
    attempts: int | None = None,
) -> None:
    if not session_id:
        return
    data: dict[str, Any] = {"ok": ok, "source": source}
    if feedback:
        data["feedback"] = feedback
    if attempts is not None:
        data["attempts"] = attempts
    publish_session_event(session_id, "structured_output.validation", data)


def _structured_source(adapter_name: str) -> str:
    if adapter_name in {"claude-code", "codex"}:
        return "native_schema"
    return "assistant_text"


def _limit_text(text: str) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= CLI_BATCH_STDIO_LIMIT_BYTES:
        return text
    return encoded[-CLI_BATCH_STDIO_LIMIT_BYTES:].decode("utf-8", errors="replace")


def _failure_text(exit_code: int | None, stdout: str, stderr: str) -> str:
    parts = [f"CLI batch process exited with code {exit_code}."]
    if stderr.strip():
        parts.append(f"stderr:\n{stderr.strip()}")
    if stdout.strip():
        parts.append(f"stdout:\n{stdout.strip()}")
    return "\n\n".join(parts)


def _timeout_text(stdout: str, stderr: str) -> str:
    parts = [f"CLI batch process timed out after {CLI_BATCH_TIMEOUT_SECONDS}s."]
    if stderr.strip():
        parts.append(f"stderr:\n{stderr.strip()}")
    if stdout.strip():
        parts.append(f"stdout:\n{stdout.strip()}")
    return "\n\n".join(parts)


def _redacted_argv(argv: list[str]) -> list[str]:
    out: list[str] = []
    skip_next = False
    for item in argv:
        if skip_next:
            out.append("<redacted>")
            skip_next = False
            continue
        out.append(item if len(item) <= 200 else item[:200] + "...")
        if item in {"--json-schema"}:
            skip_next = True
    return out
