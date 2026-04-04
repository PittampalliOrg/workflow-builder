"""Action handlers that wrap dapr-swe agent runners for workflow-builder orchestration.

Each handler takes (input_data, node_outputs) and returns
{"success": bool, "data": dict, "error": str | None}.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import posixpath
import shlex
import subprocess
import tempfile
from typing import Any

from src.events import publish_event, update_execution_status, post_agent_event
from src.integrations.github_app import get_github_app_installation_token
from src.scm import (
    ScmAuth,
    build_clone_config,
    build_greenfield_pr_body,
    build_pr_body,
    configure_git_identity_command,
    create_repository,
    create_pull_request,
    get_gitea_auth,
    normalize_provider,
    post_issue_comment as post_provider_issue_comment,
    remote_matches,
)
from src.sandbox.openshell import OpenShellBackend, create_openshell_sandbox

logger = logging.getLogger(__name__)

_DEMO_ACTIONS = {"visit", "click", "fill", "press", "wait", "assert", "scroll"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve(input_data: dict, node_outputs: dict, key: str, node_label: str = "") -> Any:
    """Resolve a value from input_data or a previous node's output.

    Searches: input_data → node_outputs[*].data → node_outputs[*].data.data (nested).
    The orchestrator stores node results as: {data: {success, data: {actual_fields}}}.
    """
    if key in input_data:
        return input_data[key]
    # Search all previous node outputs
    for nid, out in node_outputs.items():
        if not isinstance(out, dict):
            continue
        # Direct in output
        if key in out:
            return out[key]
        # In output.data
        data = out.get("data", {})
        if isinstance(data, dict):
            if key in data:
                return data[key]
            # In output.data.data (nested function-router response)
            inner = data.get("data", {})
            if isinstance(inner, dict) and key in inner:
                return inner[key]
    return None


def _resolve_execution_ids(input_data: dict, node_outputs: dict) -> tuple[str, str]:
    """Return (db_execution_id, dapr_instance_id) when available."""
    db_execution_id = (
        _resolve(input_data, node_outputs, "_db_execution_id")
        or _resolve(input_data, node_outputs, "db_execution_id")
        or _resolve(input_data, node_outputs, "wb_execution_id")
        or ""
    )
    dapr_instance_id = (
        _resolve(input_data, node_outputs, "_execution_id")
        or _resolve(input_data, node_outputs, "execution_id")
        or ""
    )
    return str(db_execution_id).strip(), str(dapr_instance_id).strip()


def _reconnect_sandbox(sandbox_id: str) -> OpenShellBackend:
    """Reconnect to an existing sandbox by its ID."""
    return create_openshell_sandbox(sandbox_id=sandbox_id)


def _coerce_mapping(value: Any) -> dict[str, Any]:
    """Accept either a dict payload or a JSON-encoded dict string."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _coerce_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _resolve_provider(input_data: dict, node_outputs: dict) -> str:
    return normalize_provider(_resolve(input_data, node_outputs, "provider"))


def _safe_relpath(path: str, root: str) -> str:
    rel = path.removeprefix(root).strip("/")
    return rel or "."


def _detect_package_manager(lockfiles: set[str]) -> str | None:
    if "pnpm-lock.yaml" in lockfiles or "pnpm-workspace.yaml" in lockfiles:
        return "pnpm"
    if "package-lock.json" in lockfiles:
        return "npm"
    if "yarn.lock" in lockfiles:
        return "yarn"
    return None


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off", ""}:
        return False
    return default


def _preview_steps_for_app(app_subdir: str) -> list[dict[str, Any]]:
    metadata = {"appSubdir": app_subdir}
    return [
        {
            "id": "home",
            "label": "Home",
            "action": "visit",
            "goal": "Open the updated experience",
            "url": "/",
            "pauseMs": 2500,
            "fullPage": True,
            "metadata": metadata,
        }
    ]


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            parsed = json.loads(raw[start:end])
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _normalize_demo_step(raw_step: Any, index: int) -> dict[str, Any]:
    step = raw_step if isinstance(raw_step, dict) else {}
    action = str(step.get("action") or "").strip().lower() or "wait"
    if action not in _DEMO_ACTIONS:
        action = "visit" if step.get("url") or step.get("path") else "wait"
    pause_ms = step.get("pauseMs")
    try:
        pause_value = int(pause_ms) if pause_ms is not None and str(pause_ms).strip() else None
    except Exception:
        pause_value = None
    return {
        "id": str(step.get("id") or f"step-{index + 1}").strip() or f"step-{index + 1}",
        "label": str(step.get("label") or f"Step {index + 1}").strip() or f"Step {index + 1}",
        "goal": str(step.get("goal") or "").strip(),
        "action": action,
        "url": str(step.get("url") or step.get("path") or "").strip(),
        "selector": str(step.get("selector") or "").strip(),
        "text": str(step.get("text") or "").strip(),
        "target": str(step.get("target") or "").strip(),
        "value": str(step.get("value") or step.get("key") or "").strip(),
        "pauseMs": pause_value if pause_value is not None else 1500,
        "waitForSelector": str(step.get("waitForSelector") or "").strip(),
        "waitForText": str(step.get("waitForText") or "").strip(),
        "successCriteria": str(step.get("successCriteria") or "").strip(),
        "fullPage": step.get("fullPage") is not False,
    }


def _default_demo_plan(*, app_subdir: str = ".", summary: str = "") -> dict[str, Any]:
    title = "Functional Demo"
    return {
        "captureMode": "demo",
        "title": title,
        "summary": summary or "Open the updated UI and capture the primary experience.",
        "entryPath": "/",
        "confidence": "low",
        "steps": _preview_steps_for_app(app_subdir),
        "fallbackSteps": [],
    }


def _normalize_demo_plan(raw_plan: Any, *, app_subdir: str = ".") -> dict[str, Any]:
    plan = raw_plan if isinstance(raw_plan, dict) else {}
    normalized = _default_demo_plan(app_subdir=app_subdir, summary=str(plan.get("summary") or "").strip())
    normalized["title"] = str(plan.get("title") or normalized["title"]).strip() or normalized["title"]
    normalized["summary"] = str(plan.get("summary") or normalized["summary"]).strip() or normalized["summary"]
    normalized["entryPath"] = str(plan.get("entryPath") or plan.get("entry_path") or "/").strip() or "/"
    normalized["confidence"] = str(plan.get("confidence") or "medium").strip().lower() or "medium"
    raw_steps = plan.get("steps")
    if isinstance(raw_steps, list) and raw_steps:
        normalized["steps"] = [_normalize_demo_step(step, index) for index, step in enumerate(raw_steps)]
    raw_fallback = plan.get("fallbackSteps") or plan.get("fallback_steps")
    if isinstance(raw_fallback, list):
        normalized["fallbackSteps"] = [
            _normalize_demo_step(step, index) for index, step in enumerate(raw_fallback)
        ]
    if not normalized["steps"]:
        normalized["steps"] = _preview_steps_for_app(app_subdir)
    if str(normalized["steps"][0].get("action") or "").strip() != "visit":
        normalized["steps"].insert(
            0,
            _normalize_demo_step(
                {
                    "id": "intro",
                    "label": "Open app",
                    "goal": "Load the main experience",
                    "action": "visit",
                    "url": normalized["entryPath"],
                    "pauseMs": 1500,
                    "fullPage": True,
                },
                0,
            ),
        )
    return normalized


def _extract_validation_asset_ref(data: dict[str, Any], *, kind: str) -> str:
    trace_assets = [
        asset
        for asset in _coerce_list(data.get("assets"))
        if isinstance(asset, dict) and str(asset.get("kind") or "").strip() == kind
    ]
    return str(trace_assets[0].get("storageRef") or "").strip() if trace_assets else ""


def _extract_validation_summary(value: Any) -> dict[str, Any]:
    data = _coerce_mapping(value)
    for path in (("data", "data", "result"), ("data", "result"), ("result",)):
        candidate: dict[str, Any] | None = data
        for key in path:
            candidate = _coerce_mapping(candidate.get(key) if candidate else None)
            if not candidate:
                break
        if candidate:
            data = candidate
            break
    artifact = _coerce_mapping(data.get("artifact"))
    artifact_manifest = _coerce_mapping(artifact.get("manifestJson"))
    assets = _coerce_list(artifact.get("assets") or artifact_manifest.get("assets") or data.get("assets"))
    trace_assets = [
        asset for asset in assets
        if isinstance(asset, dict) and str(asset.get("kind") or "").strip() == "trace"
    ]
    video_assets = [
        asset for asset in assets
        if isinstance(asset, dict) and str(asset.get("kind") or "").strip() == "video"
    ]
    steps = _coerce_list(artifact.get("steps") or artifact_manifest.get("steps") or data.get("steps"))
    screenshot_count = data.get("screenshots")
    if not isinstance(screenshot_count, int):
        screenshot_count = len(
            [
                step for step in steps
                if isinstance(step, dict) and str(step.get("screenshotStorageRef") or "").strip()
            ]
        )
    summary = {
        "status": str(data.get("status") or artifact.get("status") or "skipped").strip() or "skipped",
        "artifactId": str(data.get("artifactId") or artifact.get("id") or "").strip(),
        "screenshots": int(screenshot_count or 0),
        "traceAssetRef": str(data.get("traceAssetRef") or "").strip(),
        "videoAssetRef": str(data.get("videoAssetRef") or "").strip(),
        "error": str(data.get("error") or "").strip(),
        "phase": str(data.get("phase") or "").strip(),
        "baseUrl": str(artifact.get("baseUrl") or artifact_manifest.get("baseUrl") or data.get("baseUrl") or "").strip(),
        "captureMode": str(data.get("captureMode") or artifact_manifest.get("metadata", {}).get("captureMode") or "validation").strip() or "validation",
        "demoTitle": str(data.get("demoTitle") or artifact_manifest.get("metadata", {}).get("demoTitle") or "").strip(),
        "demoSummary": str(data.get("demoSummary") or artifact_manifest.get("metadata", {}).get("demoSummary") or "").strip(),
        "stepCount": int(data.get("stepCount") or len(steps) or 0),
    }
    if trace_assets and not summary["traceAssetRef"]:
        summary["traceAssetRef"] = str(trace_assets[0].get("storageRef") or "").strip()
    if video_assets and not summary["videoAssetRef"]:
        summary["videoAssetRef"] = str(video_assets[0].get("storageRef") or "").strip()
    if not summary["error"]:
        summary["error"] = str(artifact.get("error") or "").strip()
    return summary


