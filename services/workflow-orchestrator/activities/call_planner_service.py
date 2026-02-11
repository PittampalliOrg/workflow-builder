"""
Call Planner Service Activities

Activities that call planner-dapr-agent directly via Dapr service invocation.
This service uses OpenAI Agents SDK for planning and execution.

Endpoints:
- /run: Start planning workflow (returns tasks)
- /workflow/dapr: Multi-step workflow (clone→plan→approve→execute)
- /status/{instance_id}: Get workflow status
- /workflows/{workflow_id}: Get detailed workflow state
- /workflow/{workflow_id}/approve: Approve/reject plan
"""

import json
import logging
import os
import time

import httpx

from core.config import config

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
PLANNER_APP_ID = config.PLANNER_APP_ID
DAPR_SECRETS_STORE = config.DAPR_SECRETS_STORE
WORKFLOW_BUILDER_URL = os.getenv(
    "WORKFLOW_BUILDER_URL",
    "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
)
INTERNAL_API_TOKEN = os.getenv("INTERNAL_API_TOKEN", "")


def _normalize_branch_name(branch_value: object) -> str:
    """Normalize an optional branch value and default to main when blank."""
    branch = str(branch_value or "").strip()
    return branch or "main"


def _fetch_github_token_from_dapr() -> str:
    """Try to fetch GitHub token from Dapr secret store (Azure Key Vault)."""
    try:
        secret_url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/secrets/{DAPR_SECRETS_STORE}/github-token"
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(secret_url)
            if resp.status_code == 200:
                data = resp.json()
                token = data.get("github-token", "")
                if token:
                    logger.info("[Call Planner Clone] Resolved GitHub token from Dapr secret store")
                    return token
    except Exception as e:
        logger.debug(f"[Call Planner Clone] Dapr secret lookup failed: {e}")
    return ""


def _extract_github_token_from_connection_value(value: dict) -> str:
    """Extract a GitHub token from a decrypted app connection value."""
    value_type = str(value.get("type", ""))
    if value_type in ("OAUTH2", "CLOUD_OAUTH2", "PLATFORM_OAUTH2"):
        token = str(value.get("access_token", "")).strip()
        return token

    if value_type == "SECRET_TEXT":
        token = str(value.get("secret_text", "")).strip()
        return token

    if value_type == "CUSTOM_AUTH":
        props = value.get("props", {})
        if isinstance(props, dict):
            for key in ("token", "accessToken", "personalAccessToken", "pat", "apiKey"):
                candidate = props.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()

    return ""


def _fetch_github_token_from_connection(connection_external_id: str) -> str:
    """
    Resolve GitHub token from a selected app connection via workflow-builder internal API.
    """
    if not connection_external_id:
        return ""
    if not INTERNAL_API_TOKEN:
        logger.warning(
            "[Call Planner Clone] INTERNAL_API_TOKEN is not set, cannot resolve connection token"
        )
        return ""

    decrypt_url = (
        f"{WORKFLOW_BUILDER_URL}/api/internal/connections/"
        f"{connection_external_id}/decrypt"
    )

    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.get(
                decrypt_url,
                headers={"X-Internal-Token": INTERNAL_API_TOKEN},
            )
            if response.status_code != 200:
                logger.warning(
                    "[Call Planner Clone] Failed to decrypt connection %s: HTTP %s",
                    connection_external_id,
                    response.status_code,
                )
                return ""

            payload = response.json()
            value = payload.get("value")
            if not isinstance(value, dict):
                return ""

            token = _extract_github_token_from_connection_value(value)
            if token:
                logger.info(
                    "[Call Planner Clone] Resolved GitHub token from selected connection"
                )
            return token
    except Exception as e:
        logger.warning(
            "[Call Planner Clone] Connection token lookup failed for %s: %s",
            connection_external_id,
            e,
        )
        return ""


