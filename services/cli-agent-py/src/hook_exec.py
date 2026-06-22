"""Portable `agentConfig.hooks` execution for the interactive-cli family (P3).

dapr-agent-py runs `agentConfig.hooks` natively; the three CLIs (claude/codex/agy)
historically ignored them. The CLIs ALREADY relay every native hook event to
cli-agent-py (`/internal/hooks/{claude,cli/<adapter>}`), so this module is the one
seam that makes `agentConfig.hooks` portable: `HookProcessor` calls
`run_event_hooks(...)` on each incoming event, and folds the aggregated decision
into the response the relay/HTTP returns to the CLI (blocking where the CLI
protocol allows — claude PreToolUse blocks; codex/agy are advisory).

Scope (vs dapr-agent-py's full engine): **`command` hooks only** (`callback`
dotted-path Python is dapr-agent-py-only and is skipped here). Matcher + a
pragmatic `if`-gate are supported; the subprocess contract mirrors
dapr-agent-py/src/hooks/subprocess_runner.py (stdin JSON, exit 2 = block, JSON
stdout = decision). Decision precedence: deny > ask > allow.

A cli-agent-py pod hosts ONE session, so the run's hooks live in a module global
set by `cli_lifecycle.start_cli` via `set_run_hooks`.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import shutil
import time
from typing import Any, Mapping

logger = logging.getLogger("hook_exec")

_DEFAULT_TIMEOUT_MS = 600_000
_MAX_TIMEOUT_MS = 300_000

# Run-scoped state (one session per cli-agent-py pod).
_RUN_HOOKS: dict[str, list[dict[str, Any]]] = {}
_PROJECT_DIR: str = "/sandbox/work"


def set_run_hooks(raw: Any, *, project_dir: str | None = None) -> None:
    """Install the run's agentConfig.hooks (raw dict {Event:[{matcher?,hooks:[...]}]})."""
    global _RUN_HOOKS, _PROJECT_DIR
    parsed: dict[str, list[dict[str, Any]]] = {}
    if isinstance(raw, Mapping):
        for event, groups in raw.items():
            if isinstance(groups, list):
                parsed[str(event)] = [g for g in groups if isinstance(g, Mapping)]
    _RUN_HOOKS = parsed
    if project_dir:
        _PROJECT_DIR = project_dir
    if parsed:
        logger.info(
            "[hook_exec] portable hooks installed for events: %s",
            ", ".join(sorted(parsed.keys())),
        )


def has_run_hooks() -> bool:
    return bool(_RUN_HOOKS)


def _matcher_matches(matcher: str | None, tool_name: str | None) -> bool:
    """matcher semantics (mirrors dapr-agent-py): None/empty/`*` = always;
    `/regex/` = regex; `A|B|C` = alternation; else fnmatch glob on the tool name."""
    if matcher is None or matcher == "" or matcher == "*":
        return True
    name = tool_name or ""
    if len(matcher) >= 2 and matcher.startswith("/") and matcher.endswith("/"):
        try:
            return re.search(matcher[1:-1], name) is not None
        except re.error:
            return False
    if "|" in matcher:
        return name in {p.strip() for p in matcher.split("|")}
    return fnmatch.fnmatch(name, matcher)


def _if_passes(if_expr: str | None, hook_input: Mapping[str, Any]) -> bool:
    """Pragmatic `if`-gate: `Tool`, `Tool(argglob)`, leading `!` negation.
    Unrecognized expressions default to TRUE (the matcher already scoped it; we
    don't silently swallow a hook the author declared). The arg glob matches the
    primary tool arg (command/file_path/path/pattern)."""
    expr = (if_expr or "").strip()
    if not expr:
        return True
    negate = expr.startswith("!")
    if negate:
        expr = expr[1:].strip()
    m = re.match(r"^([A-Za-z_][\w-]*)(?:\(([^)]*)\))?$", expr)
    if not m:
        return True
    tool, arg_glob = m.group(1), m.group(2)
    name = str(hook_input.get("tool_name") or hook_input.get("toolName") or "")
    matched = name == tool
    if matched and arg_glob:
        ti = hook_input.get("tool_input") or hook_input.get("toolInput") or {}
        arg = ""
        if isinstance(ti, Mapping):
            for k in ("command", "file_path", "path", "pattern", "query"):
                if isinstance(ti.get(k), str):
                    arg = ti[k]
                    break
        matched = fnmatch.fnmatch(arg, arg_glob)
    return (not matched) if negate else matched


def _pick_shell() -> tuple[str, list[str]]:
    bash = shutil.which("bash") or "/bin/sh"
    return bash, ["-c"]