def _resolve_validation_summary(input_data: dict, node_outputs: dict) -> dict[str, Any]:
    summary = _extract_validation_summary(_resolve(input_data, node_outputs, "validation"))
    if (
        summary.get("artifactId")
        or int(summary.get("screenshots") or 0) > 0
        or summary.get("traceAssetRef")
        or summary.get("videoAssetRef")
    ):
        return summary
    raw_summary = _extract_validation_summary(node_outputs.get("preview_capture/try/validate"))
    if (
        raw_summary.get("artifactId")
        or int(raw_summary.get("screenshots") or 0) > 0
        or raw_summary.get("traceAssetRef")
        or raw_summary.get("videoAssetRef")
    ):
        return raw_summary
    return summary


def _render_validation_lines(validation: dict[str, Any]) -> list[str]:
    status = str(validation.get("status") or "skipped").strip() or "skipped"
    capture_mode = str(validation.get("captureMode") or "validation").strip().lower()
    lines = [
        "## Demo & UX Validation" if capture_mode == "demo" else "## UX Validation",
        "",
        f"- Status: {status}",
    ]
    demo_title = str(validation.get("demoTitle") or "").strip()
    if demo_title:
        lines.append(f"- Demo: {demo_title}")
    demo_summary = str(validation.get("demoSummary") or "").strip()
    if demo_summary:
        lines.append(f"- Summary: {demo_summary}")
    step_count = validation.get("stepCount")
    if isinstance(step_count, int) and step_count > 0:
        lines.append(f"- Steps: {step_count}")
    screenshots = validation.get("screenshots")
    if isinstance(screenshots, int):
        lines.append(f"- Screenshots: {screenshots}")
    artifact_id = str(validation.get("artifactId") or "").strip()
    if artifact_id:
        lines.append(f"- Artifact: `{artifact_id}`")
    trace_ref = str(validation.get("traceAssetRef") or "").strip()
    if trace_ref:
        lines.append(f"- Trace: `{trace_ref}`")
    video_ref = str(validation.get("videoAssetRef") or "").strip()
    if video_ref:
        lines.append(f"- Video: `{video_ref}`")
    error = str(validation.get("error") or "").strip()
    if error:
        lines.append(f"- Error: {error}")
    lines.append("")
    return lines


def _build_greenfield_plan_data(
    *,
    repo: str,
    app_name: str,
    request_summary: str,
    package_manager: str,
    include_tailwind: bool,
    use_typescript: bool,
) -> dict[str, Any]:
    summary = f"Bootstrap a new SvelteKit app for {app_name} in the {repo} repository."
    step_description_lines = [
        "Create a production-ready greenfield SvelteKit app in the repository root.",
        "",
        "Implementation requirements:",
        "1. Prefer the official Svelte scaffolding CLI in a non-interactive form.",
        "2. If the official CLI cannot run cleanly in this environment, scaffold an equivalent SvelteKit project manually.",
        f"3. Use {'TypeScript' if use_typescript else 'JavaScript'} for the app source.",
        f"4. Prefer {package_manager} for package management unless the official CLI enforces another tool.",
        "5. Keep the generated app runnable with standard scripts: dev, build, preview, and check.",
        "6. Add a simple landing page that names the app and explains it is the initial greenfield bootstrap.",
        "7. Update the README with local development instructions.",
        "8. Do not create branches, commits, or pull requests inside the implementation step.",
    ]
    if include_tailwind:
        step_description_lines.append("9. Include Tailwind CSS and wire it into the initial app shell.")
    if request_summary.strip():
        step_description_lines.extend(["", "User request:", request_summary.strip()])

    return {
        "summary": summary,
        "steps": [
            {
                "title": "Scaffold the initial SvelteKit application",
                "description": "\n".join(step_description_lines),
                "files": [
                    "package.json",
                    "README.md",
                    "src/routes/+page.svelte",
                ],
                "complexity": "medium",
            }
        ],
        "critical_files": ["package.json", "src/routes/+page.svelte", "README.md"],
    }


def _cleanup_greenfield_artifacts(sandbox: OpenShellBackend, working_dir: str) -> None:
    quoted_dir = shlex.quote(working_dir)
    cleanup_cmd = (
        f"cd {quoted_dir} && "
        "touch .gitignore && "
        "for entry in '.svelte-kit/' 'build/'; do "
        "grep -qxF \"$entry\" .gitignore 2>/dev/null || printf '%s\\n' \"$entry\" >> .gitignore; "
        "done && "
        "rm -rf .svelte-kit build"
    )
    result = sandbox.execute(cleanup_cmd, timeout=60)
    if result.exit_code != 0:
        raise RuntimeError(result.output or "Failed to clean generated SvelteKit artifacts")


def _generate_demo_plan_with_agent(
    *,
    sandbox: OpenShellBackend,
    issue_context: dict[str, Any],
    plan: dict[str, Any],
    review: dict[str, Any],
    changed_files: list[str],
    model_override: str | None = None,
) -> dict[str, Any]:
    from dapr_agents import Agent
    from dapr_agents.agents.configs import AgentExecutionConfig
    from src.agents.planner import make_planner_tools
    from src.config import LLM_MODEL_ID
    from src.llm_providers import resolve_llm_client

    model = model_override or LLM_MODEL_ID
    tools = make_planner_tools(sandbox)
    changed_files_block = "\n".join(f"- {path}" for path in changed_files[:25]) or "- No changed files detected"
    review_feedback = str(review.get("feedback") or "").strip() or "No automated review feedback."
    prompt = "\n".join(
        [
            f"Issue: {issue_context.get('title', 'Untitled')}",
            issue_context.get("body", ""),
            "",
            f"Repository: {issue_context.get('owner', '')}/{issue_context.get('repo', '')}",
            f"Working directory: {issue_context.get('working_dir', '/sandbox')}",
            "",
            f"Implementation summary: {plan.get('summary', '')}",
            "Changed files:",
            changed_files_block,
            "",
            f"Automated review feedback: {review_feedback}",
            "",
            "Inspect the changed code and produce a deterministic browser demo plan as JSON only.",
            "The plan must demonstrate the main functionality created, like a concise product demo.",
            "Return an object with keys: title, summary, entryPath, confidence, steps, fallbackSteps.",
            "Each step must be an object with: id, label, goal, action, url, selector, text, value, pauseMs, waitForSelector, waitForText, successCriteria, fullPage.",
            "Allowed actions: visit, click, fill, press, wait, assert, scroll.",
            "Prefer reliable selectors or visible text. Keep the demo short and user-facing.",
        ]
    )
    system_prompt = (
        "You are a product demo planner. Study the codebase using the tools and produce only valid JSON. "
        "Your output must describe a deterministic browser walkthrough that demonstrates the implemented functionality. "
        "Do not narrate. Do not include markdown fences."
    )
    import asyncio

    agent = Agent(
        name="DemoPlannerAgent",
        role="Product Demo Planner",
        goal="Generate a deterministic browser walkthrough plan for the changed functionality",
        system_prompt=system_prompt,
        llm=resolve_llm_client(model),
        tools=tools,
        execution=AgentExecutionConfig(max_iterations=8, tool_choice="auto"),
    )
    result = asyncio.run(agent.run(prompt))
    return _parse_json_object(result.content if result else "")


def _resolve_scm_auth(
    input_data: dict,
    node_outputs: dict,
    provider: str,
) -> ScmAuth | None:
    if provider == "gitea":
        username = (
            _resolve(input_data, node_outputs, "gitea_username")
            or _resolve(input_data, node_outputs, "repositoryUsername")
        )
        secret = (
            _resolve(input_data, node_outputs, "gitea_token")
            or _resolve(input_data, node_outputs, "gitea_password")
            or _resolve(input_data, node_outputs, "repositoryToken")
        )
        return get_gitea_auth(username=username, secret=secret)

    token = (
        _resolve(input_data, node_outputs, "githubToken")
        or _resolve(input_data, node_outputs, "github_token")
        or _resolve(input_data, node_outputs, "repositoryToken")
    )
    if not token:
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            token = pool.submit(
                lambda: asyncio.run(get_github_app_installation_token())
            ).result(timeout=30)
    if not token:
        token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return None
    return ScmAuth(provider="github", username="x-access-token", secret=str(token))


