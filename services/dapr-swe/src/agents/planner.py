"""PlannerAgent -- explores a codebase and produces an implementation plan."""

from __future__ import annotations

import json
import logging
from pathlib import PurePosixPath
import re
import shlex
from typing import Any

from dapr_agents import DurableAgent
from dapr_agents.agents.configs import (
    AgentExecutionConfig,
    AgentProfileConfig,
)
from dapr_agents.tool import tool

from src.prompts.planner import PLANNER_SYSTEM_PROMPT
from src.sandbox.openshell import OpenShellBackend

logger = logging.getLogger(__name__)

_PLANNER_FAILURE_MARKERS = (
    "i reached the maximum number of reasoning steps",
    "maximum number of reasoning steps",
    "please rephrase or provide more detail",
)
_BROAD_VALIDATION_PATTERNS = (
    r"\bpytest\s+tests(?:/|\b)",
    r"\bpython\s+-m\s+pytest\s+tests(?:/|\b)",
    r"\bpnpm\s+test\b",
    r"\bnpm\s+test\b",
    r"\byarn\s+test\b",
)
_MAX_TOOL_OUTPUT_CHARS = 12000
_SKIP_READ_SUFFIXES = {
    ".tsbuildinfo",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".sqlite",
    ".db",
    ".lock",
}


def _format_tool_output(output: str) -> str:
    text = output or ""
    if len(text) <= _MAX_TOOL_OUTPUT_CHARS:
        return text
    omitted = len(text) - _MAX_TOOL_OUTPUT_CHARS
    return (
        f"{text[:_MAX_TOOL_OUTPUT_CHARS]}\n"
        f"\n[output truncated: omitted {omitted} characters. Stop broad exploration and finalize the plan.]"
    )


def _should_skip_direct_read(path: str) -> bool:
    suffix = PurePosixPath(path).suffix.lower()
    return suffix in _SKIP_READ_SUFFIXES


# ---------------------------------------------------------------------------
# Sandbox-backed tools the planner can use to explore the repo
# ---------------------------------------------------------------------------


def make_planner_tools(sandbox: OpenShellBackend) -> list:
    """Create tool functions bound to a sandbox instance."""

    @tool
    def execute(command: str, timeout: int = 300) -> str:
        """Run a shell command in the sandbox and return its output."""
        if any(re.search(pattern, command) for pattern in _BROAD_VALIDATION_PATTERNS):
            return (
                "Planning guardrail: do not run the full test suite during planning. "
                "Prefer reading the most relevant tests, inspecting recent diffs, or "
                "planning focused validation on the affected files."
            )
        result = sandbox.execute(command, timeout=timeout)
        output = result.output or ""
        if result.exit_code != 0:
            output += f"\n[exit code {result.exit_code}]"
        return _format_tool_output(output)

    @tool
    def read_file(path: str) -> str:
        """Read a file from the sandbox and return its contents."""
        if _should_skip_direct_read(path):
            return (
                f"Refusing to read {path} directly because it is likely a generated, "
                "binary, or oversized artifact. Focus on source files and finalize the plan."
            )
        result = sandbox.execute(f"cat {shlex.quote(path)}", timeout=30)
        if result.exit_code != 0:
            return f"Error reading {path}: {result.output}"
        return _format_tool_output(result.output)

    @tool
    def list_directory(path: str = ".") -> str:
        """List directory contents in the sandbox."""
        result = sandbox.execute(f"ls -la {shlex.quote(path)}", timeout=30)
        return _format_tool_output(result.output)

    @tool
    def search_code(pattern: str, path: str = ".", file_glob: str = "") -> str:
        """Search for a pattern in the codebase using grep."""
        glob_flag = f"--include='{file_glob}'" if file_glob else ""
        result = sandbox.execute(
            f"grep -rn {glob_flag} {shlex.quote(pattern)} {shlex.quote(path)} | head -100",
            timeout=60,
        )
        return _format_tool_output(result.output)

    return [execute, read_file, list_directory, search_code]


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------