def _parse_stdout(raw: bytes) -> dict[str, Any] | None:
    text = raw.decode("utf-8", errors="replace").strip()
    if not text or not text.startswith("{"):
        return None
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


async def _run_command(command: str, hook_input: Mapping[str, Any], timeout_ms: int) -> dict[str, Any]:
    """Run one command hook. Returns {outcome, decision?, reason?, context?, stdout?}.
    outcome ∈ ok|blocking|error. Never raises."""
    shell, args = _pick_shell()
    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = _PROJECT_DIR
    cwd = _PROJECT_DIR if os.path.isdir(_PROJECT_DIR) else None
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            shell, *args, command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env, cwd=cwd,
        )
    except (OSError, ValueError) as exc:
        return {"outcome": "error", "reason": f"spawn failed: {exc}"}
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=(json.dumps(dict(hook_input)) + "\n").encode("utf-8")),
            timeout=max(1.0, min(timeout_ms, _MAX_TIMEOUT_MS) / 1000.0),
        )
    except asyncio.TimeoutError:
        proc.kill()
        return {"outcome": "blocking", "reason": f"hook timed out after {timeout_ms}ms"}
    code = proc.returncode if proc.returncode is not None else -1
    out = _parse_stdout(stdout) or {}
    stderr_tail = stderr.decode("utf-8", errors="replace")[-2000:].strip()
    # JSON-stdout decision (claude-style) takes precedence over the exit code.
    decision = None
    reason = out.get("reason")
    hso = out.get("hookSpecificOutput") if isinstance(out.get("hookSpecificOutput"), dict) else {}
    perm = (hso or {}).get("permissionDecision") or out.get("decision")
    if perm in ("deny", "block"):
        decision = "deny"
        reason = reason or (hso or {}).get("permissionDecisionReason")
    elif perm == "ask":
        decision = "ask"
    elif perm in ("allow", "approve"):
        decision = "allow"
    context = out.get("additionalContext") or (hso or {}).get("additionalContext")
    if code == 2 and decision is None:
        decision = "deny"
        reason = reason or stderr_tail or "hook blocked"
    if code not in (0, 2) and decision is None:
        logger.warning("[hook_exec] command hook exit=%s reason=%s", code, reason or stderr_tail)
        return {"outcome": "error", "reason": reason or stderr_tail or f"exit {code}"}
    return {
        "outcome": "blocking" if decision == "deny" else "ok",
        "decision": decision,
        "reason": reason,
        "context": context if isinstance(context, str) else None,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


_PRECEDENCE = {None: 0, "allow": 0, "ask": 1, "deny": 2}


async def run_event_hooks(
    event: str,
    *,
    tool_name: str | None,
    hook_input: Mapping[str, Any],
) -> dict[str, Any]:
    """Execute the run's agentConfig.hooks for `event`. Returns an aggregated
    decision: {matched, decision, reason, contexts:[str]}. `decision` is the
    highest-precedence non-allow outcome (deny>ask), or None."""
    groups = _RUN_HOOKS.get(event) or []
    if not groups:
        return {"matched": False, "decision": None, "reason": None, "contexts": []}

    tasks: list = []
    for group in groups:
        if not _matcher_matches(group.get("matcher"), tool_name):
            continue
        for hook in group.get("hooks", []) or []:
            if not isinstance(hook, Mapping):
                continue
            htype = str(hook.get("type") or "command")
            if htype != "command":
                # callback hooks are dapr-agent-py-only (can't load arbitrary
                # Python in the CLI pod) — skip with a log, never block.
                logger.info("[hook_exec] skipping non-command hook (type=%s) for %s", htype, event)
                continue
            if not _if_passes(hook.get("if"), hook_input):
                continue
            command = hook.get("command")
            if not isinstance(command, str) or not command.strip():
                continue
            timeout_ms = int(float(hook.get("timeout") * 1000)) if hook.get("timeout") else _DEFAULT_TIMEOUT_MS
            tasks.append(_run_command(command, hook_input, timeout_ms))

    if not tasks:
        return {"matched": False, "decision": None, "reason": None, "contexts": []}

    results = await asyncio.gather(*tasks, return_exceptions=True)
    decision: str | None = None
    reason: str | None = None
    contexts: list[str] = []
    for r in results:
        if isinstance(r, Exception) or not isinstance(r, dict):
            continue
        d = r.get("decision")
        if d and _PRECEDENCE.get(d, 0) > _PRECEDENCE.get(decision, 0):
            decision = d
            reason = r.get("reason")
        if r.get("context"):
            contexts.append(str(r["context"]))
    return {"matched": True, "decision": decision, "reason": reason, "contexts": contexts}


__all__ = ["set_run_hooks", "has_run_hooks", "run_event_hooks"]
