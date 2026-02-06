"""Dapr workflow for multi-step planning → execution → testing.

This module implements a proper Dapr workflow using dapr-ext-workflow so that
the workflow phases (planning, execution, testing) appear as activities in the
ai-chatbot UI workflow graph.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import dapr.ext.workflow as wf
from agents import Runner
from dapr.clients import DaprClient
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Pub/sub configuration (will be loaded from dapr_config)
PUBSUB_NAME = os.environ.get("PUBSUB_NAME", "pubsub")
PUBSUB_TOPIC = os.environ.get("PUBSUB_TOPIC", "workflow.stream")

# State store for event streaming (so SSE endpoint can read events)
EVENT_STORE_NAME = os.environ.get("EVENT_STORE_NAME", "statestore")
EVENT_KEY_PREFIX = "workflow-events-"
MAX_EVENTS_PER_WORKFLOW = 500  # Limit to prevent unbounded growth


def store_workflow_event(workflow_id: str, event: dict) -> bool:
    """Store a workflow event in Dapr state store for SSE streaming.

    Events are stored as a list under the key 'workflow-events-{workflow_id}'.
    The SSE endpoint in app.py reads from this store to stream events.
    """
    event_key = f"{EVENT_KEY_PREFIX}{workflow_id}"

    try:
        with DaprClient() as client:
            # Get existing events
            response = client.get_state(EVENT_STORE_NAME, event_key)
            if response.data:
                try:
                    events = json.loads(response.data.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    events = []
            else:
                events = []

            # Append new event
            events.append(event)

            # Trim to max size (keep most recent)
            if len(events) > MAX_EVENTS_PER_WORKFLOW:
                events = events[-MAX_EVENTS_PER_WORKFLOW:]

            # Save back
            client.save_state(
                EVENT_STORE_NAME,
                event_key,
                json.dumps(events),
                state_metadata={"contentType": "application/json"},
            )
        logger.info(f"Stored event {event.get('type')} for workflow {workflow_id} (total: {len(events)} events)")
        return True
    except Exception as e:
        logger.warning(f"Failed to store event in state store: {e}")
        return False


def get_workflow_events(workflow_id: str, since_index: int = 0) -> list:
    """Get workflow events from state store.

    Args:
        workflow_id: The workflow to get events for
        since_index: Only return events after this index

    Returns:
        List of events since the given index
    """
    event_key = f"{EVENT_KEY_PREFIX}{workflow_id}"

    try:
        with DaprClient() as client:
            response = client.get_state(EVENT_STORE_NAME, event_key)
            if response.data:
                try:
                    events = json.loads(response.data.decode("utf-8"))
                    # Return events after the given index
                    return events[since_index:] if since_index < len(events) else []
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return []
            return []
    except Exception as e:
        logger.debug(f"Failed to get events from state store: {e}")
        return []


def publish_workflow_event(
    workflow_id: str,
    event_type: str,
    data: dict,
    task_id: Optional[str] = None,
) -> bool:
    """Publish a workflow event to Dapr pub/sub AND store for SSE streaming."""
    event = {
        "id": f"workflow-{workflow_id}-{uuid.uuid4().hex[:8]}",
        "type": event_type,
        "workflowId": workflow_id,
        "agentId": "planner-dapr-agent",
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if task_id:
        event["taskId"] = task_id

    # Store event for SSE streaming
    store_workflow_event(workflow_id, event)

    # Also publish to pub/sub for ai-chatbot webhook
    try:
        with DaprClient() as client:
            client.publish_event(
                pubsub_name=PUBSUB_NAME,
                topic_name=PUBSUB_TOPIC,
                data=json.dumps(event),
                data_content_type="application/json",
            )
        logger.debug(f"Published {event_type} event for workflow {workflow_id}")
        return True
    except Exception as e:
        logger.warning(f"Failed to publish {event_type} event: {e}")
        return False


# ============================================================================
# Detailed Streaming Event Publishers
# ============================================================================

def publish_tool_call(
    workflow_id: str,
    tool_name: str,
    tool_input: Any,
    call_id: str,
    task_id: Optional[str] = None,
) -> bool:
    """Publish a tool call event for ai-chatbot streaming."""
    # Truncate large inputs for display
    input_str = str(tool_input)
    if len(input_str) > 500:
        input_str = input_str[:500] + "..."

    return publish_workflow_event(
        workflow_id,
        "tool_call",
        {
            "toolName": tool_name,
            "toolInput": tool_input if isinstance(tool_input, dict) else {"input": input_str},
            "callId": call_id,
            "status": "running",
        },
        task_id,
    )


def publish_tool_result(
    workflow_id: str,
    tool_name: str,
    result: Any,
    call_id: str,
    is_error: bool = False,
    task_id: Optional[str] = None,
) -> bool:
    """Publish a tool result event for ai-chatbot streaming."""
    # Truncate large outputs for display
    result_str = str(result) if result else ""
    if len(result_str) > 1000:
        result_str = result_str[:1000] + f"... (truncated, {len(str(result))} chars total)"

    return publish_workflow_event(
        workflow_id,
        "tool_result",
        {
            "toolName": tool_name,
            "toolOutput": result_str,
            "callId": call_id,
            "isError": is_error,
            "status": "error" if is_error else "success",
        },
        task_id,
    )


def publish_llm_chunk(
    workflow_id: str,
    content: str,
    agent_name: str = "Executor",
    task_id: Optional[str] = None,
) -> bool:
    """Publish an LLM response chunk for ai-chatbot streaming."""
    return publish_workflow_event(
        workflow_id,
        "llm_chunk",
        {
            "content": content,
            "agentName": agent_name,
        },
        task_id,
    )


def publish_thinking(
    workflow_id: str,
    content: str,
    task_id: Optional[str] = None,
) -> bool:
    """Publish a thinking/reasoning event for ai-chatbot streaming."""
    return publish_workflow_event(
        workflow_id,
        "thinking_delta",
        {
            "content": content,
        },
        task_id,
    )


def publish_agent_message(
    workflow_id: str,
    message: str,
    agent_name: str,
    task_id: Optional[str] = None,
) -> bool:
    """Publish an agent message event for ai-chatbot streaming."""
    return publish_workflow_event(
        workflow_id,
        "message_start",
        {
            "content": message,
            "agentName": agent_name,
        },
        task_id,
    )


# ============================================================================
# Clone Activity Models
# ============================================================================

class CloneInput(BaseModel):
    """Input for repository cloning activity."""
    owner: str
    repo: str
    branch: str = "main"
    token: Optional[str] = None
    workspace_dir: str = "/app/workspace"
    workflow_id: Optional[str] = None


class CloneOutput(BaseModel):
    """Output from repository cloning activity."""
    success: bool
    path: str = ""
    file_count: int = 0
    error: Optional[str] = None

# Initialize workflow runtime
wfr = wf.WorkflowRuntime()


# ============================================================================
# Activity: Clone Repository Phase
# ============================================================================

@wfr.activity(name="clone_repository")
def clone_repository_activity(ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Clone a GitHub repository with optional token authentication.

    This activity:
    1. Validates the input parameters
    2. Builds the git URL (with token if provided)
    3. Clones the repository with --depth 1 for speed
    4. Counts files for tracking
    5. Returns the clone path and file count
    """
    clone_input = CloneInput(**input_data)
    workflow_id = clone_input.workflow_id or "unknown"

    logger.info(f"Clone activity started for {clone_input.owner}/{clone_input.repo}@{clone_input.branch}")

    # Publish clone started event
    publish_workflow_event(workflow_id, "phase_started", {
        "phase": "cloning",
        "status": f"Cloning {clone_input.owner}/{clone_input.repo}@{clone_input.branch}...",
        "progress": 5,
    })

    # Build repository path
    repo_path = os.path.join(clone_input.workspace_dir, clone_input.repo)

    # Remove existing directory if present
    if os.path.exists(repo_path):
        logger.info(f"Removing existing directory: {repo_path}")
        subprocess.run(["rm", "-rf", repo_path], check=True)

    # Build git URL with token if provided
    if clone_input.token:
        git_url = f"https://{clone_input.token}@github.com/{clone_input.owner}/{clone_input.repo}.git"
        logger.info(f"Using token authentication for clone")
    else:
        git_url = f"https://github.com/{clone_input.owner}/{clone_input.repo}.git"
        logger.info(f"Using public clone (no token)")

    try:
        # Clone with depth 1 for speed
        result = subprocess.run(
            [
                "git", "clone",
                "--depth", "1",
                "--branch", clone_input.branch,
                git_url,
                repo_path,
            ],
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )

        if result.returncode != 0:
            error_msg = result.stderr or result.stdout or "Unknown git error"
            # Sanitize token from error message
            if clone_input.token:
                error_msg = error_msg.replace(clone_input.token, "***")
            logger.error(f"Git clone failed: {error_msg}")
            return CloneOutput(
                success=False,
                error=f"Git clone failed: {error_msg}",
            ).model_dump()

        # Count files (excluding .git)
        file_count = 0
        for root, dirs, files in os.walk(repo_path):
            # Skip .git directory
            if '.git' in dirs:
                dirs.remove('.git')
            file_count += len(files)

        logger.info(f"Clone completed: {repo_path} with {file_count} files")

        # Publish clone completed event
        publish_workflow_event(workflow_id, "phase_completed", {
            "phase": "cloning",
            "status": f"Repository cloned: {file_count} files",
            "progress": 10,
            "file_count": file_count,
            "repo_path": repo_path,
        })

        return CloneOutput(
            success=True,
            path=repo_path,
            file_count=file_count,
        ).model_dump()

    except subprocess.TimeoutExpired:
        logger.error("Git clone timed out after 5 minutes")
        return CloneOutput(
            success=False,
            error="Git clone timed out after 5 minutes",
        ).model_dump()
    except Exception as e:
        error_msg = str(e)
        # Sanitize token from error message
        if clone_input.token:
            error_msg = error_msg.replace(clone_input.token, "***")
        logger.error(f"Clone failed: {error_msg}")
        return CloneOutput(
            success=False,
            error=error_msg,
        ).model_dump()