def create_planner_agent(
    sandbox: OpenShellBackend,
    **kwargs: Any,
) -> DurableAgent:
    """Create a DurableAgent configured as a PlannerAgent."""
    tools = make_planner_tools(sandbox)

    return DurableAgent(
        profile=AgentProfileConfig(
            name="PlannerAgent",
            role="Software Architect",
            goal="Analyze a codebase and produce a detailed implementation plan",
            system_prompt=PLANNER_SYSTEM_PROMPT,
        ),
        tools=tools,
        execution=AgentExecutionConfig(max_iterations=12, tool_choice="auto"),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Standalone runner using DurableAgent
# ---------------------------------------------------------------------------


def run_planner(
    sandbox: OpenShellBackend,
    issue_context: dict,
    *,
    model_override: str | None = None,
    max_iterations: int | None = None,
    system_prompt_extra: str | None = None,
) -> dict:
    """Run the planner via DurableAgent and return the parsed plan."""
    from src.config import LLM_MODEL_ID
    from src.llm_providers import (
        get_openai_fallback_model,
        is_anthropic_model,
        is_anthropic_usage_error,
        resolve_llm_client,
    )

    model = (
        model_override.removeprefix("anthropic/")
        if model_override
        else LLM_MODEL_ID.removeprefix("anthropic/")
    )

    system_prompt = PLANNER_SYSTEM_PROMPT
    if system_prompt_extra:
        system_prompt += "\n\n" + system_prompt_extra

    tools = make_planner_tools(sandbox)
    iteration_limit = max_iterations if max_iterations is not None else 12

    import asyncio
    from dapr_agents import Agent

    preflight_context = _build_preflight_context(sandbox, issue_context)
    task_prompt = _format_issue_prompt(issue_context, preflight_context)

    def _run_with_model(model_name: str) -> dict:
        agent = Agent(
            name="PlannerAgent",
            role="Software Architect",
            goal="Analyze codebase and produce implementation plan as JSON",
            system_prompt=system_prompt,
            llm=resolve_llm_client(model_name),
            tools=tools,
            execution=AgentExecutionConfig(
                max_iterations=iteration_limit,
                tool_choice="auto",
            ),
        )
        result = asyncio.run(agent.run(task_prompt))
        text = result.content if result else ""
        return _normalize_plan(_parse_plan(text, issue_context), issue_context)

    try:
        return _run_with_model(model)
    except Exception as exc:
        fallback_model = get_openai_fallback_model()
        if is_anthropic_model(model) and is_anthropic_usage_error(exc) and fallback_model:
            logger.warning(
                "PlannerAgent Anthropic request failed; retrying with OpenAI fallback model %s",
                fallback_model,
            )
            return _run_with_model(fallback_model)
        raise


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _format_issue_prompt(issue_context: dict, preflight_context: str = "") -> str:
    """Format the issue context into a user prompt."""
    parts = [
        f"## Issue: {issue_context.get('title', 'Untitled')}",
        "",
        issue_context.get("body", "No description provided."),
        "",
    ]
    comments = issue_context.get("comments", [])
    if comments:
        parts.append("## Comments")
        for c in comments:
            # Wrap external comments in untrusted tags per open-swe security model
            parts.append(f"<untrusted-content user=\"{c.get('user', 'unknown')}\">")
            parts.append(c.get("body", ""))
            parts.append("</untrusted-content>")
            parts.append("")

    parts.append(
        f"Repository: {issue_context.get('owner', '')}/{issue_context.get('repo', '')}"
    )
    parts.append(f"Working directory: {issue_context.get('working_dir', '/sandbox')}")
    parts.append("")
    if preflight_context:
        parts.append("## Preflight Context")
        parts.append(preflight_context)
        parts.append("")
    parts.append(
        "Explore the codebase using the tools, then produce your implementation "
        "plan as a JSON object. This workflow executes the full plan in one "
        "developer phase, so keep the plan concise and strategic rather than "
        "turning every small edit into its own step. Remember: your final "
        "message must be ONLY valid JSON."
    )
    return "\n".join(parts)


def _contains_planner_failure(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _PLANNER_FAILURE_MARKERS)


def _extract_search_terms(issue_context: dict) -> list[str]:
    combined = " ".join(
        str(issue_context.get(field) or "") for field in ("title", "body")
    ).lower()
    stop_words = {
        "about",
        "after",
        "agent",
        "alternate",
        "create",
        "diagnosis",
        "feature",
        "feat",
        "fix",
        "github",
        "issue",
        "loop",
        "open",
        "pull",
        "repo",
        "repository",
        "resolve",
        "should",
        "that",
        "this",
        "use",
        "with",
        "workflow",
    }
    terms: list[str] = []
    for raw_term in re.findall(r"[a-z0-9][a-z0-9_-]{3,}", combined):
        if raw_term in stop_words or raw_term.isdigit():
            continue
        if raw_term not in terms:
            terms.append(raw_term)
        if len(terms) >= 5:
            break
    return terms


def _build_preflight_context(sandbox: OpenShellBackend, issue_context: dict) -> str:
    working_dir = str(issue_context.get("working_dir") or "/sandbox").strip() or "/sandbox"
    safe_dir = shlex.quote(working_dir)
    sections: list[str] = []

    commands = [
        (
            "Root listing",
            f"cd {safe_dir} && ls -1 | head -40",
        ),
        (
            "AGENTS files",
            f"find {safe_dir} -name AGENTS.md -print | head -10",
        ),
        (
            "Recent git history",
            f"cd {safe_dir} && git log --oneline -10",
        ),
    ]

    search_terms = _extract_search_terms(issue_context)
    if search_terms:
        pattern = "|".join(re.escape(term) for term in search_terms)
        commands.append(
            (
                "Issue-related matches",
                f"cd {safe_dir} && rg -n -i -e '{pattern}' --glob '!node_modules' --glob '!.git' . | head -80",
            )
        )

    for label, command in commands:
        result = sandbox.execute(command, timeout=45)
        output = (result.output or "").strip()
        if result.exit_code != 0 and not output:
            continue
        if not output:
            continue
        sections.append(f"{label}:\n{output[:3000]}")

    return "\n\n".join(sections)[:6000]


def _sanitize_planner_text(text: str) -> str:
    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if cleaned_lines and cleaned_lines[-1]:
                cleaned_lines.append("")
            continue
        if _contains_planner_failure(line):
            continue
        cleaned_lines.append(line)

    cleaned = "\n".join(cleaned_lines).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def _issue_summary(issue_context: dict) -> str:
    title = str(issue_context.get("title") or "").strip()
    if title:
        return title
    body = str(issue_context.get("body") or "").strip()
    if body:
        return body.splitlines()[0][:200].strip()
    return "Implement the requested changes"


def _looks_mostly_implemented(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in (
            "already implemented",
            "already complete",
            "already in the codebase",
            "all 118 tests pass",
            "all tests pass",
        )
    )


def _should_collapse_to_verification_plan(summary: str, steps: list[dict[str, Any]]) -> bool:
    combined = [summary]
    for step in steps:
        combined.append(str(step.get("title") or ""))
        combined.append(str(step.get("description") or ""))
    return _looks_mostly_implemented("\n".join(combined))


def _fallback_plan(issue_context: dict, context_text: str = "") -> dict:
    summary = _issue_summary(issue_context)
    cleaned_context = _sanitize_planner_text(context_text)
    step_title = "Implement the requested changes"
    description = (
        "Analyze the issue requirements, implement the necessary code changes, "
        "and verify the result with focused checks."
    )
    if cleaned_context and _looks_mostly_implemented(cleaned_context):
        step_title = "Verify existing implementation and close the remaining gap"
        description = (
            "Verify the existing implementation against the issue requirements, "
            "identify any remaining delta, make only the necessary fixes, and "
            "run focused checks on the affected files."
        )
    if cleaned_context:
        description += f" Context: {cleaned_context[:600]}"
    else:
        body = str(issue_context.get("body") or "").strip()
        if body:
            description += f" Context: {body[:600]}"

    return {
        "summary": summary,
        "steps": [
            {
                "title": step_title,
                "description": description,
                "files": [],
                "complexity": "medium",
            }
        ],
        "critical_files": [],
    }


def _parse_plan(text: str, issue_context: dict) -> dict:
    """Extract JSON plan from LLM text output."""
    if isinstance(text, dict):
        return text
    text = str(text).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            summary = str(parsed.get("summary") or "")
            if summary and _contains_planner_failure(summary):
                logger.warning("Planner returned degraded JSON summary; using deterministic fallback")
                return _fallback_plan(issue_context, summary)
        return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start:end])
            if isinstance(parsed, dict):
                summary = str(parsed.get("summary") or "")
                if summary and _contains_planner_failure(summary):
                    logger.warning("Planner returned degraded extracted JSON summary; using deterministic fallback")
                    return _fallback_plan(issue_context, summary)
            return parsed
        except json.JSONDecodeError:
            pass

    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if fence_match:
        try:
            parsed = json.loads(fence_match.group(1).strip())
            if isinstance(parsed, dict):
                summary = str(parsed.get("summary") or "")
                if summary and _contains_planner_failure(summary):
                    logger.warning("Planner returned degraded fenced JSON summary; using deterministic fallback")
                    return _fallback_plan(issue_context, summary)
            return parsed
        except json.JSONDecodeError:
            pass

    logger.warning("Could not parse plan JSON, creating actionable fallback")
    return _fallback_plan(issue_context, text)