def _collect_changed_files(sandbox: OpenShellBackend, working_dir: str) -> list[str]:
    result = sandbox.execute(
        f"cd {shlex.quote(working_dir)} && git status --porcelain",
        timeout=10,
    )
    changed_files: list[str] = []
    for raw_line in (result.output or "").splitlines():
        line = raw_line.strip()
        if not line or len(line) < 4:
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        if path and path not in changed_files:
            changed_files.append(path)
    return changed_files


def _reset_worktree(sandbox: OpenShellBackend, working_dir: str) -> None:
    """Reset a reused sandbox checkout to a clean remote-tracking state."""
    quoted_dir = shlex.quote(working_dir)
    sandbox.execute(
        " && ".join(
            [
                f"cd {quoted_dir}",
                "git fetch origin --prune --tags || true",
                "(git checkout -B main origin/main || git checkout -B master origin/master || true)",
                "git reset --hard HEAD",
                "git clean -fd",
            ],
        ),
        timeout=60,
    )


def _build_full_plan_step(plan: dict[str, Any], issue_context: dict[str, Any]) -> dict[str, Any]:
    """Synthesize one implementation task from a structured multi-step plan."""
    steps = plan.get("steps", [])
    summary = plan.get("summary") or issue_context.get("title") or "Implement the requested changes"
    files: list[str] = []
    for step in steps:
        for path in step.get("files", []):
            if isinstance(path, str) and path not in files:
                files.append(path)

    description_lines = [
        "Implement the full plan end to end. You are responsible for sequencing the work,",
        "iterating through the plan steps, and verifying the result before finishing.",
        "Do not create branches, commit changes, push to remotes, or open pull requests.",
        "Those SCM actions are handled by later workflow steps.",
        "",
        f"Plan summary: {summary}",
    ]
    if steps:
        description_lines.append("")
        description_lines.append("Plan steps:")
        for index, step in enumerate(steps, start=1):
            description_lines.append(f"{index}. {step.get('title', 'Untitled step')}")
            step_description = step.get("description", "").strip()
            if step_description:
                filtered_lines = []
                for raw_line in step_description.splitlines():
                    line = raw_line.strip()
                    lowered = line.lower()
                    if any(
                        marker in lowered
                        for marker in (
                            "create a new branch",
                            "checkout -b",
                            "git checkout",
                            "git commit",
                            "commit with message",
                            "git push",
                            "open a draft pull request",
                            "open a pull request",
                            "pull request",
                            "gh pr",
                        )
                    ):
                        continue
                    filtered_lines.append(raw_line)
                if filtered_lines:
                    description_lines.append("\n".join(filtered_lines))
    elif issue_context.get("body"):
        description_lines.append("")
        description_lines.append(issue_context["body"])

    complexities = [
        step.get("complexity")
        for step in steps
        if isinstance(step, dict) and step.get("complexity")
    ]
    complexity = "high" if "high" in complexities else "medium"

    return {
        "title": "Implement full plan",
        "description": "\n".join(description_lines),
        "files": files,
        "complexity": complexity,
    }


def _credential_file_path(working_dir: str) -> str:
    return f"{working_dir}/.git/dapr-swe-credentials"


def _run_local_git(
    args: list[str],
    *,
    cwd: str,
    env: dict[str, str] | None = None,
    timeout: int = 120,
) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "git command failed")
    return (result.stdout or "").strip()


def _build_staged_patch(sandbox: OpenShellBackend, working_dir: str) -> str:
    quoted_dir = shlex.quote(working_dir)
    result = sandbox.execute(
        f"cd {quoted_dir} && git add -A && git diff --cached --binary",
        timeout=30,
    )
    if result.exit_code != 0:
        raise RuntimeError(result.output or "Failed to build staged patch")
    return result.output or ""


def _commit_and_push_gitea_from_local_clone(
    *,
    clone_config,
    base_branch: str,
    branch_name: str,
    pr_title: str,
    patch_text: str,
) -> None:
    with tempfile.TemporaryDirectory(prefix="dapr-swe-gitea-") as temp_dir:
        repo_dir = os.path.join(temp_dir, "repo")
        patch_path = os.path.join(temp_dir, "changes.patch")
        credential_path = os.path.join(repo_dir, ".git", "dapr-swe-credentials")

        _run_local_git(
            [
                "git",
                "clone",
                "--branch",
                base_branch,
                clone_config.credential_url,
                repo_dir,
            ],
            cwd=temp_dir,
            timeout=120,
        )
        _run_local_git(
            ["git", "remote", "set-url", "origin", clone_config.canonical_remote_url],
            cwd=repo_dir,
        )

        with open(credential_path, "w", encoding="utf-8") as handle:
            handle.write(f"{clone_config.credential_url}\n")
        os.chmod(credential_path, 0o600)

        _run_local_git(
            ["git", "config", "credential.helper", f"store --file={credential_path}"],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "config", "credential.useHttpPath", "true"],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "config", "http.sslVerify", "false"],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "config", "user.email", clone_config.git_user_email],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "config", "user.name", clone_config.git_user_name],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "checkout", "-B", branch_name, f"origin/{base_branch}"],
            cwd=repo_dir,
        )

        with open(patch_path, "w", encoding="utf-8") as handle:
            handle.write(patch_text)

        _run_local_git(
            ["git", "apply", "--index", "--binary", patch_path],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "commit", "-m", pr_title],
            cwd=repo_dir,
        )
        _run_local_git(
            ["git", "push", "-u", "origin", branch_name],
            cwd=repo_dir,
            timeout=120,
        )


def _collect_review_diff(sandbox: OpenShellBackend, working_dir: str) -> str:
    """Return a review diff that includes tracked and untracked file changes."""
    quoted_dir = shlex.quote(working_dir)
    diff_parts: list[str] = []

    tracked_result = sandbox.execute(
        f"cd {quoted_dir} && git diff HEAD --",
        timeout=60,
    )
    tracked_diff = tracked_result.output or ""
    if tracked_diff.strip():
        diff_parts.append(tracked_diff)
    else:
        ahead_result = sandbox.execute(
            f"cd {quoted_dir} && git diff origin/main...HEAD --",
            timeout=60,
        )
        ahead_diff = ahead_result.output or ""
        if ahead_diff.strip():
            diff_parts.append(ahead_diff)

    untracked_result = sandbox.execute(
        f"cd {quoted_dir} && git ls-files --others --exclude-standard",
        timeout=30,
    )
    for raw_path in (untracked_result.output or "").splitlines():
        path = raw_path.strip()
        if not path:
            continue
        patch_result = sandbox.execute(
            f"cd {quoted_dir} && git diff --no-index -- /dev/null {shlex.quote(path)} || true",
            timeout=30,
        )
        patch = patch_result.output or ""
        if patch.strip():
            diff_parts.append(patch)

    return "\n".join(part for part in diff_parts if part.strip())


# ---------------------------------------------------------------------------
# 1. Initialize -- create sandbox, clone repo, read AGENTS.md
# ---------------------------------------------------------------------------