# ============================================================================
# Activity: Planning Phase
# ============================================================================

@wfr.activity(name="planning")
def planning_activity(ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Run the planning phase using OpenAI agents WITH streaming.

    This activity:
    1. Creates a planning agent
    2. Runs it with streaming to capture tool calls, LLM responses
    3. Publishes detailed events for ai-chatbot UI
    4. Returns the plan data
    """
    import asyncio
    from workflow_agent import create_planning_agent, Plan, Task

    task = input_data.get("task", "")
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 20)
    workflow_id = input_data.get("workflow_id", "unknown")

    logger.info(f"Planning activity started for task: {task[:100]}... (streaming enabled)")

    # Publish phase started event
    publish_workflow_event(workflow_id, "phase_started", {
        "phase": "planning",
        "status": "Creating implementation plan...",
        "progress": 10,
    })

    async def run_planning_streamed():
        from agents.run import RunResultStreaming
        from agents.stream_events import (
            RawResponsesStreamEvent,
            RunItemStreamEvent,
        )
        from agents.items import (
            ToolCallItem,
            ToolCallOutputItem,
            MessageOutputItem,
            ReasoningItem,
        )

        planning_agent = create_planning_agent(model)

        # Use streaming to capture detailed events
        result: RunResultStreaming = Runner.run_streamed(
            planning_agent,
            input=task,
            max_turns=max_turns,
        )

        accumulated_text = ""
        tool_call_count = 0
        tool_call_map = {}

        async for event in result.stream_events():
            try:
                # Handle raw LLM response chunks
                if isinstance(event, RawResponsesStreamEvent):
                    response = event.data
                    if hasattr(response, 'choices') and response.choices:
                        for choice in response.choices:
                            if hasattr(choice, 'delta') and choice.delta:
                                delta = choice.delta
                                if hasattr(delta, 'content') and delta.content:
                                    accumulated_text += delta.content
                                    if len(accumulated_text) >= 100:
                                        publish_llm_chunk(workflow_id, accumulated_text, "Planner")
                                        accumulated_text = ""

                # Handle run items (tool calls, messages, reasoning)
                elif isinstance(event, RunItemStreamEvent):
                    item = event.item

                    # Tool call started
                    if isinstance(item, ToolCallItem):
                        tool_call_count += 1
                        tool_name = None
                        if hasattr(item, 'name') and item.name:
                            tool_name = item.name
                        elif hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'function') and hasattr(raw.function, 'name'):
                                tool_name = raw.function.name
                            elif hasattr(raw, 'name'):
                                tool_name = raw.name
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"

                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'id') and item.id:
                            call_id = item.id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'id'):
                            call_id = item.raw_item.id
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        tool_args = {}
                        if hasattr(item, 'arguments') and item.arguments:
                            tool_args = item.arguments
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'arguments') and raw.arguments:
                                try:
                                    args_str = raw.arguments
                                    if isinstance(args_str, str):
                                        tool_args = json.loads(args_str)
                                    elif isinstance(args_str, dict):
                                        tool_args = args_str
                                except (json.JSONDecodeError, TypeError):
                                    tool_args = {"raw": str(raw.arguments)[:500]}

                        logger.info(f"Planning tool call: {tool_name}")
                        publish_tool_call(workflow_id, tool_name, tool_args, call_id)
                        tool_call_map[call_id] = tool_name

                    # Tool call result
                    elif isinstance(item, ToolCallOutputItem):
                        tool_name = None
                        if hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'name') and item.name:
                            tool_name = item.name

                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'call_id'):
                            call_id = item.raw_item.call_id

                        if not tool_name and call_id and call_id in tool_call_map:
                            tool_name = tool_call_map[call_id]
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        output = item.output if hasattr(item, 'output') else str(item)
                        is_error = hasattr(item, 'is_error') and item.is_error

                        logger.info(f"Planning tool result: {tool_name}")
                        publish_tool_result(workflow_id, tool_name, output, call_id, is_error)

                    # Reasoning/thinking
                    elif isinstance(item, ReasoningItem):
                        if hasattr(item, 'text') and item.text:
                            publish_thinking(workflow_id, item.text, "Planner")

                    # Message output
                    elif isinstance(item, MessageOutputItem):
                        if hasattr(item, 'text') and item.text:
                            publish_agent_message(workflow_id, item.text, "Planner")

            except Exception as e:
                logger.debug(f"Error processing planning stream event: {e}")

        # Flush any remaining text
        if accumulated_text:
            publish_llm_chunk(workflow_id, accumulated_text, "Planner")

        # Get final output after stream completes
        plan: Plan = result.final_output

        # Auto-populate blocks based on blockedBy
        task_map = {t.id: t for t in plan.tasks}
        for t in plan.tasks:
            for blocked_by_id in t.blockedBy:
                if blocked_by_id in task_map:
                    if t.id not in task_map[blocked_by_id].blocks:
                        task_map[blocked_by_id].blocks.append(t.id)

        return plan.model_dump()

    try:
        plan_data = asyncio.run(run_planning_streamed())
        logger.info(f"Planning completed with {len(plan_data.get('tasks', []))} tasks")

        # Publish phase completed event
        publish_workflow_event(workflow_id, "phase_completed", {
            "phase": "planning",
            "status": f"Plan created with {len(plan_data.get('tasks', []))} tasks",
            "progress": 30,
            "tasks_count": len(plan_data.get("tasks", [])),
            "tests_count": len(plan_data.get("tests", [])),
        })

        return {
            "success": True,
            "plan": plan_data,
        }
    except Exception as e:
        logger.error(f"Planning failed: {e}")

        # Publish failure event
        publish_workflow_event(workflow_id, "phase_failed", {
            "phase": "planning",
            "status": f"Planning failed: {str(e)}",
            "error": str(e),
        })

        return {
            "success": False,
            "error": str(e),
        }


# ============================================================================
# Activity: Execution Phase (with Streaming)
# ============================================================================

@wfr.activity(name="execution")
def execution_activity(ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Run the execution phase using OpenAI agents WITH streaming.

    This activity:
    1. Creates an execution agent
    2. Runs it with streaming to capture tool calls, LLM responses
    3. Publishes detailed events for ai-chatbot UI
    4. Returns the execution result
    """
    import asyncio
    from workflow_agent import create_execution_agent, ExecutionResult

    plan = input_data.get("plan", {})
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 20)
    workflow_id = input_data.get("workflow_id", "unknown")
    tasks = plan.get("tasks", [])

    logger.info(f"Execution activity started with {len(tasks)} tasks (streaming enabled)")

    # Publish execution started event
    publish_workflow_event(workflow_id, "execution_started", {
        "phase": "execution",
        "status": f"Executing {len(tasks)} tasks...",
        "progress": 50,
        "tasks_count": len(tasks),
    })

    async def run_execution_streamed():
        from agents.run import RunResultStreaming
        from agents.stream_events import (
            RawResponsesStreamEvent,
            RunItemStreamEvent,
        )
        from agents.items import (
            ToolCallItem,
            ToolCallOutputItem,
            MessageOutputItem,
            ReasoningItem,
        )

        execution_agent = create_execution_agent(model)

        exec_prompt = f"""Execute this plan:

Summary: {plan.get('summary', '')}

Tasks:
{chr(10).join(f"- [{t['id']}] {t['subject']}: {t['description']} (blockedBy: {t.get('blockedBy', [])})" for t in tasks)}

Reasoning: {plan.get('reasoning', '')}"""

        # Use streaming to capture detailed events
        result: RunResultStreaming = Runner.run_streamed(
            execution_agent,
            input=exec_prompt,
            max_turns=max_turns,
        )

        accumulated_text = ""
        tool_call_count = 0
        tool_call_map = {}  # Maps call_id -> tool_name for result lookup

        async for event in result.stream_events():
            try:
                # Handle raw LLM response chunks
                if isinstance(event, RawResponsesStreamEvent):
                    response = event.data
                    # Extract text from response choices
                    if hasattr(response, 'choices') and response.choices:
                        for choice in response.choices:
                            if hasattr(choice, 'delta') and choice.delta:
                                delta = choice.delta
                                # Text content
                                if hasattr(delta, 'content') and delta.content:
                                    accumulated_text += delta.content
                                    # Publish every 100 chars to avoid flooding
                                    if len(accumulated_text) >= 100:
                                        publish_llm_chunk(workflow_id, accumulated_text, "Executor")
                                        accumulated_text = ""

                # Handle run items (tool calls, messages, etc.)
                elif isinstance(event, RunItemStreamEvent):
                    item = event.item

                    # Tool call started
                    if isinstance(item, ToolCallItem):
                        tool_call_count += 1
                        # Extract tool name from various possible locations
                        tool_name = None
                        if hasattr(item, 'name') and item.name:
                            tool_name = item.name
                        elif hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'function') and hasattr(raw.function, 'name'):
                                tool_name = raw.function.name
                            elif hasattr(raw, 'name'):
                                tool_name = raw.name
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"

                        # Extract call_id from item or generate one
                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'id') and item.id:
                            call_id = item.id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'id'):
                            call_id = item.raw_item.id
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        # Extract arguments from item or raw_item
                        # ResponseFunctionToolCall has: arguments (str), call_id, name, type
                        tool_args = {}

                        if hasattr(item, 'arguments') and item.arguments:
                            # Direct arguments on item (if present)
                            tool_args = item.arguments
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            # ResponseFunctionToolCall has arguments directly on raw_item
                            if hasattr(raw, 'arguments') and raw.arguments:
                                try:
                                    args_str = raw.arguments
                                    if isinstance(args_str, str):
                                        tool_args = json.loads(args_str)
                                    elif isinstance(args_str, dict):
                                        tool_args = args_str
                                except (json.JSONDecodeError, TypeError) as e:
                                    logger.debug(f"Could not parse raw_item.arguments: {e}")
                                    tool_args = {"raw": str(raw.arguments)[:500]}
                            # Fallback: some tool types might use function.arguments
                            elif hasattr(raw, 'function') and hasattr(raw.function, 'arguments'):
                                try:
                                    args_str = raw.function.arguments
                                    if isinstance(args_str, str) and args_str:
                                        tool_args = json.loads(args_str)
                                    elif isinstance(args_str, dict):
                                        tool_args = args_str
                                except (json.JSONDecodeError, TypeError) as e:
                                    logger.debug(f"Could not parse raw_item.function.arguments: {e}")
                                    tool_args = {"raw": str(raw.function.arguments)[:500]}

                        logger.info(f"Tool call: {tool_name} (call_id={call_id})")
                        publish_tool_call(
                            workflow_id,
                            tool_name,
                            tool_args,
                            call_id,
                        )
                        # Store mapping for result lookup
                        tool_call_map[call_id] = tool_name

                    # Tool call result
                    elif isinstance(item, ToolCallOutputItem):
                        # Extract tool name
                        tool_name = None
                        if hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'name') and item.name:
                            tool_name = item.name

                        # Extract call_id
                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'call_id'):
                            call_id = item.raw_item.call_id

                        # Fallback to stored mapping
                        if not tool_name and call_id and call_id in tool_call_map:
                            tool_name = tool_call_map[call_id]
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        output = item.output if hasattr(item, 'output') else str(item)
                        is_error = hasattr(item, 'is_error') and item.is_error

                        logger.info(f"Tool result: {tool_name} (call_id={call_id}, error={is_error})")
                        publish_tool_result(
                            workflow_id,
                            tool_name,
                            output,
                            call_id,
                            is_error,
                        )

                    # Agent message
                    elif isinstance(item, MessageOutputItem):
                        content = ""
                        if hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'content') and raw.content:
                                for part in raw.content:
                                    if hasattr(part, 'text'):
                                        content += part.text
                        if content:
                            publish_agent_message(workflow_id, content[:500], "Executor")

                    # Reasoning/thinking
                    elif isinstance(item, ReasoningItem):
                        # Try direct text attribute first (most common)
                        if hasattr(item, 'text') and item.text:
                            publish_thinking(workflow_id, item.text[:500], "Executor")
                        # Fallback: try raw_item.summary (for reasoning models)
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            reasoning = ""
                            raw = item.raw_item
                            if hasattr(raw, 'summary') and raw.summary:
                                for part in raw.summary:
                                    if hasattr(part, 'text'):
                                        reasoning += part.text
                            if reasoning:
                                publish_thinking(workflow_id, reasoning[:500], "Executor")

            except Exception as e:
                logger.debug(f"Error processing stream event: {e}")

        # Flush remaining text
        if accumulated_text:
            publish_llm_chunk(workflow_id, accumulated_text, "Executor")

        # Get final result - final_output is a property, not a coroutine
        final_result = result.final_output
        if isinstance(final_result, ExecutionResult):
            return final_result.model_dump()
        # If not ExecutionResult, try to extract from raw result
        logger.warning(f"Unexpected final_result type: {type(final_result)}")
        return {"success": True, "error": None, "completed_tasks": [], "output": str(final_result)[:1000] if final_result else "", "errors": []}

    try:
        execution_data = asyncio.run(run_execution_streamed())
        logger.info(f"Execution completed: success={execution_data.get('success')}")

        # Publish execution completed event
        publish_workflow_event(workflow_id, "execution_completed", {
            "phase": "execution",
            "status": "Execution completed",
            "progress": 80,
            "success": execution_data.get("success", False),
            "completed_tasks": execution_data.get("completed_tasks", []),
        })

        return {
            "success": True,
            "execution": execution_data,
        }
    except Exception as e:
        logger.error(f"Execution failed: {e}")

        # Publish execution failed event
        publish_workflow_event(workflow_id, "execution_failed", {
            "phase": "execution",
            "status": f"Execution failed: {str(e)}",
            "error": str(e),
        })

        return {
            "success": False,
            "error": str(e),
        }