def call_planner_clone(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /clone endpoint for standalone repository cloning.

    Token resolution priority:
    1. Explicit token from node config (repositoryToken)
    2. Selected node connection (connection_external_id)
    3. User's GitHub integration (passed via integrations dict)
    4. Dapr secret store (azure-keyvault/github-token)

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - owner: GitHub repository owner
            - repo: Repository name
            - branch: Branch to clone (default: "main")
            - token: GitHub token (already resolved from config + integrations)
            - connection_external_id: Optional app connection external ID
            - execution_id: Parent execution ID for tracking

    Returns:
        Result with clonePath, commitHash, repository, branch, file_count
    """
    owner = str(input_data.get("owner", "")).strip()
    repo = str(input_data.get("repo", "")).strip()
    branch = _normalize_branch_name(input_data.get("branch", "main"))
    token = input_data.get("token", "")
    connection_external_id = input_data.get("connection_external_id", "")
    execution_id = input_data.get("execution_id", "")

    if not owner or not repo:
        return {
            "success": False,
            "error": "Both 'owner' and 'repo' are required for cloning",
        }

    token_source = "config/integrations" if token else "none"

    # Fallback: resolve token from selected node connection
    if not token and connection_external_id:
        token = _fetch_github_token_from_connection(connection_external_id)
        if token:
            token_source = "selected-connection"

    # Fallback: try Dapr secret store if no token from config/connection
    if not token:
        token = _fetch_github_token_from_dapr()
        if token:
            token_source = "dapr-secrets"

    logger.info(f"[Call Planner Clone] Cloning {owner}/{repo}@{branch} (token source: {token_source})")

    try:
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/clone"

        payload = {
            "owner": owner,
            "repo": repo,
            "branch": branch,
            "token": token,
            "execution_id": execution_id,
        }

        with httpx.Client(timeout=600.0) as client:  # 10 min timeout for large repos
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Clone] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Clone failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            logger.info(
                f"[Call Planner Clone] Success: path={result.get('clonePath')}, "
                f"files={result.get('file_count')}"
            )
            return result

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Clone] Timeout: {e}")
        return {
            "success": False,
            "error": f"Clone timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Clone] Error: {e}")
        return {
            "success": False,
            "error": f"Clone failed: {e}",
        }


def call_planner_plan(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /plan endpoint via Dapr service invocation.

    Uses the standalone /plan endpoint which runs planning synchronously
    and supports explicit cwd for cloned workspaces.

    Falls back to /run (standard mode) + polling if /plan returns 404.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - workflow_id: Parent workflow instance ID
            - feature_request: The feature to plan
            - cwd: Working directory (e.g., cloned repo path)
            - repo_url: Git repository URL (optional)
            - parent_execution_id: Parent workflow instance ID for event routing

    Returns:
        Result with tasks from planner-dapr-agent
    """
    workflow_id = input_data.get("workflow_id", "")
    feature_request = input_data.get("feature_request", "")
    cwd = input_data.get("cwd", "/workspace")
    repo_url = input_data.get("repo_url", "")
    parent_execution_id = input_data.get("parent_execution_id")

    logger.info(f"[Call Planner Plan] Invoking planner-dapr-agent /plan")
    logger.info(f"[Call Planner Plan] Task: {feature_request[:100]}...")
    logger.info(f"[Call Planner Plan] Working directory: {cwd}")
    if parent_execution_id:
        logger.info(f"[Call Planner Plan] Parent execution ID: {parent_execution_id}")

    try:
        # Try standalone /plan endpoint first (synchronous, supports cwd)
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/plan"

        payload = {
            "task": feature_request,
            "cwd": cwd,
            "workflow_id": workflow_id,
        }

        with httpx.Client(timeout=1800.0) as client:  # 30 min timeout for planning
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            # If /plan endpoint exists and succeeded
            if response.status_code < 400:
                result = response.json()
                logger.info(f"[Call Planner Plan] Standalone plan completed: success={result.get('success')}")
                return result

            # If /plan doesn't exist (404), fall back to /run + polling
            if response.status_code == 404:
                logger.info("[Call Planner Plan] /plan not found, falling back to /run")
                return _call_planner_plan_via_run(client, feature_request, parent_execution_id)

            error_text = response.text
            logger.error(f"[Call Planner Plan] Failed: {response.status_code} - {error_text}")
            return {
                "success": False,
                "error": f"Planner plan failed: {response.status_code} - {error_text}",
            }

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Plan] Timeout: {e}")
        return {
            "success": False,
            "error": f"Planner plan timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Plan] Error: {e}")
        return {
            "success": False,
            "error": f"Planner plan failed: {e}",
        }