def handle_initialize(input_data: dict, node_outputs: dict) -> dict:
    """Create sandbox, clone the repo, and read AGENTS.md.

    Expects owner and repo in input_data (or from a trigger node output).
    Returns sandbox_id, working_dir, agents_md, github_token.
    """
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")

    if not owner or not repo:
        return {"success": False, "data": {}, "error": "Missing required fields: owner, repo"}

    provider = _resolve_provider(input_data, node_outputs)
    auth = _resolve_scm_auth(input_data, node_outputs, provider)
    if not auth:
        credential_name = "repository credentials" if provider == "gitea" else "GitHub token"
        return {"success": False, "data": {}, "error": f"No {credential_name} available"}

    # Derive deterministic sandbox ID from context
    issue_num = _resolve(input_data, node_outputs, "issue_number") or "latest"
    sandbox_id = f"dapr-swe-{provider}-{owner}-{repo}-{issue_num}"

    # Create sandbox (reconnects if sandbox_id already exists)
    try:
        sandbox = create_openshell_sandbox(sandbox_id=sandbox_id)
    except Exception as exc:
        return {"success": False, "data": {}, "error": f"Failed to create sandbox: {exc}"}

    sandbox_id = sandbox.id
    working_dir = f"/sandbox/{repo}"

    clone = build_clone_config(provider, owner, repo, auth)

    # Clone repository via the runtime's archive staging path.
    # This avoids putting SCM credentials into the shell command transport.
    check = sandbox.execute(f"test -d {working_dir}/.git && echo exists", timeout=10)
    if "exists" in (check.output or ""):
        logger.info("Repo already cloned at %s, skipping clone", working_dir)
    else:
        try:
            sandbox.clone_repository(
                repository_url=clone.canonical_remote_url,
                repository_branch=str(_resolve(input_data, node_outputs, "baseBranch") or "main"),
                repository_token=clone.repository_token,
                repository_username=clone.repository_username,
                repository_owner=str(owner),
                repository_repo=str(repo),
                target_dir=str(repo),
                timeout=300,
            )
        except Exception as exc:
            return {
                "success": False,
                "data": {"sandbox_id": sandbox_id},
                "error": f"CLONE FAIL: {str(exc)[:200]}",
            }

    # Reused sandboxes can point at a stale fork/remote from a previous run.
    # Force origin to the requested repository before any fetch/push operations.
    remote_result = sandbox.execute(
        f"cd {working_dir} && git remote get-url origin",
        timeout=10,
    )
    current_remote = (remote_result.output or "").strip()
    if remote_result.exit_code != 0 or not remote_matches(provider, current_remote, owner, repo):
        logger.info(
            "Updating origin for %s from %r to %s",
            working_dir,
            current_remote or None,
            clone.canonical_remote_url,
        )
        set_remote_result = sandbox.execute(
            f"cd {working_dir} && git remote set-url origin {shlex.quote(clone.canonical_remote_url)}",
            timeout=10,
        )
        if set_remote_result.exit_code != 0:
            return {
                "success": False,
                "data": {"sandbox_id": sandbox_id},
                "error": f"Failed to set origin remote: {set_remote_result.output}",
            }

    # Materialize a repo-scoped credential file out of band so later git push
    # never needs to carry credentials in the OpenShell command payload.
    try:
        sandbox.materialize_files(
            [
                (
                    _credential_file_path(working_dir),
                    f"{clone.credential_url}\n".encode("utf-8"),
                    0o600,
                )
            ],
            timeout=30,
        )
    except Exception as exc:
        return {
            "success": False,
            "data": {"sandbox_id": sandbox_id},
            "error": f"Failed to materialize git credentials: {exc}",
        }
    credential_file = _credential_file_path(working_dir)
    git_auth_result = sandbox.execute(
        f"cd {working_dir} && "
        f"git config credential.helper {shlex.quote(f'store --file={credential_file}')} && "
        "git config credential.useHttpPath true && "
        "git config http.sslVerify false",
        timeout=10,
    )
    if git_auth_result.exit_code != 0:
        return {
            "success": False,
            "data": {"sandbox_id": sandbox_id},
            "error": f"Failed to configure git credentials: {git_auth_result.output}",
        }

    # Reused sandboxes can retain stale branches and untracked files from prior runs.
    # Reset to a clean remote-tracking checkout before planning or implementation.
    _reset_worktree(sandbox, working_dir)

    # Configure git identity
    sandbox.execute(
        configure_git_identity_command(working_dir, clone),
        timeout=10,
    )

    # Read AGENTS.md if present
    agents_md = ""
    agents_result = sandbox.execute(f"cat {working_dir}/AGENTS.md 2>/dev/null", timeout=10)
    if agents_result.exit_code == 0 and agents_result.output.strip():
        agents_md = agents_result.output.strip()

    # Publish workflow started event (best-effort, non-blocking).
    # NOTE: Do NOT call register_execution() here — this handler is called
    # by the orchestrator via function-router. The BFF webhook already created
    # the execution record. Calling register_execution() would hit the BFF's
    # /api/internal/agent/workflows/execute which starts a NEW orchestrator
    # workflow, creating an infinite cascade loop.
    issue_ref = f"{owner}/{repo}#{input_data.get('issue_number', '')}"
    publish_event("dapr-swe.workflow.started", {"issue": issue_ref, "title": input_data.get("title", ""), "sandbox_id": sandbox_id})

    return {
        "success": True,
        "data": {
            "provider": provider,
            "sandbox_id": sandbox_id,
            "working_dir": working_dir,
            "agents_md": agents_md,
            "github_token": auth.secret if provider == "github" else "",
            "gitea_username": auth.username if provider == "gitea" else "",
            "gitea_token": auth.secret if provider == "gitea" else "",
            "wb_execution_id": "",
        },
        "error": None,
    }


# ---------------------------------------------------------------------------
# 2. Plan -- run PlannerAgent
# ---------------------------------------------------------------------------


def handle_plan(input_data: dict, node_outputs: dict) -> dict:
    """Run the PlannerAgent to produce an implementation plan.

    Expects sandbox_id and issue context (issue_number, title, body, etc.).
    """
    from src.agents.planner import run_planner

    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    if not sandbox_id:
        return {"success": False, "data": {}, "error": "Missing required field: sandbox_id"}

    sandbox = _reconnect_sandbox(sandbox_id)

    # Build issue context from all available fields
    issue_context = {}
    for key in ("provider", "owner", "repo", "issue_number", "title", "body", "comments",
                "sender", "working_dir", "agents_md", "github_token", "gitea_username", "gitea_token"):
        val = _resolve(input_data, node_outputs, key)
        if val is not None:
            issue_context[key] = val

    # Resolve optional configuration overrides from workflow-builder UI
    model = _resolve(input_data, node_outputs, "model")
    max_iters = _resolve(input_data, node_outputs, "maxIterations")
    prompt_extra = _resolve(input_data, node_outputs, "systemPromptOverride")

    try:
        plan = run_planner(
            sandbox, issue_context,
            model_override=model,
            max_iterations=int(max_iters) if max_iters else None,
            system_prompt_extra=prompt_extra,
        )
    except Exception as exc:
        logger.exception("PlannerAgent failed")
        return {"success": False, "data": {}, "error": f"PlannerAgent failed: {exc}"}

    # Publish plan-created events
    wb_exec_id, dapr_instance_id = _resolve_execution_ids(input_data, node_outputs)
    issue_ref = f"{_resolve(input_data, node_outputs, 'owner')}/{_resolve(input_data, node_outputs, 'repo')}#{_resolve(input_data, node_outputs, 'issue_number')}"
    publish_event("dapr-swe.plan.created", {"issue": issue_ref, "summary": plan.get("summary", ""), "steps": len(plan.get("steps", []))})
    update_execution_status(wb_exec_id, "planning", 25)
    post_agent_event(
        wb_exec_id,
        dapr_instance_id,
        "plan_created",
        {"phase": "planning", "summary": plan.get("summary", ""), "stepCount": len(plan.get("steps", []))},
    )

    return {
        "success": True,
        "data": {
            "plan": plan,
            "summary": plan.get("summary", ""),
            "step_count": len(plan.get("steps", [])),
        },
        "error": None,
    }


# ---------------------------------------------------------------------------
# 3. Develop -- run DeveloperAgent for a single step
# ---------------------------------------------------------------------------


def handle_develop(input_data: dict, node_outputs: dict) -> dict:
    """Run the DeveloperAgent once for an explicit step or the full plan."""
    from src.agents.developer import run_developer

    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    if not sandbox_id:
        return {"success": False, "data": {}, "error": "Missing required field: sandbox_id"}

    sandbox = _reconnect_sandbox(sandbox_id)

    # Build issue context from all available sources
    issue_context = {}
    for key in ("provider", "owner", "repo", "issue_number", "title", "body", "comments",
                "sender", "working_dir", "agents_md", "github_token", "gitea_username", "gitea_token"):
        val = _resolve(input_data, node_outputs, key)
        if val is not None:
            issue_context[key] = val

    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))

    # Resolve event tracking context
    wb_exec_id, dapr_instance_id = _resolve_execution_ids(input_data, node_outputs)
    issue_ref = f"{_resolve(input_data, node_outputs, 'owner')}/{_resolve(input_data, node_outputs, 'repo')}#{_resolve(input_data, node_outputs, 'issue_number')}"

    # Resolve optional configuration overrides from workflow-builder UI
    model = _resolve(input_data, node_outputs, "model")
    max_iters = _resolve(input_data, node_outputs, "maxIterations")
    prompt_extra = _resolve(input_data, node_outputs, "systemPromptOverride")
    dev_overrides = dict(
        model_override=model,
        max_iterations=int(max_iters) if max_iters else None,
        system_prompt_extra=prompt_extra,
    )

    step = _coerce_mapping(_resolve(input_data, node_outputs, "step"))

    if not step:
        step = _build_full_plan_step(plan, issue_context)

    publish_event("dapr-swe.step.started", {"issue": issue_ref, "step_index": 0, "step_title": step.get("title", "")})
    try:
        result = run_developer(
            sandbox=sandbox,
            step=step,
            issue_context=issue_context,
            plan=plan,
            **dev_overrides,
        )
    except Exception as exc:
        logger.exception("DeveloperAgent failed")
        return {"success": False, "data": {}, "error": f"DeveloperAgent failed: {exc}"}

    publish_event("dapr-swe.step.completed", {"issue": issue_ref, "step_index": 0, "step_title": step.get("title", ""), "status": result.get("status", "")})
    update_execution_status(wb_exec_id, "implementing", 50)
    post_agent_event(
        wb_exec_id,
        dapr_instance_id,
        "step_completed",
        {"phase": "implementing", "stepIndex": 0, "stepTitle": step.get("title", "")},
    )

    changed_files = _collect_changed_files(
        sandbox,
        issue_context.get("working_dir", "/sandbox"),
    )
    status = "changes_ready" if changed_files else "no_changes"

    return {
        "success": True,
        "data": {
            "status": status,
            "summary": result.get("summary", ""),
            "files_changed": changed_files,
        },
        "error": None,
    }


# ---------------------------------------------------------------------------
# 4. Review -- run ReviewerAgent on the full diff
# ---------------------------------------------------------------------------


