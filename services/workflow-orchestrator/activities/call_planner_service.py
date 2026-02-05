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

logger = logging.getLogger(__name__)

DAPR_HOST = os.getenv("DAPR_HOST", "localhost")
DAPR_HTTP_PORT = os.getenv("DAPR_HTTP_PORT", "3500")
PLANNER_APP_ID = os.getenv("PLANNER_APP_ID", "planner-dapr-agent")


def call_planner_plan(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /run endpoint via Dapr service invocation.

    This starts a planning workflow that analyzes the codebase and creates tasks.

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with workflow_id, feature_request, cwd, repo_url (optional)

    Returns:
        Result with tasks from planner-dapr-agent
    """
    workflow_id = input_data.get("workflow_id", "")
    feature_request = input_data.get("feature_request", "")
    cwd = input_data.get("cwd", "/workspace")
    repo_url = input_data.get("repo_url", "")

    logger.info(f"[Call Planner Plan] Invoking planner-dapr-agent /run")
    logger.info(f"[Call Planner Plan] Feature request: {feature_request[:100]}...")

    try:
        # Dapr service invocation URL
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/run"

        payload = {
            "task": feature_request,
            "message": feature_request,
            "mode": "durable",  # Use durable mode for activity tracking
            "durable": True,
        }

        with httpx.Client(timeout=300.0) as client:
            response = client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )

            if response.status_code >= 400:
                error_text = response.text
                logger.error(f"[Call Planner Plan] Failed: {response.status_code} - {error_text}")
                return {
                    "success": False,
                    "error": f"Planner plan failed: {response.status_code} - {error_text}",
                }

            result = response.json()
            instance_id = result.get("instance_id", "")
            logger.info(f"[Call Planner Plan] Started workflow: {instance_id}")

            # Poll for completion (planning should complete relatively quickly)
            return _poll_workflow_completion(client, instance_id, timeout=300)

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


def call_planner_workflow(ctx, input_data: dict) -> dict:
    """
    Call planner-dapr-agent /workflow/dapr endpoint for full multi-step workflow.

    This runs the complete workflow: clone → plan → approve → execute → test

    Args:
        ctx: Dapr activity context (unused but required by Dapr)
        input_data: Dict with:
            - workflow_id: Parent workflow ID
            - feature_request: The feature/task to implement
            - cwd: Working directory
            - repo_url: Git repository URL to clone (optional)
            - auto_approve: Whether to auto-approve the plan (default: False)

    Returns:
        Result from the multi-step workflow
    """
    workflow_id = input_data.get("workflow_id", "")
    feature_request = input_data.get("feature_request", "")
    cwd = input_data.get("cwd", "/workspace")
    repo_url = input_data.get("repo_url", "")
    auto_approve = input_data.get("auto_approve", False)

    logger.info(f"[Call Planner Workflow] Invoking planner-dapr-agent /workflow/dapr")
    logger.info(f"[Call Planner Workflow] Feature request: {feature_request[:100]}...")
    logger.info(f"[Call Planner Workflow] Auto-approve: {auto_approve}")

    try:
        # Dapr service invocation URL
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{PLANNER_APP_ID}/method/workflow/dapr"

        payload = {
            "task": feature_request,
            "auto_approve": auto_approve,
        }

        # Add repo_url if provided for clone step
        if repo_url:
            payload["repo_url"] = repo_url

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