def _call_planner_plan_via_run(client: httpx.Client, feature_request: str, parent_execution_id: str | None) -> dict:
    """Fallback: call /run endpoint with standard mode + polling."""
    url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/run"

    payload = {
        "task": feature_request,
        "mode": "standard",
    }
    if parent_execution_id:
        payload["parent_execution_id"] = parent_execution_id

    response = client.post(url, json=payload, headers={"Content-Type": "application/json"})

    if response.status_code >= 400:
        error_text = response.text
        return {"success": False, "error": f"Planner plan failed: {response.status_code} - {error_text}"}

    result = response.json()
    instance_id = result.get("instance_id", "")
    logger.info(f"[Call Planner Plan] Started workflow via /run: {instance_id}")
    return _poll_workflow_completion(client, instance_id, timeout=300)


def call_planner_workflow(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /api/workflows endpoint for full multi-step workflow.

    This runs the complete workflow: plan → persist → approve → execute
    When parent_execution_id is provided, the planner-dapr-agent will publish
    completion events that are routed back to the parent workflow.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - workflow_id: Parent workflow ID
            - feature_request: The feature/task to implement
            - cwd: Working directory
            - repo_url: Git repository URL to clone (optional)
            - auto_approve: Whether to auto-approve the plan (default: False)
            - parent_execution_id: Parent workflow instance ID for event routing

    Returns:
        Result from the multi-step workflow
    """
    workflow_id = input_data.get("workflow_id", "")
    feature_request = input_data.get("feature_request", "")
    cwd = input_data.get("cwd", "/workspace")
    repo_url = input_data.get("repo_url", "")
    auto_approve = input_data.get("auto_approve", False)
    parent_execution_id = input_data.get("parent_execution_id")

    logger.info(f"[Call Planner Workflow] Invoking planner-dapr-agent /run")
    logger.info(f"[Call Planner Workflow] Task: {feature_request[:100]}...")
    logger.info(f"[Call Planner Workflow] Auto-approve: {auto_approve}")
    if parent_execution_id:
        logger.info(f"[Call Planner Workflow] Parent execution ID: {parent_execution_id}")

    try:
        # Dapr service invocation URL - calls planner-dapr-agent /run endpoint
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/run"

        payload = {
            "task": feature_request,  # /run expects 'task' field
            "mode": "standard",  # Use standard mode (most reliable)
        }

        with httpx.Client(timeout=1800.0) as client:  # 30 min timeout for full workflow
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Workflow] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Planner workflow failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            planner_workflow_id = result.get("workflow_id", "")
            logger.info(f"[Call Planner Workflow] Started workflow: {planner_workflow_id}")

            # If auto_approve is False, we need to handle approval externally
            if not auto_approve:
                return {
                    "success": True,
                    "workflow_id": planner_workflow_id,
                    "status": result.get("status", "started"),
                    "requires_approval": True,
                    "message": "Workflow started. Waiting for plan approval.",
                }

            # If auto_approve, poll for completion
            return _poll_workflow_completion(client, planner_workflow_id, timeout=1800)

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Workflow] Timeout: {e}")
        return {
            "success": False,
            "error": f"Planner workflow timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Workflow] Error: {e}")
        return {
            "success": False,
            "error": f"Planner workflow failed: {e}",
        }


def call_planner_execute(ctx, input_data: dict) -> dict:
    """
    Continue a planner workflow after approval (execute phase).

    This calls /continue/{workflow_id} to resume execution after approval.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - planner_workflow_id: The planner workflow to continue
            - tasks: Tasks to execute (optional, uses previously planned tasks)

    Returns:
        Result from planner execution
    """
    planner_workflow_id = input_data.get("planner_workflow_id", "")
    tasks = input_data.get("tasks", [])

    if not planner_workflow_id:
        return {
            "success": False,
            "error": "planner_workflow_id is required to continue execution",
        }

    logger.info(f"[Call Planner Execute] Continuing workflow: {planner_workflow_id}")

    try:
        # Dapr service invocation URL
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/continue/{planner_workflow_id}"

        with httpx.Client(timeout=600.0) as client:  # 10 min timeout for execution
            response = client.post(
                url,
                json={},
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Execute] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Planner execute failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            logger.info(f"[Call Planner Execute] Continued workflow")

            # Poll for completion
            return _poll_workflow_completion(client, planner_workflow_id, timeout=600)

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Execute] Timeout: {e}")
        return {
            "success": False,
            "error": f"Planner execute timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Execute] Error: {e}")
        return {
            "success": False,
            "error": f"Planner execute failed: {e}",
        }


def call_planner_approve(ctx, input_data: dict) -> dict:
    """
    Approve or reject a planner workflow's plan.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - planner_workflow_id: The planner workflow to approve/reject
            - approved: Boolean indicating approval
            - reason: Optional reason for rejection

    Returns:
        Result from approval action
    """
    planner_workflow_id = input_data.get("planner_workflow_id", "")
    approved = input_data.get("approved", True)
    reason = input_data.get("reason", "")

    if not planner_workflow_id:
        return {
            "success": False,
            "error": "planner_workflow_id is required for approval",
        }

    logger.info(f"[Call Planner Approve] {'Approving' if approved else 'Rejecting'} workflow: {planner_workflow_id}")

    try:
        # Dapr service invocation URL
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/workflow/{planner_workflow_id}/approve"

        payload = {
            "approved": approved,
        }
        if reason:
            payload["reason"] = reason

        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Approve] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Planner approve failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            logger.info(f"[Call Planner Approve] Success: approved={approved}")

            return {
                "success": True,
                "approved": approved,
                "workflow_id": planner_workflow_id,
            }

    except Exception as e:
        logger.error(f"[Call Planner Approve] Error: {e}")
        return {
            "success": False,
            "error": f"Planner approve failed: {e}",
        }


def call_planner_execute_standalone(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /execute endpoint via Dapr service invocation.

    Uses the standalone /execute endpoint which runs execution in a sandbox.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - tasks: List of task objects from the plan
            - plan: Full plan data
            - cwd: Working directory (e.g., cloned repo path)
            - workflow_id: Workflow ID for tracking

    Returns:
        Execution result
    """
    tasks = input_data.get("tasks", [])
    plan = input_data.get("plan", {})
    cwd = input_data.get("cwd", "/workspace")
    workflow_id = input_data.get("workflow_id", "")

    logger.info(f"[Call Planner Execute] Invoking planner-dapr-agent /execute")
    logger.info(f"[Call Planner Execute] Tasks: {len(tasks)}, cwd: {cwd}")

    try:
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/execute"

        payload = {
            "tasks": tasks,
            "plan": plan,
            "cwd": cwd,
            "workflow_id": workflow_id,
        }

        with httpx.Client(timeout=7200.0) as client:  # 2 hour timeout for execution
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code < 400:
                result = response.json()
                logger.info(f"[Call Planner Execute] Completed: success={result.get('success')}")
                return result

            error_text = response.text
            logger.error(f"[Call Planner Execute] Failed: {response.status_code} - {error_text}")
            return {
                "success": False,
                "error": f"Planner execute failed: {response.status_code} - {error_text}",
            }

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Execute] Timeout: {e}")
        return {
            "success": False,
            "error": f"Planner execute timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Execute] Error: {e}")
        return {
            "success": False,
            "error": f"Planner execute failed: {e}",
        }