def handle_review(input_data: dict, node_outputs: dict) -> dict:
    """Run the ReviewerAgent on the current diff.

    Expects sandbox_id, working_dir, and issue/plan context.
    """
    from src.agents.reviewer import run_reviewer

    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")

    if not sandbox_id:
        return {"success": False, "data": {}, "error": "Missing required field: sandbox_id"}
    if not working_dir:
        return {"success": False, "data": {}, "error": "Missing required field: working_dir"}

    sandbox = _reconnect_sandbox(sandbox_id)

    diff = _collect_review_diff(sandbox, working_dir)

    if not diff.strip():
        return {
            "success": True,
            "data": {
                "approved": False,
                "status": "no_changes",
                "feedback": "No changes to review",
                "suggestions": [],
            },
            "error": None,
        }

    # Build issue context and plan
    issue_context = {}
    for key in ("owner", "repo", "issue_number", "title", "body"):
        val = _resolve(input_data, node_outputs, key)
        if val is not None:
            issue_context[key] = val

    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))

    # Resolve optional configuration overrides from workflow-builder UI
    model = _resolve(input_data, node_outputs, "model")

    try:
        review = run_reviewer(diff=diff, issue_context=issue_context, plan=plan, model_override=model)
    except Exception as exc:
        logger.exception("ReviewerAgent failed")
        review = {
            "approved": False,
            "feedback": f"Automated review failed: {exc}",
            "suggestions": [
                "Inspect the reviewer logs and provider credentials, then rerun the workflow.",
            ],
            "review_error": str(exc),
        }

    # Publish review events
    wb_exec_id, _ = _resolve_execution_ids(input_data, node_outputs)
    issue_ref = f"{_resolve(input_data, node_outputs, 'owner')}/{_resolve(input_data, node_outputs, 'repo')}#{_resolve(input_data, node_outputs, 'issue_number')}"
    update_execution_status(wb_exec_id, "reviewing", 75)
    publish_event("dapr-swe.review.completed", {"issue": issue_ref, "approved": review.get("approved", False)})

    return {
        "success": True,
        "data": {
            "approved": review.get("approved", False),
            "status": "approved" if review.get("approved", False) else "review_rejected",
            "feedback": review.get("feedback", ""),
            "suggestions": review.get("suggestions", []),
            "review_error": review.get("review_error", ""),
        },
        "error": None,
    }


# ---------------------------------------------------------------------------
# 5. Commit & PR -- stage, commit, push, and open a GitHub PR
# ---------------------------------------------------------------------------


def handle_commit_pr(input_data: dict, node_outputs: dict) -> dict:
    """Stage changes, create branch, commit, push, and open a GitHub PR.

    Expects sandbox_id, working_dir, owner, repo, issue_number, github_token.
    """
    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")
    issue_number = _resolve(input_data, node_outputs, "issue_number")
    provider = _resolve_provider(input_data, node_outputs)
    auth = _resolve_scm_auth(input_data, node_outputs, provider)
    title = _resolve(input_data, node_outputs, "title") or "Untitled issue"
    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))
    review = _coerce_mapping(_resolve(input_data, node_outputs, "review"))
    validation = _resolve_validation_summary(input_data, node_outputs)

    for field, val in [("sandbox_id", sandbox_id), ("working_dir", working_dir),
                       ("owner", owner), ("repo", repo),
                       ("issue_number", issue_number)]:
        if not val:
            return {"success": False, "data": {}, "error": f"Missing required field: {field}"}
    if not auth:
        credential_name = "repository credentials" if provider == "gitea" else "GitHub token"
        return {"success": False, "data": {}, "error": f"Missing required field: {credential_name}"}
    if review and review.get("approved") is False:
        return {
            "success": True,
            "data": {"pr_url": "", "branch": "", "status": "review_rejected"},
            "error": None,
        }

    # Resolve optional configuration overrides from workflow-builder UI
    draft = _resolve(input_data, node_outputs, "draft")
    base_branch = _resolve(input_data, node_outputs, "baseBranch") or "main"
    pr_title = _resolve(input_data, node_outputs, "prTitle") or f"fix: {title} [closes #{issue_number}]"

    # draft is True unless explicitly set to "false"
    is_draft = True if draft is None else str(draft).lower() != "false"

    sandbox = _reconnect_sandbox(sandbox_id)
    import time; branch_name = f"dapr-swe/issue-{issue_number}-{int(time.time())}"

    # Check for actual changes
    changed_files = _collect_changed_files(sandbox, working_dir)
    if not changed_files:
        return {
            "success": True,
            "data": {"pr_url": "", "branch": branch_name, "status": "no_changes"},
            "error": None,
        }

    # Configure git user, create branch, stage, commit
    clone = build_clone_config(provider, owner, repo, auth)
    if provider == "gitea":
        try:
            patch_text = _build_staged_patch(sandbox, working_dir)
        except Exception as exc:
            return {
                "success": False,
                "data": {"branch": branch_name},
                "error": f"Failed to build staged patch: {exc}",
            }
        if not patch_text.strip():
            return {
                "success": True,
                "data": {"pr_url": "", "branch": branch_name, "status": "no_changes"},
                "error": None,
            }
        try:
            _commit_and_push_gitea_from_local_clone(
                clone_config=clone,
                base_branch=str(base_branch),
                branch_name=branch_name,
                pr_title=str(pr_title),
                patch_text=patch_text,
            )
        except Exception as exc:
            return {
                "success": False,
                "data": {"branch": branch_name},
                "error": f"Push failed: {exc}",
            }
    else:
        commit_result = sandbox.execute(
            configure_git_identity_command(working_dir, clone)
            + " && "
            + f"git checkout -B {branch_name} && "
            "git add -A && "
            f'git commit -m "{pr_title}"',
            timeout=60,
        )
        if commit_result.exit_code != 0:
            return {
                "success": False,
                "data": {"branch": branch_name},
                "error": f"Failed to commit: {commit_result.output}",
            }

        credential_file = _credential_file_path(working_dir)
        git_auth_result = sandbox.execute(
            f"cd {working_dir} && "
            f"git config credential.helper {shlex.quote(f'store --file={credential_file}')} && "
            "git config credential.useHttpPath true && "
            "git config http.sslVerify false",
            timeout=10,
        )
        if git_auth_result.exit_code != 0:
            return {
                "success": False,
                "data": {"branch": branch_name},
                "error": f"Failed to configure git push credentials: {git_auth_result.output}",
            }
        push_result = sandbox.execute(
            f"cd {working_dir} && git push -u origin {branch_name}",
            timeout=120,
        )
        if push_result.exit_code != 0:
            return {
                "success": False,
                "data": {"branch": branch_name},
                "error": f"Push failed: {push_result.output}",
            }

    # Open PR via SCM API
    pr_body = build_pr_body(plan, int(issue_number), validation=validation)
    try:
        pr_result = create_pull_request(
            provider=provider,
            owner=owner,
            repo=repo,
            head_branch=branch_name,
            base_branch=str(base_branch),
            title=str(pr_title),
            body=pr_body,
            auth=auth,
            draft=is_draft,
        )
    except Exception as exc:
        return {
            "success": False,
            "data": {"branch": branch_name},
            "error": f"SCM API request failed: {exc}",
        }

    if pr_result["status"] == "success":
        pr_url = pr_result.get("pr_url", "")
        publish_event("dapr-swe.pr.created", {"issue": f"{owner}/{repo}#{issue_number}", "pr_url": pr_url})
        return {
            "success": True,
            "data": {"pr_url": pr_url, "branch": branch_name, "status": "success"},
            "error": None,
        }
    if pr_result["status"] == "already_exists":
        return {
            "success": True,
            "data": {"pr_url": "", "branch": branch_name, "status": "already_exists"},
            "error": None,
        }
    return {
        "success": False,
        "data": {"branch": branch_name},
        "error": f"PR creation failed: {pr_result.get('error') or pr_result.get('detail') or 'Unknown error'}",
    }


# ---------------------------------------------------------------------------
# 6. Notify -- post a result-specific issue comment
# ---------------------------------------------------------------------------


def handle_notify(input_data: dict, node_outputs: dict) -> dict:
    provider = _resolve_provider(input_data, node_outputs)
    auth = _resolve_scm_auth(input_data, node_outputs, provider)
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")
    issue_number = _resolve(input_data, node_outputs, "issue_number")
    pr_url = _resolve(input_data, node_outputs, "pr_url") or ""
    status = _resolve(input_data, node_outputs, "status") or ""
    error = _resolve(input_data, node_outputs, "error") or ""
    review = _coerce_mapping(_resolve(input_data, node_outputs, "review"))
    validation = _resolve_validation_summary(input_data, node_outputs)

    for field, val in [("owner", owner), ("repo", repo), ("issue_number", issue_number)]:
        if not val:
            return {"success": False, "data": {}, "error": f"Missing required field: {field}"}
    if not auth:
        credential_name = "repository credentials" if provider == "gitea" else "GitHub token"
        return {"success": False, "data": {}, "error": f"Missing required field: {credential_name}"}

    if status == "success" and pr_url:
        body = (
            f"I've opened a draft PR with the implementation: {pr_url}\n\n"
            f"Review: {'Approved' if review.get('approved') else 'Needs changes'}\n"
            f"Feedback: {review.get('feedback', 'N/A')}"
        )
        validation_lines = _render_validation_lines(validation)
        if validation_lines:
            body += "\n\n" + "\n".join(validation_lines).strip()
    elif status == "no_changes":
        body = (
            "I investigated this issue and did not find any repository changes to make.\n\n"
            f"Summary: {review.get('feedback') or 'No code changes were produced.'}"
        )
    elif status == "review_rejected":
        body = (
            "I implemented changes, but the automated review did not approve them.\n\n"
            f"Feedback: {review.get('feedback', 'Review rejected the changes.')}"
        )
    elif status == "already_exists":
        body = "A pull request for this issue already exists, so I did not open a new one."
    else:
        body = (
            "I encountered an error while trying to resolve this issue.\n\n"
            f"Error: {error or 'Unknown error'}"
        )

    try:
        post_provider_issue_comment(
            provider=provider,
            owner=str(owner),
            repo=str(repo),
            issue_number=int(issue_number),
            body=body,
            auth=auth,
        )
    except Exception as exc:
        logger.exception("Failed to post completion comment")
        return {"success": False, "data": {}, "error": f"Failed to post issue comment: {exc}"}

    publish_event(
        "dapr-swe.workflow.completed",
        {
            "issue": f"{owner}/{repo}#{issue_number}",
            "status": status or "completed",
            "pr_url": pr_url,
        },
    )
    return {
        "success": True,
        "data": {"status": status or "completed", "pr_url": pr_url, "notified": True},
        "error": None,
    }


