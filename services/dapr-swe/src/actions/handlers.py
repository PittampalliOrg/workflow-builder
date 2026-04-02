"""Action handlers that wrap dapr-swe agent runners for workflow-builder orchestration.

Each handler takes (input_data, node_outputs) and returns
{"success": bool, "data": dict, "error": str | None}.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
from typing import Any

from src.events import publish_event, update_execution_status, post_agent_event
from src.integrations.github_app import get_github_app_installation_token
from src.scm import (
    ScmAuth,
    build_clone_config,
    build_pr_body,
    configure_git_identity_command,
    create_pull_request,
    get_gitea_auth,
    normalize_provider,
    post_issue_comment as post_provider_issue_comment,
    remote_matches,
)
from src.sandbox.openshell import OpenShellBackend, create_openshell_sandbox

logger = logging.getLogger(__name__)


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


def _resolve_provider(input_data: dict, node_outputs: dict) -> str:
    return normalize_provider(_resolve(input_data, node_outputs, "provider"))


def _resolve_scm_auth(
    input_data: dict,
    node_outputs: dict,
    provider: str,
) -> ScmAuth | None:
    if provider == "gitea":
        username = (
            _resolve(input_data, node_outputs, "gitea_username")
            or _resolve(input_data, node_outputs, "repositoryUsername")
            or os.environ.get("GITEA_USERNAME")
        )
        secret = (
            _resolve(input_data, node_outputs, "gitea_token")
            or _resolve(input_data, node_outputs, "gitea_password")
            or _resolve(input_data, node_outputs, "repositoryToken")
            or os.environ.get("GITEA_PASSWORD")
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

    # Clone repository (skip if already cloned — idempotent for activity replay)
    check = sandbox.execute(f"test -d {working_dir}/.git && echo exists", timeout=10)
    if "exists" in (check.output or ""):
        logger.info("Repo already cloned at %s, skipping clone", working_dir)
    else:
        clone_depth = _resolve(input_data, node_outputs, "cloneDepth") or "50"
        result = sandbox.execute(
            " ".join(
                [
                    f"git clone --depth={clone_depth}",
                    shlex.quote(clone.clone_url),
                    shlex.quote(working_dir),
                ],
            ),
            timeout=120,
        )
        if result.exit_code != 0:
            return {
                "success": False,
                "data": {"sandbox_id": sandbox_id},
                "error": f"CLONE FAIL: {result.output[:200]}",
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

    # Store credentials for later push
    sandbox.execute(
        "printf '%s\\n' "
        + shlex.quote(clone.credential_url)
        + " > /tmp/.git-credentials",
        timeout=10,
    )
    sandbox.execute(
        "git config --global credential.helper 'store --file=/tmp/.git-credentials' "
        "&& git config --global http.sslVerify false",
        timeout=10,
    )

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
            "gitea_password": auth.secret if provider == "gitea" else "",
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
                "sender", "working_dir", "agents_md", "github_token", "gitea_username", "gitea_password"):
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
    wb_exec_id = _resolve(input_data, node_outputs, "wb_execution_id") or ""
    issue_ref = f"{_resolve(input_data, node_outputs, 'owner')}/{_resolve(input_data, node_outputs, 'repo')}#{_resolve(input_data, node_outputs, 'issue_number')}"
    publish_event("dapr-swe.plan.created", {"issue": issue_ref, "summary": plan.get("summary", ""), "steps": len(plan.get("steps", []))})
    update_execution_status(wb_exec_id, "planning", 25)
    post_agent_event(wb_exec_id, "plan_created", {"phase": "planning", "summary": plan.get("summary", ""), "stepCount": len(plan.get("steps", []))})

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
                "sender", "working_dir", "agents_md", "github_token", "gitea_username", "gitea_password"):
        val = _resolve(input_data, node_outputs, key)
        if val is not None:
            issue_context[key] = val

    plan = _coerce_mapping(_resolve(input_data, node_outputs, "plan"))

    # Resolve event tracking context
    wb_exec_id = _resolve(input_data, node_outputs, "wb_execution_id") or ""
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
    post_agent_event(wb_exec_id, "step_completed", {"phase": "implementing", "stepIndex": 0, "stepTitle": step.get("title", "")})

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
    wb_exec_id = _resolve(input_data, node_outputs, "wb_execution_id") or ""
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

    # Push
    sandbox.execute(
        "git config --global credential.helper 'store --file=/tmp/.git-credentials' "
        "&& git config --global http.sslVerify false",
        timeout=10,
    )
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
    pr_body = build_pr_body(plan, int(issue_number))
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
    "dapr-swe/initialize": handle_initialize,
    "dapr-swe/solve": handle_solve,
    # Legacy handlers route to solve for backwards compat
    "dapr-swe/plan": handle_plan,
    "dapr-swe/develop": handle_develop,
    "dapr-swe/review": handle_review,
    "dapr-swe/commit-pr": handle_commit_pr,
    "dapr-swe/notify": handle_notify,
}