def call_planner_status(ctx, input_data: dict) -> dict:
    """
    Get the status of a planner workflow.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with planner_workflow_id

    Returns:
        Workflow status and details
    """
    planner_workflow_id = input_data.get("planner_workflow_id", "")

    if not planner_workflow_id:
        return {
            "success": False,
            "error": "planner_workflow_id is required",
        }

    try:
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/workflows/{planner_workflow_id}"

        with httpx.Client(timeout=30.0) as client:
            response = client.get(url)

            if response.status_code >= 400:
                error_text = response.text
                return {
                    "success": False,
                    "error": f"Failed to get status: {response.status_code} - {error_text}",
                }

            result = response.json()
            return {
                "success": True,
                **result,
            }

    except Exception as e:
        logger.error(f"[Call Planner Status] Error: {e}")
        return {
            "success": False,
            "error": f"Failed to get status: {e}",
        }


def call_planner_multi_step(ctx, input_data: dict) -> dict:
    """
    Start full multi-step workflow on planner-dapr-agent: clone → plan → approve → sandbox exec+test.

    This calls the /workflow/dapr endpoint (not /run) which handles:
    1. Clone repository to local workspace
    2. Plan tasks using AI agent
    3. Wait for approval (or auto-approve)
    4. Execute tasks in isolated sandbox pods
    5. Run tests and validate

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - workflow_id: Parent workflow instance ID
            - feature_request: The feature to implement
            - model: AI model to use (default: gpt-5.2-codex)
            - max_turns: Max agent turns (default: 20)
            - max_test_retries: Max test retries (default: 3)
            - auto_approve: Whether to auto-approve the plan (default: False)
            - repository: Optional dict with {owner, repo, branch, token}
            - parent_execution_id: Parent workflow instance ID for event routing

    Returns:
        Result from the multi-step workflow including tasks and execution output
    """
    workflow_id = input_data.get("workflow_id", "")
    feature_request = input_data.get("feature_request", "")
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 20)
    max_test_retries = input_data.get("max_test_retries", 3)
    auto_approve = input_data.get("auto_approve", False)
    repository = input_data.get("repository")
    connection_external_id = input_data.get("connection_external_id", "")
    parent_execution_id = input_data.get("parent_execution_id")

    logger.info(f"[Call Planner Multi-Step] Invoking planner-dapr-agent /workflow/dapr")
    logger.info(f"[Call Planner Multi-Step] Task: {feature_request[:100]}...")
    logger.info(f"[Call Planner Multi-Step] Model: {model}, auto_approve: {auto_approve}")
    if repository:
        logger.info(f"[Call Planner Multi-Step] Repository: {repository.get('owner')}/{repository.get('repo')}")
    if parent_execution_id:
        logger.info(f"[Call Planner Multi-Step] Parent execution ID: {parent_execution_id}")

    repo_payload = repository
    if isinstance(repository, dict):
        repo_payload = {**repository}
        repo_payload["branch"] = _normalize_branch_name(repo_payload.get("branch", "main"))
        repo_token = str(repo_payload.get("token", "")).strip()
        token_source = "config"

        if not repo_token and connection_external_id:
            repo_token = _fetch_github_token_from_connection(connection_external_id)
            if repo_token:
                token_source = "selected-connection"

        if not repo_token:
            repo_token = _fetch_github_token_from_dapr()
            if repo_token:
                token_source = "dapr-secrets"

        if repo_token:
            repo_payload["token"] = repo_token
        logger.info(
            f"[Call Planner Multi-Step] Repository token source: {token_source}"
        )

    try:
        # Dapr service invocation URL - calls planner-dapr-agent /workflow/dapr endpoint
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/workflow/dapr"

        payload = {
            "task": feature_request,
            "model": model,
            "max_turns": max_turns,
            "max_test_retries": max_test_retries,
            "auto_approve": auto_approve,
        }

        # Include repository config only when owner and repo are both provided
        if (
            isinstance(repo_payload, dict)
            and repo_payload.get("owner")
            and repo_payload.get("repo")
        ):
            payload["repository"] = repo_payload

        # Include parent_execution_id for event routing back to parent workflow
        if parent_execution_id:
            payload["parent_execution_id"] = parent_execution_id

        with httpx.Client(timeout=1800.0) as client:  # 30 min timeout for full workflow
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Multi-Step] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Planner multi-step failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            planner_workflow_id = result.get("workflow_id", result.get("instance_id", ""))
            logger.info(f"[Call Planner Multi-Step] Started workflow: {planner_workflow_id}")

            # Poll for completion (full workflow may take a while)
            return _poll_workflow_completion(client, planner_workflow_id, timeout=1800)

    except httpx.TimeoutException as e:
        logger.error(f"[Call Planner Multi-Step] Timeout: {e}")
        return {
            "success": False,
            "error": f"Planner multi-step timed out: {e}",
        }
    except Exception as e:
        logger.error(f"[Call Planner Multi-Step] Error: {e}")
        return {
            "success": False,
            "error": f"Planner multi-step failed: {e}",
        }