def handle_create_repo(input_data: dict, node_outputs: dict) -> dict:
    """Create or reuse a greenfield repository in Gitea."""
    provider = _resolve_provider(input_data, node_outputs)
    owner = str(_resolve(input_data, node_outputs, "owner") or "").strip()
    repo = str(_resolve(input_data, node_outputs, "repo") or "").strip()
    description = str(_resolve(input_data, node_outputs, "description") or "").strip()
    app_name = str(_resolve(input_data, node_outputs, "app_name") or repo).strip() or repo
    private = _as_bool(_resolve(input_data, node_outputs, "private"), False)
    default_branch = str(_resolve(input_data, node_outputs, "baseBranch") or "main").strip() or "main"

    if not owner or not repo:
        return {"success": False, "data": {}, "error": "Missing required fields: owner, repo"}
    if provider != "gitea":
        return {"success": False, "data": {}, "error": "Greenfield SvelteKit bootstrap currently supports provider=gitea only"}

    auth = _resolve_scm_auth(input_data, node_outputs, provider)
    if not auth:
        return {"success": False, "data": {}, "error": "No repository credentials available"}

    repo_result = create_repository(
        provider=provider,
        owner=owner,
        repo=repo,
        auth=auth,
        description=description or f"Greenfield SvelteKit app for {app_name}",
        private=private,
        default_branch=default_branch,
        auto_init=True,
        gitignore_template="Node",
    )
    if repo_result.get("status") not in {"created", "exists"}:
        return {
            "success": False,
            "data": {},
            "error": str(repo_result.get("error") or "Failed to create repository"),
        }

    publish_event(
        "dapr-swe.greenfield.repo.ready",
        {
            "repo": f"{owner}/{repo}",
            "status": repo_result.get("status"),
            "repo_url": repo_result.get("repo_url", ""),
        },
    )
    return {
        "success": True,
        "data": {
            "provider": provider,
            "owner": owner,
            "repo": repo,
            "app_name": app_name,
            "repo_url": repo_result.get("repo_url", ""),
            "clone_url": repo_result.get("clone_url", ""),
            "default_branch": repo_result.get("default_branch", default_branch),
            "status": repo_result.get("status", "created"),
            "private": private,
        },
        "error": None,
    }


def handle_greenfield_plan(input_data: dict, node_outputs: dict) -> dict:
    """Build a deterministic bootstrap plan for a new SvelteKit app."""
    repo = str(_resolve(input_data, node_outputs, "repo") or "").strip()
    if not repo:
        return {"success": False, "data": {}, "error": "Missing required field: repo"}

    app_name = str(_resolve(input_data, node_outputs, "app_name") or repo).strip() or repo
    request_summary = str(_resolve(input_data, node_outputs, "body") or _resolve(input_data, node_outputs, "description") or "").strip()
    package_manager = str(_resolve(input_data, node_outputs, "package_manager") or "npm").strip().lower() or "npm"
    if package_manager not in {"npm", "pnpm", "yarn"}:
        package_manager = "npm"
    include_tailwind = _as_bool(_resolve(input_data, node_outputs, "include_tailwind"), False)
    use_typescript = _as_bool(_resolve(input_data, node_outputs, "use_typescript"), True)

    plan = _build_greenfield_plan_data(
        repo=repo,
        app_name=app_name,
        request_summary=request_summary,
        package_manager=package_manager,
        include_tailwind=include_tailwind,
        use_typescript=use_typescript,
    )
    return {
        "success": True,
        "data": {
            "plan": plan,
            "summary": plan["summary"],
            "step_count": len(plan.get("steps", [])),
            "app_name": app_name,
            "package_manager": package_manager,
            "include_tailwind": include_tailwind,
            "use_typescript": use_typescript,
        },
        "error": None,
    }


def handle_plan_demo(input_data: dict, node_outputs: dict) -> dict:
    """Infer a deterministic demo walkthrough for the changed functionality."""
    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    if not sandbox_id or not working_dir:
        return {"success": False, "data": {}, "error": "Missing required fields: sandbox_id, working_dir"}

    sandbox = _reconnect_sandbox(str(sandbox_id))
    issue_context: dict[str, Any] = {}
    for key in ("owner", "repo", "issue_number", "title", "body", "working_dir"):
        val = _resolve(input_data, node_outputs, key)
        if val is not None:
            issue_context[key] = val
    issue_context.setdefault("working_dir", working_dir)

    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))
    review = _coerce_mapping(_resolve(input_data, node_outputs, "review"))
    model = _resolve(input_data, node_outputs, "model")
    changed_files = _collect_changed_files(sandbox, str(working_dir))
    default_plan = _default_demo_plan(
        app_subdir=".",
        summary="Open the updated experience and demonstrate the primary functionality.",
    )
    try:
        inferred = _generate_demo_plan_with_agent(
            sandbox=sandbox,
            issue_context=issue_context,
            plan=plan,
            review=review,
            changed_files=changed_files,
            model_override=str(model).strip() if model else None,
        )
        demo_plan = _normalize_demo_plan(inferred, app_subdir=".")
        planning_error = ""
    except Exception as exc:
        logger.exception("Demo planner failed")
        demo_plan = default_plan
        planning_error = str(exc)

    wb_exec_id, dapr_instance_id = _resolve_execution_ids(input_data, node_outputs)
    if wb_exec_id and dapr_instance_id:
        update_execution_status(wb_exec_id, "preview_planning", 79)
        post_agent_event(
            wb_exec_id,
            dapr_instance_id,
            "demo_plan_created",
            {
                "phase": "preview_planning",
                "captureMode": "demo",
                "demoTitle": demo_plan.get("title", ""),
                "demoSummary": demo_plan.get("summary", ""),
                "stepCount": len(_coerce_list(demo_plan.get("steps"))),
                "confidence": demo_plan.get("confidence", ""),
            },
        )

    return {
        "success": True,
        "data": {
            "demoPlan": demo_plan,
            "captureMode": "demo",
            "demoTitle": demo_plan.get("title", ""),
            "demoSummary": demo_plan.get("summary", ""),
            "stepCount": len(_coerce_list(demo_plan.get("steps"))),
            "planningError": planning_error,
        },
        "error": None,
    }


def handle_greenfield_scaffold(input_data: dict, node_outputs: dict) -> dict:
    """Scaffold a new SvelteKit app in the target repository."""
    from src.agents.developer import run_developer

    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")
    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))
    agents_md = _resolve(input_data, node_outputs, "agents_md") or ""

    for field, val in [("sandbox_id", sandbox_id), ("working_dir", working_dir), ("owner", owner), ("repo", repo)]:
        if not val:
            return {"success": False, "data": {}, "error": f"Missing required field: {field}"}
    if not plan:
        return {"success": False, "data": {}, "error": "Missing required field: plan"}

    sandbox = _reconnect_sandbox(str(sandbox_id))
    app_name = str(_resolve(input_data, node_outputs, "app_name") or repo).strip() or str(repo)
    request_summary = str(_resolve(input_data, node_outputs, "body") or _resolve(input_data, node_outputs, "description") or "").strip()
    package_manager = str(_resolve(input_data, node_outputs, "package_manager") or "npm").strip().lower() or "npm"
    include_tailwind = _as_bool(_resolve(input_data, node_outputs, "include_tailwind"), False)
    use_typescript = _as_bool(_resolve(input_data, node_outputs, "use_typescript"), True)

    issue_context = {
        "owner": owner,
        "repo": repo,
        "title": f"Bootstrap a new SvelteKit app for {app_name}",
        "body": request_summary or f"Create a new greenfield SvelteKit app called {app_name}.",
        "working_dir": working_dir,
        "agents_md": agents_md,
    }
    step = _build_full_plan_step(plan, issue_context)
    style_line = "Include Tailwind CSS in the initial scaffold." if include_tailwind else "Use standard SvelteKit styling without Tailwind unless the scaffold adds it by default."
    system_prompt_extra = "\n".join(
        [
            "This is a greenfield repository bootstrap task.",
            "You may use the official Svelte scaffolding CLI in a non-interactive form if available.",
            "If the official CLI fails or requires unsupported interaction, manually create an equivalent SvelteKit project structure.",
            f"Prefer {package_manager} unless the official Svelte tooling chooses a different package manager during scaffolding.",
            f"Use {'TypeScript' if use_typescript else 'JavaScript'} in the generated source.",
            style_line,
            "It is acceptable to install dependencies for this bootstrap task.",
            "Do not create branches, commits, or pull requests in this step.",
        ]
    )
    model = _resolve(input_data, node_outputs, "model")

    try:
        result = run_developer(
            sandbox=sandbox,
            step=step,
            issue_context=issue_context,
            plan=plan,
            model_override=model,
            max_iterations=80,
            system_prompt_extra=system_prompt_extra,
        )
    except Exception as exc:
        logger.exception("Greenfield scaffold failed")
        return {"success": False, "data": {}, "error": f"Greenfield scaffold failed: {exc}"}

    try:
        _cleanup_greenfield_artifacts(sandbox, str(working_dir))
    except Exception as exc:
        logger.exception("Greenfield cleanup failed")
        return {"success": False, "data": {}, "error": f"Greenfield cleanup failed: {exc}"}

    changed_files = _collect_changed_files(sandbox, str(working_dir))
    status = "changes_ready" if changed_files else "no_changes"
    publish_event(
        "dapr-swe.greenfield.scaffold.completed",
        {"repo": f"{owner}/{repo}", "status": status, "files_changed": len(changed_files)},
    )
    return {
        "success": True,
        "data": {
            "status": status,
            "summary": result.get("summary", ""),
            "files_changed": changed_files,
        },
        "error": None,
    }