def _normalize_plan(plan: Any, issue_context: dict) -> dict:
    """Coerce planner output into the compact shape expected by the workflow."""
    if not isinstance(plan, dict):
        plan = {}

    raw_steps = plan.get("steps")
    if not isinstance(raw_steps, list):
        raw_steps = []

    normalized_steps: list[dict[str, Any]] = []
    critical_files: list[str] = []

    for index, raw_step in enumerate(raw_steps[:3], start=1):
        if not isinstance(raw_step, dict):
            continue

        files: list[str] = []
        for raw_file in raw_step.get("files", []):
            if isinstance(raw_file, str) and raw_file.strip():
                path = raw_file.strip()
                if path not in files:
                    files.append(path)
                if path not in critical_files:
                    critical_files.append(path)

        complexity = raw_step.get("complexity")
        if complexity not in {"low", "medium", "high"}:
            complexity = "medium"

        title = str(raw_step.get("title") or f"Implementation step {index}").strip()
        description = _sanitize_planner_text(str(raw_step.get("description") or "").strip())
        if not description:
            description = (
                f"Implement {title.lower()}, update the affected files, and verify "
                "the result with focused checks."
            )

        normalized_steps.append(
            {
                "title": title,
                "description": description,
                "files": files,
                "complexity": complexity,
            }
        )

    summary = str(plan.get("summary") or issue_context.get("title") or "").strip()
    if _contains_planner_failure(summary):
        summary = _issue_summary(issue_context)
    if not summary:
        summary = "Implement the requested changes"

    if not normalized_steps:
        normalized_steps = [
            {
                "title": "Implement the requested changes",
                "description": (
                    "Analyze the issue requirements, make the necessary code changes, "
                    "and verify the behavior with focused checks."
                ),
                "files": [],
                "complexity": "medium",
            }
        ]

    if not critical_files:
        raw_critical = plan.get("critical_files")
        if isinstance(raw_critical, list):
            for raw_file in raw_critical[:5]:
                if isinstance(raw_file, str) and raw_file.strip():
                    path = raw_file.strip()
                    if path not in critical_files:
                        critical_files.append(path)

    if _should_collapse_to_verification_plan(summary, normalized_steps):
        collapsed = _fallback_plan(
            issue_context,
            "\n".join(
                [
                    summary,
                    *[
                        f"{step['title']}: {step['description']}"
                        for step in normalized_steps
                    ],
                ]
            ),
        )
        collapsed["critical_files"] = critical_files[:5]
        return collapsed

    return {
        "summary": summary[:1000],
        "steps": normalized_steps,
        "critical_files": critical_files[:5],
    }