# ============================================================================
# Activity: Testing Phase
# ============================================================================

@wfr.activity(name="testing")
def testing_activity(ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Run the testing phase using OpenAI agents.

    This activity:
    1. Creates a testing agent
    2. Runs it to verify the implementation
    3. Returns the test result
    """
    import asyncio
    from workflow_agent import create_testing_agent, TestResult

    plan = input_data.get("plan", {})
    execution = input_data.get("execution", {})
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 20)
    max_test_retries = input_data.get("max_test_retries", 3)
    workflow_id = input_data.get("workflow_id", "unknown")

    tests = plan.get("tests", [])
    logger.info(f"Testing activity started with {len(tests)} test cases")

    # Publish testing started event
    publish_workflow_event(workflow_id, "phase_started", {
        "phase": "testing",
        "status": f"Running {len(tests)} test cases...",
        "progress": 85,
        "tests_count": len(tests),
    })

    async def run_testing_streamed():
        from agents.run import RunResultStreaming
        from agents.stream_events import (
            RawResponsesStreamEvent,
            RunItemStreamEvent,
        )
        from agents.items import (
            ToolCallItem,
            ToolCallOutputItem,
            MessageOutputItem,
            ReasoningItem,
        )

        testing_agent = create_testing_agent(model)

        test_prompt = f"""Verify the implementation:

Plan Summary: {plan.get('summary', '')}

Test Cases:
{chr(10).join(f"- [{tc['id']}] {tc['description']} (type: {tc.get('test_type', '')}, command: {tc.get('command', '')})" for tc in tests)}

Execution Summary: {execution.get('output', '')}
Completed Tasks: {execution.get('completed_tasks', [])}"""

        test: TestResult = TestResult(
            passed=False, tests_run=0, tests_passed=0, tests_failed=0,
            failures=[], summary="Tests not yet run"
        )

        for attempt in range(max_test_retries):
            # Use streaming to capture detailed events
            result: RunResultStreaming = Runner.run_streamed(
                testing_agent,
                input=test_prompt,
                max_turns=max_turns,
            )

            accumulated_text = ""
            tool_call_count = 0
            tool_call_map = {}

            async for event in result.stream_events():
                try:
                    # Handle raw LLM response chunks
                    if isinstance(event, RawResponsesStreamEvent):
                        response = event.data
                        if hasattr(response, 'choices') and response.choices:
                            for choice in response.choices:
                                if hasattr(choice, 'delta') and choice.delta:
                                    delta = choice.delta
                                    if hasattr(delta, 'content') and delta.content:
                                        accumulated_text += delta.content
                                        if len(accumulated_text) >= 100:
                                            publish_llm_chunk(workflow_id, accumulated_text, "Tester")
                                            accumulated_text = ""

                    # Handle run items (tool calls, messages, reasoning)
                    elif isinstance(event, RunItemStreamEvent):
                        item = event.item

                        # Tool call started
                        if isinstance(item, ToolCallItem):
                            tool_call_count += 1
                            tool_name = None
                            if hasattr(item, 'name') and item.name:
                                tool_name = item.name
                            elif hasattr(item, 'tool_name') and item.tool_name:
                                tool_name = item.tool_name
                            elif hasattr(item, 'raw_item') and item.raw_item:
                                raw = item.raw_item
                                if hasattr(raw, 'function') and hasattr(raw.function, 'name'):
                                    tool_name = raw.function.name
                                elif hasattr(raw, 'name'):
                                    tool_name = raw.name
                            if not tool_name:
                                tool_name = f"tool_{tool_call_count}"

                            call_id = None
                            if hasattr(item, 'call_id') and item.call_id:
                                call_id = item.call_id
                            elif hasattr(item, 'id') and item.id:
                                call_id = item.id
                            elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'id'):
                                call_id = item.raw_item.id
                            if not call_id:
                                call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                            tool_args = {}
                            if hasattr(item, 'arguments') and item.arguments:
                                tool_args = item.arguments
                            elif hasattr(item, 'raw_item') and item.raw_item:
                                raw = item.raw_item
                                if hasattr(raw, 'arguments') and raw.arguments:
                                    try:
                                        args_str = raw.arguments
                                        if isinstance(args_str, str):
                                            tool_args = json.loads(args_str)
                                        elif isinstance(args_str, dict):
                                            tool_args = args_str
                                    except (json.JSONDecodeError, TypeError):
                                        tool_args = {"raw": str(raw.arguments)[:500]}

                            logger.info(f"Testing tool call: {tool_name}")
                            publish_tool_call(workflow_id, tool_name, tool_args, call_id)
                            tool_call_map[call_id] = tool_name

                        # Tool call result
                        elif isinstance(item, ToolCallOutputItem):
                            tool_name = None
                            if hasattr(item, 'tool_name') and item.tool_name:
                                tool_name = item.tool_name
                            elif hasattr(item, 'name') and item.name:
                                tool_name = item.name

                            call_id = None
                            if hasattr(item, 'call_id') and item.call_id:
                                call_id = item.call_id
                            elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'call_id'):
                                call_id = item.raw_item.call_id

                            if not tool_name and call_id and call_id in tool_call_map:
                                tool_name = tool_call_map[call_id]
                            if not tool_name:
                                tool_name = f"tool_{tool_call_count}"
                            if not call_id:
                                call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                            output = item.output if hasattr(item, 'output') else str(item)
                            is_error = hasattr(item, 'is_error') and item.is_error

                            logger.info(f"Testing tool result: {tool_name}")
                            publish_tool_result(workflow_id, tool_name, output, call_id, is_error)

                        # Reasoning/thinking
                        elif isinstance(item, ReasoningItem):
                            if hasattr(item, 'text') and item.text:
                                publish_thinking(workflow_id, item.text, "Tester")

                        # Message output
                        elif isinstance(item, MessageOutputItem):
                            if hasattr(item, 'text') and item.text:
                                publish_agent_message(workflow_id, item.text, "Tester")

                except Exception as e:
                    logger.debug(f"Error processing testing stream event: {e}")

            # Flush any remaining text
            if accumulated_text:
                publish_llm_chunk(workflow_id, accumulated_text, "Tester")

            # Get final output after stream completes
            test = result.final_output

            if test.passed:
                break

            # Publish retry event if not passed and more attempts remain
            if attempt < max_test_retries - 1:
                publish_workflow_event(workflow_id, "test_retry", {
                    "attempt": attempt + 1,
                    "max_retries": max_test_retries,
                    "status": f"Test attempt {attempt + 1} failed, retrying...",
                })

        return test.model_dump()

    try:
        test_data = asyncio.run(run_testing_streamed())
        logger.info(f"Testing completed: passed={test_data.get('passed')}")

        # Publish testing completed event
        publish_workflow_event(workflow_id, "phase_completed", {
            "phase": "testing",
            "status": "All tests passed!" if test_data.get("passed") else f"Tests failed: {test_data.get('tests_failed', 0)} failures",
            "progress": 95,
            "passed": test_data.get("passed", False),
            "tests_run": test_data.get("tests_run", 0),
            "tests_passed": test_data.get("tests_passed", 0),
            "tests_failed": test_data.get("tests_failed", 0),
        })

        return {
            "success": True,
            "testing": test_data,
        }
    except Exception as e:
        logger.error(f"Testing failed: {e}")

        # Publish testing failed event
        publish_workflow_event(workflow_id, "phase_failed", {
            "phase": "testing",
            "status": f"Testing failed: {str(e)}",
            "error": str(e),
        })

        return {
            "success": False,
            "error": str(e),
        }


# ============================================================================
# Activity: Combined Sandbox Execution + Testing Phase
# ============================================================================

@wfr.activity(name="sandboxed_execution_and_testing")
def sandboxed_execution_and_testing_activity(
    ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]
) -> Dict[str, Any]:
    """Run execution AND testing in a single Agent Sandbox pod.

    This keeps the workspace intact between phases - files created during
    execution are immediately available for testing. The sandbox provides:
    - Isolated execution environment (gVisor/Kata containers)
    - Dapr sidecar access via dapr-shared DaemonSet
    - Workspace persistence between phases
    - Automatic cleanup on completion

    This activity:
    1. Creates an Agent Sandbox pod
    2. Runs execution phase with streaming
    3. Runs testing phase in the same sandbox
    4. Cleans up the sandbox automatically
    5. Returns combined results
    """
    import asyncio
    from sandbox_executor import SandboxExecutor
    from workflow_agent import (
        create_execution_agent_sandboxed,
        create_testing_agent_sandboxed,
        ExecutionResult,
        TestResult,
    )

    plan = input_data.get("plan", {})
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 50)  # Increased for sandbox operations
    max_test_retries = input_data.get("max_test_retries", 3)
    workflow_id = input_data.get("workflow_id", "unknown")
    tasks = plan.get("tasks", [])
    tests = plan.get("tests", [])

    logger.info(
        f"Sandboxed execution+testing activity started: "
        f"{len(tasks)} tasks, {len(tests)} tests"
    )

    async def run_execution_streamed(execution_agent, plan_data, wf_id):
        """Run execution phase with streaming."""
        from agents.run import RunResultStreaming
        from agents.stream_events import (
            RawResponsesStreamEvent,
            RunItemStreamEvent,
        )
        from agents.items import (
            ToolCallItem,
            ToolCallOutputItem,
            MessageOutputItem,
            ReasoningItem,
        )

        exec_prompt = f"""Execute this plan:

Summary: {plan_data.get('summary', '')}

Tasks:
{chr(10).join(f"- [{t['id']}] {t['subject']}: {t['description']} (blockedBy: {t.get('blockedBy', [])})" for t in plan_data.get('tasks', []))}

Reasoning: {plan_data.get('reasoning', '')}"""

        result: RunResultStreaming = Runner.run_streamed(
            execution_agent,
            input=exec_prompt,
            max_turns=max_turns,
        )

        accumulated_text = ""
        tool_call_count = 0
        tool_call_map = {}

        async for event in result.stream_events():
            try:
                if isinstance(event, RawResponsesStreamEvent):
                    response = event.data
                    if hasattr(response, 'choices') and response.choices:
                        for choice in response.choices:
                            if hasattr(choice, 'delta') and choice.delta:
                                delta = choice.delta
                                if hasattr(delta, 'content') and delta.content:
                                    accumulated_text += delta.content
                                    if len(accumulated_text) >= 100:
                                        publish_llm_chunk(wf_id, accumulated_text, "Executor (Sandbox)")
                                        accumulated_text = ""

                elif isinstance(event, RunItemStreamEvent):
                    item = event.item

                    if isinstance(item, ToolCallItem):
                        tool_call_count += 1
                        tool_name = None
                        if hasattr(item, 'name') and item.name:
                            tool_name = item.name
                        elif hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'function') and hasattr(raw.function, 'name'):
                                tool_name = raw.function.name
                            elif hasattr(raw, 'name'):
                                tool_name = raw.name
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"

                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'id') and item.id:
                            call_id = item.id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'id'):
                            call_id = item.raw_item.id
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        tool_args = {}
                        if hasattr(item, 'arguments') and item.arguments:
                            tool_args = item.arguments
                        elif hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'arguments') and raw.arguments:
                                try:
                                    args_str = raw.arguments
                                    if isinstance(args_str, str):
                                        tool_args = json.loads(args_str)
                                    elif isinstance(args_str, dict):
                                        tool_args = args_str
                                except (json.JSONDecodeError, TypeError):
                                    tool_args = {"raw": str(raw.arguments)[:500]}

                        logger.info(f"Sandbox execution tool call: {tool_name}")
                        publish_tool_call(wf_id, tool_name, tool_args, call_id)
                        tool_call_map[call_id] = tool_name

                    elif isinstance(item, ToolCallOutputItem):
                        tool_name = None
                        if hasattr(item, 'tool_name') and item.tool_name:
                            tool_name = item.tool_name
                        elif hasattr(item, 'name') and item.name:
                            tool_name = item.name

                        call_id = None
                        if hasattr(item, 'call_id') and item.call_id:
                            call_id = item.call_id
                        elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'call_id'):
                            call_id = item.raw_item.call_id

                        if not tool_name and call_id and call_id in tool_call_map:
                            tool_name = tool_call_map[call_id]
                        if not tool_name:
                            tool_name = f"tool_{tool_call_count}"
                        if not call_id:
                            call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                        output = item.output if hasattr(item, 'output') else str(item)
                        is_error = hasattr(item, 'is_error') and item.is_error

                        logger.info(f"Sandbox execution tool result: {tool_name}")
                        publish_tool_result(wf_id, tool_name, output, call_id, is_error)

                    elif isinstance(item, ReasoningItem):
                        if hasattr(item, 'text') and item.text:
                            publish_thinking(wf_id, item.text[:500])

                    elif isinstance(item, MessageOutputItem):
                        content = ""
                        if hasattr(item, 'raw_item') and item.raw_item:
                            raw = item.raw_item
                            if hasattr(raw, 'content') and raw.content:
                                for part in raw.content:
                                    if hasattr(part, 'text'):
                                        content += part.text
                        if content:
                            publish_agent_message(wf_id, content[:500], "Executor (Sandbox)")

            except Exception as e:
                logger.debug(f"Error processing sandbox execution stream event: {e}")

        if accumulated_text:
            publish_llm_chunk(wf_id, accumulated_text, "Executor (Sandbox)")

        final_result = result.final_output
        if isinstance(final_result, ExecutionResult):
            return final_result.model_dump()
        logger.warning(f"Unexpected execution final_result type: {type(final_result)}")
        return {
            "success": True,
            "completed_tasks": [],
            "output": str(final_result)[:1000] if final_result else "",
            "errors": [],
        }

    async def run_testing_streamed(testing_agent, plan_data, execution_data, wf_id):
        """Run testing phase with streaming."""
        from agents.run import RunResultStreaming
        from agents.stream_events import (
            RawResponsesStreamEvent,
            RunItemStreamEvent,
        )
        from agents.items import (
            ToolCallItem,
            ToolCallOutputItem,
            MessageOutputItem,
            ReasoningItem,
        )

        test_cases = plan_data.get("tests", [])
        test_prompt = f"""Verify the implementation:

Plan Summary: {plan_data.get('summary', '')}

Test Cases:
{chr(10).join(f"- [{tc['id']}] {tc['description']} (type: {tc.get('test_type', '')}, command: {tc.get('command', '')})" for tc in test_cases)}

Execution Summary: {execution_data.get('output', '')}
Completed Tasks: {execution_data.get('completed_tasks', [])}"""

        test_result: TestResult = TestResult(
            passed=False, tests_run=0, tests_passed=0, tests_failed=0,
            failures=[], summary="Tests not yet run"
        )

        for attempt in range(max_test_retries):
            result: RunResultStreaming = Runner.run_streamed(
                testing_agent,
                input=test_prompt,
                max_turns=max_turns,
            )

            accumulated_text = ""
            tool_call_count = 0
            tool_call_map = {}

            async for event in result.stream_events():
                try:
                    if isinstance(event, RawResponsesStreamEvent):
                        response = event.data
                        if hasattr(response, 'choices') and response.choices:
                            for choice in response.choices:
                                if hasattr(choice, 'delta') and choice.delta:
                                    delta = choice.delta
                                    if hasattr(delta, 'content') and delta.content:
                                        accumulated_text += delta.content
                                        if len(accumulated_text) >= 100:
                                            publish_llm_chunk(wf_id, accumulated_text, "Tester (Sandbox)")
                                            accumulated_text = ""

                    elif isinstance(event, RunItemStreamEvent):
                        item = event.item

                        if isinstance(item, ToolCallItem):
                            tool_call_count += 1
                            tool_name = None
                            if hasattr(item, 'name') and item.name:
                                tool_name = item.name
                            elif hasattr(item, 'tool_name') and item.tool_name:
                                tool_name = item.tool_name
                            elif hasattr(item, 'raw_item') and item.raw_item:
                                raw = item.raw_item
                                if hasattr(raw, 'function') and hasattr(raw.function, 'name'):
                                    tool_name = raw.function.name
                                elif hasattr(raw, 'name'):
                                    tool_name = raw.name
                            if not tool_name:
                                tool_name = f"tool_{tool_call_count}"

                            call_id = None
                            if hasattr(item, 'call_id') and item.call_id:
                                call_id = item.call_id
                            elif hasattr(item, 'id') and item.id:
                                call_id = item.id
                            elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'id'):
                                call_id = item.raw_item.id
                            if not call_id:
                                call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                            tool_args = {}
                            if hasattr(item, 'arguments') and item.arguments:
                                tool_args = item.arguments
                            elif hasattr(item, 'raw_item') and item.raw_item:
                                raw = item.raw_item
                                if hasattr(raw, 'arguments') and raw.arguments:
                                    try:
                                        args_str = raw.arguments
                                        if isinstance(args_str, str):
                                            tool_args = json.loads(args_str)
                                        elif isinstance(args_str, dict):
                                            tool_args = args_str
                                    except (json.JSONDecodeError, TypeError):
                                        tool_args = {"raw": str(raw.arguments)[:500]}

                            logger.info(f"Sandbox testing tool call: {tool_name}")
                            publish_tool_call(wf_id, tool_name, tool_args, call_id)
                            tool_call_map[call_id] = tool_name

                        elif isinstance(item, ToolCallOutputItem):
                            tool_name = None
                            if hasattr(item, 'tool_name') and item.tool_name:
                                tool_name = item.tool_name
                            elif hasattr(item, 'name') and item.name:
                                tool_name = item.name

                            call_id = None
                            if hasattr(item, 'call_id') and item.call_id:
                                call_id = item.call_id
                            elif hasattr(item, 'raw_item') and item.raw_item and hasattr(item.raw_item, 'call_id'):
                                call_id = item.raw_item.call_id

                            if not tool_name and call_id and call_id in tool_call_map:
                                tool_name = tool_call_map[call_id]
                            if not tool_name:
                                tool_name = f"tool_{tool_call_count}"
                            if not call_id:
                                call_id = f"call-{tool_call_count}-{uuid.uuid4().hex[:8]}"

                            output = item.output if hasattr(item, 'output') else str(item)
                            is_error = hasattr(item, 'is_error') and item.is_error

                            logger.info(f"Sandbox testing tool result: {tool_name}")
                            publish_tool_result(wf_id, tool_name, output, call_id, is_error)

                        elif isinstance(item, ReasoningItem):
                            if hasattr(item, 'text') and item.text:
                                publish_thinking(wf_id, item.text[:500])

                        elif isinstance(item, MessageOutputItem):
                            if hasattr(item, 'text') and item.text:
                                publish_agent_message(wf_id, item.text[:500], "Tester (Sandbox)")

                except Exception as e:
                    logger.debug(f"Error processing sandbox testing stream event: {e}")

            if accumulated_text:
                publish_llm_chunk(wf_id, accumulated_text, "Tester (Sandbox)")

            test_result = result.final_output

            if test_result.passed:
                break

            if attempt < max_test_retries - 1:
                publish_workflow_event(wf_id, "test_retry", {
                    "attempt": attempt + 1,
                    "max_retries": max_test_retries,
                    "status": f"Test attempt {attempt + 1} failed, retrying in sandbox...",
                })

        return test_result.model_dump()

    try:
        with SandboxExecutor() as sandbox:
            # --- Phase 3: Execution in Sandbox ---
            publish_workflow_event(workflow_id, "phase_started", {
                "phase": "sandbox_execution",
                "status": f"Executing {len(tasks)} tasks in Agent Sandbox...",
                "progress": 50,
                "sandbox": True,
            })

            execution_agent = create_execution_agent_sandboxed(sandbox, model)
            execution_data = asyncio.run(run_execution_streamed(
                execution_agent, plan, workflow_id
            ))

            if not execution_data.get("success", True):
                publish_workflow_event(workflow_id, "execution_failed", {
                    "phase": "sandbox_execution",
                    "status": f"Sandbox execution failed: {execution_data.get('errors', [])}",
                    "error": str(execution_data.get("errors", [])),
                })
                return {
                    "success": False,
                    "phase": "execution",
                    "error": str(execution_data.get("errors", [])),
                    "execution": execution_data,
                }

            publish_workflow_event(workflow_id, "execution_completed", {
                "phase": "sandbox_execution",
                "status": "Sandbox execution completed",
                "progress": 80,
                "success": True,
                "completed_tasks": execution_data.get("completed_tasks", []),
            })

            # --- Phase 4: Testing in Same Sandbox ---
            publish_workflow_event(workflow_id, "phase_started", {
                "phase": "sandbox_testing",
                "status": f"Running {len(tests)} tests in Agent Sandbox...",
                "progress": 85,
                "sandbox": True,
            })

            testing_agent = create_testing_agent_sandboxed(sandbox, model)
            testing_data = asyncio.run(run_testing_streamed(
                testing_agent, plan, execution_data, workflow_id
            ))

            passed = testing_data.get("passed", False)

            publish_workflow_event(workflow_id, "phase_completed", {
                "phase": "sandbox_testing",
                "status": "All tests passed in sandbox!" if passed else f"Sandbox tests failed: {testing_data.get('tests_failed', 0)} failures",
                "progress": 95,
                "passed": passed,
                "tests_run": testing_data.get("tests_run", 0),
                "tests_passed": testing_data.get("tests_passed", 0),
                "tests_failed": testing_data.get("tests_failed", 0),
            })

            # Build result with proper error message if tests failed
            result = {
                "success": passed,
                "execution": execution_data,
                "testing": testing_data,
            }

            # Include error details if tests failed
            if not passed:
                failures = testing_data.get("failures", [])
                tests_failed = testing_data.get("tests_failed", 0)
                if failures:
                    result["error"] = f"Testing failed: {tests_failed} test(s) failed - {failures}"
                    result["phase"] = "testing"
                else:
                    result["error"] = f"Testing failed: {tests_failed} test(s) failed"
                    result["phase"] = "testing"

            return result

        # Sandbox automatically cleaned up on context exit

    except ImportError as e:
        logger.error(f"Sandbox client not available: {e}")
        publish_workflow_event(workflow_id, "phase_failed", {
            "phase": "sandbox_execution",
            "status": f"Sandbox client not available: {e}",
            "error": str(e),
        })
        return {
            "success": False,
            "phase": "sandbox_setup",
            "error": f"Sandbox client not available: {e}",
        }
    except Exception as e:
        logger.error(f"Sandboxed execution+testing failed: {e}")
        publish_workflow_event(workflow_id, "phase_failed", {
            "phase": "sandbox_execution",
            "status": f"Sandboxed execution failed: {e}",
            "error": str(e),
        })
        return {
            "success": False,
            "phase": "sandbox_execution",
            "error": str(e),
        }


# ============================================================================
# Workflow: Multi-Step Clone → Planning → Approval → Execution → Testing
# ============================================================================

@wfr.workflow(name="multi_step_workflow")
def multi_step_workflow(ctx: wf.DaprWorkflowContext, input_data: Dict[str, Any]):
    """Dapr workflow for multi-step clone → planning → approval → execution → testing.

    This workflow:
    0. Clone Phase (optional) - Clone repository if provided
    1. Planning Phase - Creates detailed plan with tasks and test cases
    2. Approval Phase - Wait for human approval (can be auto-approved)
    3. Execution Phase - Executes the plan
    4. Testing Phase - Verifies the implementation

    Each phase is a separate activity that appears in the UI workflow graph.
    """
    workflow_id = ctx.instance_id
    task = input_data.get("task", "")
    model = input_data.get("model", "gpt-5.2-codex")
    max_turns = input_data.get("max_turns", 20)
    max_test_retries = input_data.get("max_test_retries", 3)

    # Repository cloning configuration (optional)
    repository = input_data.get("repository")
    auto_approve = input_data.get("auto_approve", False)

    # Track workspace path - may be updated by clone
    workspace_path = input_data.get("workspace_dir", "/app/workspace")

    # --- Phase 0: Clone Repository (optional) ---
    if repository:
        ctx.set_custom_status(json.dumps({
            "phase": "cloning",
            "progress": 5,
            "message": f"Cloning {repository.get('owner')}/{repository.get('repo')}@{repository.get('branch', 'main')}...",
        }))

        clone_result = yield ctx.call_activity(
            clone_repository_activity,
            input={
                "owner": repository.get("owner"),
                "repo": repository.get("repo"),
                "branch": repository.get("branch", "main"),
                "token": repository.get("token"),
                "workspace_dir": workspace_path,
                "workflow_id": workflow_id,
            }
        )

        if not clone_result.get("success"):
            error = clone_result.get("error", "Unknown clone error")
            ctx.set_custom_status(json.dumps({
                "phase": "failed",
                "progress": 0,
                "message": f"Clone failed: {error}",
            }))
            return {
                "success": False,
                "workflow_id": workflow_id,
                "phase": "cloning",
                "error": error,
            }

        # Update workspace path to cloned repo
        workspace_path = clone_result.get("path", workspace_path)
        logger.info(f"Repository cloned to {workspace_path} ({clone_result.get('file_count', 0)} files)")

    # --- Phase 1: Planning ---
    ctx.set_custom_status(json.dumps({
        "phase": "planning",
        "progress": 10,
        "message": "Creating implementation plan with tasks and test cases...",
    }))

    planning_result = yield ctx.call_activity(
        planning_activity,
        input={
            "task": task,
            "model": model,
            "max_turns": max_turns,
            "workspace_path": workspace_path,
            "workflow_id": workflow_id,
        }
    )

    if not planning_result.get("success"):
        error = planning_result.get("error", "Unknown error")
        ctx.set_custom_status(json.dumps({
            "phase": "failed",
            "progress": 0,
            "message": f"Planning failed: {error}",
        }))
        return {
            "success": False,
            "workflow_id": workflow_id,
            "phase": "planning",
            "error": error,
        }

    plan = planning_result.get("plan", {})

    # --- Phase 2: Approval Gate ---
    if not auto_approve:
        ctx.set_custom_status(json.dumps({
            "phase": "awaiting_approval",
            "progress": 40,
            "message": f"Plan ready for review. {len(plan.get('tasks', []))} tasks pending approval...",
            "plan": plan,
        }))

        # Wait for external approval event (24h timeout handled by Dapr)
        logger.info(f"Workflow {workflow_id} waiting for approval event")
        approval = yield ctx.wait_for_external_event("approval")
        logger.info(f"Workflow {workflow_id} received approval event: {approval}")

        if not approval.get("approved", False):
            reason = approval.get("reason", "Plan rejected by user")
            ctx.set_custom_status(json.dumps({
                "phase": "rejected",
                "progress": 0,
                "message": f"Plan rejected: {reason}",
            }))
            return {
                "success": False,
                "workflow_id": workflow_id,
                "phase": "rejected",
                "reason": reason,
                "plan": plan,
            }

    # --- Phases 3+4: Combined Sandbox Execution + Testing ---
    # Runs both execution and testing in a single Agent Sandbox pod,
    # preserving the workspace between phases for immediate file access.
    ctx.set_custom_status(json.dumps({
        "phase": "sandbox_execution",
        "progress": 50,
        "message": f"Starting sandboxed execution and testing ({len(plan.get('tasks', []))} tasks, {len(plan.get('tests', []))} tests)...",
    }))

    sandbox_result = yield ctx.call_activity(
        sandboxed_execution_and_testing_activity,
        input={
            "plan": plan,
            "model": model,
            "max_turns": max_turns,
            "max_test_retries": max_test_retries,
            "workspace_path": workspace_path,
            "workflow_id": workflow_id,
        }
    )

    if not sandbox_result.get("success"):
        error = sandbox_result.get("error", "Unknown error")
        phase = sandbox_result.get("phase", "sandbox_execution")
        ctx.set_custom_status(json.dumps({
            "phase": "failed",
            "progress": 0,
            "message": f"Sandbox {phase} failed: {error}",
        }))
        return {
            "success": False,
            "workflow_id": workflow_id,
            "phase": phase,
            "error": error,
            "plan": plan,
            "execution": sandbox_result.get("execution", {}),
        }

    execution = sandbox_result.get("execution", {})
    testing = sandbox_result.get("testing", {})
    passed = testing.get("passed", False)

    # --- Completed ---
    ctx.set_custom_status(json.dumps({
        "phase": "completed" if passed else "tests_failed",
        "progress": 100,
        "message": "All tests passed!" if passed else f"Tests failed: {testing.get('tests_failed', 0)} failures",
    }))

    return {
        "success": passed,
        "workflow_id": workflow_id,
        "status": "completed" if passed else "failed",
        "plan": plan,
        "execution": execution,
        "testing": testing,
    }


def get_workflow_runtime() -> wf.WorkflowRuntime:
    """Get the workflow runtime instance."""
    return wfr