def handle_greenfield_publish(input_data: dict, node_outputs: dict) -> dict:
    """Commit bootstrap changes and open a PR for a new greenfield repository."""
    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")
    provider = _resolve_provider(input_data, node_outputs)
    auth = _resolve_scm_auth(input_data, node_outputs, provider)
    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))
    review = _coerce_mapping(_resolve(input_data, node_outputs, "review"))
    validation = _resolve_validation_summary(input_data, node_outputs)
    app_name = str(_resolve(input_data, node_outputs, "app_name") or repo).strip() or str(repo)
    request_summary = str(_resolve(input_data, node_outputs, "body") or _resolve(input_data, node_outputs, "description") or "").strip()
    repo_url = str(_resolve(input_data, node_outputs, "repo_url") or "").strip()

    for field, val in [("sandbox_id", sandbox_id), ("working_dir", working_dir), ("owner", owner), ("repo", repo)]:
        if not val:
            return {"success": False, "data": {}, "error": f"Missing required field: {field}"}
    if not auth:
        return {"success": False, "data": {}, "error": "Missing required field: repository credentials"}

    base_branch = str(_resolve(input_data, node_outputs, "baseBranch") or "main").strip() or "main"
    pr_title = str(_resolve(input_data, node_outputs, "prTitle") or f"feat: bootstrap {app_name} SvelteKit app").strip()
    is_draft = False if _resolve(input_data, node_outputs, "draft") in {False, "false", "0"} else True
    review_rejected = bool(review and review.get("approved") is False)
    if review_rejected:
        is_draft = True

    sandbox = _reconnect_sandbox(str(sandbox_id))
    import time
    branch_name = f"bootstrap/sveltekit-{int(time.time())}"

    changed_files = _collect_changed_files(sandbox, str(working_dir))
    if not changed_files:
        return {
            "success": True,
            "data": {"pr_url": "", "branch": branch_name, "status": "no_changes", "repo_url": repo_url},
            "error": None,
        }

    clone = build_clone_config(provider, str(owner), str(repo), auth)
    if provider == "gitea":
        try:
            patch_text = _build_staged_patch(sandbox, str(working_dir))
        except Exception as exc:
            return {"success": False, "data": {"branch": branch_name}, "error": f"Failed to build staged patch: {exc}"}
        if not patch_text.strip():
            return {
                "success": True,
                "data": {"pr_url": "", "branch": branch_name, "status": "no_changes", "repo_url": repo_url},
                "error": None,
            }
        try:
            _commit_and_push_gitea_from_local_clone(
                clone_config=clone,
                base_branch=base_branch,
                branch_name=branch_name,
                pr_title=pr_title,
                patch_text=patch_text,
            )
        except Exception as exc:
            return {"success": False, "data": {"branch": branch_name}, "error": f"Push failed: {exc}"}
    else:
        return {"success": False, "data": {}, "error": "Greenfield SvelteKit bootstrap currently supports provider=gitea only"}

    pr_body = build_greenfield_pr_body(
        app_name=app_name,
        request_summary=request_summary,
        plan=plan,
        review=review,
        validation=validation,
    )
    try:
        pr_result = create_pull_request(
            provider=provider,
            owner=str(owner),
            repo=str(repo),
            head_branch=branch_name,
            base_branch=base_branch,
            title=pr_title,
            body=pr_body,
            auth=auth,
            draft=is_draft,
        )
    except Exception as exc:
        return {"success": False, "data": {"branch": branch_name}, "error": f"SCM API request failed: {exc}"}

    if pr_result["status"] == "success":
        pr_url = pr_result.get("pr_url", "")
        publish_event("dapr-swe.greenfield.pr.created", {"repo": f"{owner}/{repo}", "pr_url": pr_url})
        return {
            "success": True,
            "data": {
                "pr_url": pr_url,
                "branch": branch_name,
                "status": "success",
                "repo_url": repo_url,
                "review_status": "review_rejected" if review_rejected else "approved",
            },
            "error": None,
        }
    if pr_result["status"] == "already_exists":
        return {
            "success": True,
            "data": {"pr_url": "", "branch": branch_name, "status": "already_exists", "repo_url": repo_url},
            "error": None,
        }
    return {
        "success": False,
        "data": {"branch": branch_name, "repo_url": repo_url},
        "error": f"PR creation failed: {pr_result.get('error') or pr_result.get('detail') or 'Unknown error'}",
    }


def handle_prepare_preview(input_data: dict, node_outputs: dict) -> dict:
    """Inspect the repo and determine whether screenshot validation should run."""
    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    if not sandbox_id or not working_dir:
        return {
            "success": False,
            "data": {},
            "error": "Missing required fields: sandbox_id, working_dir",
        }

    sandbox = _reconnect_sandbox(str(sandbox_id))
    find_result = sandbox.execute(
        " && ".join(
            [
                f"cd {shlex.quote(str(working_dir))}",
                "find . -path '*/node_modules' -prune -o -name package.json -print | sort",
            ]
        ),
        timeout=20,
    )
    if find_result.exit_code != 0:
        return {
            "success": True,
            "data": {
                "should_validate": False,
                "reason": "Could not inspect package manifests for preview validation.",
            },
            "error": None,
        }

    candidate_paths: list[str] = []
    for raw_line in (find_result.output or "").splitlines():
        rel_path = raw_line.strip().removeprefix("./")
        if not rel_path:
            continue
        candidate_paths.append(posixpath.join(str(working_dir), rel_path))

    if not candidate_paths:
        return {
            "success": True,
            "data": {
                "should_validate": False,
                "reason": "No package.json files were found, so browser validation is not applicable.",
            },
            "error": None,
        }

    downloads = sandbox.download_files(candidate_paths)
    best_candidate: dict[str, Any] | None = None
    for download in downloads:
        if download.error:
            continue
        try:
            package_json = json.loads(download.content.decode("utf-8"))
        except Exception:
            continue
        if not isinstance(package_json, dict):
            continue
        scripts = package_json.get("scripts") if isinstance(package_json.get("scripts"), dict) else {}
        dependencies: dict[str, Any] = {}
        for section in ("dependencies", "devDependencies"):
            value = package_json.get(section)
            if isinstance(value, dict):
                dependencies.update(value)
        framework_hits = sum(
            1
            for dep_name in (
                "next",
                "vite",
                "react-scripts",
                "@sveltejs/kit",
                "nuxt",
                "astro",
            )
            if dep_name in dependencies
        )
        has_dev_script = isinstance(scripts.get("dev"), str) and str(scripts.get("dev")).strip()
        has_start_script = isinstance(scripts.get("start"), str) and str(scripts.get("start")).strip()
        if not has_dev_script and not has_start_script and framework_hits == 0:
            continue
        app_dir = posixpath.dirname(download.path)
        rel_app_dir = _safe_relpath(app_dir, str(working_dir))
        score = 0
        if rel_app_dir == ".":
            score += 5
        score += framework_hits * 3
        if has_dev_script:
            score += 4
        if has_start_script:
            score += 1
        candidate = {
            "repo_path": app_dir,
            "app_subdir": rel_app_dir,
            "score": score,
        }
        if not best_candidate or candidate["score"] > best_candidate["score"]:
            best_candidate = candidate

    if not best_candidate:
        return {
            "success": True,
            "data": {
                "should_validate": False,
                "reason": "No frontend dev server entrypoint was detected for browser validation.",
            },
            "error": None,
        }

    lockfile_check = sandbox.execute(
        " && ".join(
            [
                f"cd {shlex.quote(best_candidate['repo_path'])}",
                "for file in pnpm-lock.yaml pnpm-workspace.yaml package-lock.json yarn.lock; do [ -f \"$file\" ] && echo \"$file\"; done",
            ]
        ),
        timeout=10,
    )
    lockfiles = {line.strip() for line in (lockfile_check.output or "").splitlines() if line.strip()}
    package_manager = _detect_package_manager(lockfiles)
    install_command = ""
    dev_server_command = ""
    if package_manager:
        install_command = {
            "pnpm": "npx -y pnpm@9.15.9 install --reporter=append-only --frozen-lockfile --prefer-offline --force",
            "yarn": "npx -y yarn@1.22.22 install --immutable",
            "npm": "npm ci --no-audit --no-fund --loglevel=warn",
        }.get(package_manager, "")

    demo_plan = _normalize_demo_plan(
        _coerce_mapping(_resolve(input_data, node_outputs, "demoPlan") or _resolve(input_data, node_outputs, "demo_plan")),
        app_subdir=best_candidate["app_subdir"],
    )
    steps = _coerce_list(demo_plan.get("steps")) or _preview_steps_for_app(best_candidate["app_subdir"])

    return {
        "success": True,
        "data": {
            "should_validate": True,
            "workspaceRef": str(sandbox_id),
            "repoPath": best_candidate["repo_path"],
            "appSubdir": best_candidate["app_subdir"],
            "installCommand": install_command,
            "devServerCommand": dev_server_command,
            "baseUrl": "http://127.0.0.1:3009",
            "steps": steps,
            "captureTrace": True,
            "captureVideo": True,
            "viewportPreset": "desktop",
            "captureMode": "demo" if steps else "validation",
            "demoTitle": str(demo_plan.get("title") or "").strip(),
            "demoSummary": str(demo_plan.get("summary") or "").strip(),
            "demoConfidence": str(demo_plan.get("confidence") or "").strip(),
            "stepCount": len(steps),
            "reason": "",
        },
        "error": None,
    }