def _poll_workflow_completion(client: httpx.Client, instance_id: str, timeout: int = 300) -> dict:
    """
    Poll planner-dapr-agent for workflow completion.

    Args:
        client: httpx client
        instance_id: Workflow instance ID to poll
        timeout: Maximum time to wait in seconds

    Returns:
        Final workflow result
    """
    status_url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/workflows/{instance_id}"
    start_time = time.time()
    poll_interval = 2.0  # Start with 2 second intervals

    while time.time() - start_time < timeout:
        try:
            response = client.get(status_url)

            if response.status_code >= 400:
                logger.warning(f"[Poll] Status check failed: {response.status_code}")
                time.sleep(poll_interval)
                continue

            result = response.json()
            status = result.get("status", "").upper()

            logger.debug(f"[Poll] Workflow {instance_id} status: {status}")

            if status in ("COMPLETED", "SUCCEEDED"):
                # Extract tasks from output
                output = result.get("output", {})
                tasks = []

                # Handle different output formats
                if isinstance(output, dict):
                    tasks = output.get("tasks", [])
                    if not tasks and "plan" in output:
                        plan = output.get("plan", {})
                        if isinstance(plan, dict):
                            tasks = plan.get("tasks", [])

                return {
                    "success": True,
                    "status": status,
                    "workflow_id": instance_id,  # Include workflow_id for parent workflow
                    "tasks": tasks,
                    "output": output,
                    "taskCount": len(tasks),
                    "phase": result.get("phase", "completed"),
                    "activities": result.get("activities", []),
                }

            elif status in ("FAILED", "ERROR"):
                error = result.get("error", result.get("output", "Unknown error"))
                return {
                    "success": False,
                    "status": status,
                    "workflow_id": instance_id,  # Include workflow_id for debugging
                    "error": str(error),
                }

            elif status == "WAITING_FOR_APPROVAL":
                # Return current state, workflow needs approval
                output = result.get("output", {})
                tasks = []
                if isinstance(output, dict):
                    tasks = output.get("tasks", [])

                return {
                    "success": True,
                    "status": status,
                    "requires_approval": True,
                    "tasks": tasks,
                    "taskCount": len(tasks),
                    "phase": result.get("phase", "planning"),
                    "workflow_id": instance_id,
                }

            # Still running, continue polling
            time.sleep(poll_interval)
            # Increase poll interval gradually (max 10 seconds)
            poll_interval = min(poll_interval * 1.2, 10.0)

        except Exception as e:
            logger.warning(f"[Poll] Error polling status: {e}")
            time.sleep(poll_interval)

    # Timeout reached
    return {
        "success": False,
        "error": f"Workflow {instance_id} timed out after {timeout} seconds",
        "status": "TIMEOUT",
    }