def handle_report_preview(input_data: dict, node_outputs: dict) -> dict:
    """Publish preview lifecycle events for workflow-builder tracking."""
    wb_exec_id, dapr_instance_id = _resolve_execution_ids(input_data, node_outputs)
    if not wb_exec_id or not dapr_instance_id:
        return {"success": True, "data": {"reported": False}, "error": None}

    stage = str(_resolve(input_data, node_outputs, "stage") or "").strip().lower() or "completed"
    validation = _resolve_validation_summary(input_data, node_outputs)
    app_subdir = str(_resolve(input_data, node_outputs, "appSubdir") or "").strip()
    phase = "previewing"
    progress = 82 if stage == "started" else 90
    event_type = "preview_started" if stage == "started" else "preview_completed"
    payload = {
        "phase": phase,
        "status": validation.get("status") if stage != "started" else "running",
        "artifactId": validation.get("artifactId"),
        "screenshots": validation.get("screenshots"),
        "traceAssetRef": validation.get("traceAssetRef"),
        "videoAssetRef": validation.get("videoAssetRef"),
        "error": validation.get("error"),
        "appSubdir": app_subdir,
        "captureMode": validation.get("captureMode") or str(_resolve(input_data, node_outputs, "captureMode") or "validation"),
        "demoTitle": validation.get("demoTitle") or str(_resolve(input_data, node_outputs, "demoTitle") or ""),
        "demoSummary": validation.get("demoSummary") or str(_resolve(input_data, node_outputs, "demoSummary") or ""),
        "stepCount": validation.get("stepCount") or int(_resolve(input_data, node_outputs, "stepCount") or 0),
    }
    update_execution_status(wb_exec_id, phase, progress)
    post_agent_event(wb_exec_id, dapr_instance_id, event_type, payload)
    return {"success": True, "data": {"reported": True, **payload}, "error": None}


# ---------------------------------------------------------------------------
# 7. Solve -- single DurableAgent that does everything end-to-end
# ---------------------------------------------------------------------------


def handle_solve(input_data: dict, node_outputs: dict) -> dict:
    """Run the full CodingAgent: explore → plan → implement → test → commit → PR.

    Expects sandbox_id, working_dir, owner, repo, issue_number, github_token
    from the initialize step's output (via node_outputs).
    """
    sandbox_id = _resolve(input_data, node_outputs, "sandbox_id")
    working_dir = _resolve(input_data, node_outputs, "working_dir")
    owner = _resolve(input_data, node_outputs, "owner")
    repo = _resolve(input_data, node_outputs, "repo")
    issue_number = _resolve(input_data, node_outputs, "issue_number")
    token = _resolve(input_data, node_outputs, "github_token")
    agents_md = _resolve(input_data, node_outputs, "agents_md") or ""
    title = _resolve(input_data, node_outputs, "title") or "Untitled issue"
    body = _resolve(input_data, node_outputs, "body") or ""
    comments = _resolve(input_data, node_outputs, "comments") or []

    for field, val in [("sandbox_id", sandbox_id), ("working_dir", working_dir),
                       ("owner", owner), ("repo", repo)]:
        if not val:
            return {"success": False, "data": {}, "error": f"Missing required field: {field}"}

    # Resolve model from config (workflow-builder UI passes this)
    model = _resolve(input_data, node_outputs, "model") or os.environ.get("LLM_MODEL_ID", "claude-opus-4-6")
    max_iterations = int(_resolve(input_data, node_outputs, "maxIterations") or 1000)

    # Reconnect to existing sandbox
    sandbox = _reconnect_sandbox(sandbox_id)

    # Build issue context
    issue_context = {
        "owner": owner,
        "repo": repo,
        "issue_number": issue_number,
        "title": title,
        "body": body,
        "comments": comments,
        "github_token": token,
        "working_dir": working_dir,
        "agents_md": agents_md,
    }

    try:
        from dapr_agents import DurableAgent
        from dapr_agents.agents.configs import AgentExecutionConfig, WorkflowRetryPolicy
        from dapr_agents.workflow.runners import AgentRunner
        from src.llm_providers import resolve_llm_client
        from src.prompts.coding_agent import construct_system_prompt
        from src.tools.sandbox import make_sandbox_tools
        from src.tools.github import make_github_tools
        from src.tools.web import make_web_tools
        from src.tools.linear import make_linear_tools
        from src.tools.slack import make_slack_tools

        # Build all tools bound to this sandbox + context
        all_tools = (
            make_sandbox_tools(sandbox)
            + make_github_tools(sandbox, issue_context)
            + make_web_tools()
            + make_linear_tools(issue_context)
            + make_slack_tools(issue_context)
        )

        # Get the shared workflow runtime from main.py
        from src.main import _workflow_runtime

        # Create DurableAgent with shared runtime
        agent = DurableAgent(
            name="CodingAgent",
            role="Senior Software Engineer",
            goal="Resolve the assigned issue by implementing changes and opening a PR",
            system_prompt=construct_system_prompt(working_dir, issue_context),
            llm=resolve_llm_client(model),
            tools=all_tools,
            execution=AgentExecutionConfig(
                max_iterations=max_iterations,
            ),
            retry_policy=WorkflowRetryPolicy(
                max_attempts=3,
                initial_backoff_seconds=10,
                max_backoff_seconds=60,
                backoff_multiplier=2.0,
            ),
            runtime=_workflow_runtime,
        )

        # Pre-start agent (registers workflows on runtime). Catch if already registered
        # from a previous call — the shared runtime persists across requests.
        try:
            agent.start()
        except (ValueError, RuntimeError) as start_err:
            logger.debug("Agent start (likely already registered): %s", start_err)

        # Run via AgentRunner (async — use asyncio.run in the thread)
        async def _run_agent():
            runner = AgentRunner(name="solve-runner", timeout_in_seconds=1800)
            try:
                result = await runner.run(agent, payload={"task": _format_solve_task(issue_context)}, wait=True)
                return result
            finally:
                runner.shutdown(agent)

        result = asyncio.run(_run_agent())

        return {
            "success": True,
            "data": {"result": str(result) if result else "Agent completed"},
            "error": None,
        }

    except Exception as exc:
        logger.exception("CodingAgent failed")
        return {"success": False, "data": {}, "error": f"CodingAgent failed: {exc}"}


def _format_solve_task(issue_context: dict) -> str:
    """Format the issue into the initial task prompt for the CodingAgent."""
    parts = [f"## Issue: {issue_context.get('title', 'Untitled')}"]
    parts.append("")
    parts.append(issue_context.get("body", "No description provided."))
    comments = issue_context.get("comments", [])
    if comments:
        parts.append("\n## Comments")
        for c in comments:
            user = c.get("user", "unknown")
            parts.append(f"<untrusted-content user=\"{user}\">")
            parts.append(c.get("body", ""))
            parts.append("</untrusted-content>")
    parts.append(f"\nRepository: {issue_context.get('owner', '')}/{issue_context.get('repo', '')}")
    parts.append(f"Issue: #{issue_context.get('issue_number', '')}")
    parts.append(f"Working directory: {issue_context.get('working_dir', '/sandbox')}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Action handler registry
# ---------------------------------------------------------------------------

ACTION_HANDLERS: dict[str, Any] = {
    "dapr-swe/create-repo": handle_create_repo,
    "dapr-swe/initialize": handle_initialize,
    "dapr-swe/solve": handle_solve,
    "dapr-swe/greenfield-plan": handle_greenfield_plan,
    "dapr-swe/plan-demo": handle_plan_demo,
    "dapr-swe/greenfield-scaffold": handle_greenfield_scaffold,
    "dapr-swe/greenfield-publish": handle_greenfield_publish,
    "dapr-swe/prepare-preview": handle_prepare_preview,
    "dapr-swe/report-preview": handle_report_preview,
    # Legacy handlers route to solve for backwards compat
    "dapr-swe/plan": handle_plan,
    "dapr-swe/develop": handle_develop,
    "dapr-swe/review": handle_review,
    "dapr-swe/commit-pr": handle_commit_pr,
    "dapr-swe/notify": handle_notify,
}
