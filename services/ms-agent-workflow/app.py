from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import UserDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ValidationError

from config import TemplateConfigResolver, parse_config_keys, parse_config_metadata
from tools import DEFAULT_WORKSPACE_ROOT, ToolRuntimeContext, resolve_tool_group

try:
    import dapr.ext.workflow as wf
    from dapr.ext.workflow import DaprWorkflowContext, DaprWorkflowClient
except ImportError:  # pragma: no cover - fallback for lightweight test environments
    class _StubWorkflowRuntime:
        def activity(self, name: str | None = None):
            def decorator(fn):
                return fn

            return decorator

        def workflow(self, name: str | None = None):
            def decorator(fn):
                return fn

            return decorator

        def start(self) -> None:
            return None

        def shutdown(self) -> None:
            return None

    class _StubWorkflowModule:
        WorkflowRuntime = _StubWorkflowRuntime

    class DaprWorkflowContext:  # type: ignore[no-redef]
        pass

    class DaprWorkflowClient:  # type: ignore[no-redef]
        def schedule_new_workflow(self, workflow: Any, input: dict[str, Any]) -> str:
            raise RuntimeError("Dapr workflow client unavailable in test fallback")

        def wait_for_workflow_completion(
            self, instance_id: str, timeout_in_seconds: int
        ) -> Any:
            raise RuntimeError("Dapr workflow client unavailable in test fallback")

        def get_workflow_state(self, instance_id: str, fetch_payloads: bool = True) -> Any:
            raise RuntimeError("Dapr workflow client unavailable in test fallback")

        def terminate_workflow(self, instance_id: str, output: str | None = None) -> None:
            return None

    wf = _StubWorkflowModule()

try:
    from agent_framework import Agent
    from agent_framework.openai import OpenAIChatClient
except ImportError:  # pragma: no cover - fallback for lightweight test environments
    class OpenAIChatClient:  # type: ignore[no-redef]
        def __init__(self, **_kwargs) -> None:
            pass

    class Agent:  # type: ignore[no-redef]
        def __init__(self, **_kwargs) -> None:
            pass

        async def run(self, prompt: str, **_kwargs) -> str:
            return prompt


logger = logging.getLogger(__name__)
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

PORT = int(os.environ.get("PORT", "8081"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_TEMPLATE_ID = os.environ.get("MS_AGENT_DEFAULT_TEMPLATE_ID", "repo-review")
DEFAULT_MODEL = os.environ.get("OPENAI_CHAT_MODEL_ID", "gpt-5.2")
WORKFLOW_NAME = os.environ.get("MS_AGENT_CHILD_WORKFLOW_RUN_NAME", "msAgentWorkflowV1")
ENABLE_DAPR_AGENTS_INSTRUMENTATION = (
    os.environ.get("ENABLE_DAPR_AGENTS_INSTRUMENTATION", "true").strip().lower()
    == "true"
)
SERVICE_VERSION = "1.1.0"
_EVENT_LOOP_THREAD_JOIN_TIMEOUT_SECONDS = 5
PromptMode = Literal["pass_through", "chain_previous", "template"]


@dataclass(frozen=True)
class TemplateStep:
    agent_name: str
    instructions: str
    description: str
    prompt_mode: PromptMode = "pass_through"
    prompt_template: str | None = None
    tool_group: str | None = None
    max_iterations: int = 40
    optional_flag: str | None = None


@dataclass(frozen=True)
class WorkflowTemplate:
    id: str
    label: str
    description: str
    steps: list[TemplateStep]
    default_model: str | None = None
    supports_tools: bool = False
    default_tool_group: str | None = None


class SafeFormatMap(UserDict[str, str]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


TEMPLATES: dict[str, WorkflowTemplate] = {
    "repo-review": WorkflowTemplate(
        id="repo-review",
        label="Repository Review",
        description="Structured repository review with architecture discovery, findings, and summary.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="read_only",
        steps=[
            TemplateStep(
                agent_name="RepoScout",
                description="Repository structure and architecture discovery",
                instructions=(
                    "Inspect the repository structure, important entry points, test layout, "
                    "deployment/runtime surfaces, and the files most relevant to the task."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Repository root: {cwd}\n\n"
                    "Task:\n{task}\n\n"
                    "Expected output:\n{expected_output}\n\n"
                    "Start by mapping the project structure, key directories, and likely critical paths."
                ),
                tool_group="read_only",
                max_iterations=15,
            ),
            TemplateStep(
                agent_name="Reviewer",
                description="Repository review findings",
                instructions=(
                    "Review the implementation with focus on: {focus_areas}. "
                    "Produce prioritized findings with file references and concrete engineering impact."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Original task:\n{task}\n\n"
                    "Repository map:\n{previous_output}\n\n"
                    "Now perform the review and identify the highest-value findings."
                ),
                tool_group="read_only",
                max_iterations=25,
            ),
            TemplateStep(
                agent_name="Summarizer",
                description="Engineer-facing summary",
                instructions=(
                    "Summarize the repository purpose, major subsystems, deployment shape, "
                    "key docs, and the most important findings in a compact handoff format."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Repository review findings:\n{step_1_output}\n\n"
                    "Expected output:\n{expected_output}\n\n"
                    "Produce the final structured summary."
                ),
                tool_group="read_only",
                max_iterations=12,
            ),
        ],
    ),
    "implement-task": WorkflowTemplate(
        id="implement-task",
        label="Implement Task",
        description="Plan, edit, verify, and summarize a coding task with Microsoft Agent Framework specialists.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="all",
        steps=[
            TemplateStep(
                agent_name="Planner",
                description="Implementation planning specialist",
                instructions=(
                    "Inspect the codebase and produce the smallest coherent implementation plan "
                    "for the requested task before editing files."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Repository root: {cwd}\n\n"
                    "Task:\n{task}\n\n"
                    "Expected output:\n{expected_output}\n\n"
                    "Plan the implementation in a concise engineering checklist."
                ),
                tool_group="read_only",
                max_iterations=12,
            ),
            TemplateStep(
                agent_name="Editor",
                description="Implementation editing specialist",
                instructions=(
                    "Implement the requested task directly. Keep edits minimal, consistent, "
                    "and confined to the repository root."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Implementation plan:\n{previous_output}\n\n"
                    "Apply the code changes now."
                ),
                tool_group="all",
                max_iterations=30,
            ),
            TemplateStep(
                agent_name="Verifier",
                description="Verification and summary specialist",
                instructions=(
                    "Review the resulting changes, run the requested verification commands when provided, "
                    "and summarize the outcome, including any residual risks."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Implementation summary:\n{step_1_output}\n\n"
                    "Verification commands:\n{verify_commands}\n\n"
                    "Verify the work and produce the final engineering summary."
                ),
                tool_group="all",
                max_iterations=18,
            ),
        ],
    ),
    "fix-tests": WorkflowTemplate(
        id="fix-tests",
        label="Fix Tests",
        description="Investigate a failing test or verification command, repair it, and summarize the fix.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="all",
        steps=[
            TemplateStep(
                agent_name="FailureAnalyzer",
                description="Failure reproduction and diagnosis",
                instructions=(
                    "Reproduce or inspect the failing test scenario, identify the likely root cause, "
                    "and describe the narrowest robust fix."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Repository root: {cwd}\n\n"
                    "Task:\n{task}\n\n"
                    "Verification commands:\n{verify_commands}\n\n"
                    "If verification commands are provided, use them to diagnose the failure."
                ),
                tool_group="all",
                max_iterations=18,
            ),
            TemplateStep(
                agent_name="RepairEngineer",
                description="Apply the repair",
                instructions=(
                    "Implement the smallest durable repair for the diagnosed failure and keep the change set focused."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Diagnosis:\n{previous_output}\n\n"
                    "Apply the repair now."
                ),
                tool_group="all",
                max_iterations=24,
            ),
            TemplateStep(
                agent_name="RegressionReviewer",
                description="Regression and residual risk summary",
                instructions=(
                    "Verify the repaired state, note any remaining failure modes, and summarize what changed."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Repair summary:\n{step_1_output}\n\n"
                    "Verification commands:\n{verify_commands}\n\n"
                    "Provide the final verification summary."
                ),
                tool_group="all",
                max_iterations=15,
            ),
        ],
    ),
    "explain-code": WorkflowTemplate(
        id="explain-code",
        label="Explain Code",
        description="Read the repository and produce a guided explanation for engineers.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="read_only",
        steps=[
            TemplateStep(
                agent_name="CodeExplorer",
                description="Codebase exploration",
                instructions=(
                    "Inspect the relevant files and trace the control flow or system boundaries needed to answer the task."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Repository root: {cwd}\n\n"
                    "Question:\n{task}\n\n"
                    "Expected output:\n{expected_output}\n\n"
                    "Explore the code paths required to answer it accurately."
                ),
                tool_group="read_only",
                max_iterations=16,
            ),
            TemplateStep(
                agent_name="Explainer",
                description="Engineer-facing explanation",
                instructions=(
                    "Explain the code clearly for another engineer. Include the purpose, main execution path, "
                    "important data flows, and caveats."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Question:\n{task}\n\n"
                    "Exploration notes:\n{previous_output}\n\n"
                    "Produce the final explanation."
                ),
                tool_group="read_only",
                max_iterations=12,
            ),
        ],
    ),
    "custom-coding-workflow": WorkflowTemplate(
        id="custom-coding-workflow",
        label="Custom Coding Workflow",
        description="General multi-phase coding workflow with planning, editing, review, and optional verification.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="all",
        steps=[
            TemplateStep(
                agent_name="Planner",
                description="Task planning",
                instructions="Create a concrete engineering plan for the requested coding task.",
                prompt_mode="template",
                prompt_template="Repository root: {cwd}\n\nTask:\n{task}\n\nPlan the work.",
                tool_group="read_only",
                max_iterations=12,
            ),
            TemplateStep(
                agent_name="Editor",
                description="Code editing",
                instructions="Apply the requested coding changes directly in the repository.",
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Plan:\n{previous_output}\n\n"
                    "Implement the changes now."
                ),
                tool_group="all",
                max_iterations=30,
            ),
            TemplateStep(
                agent_name="Reviewer",
                description="Change review and summary",
                instructions=(
                    "Review the final changes, verify where appropriate, and summarize the outcome with risks."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Task:\n{task}\n\n"
                    "Implementation output:\n{step_1_output}\n\n"
                    "Verification commands:\n{verify_commands}\n\n"
                    "Produce the final review."
                ),
                tool_group="all",
                max_iterations=16,
            ),
        ],
    ),
    "travel-planner": WorkflowTemplate(
        id="travel-planner",
        label="Travel Planner",
        description="Sequential trip-planning workflow: extract destination, draft outline, expand itinerary.",
        steps=[
            TemplateStep(
                agent_name="DestinationExtractor",
                description="Travel Planner destination extraction agent",
                instructions=(
                    "Extract the main destination city from the user's request. "
                    "Return only the city or destination name with no extra text."
                ),
                prompt_mode="pass_through",
            ),
            TemplateStep(
                agent_name="PlannerAgent",
                description="Travel Planner outline planning agent",
                instructions=(
                    "Create a concise 3-day outline for the destination. "
                    "Balance culture, food, and leisure in bullet form."
                ),
                prompt_mode="template",
                prompt_template="Destination: {previous_output}\nCreate a concise 3-day outline.",
            ),
            TemplateStep(
                agent_name="ItineraryAgent",
                description="Travel Planner itinerary expansion agent",
                instructions=(
                    "Expand the outline into a detailed 3-day itinerary. "
                    "Each day must have Morning, Afternoon, and Evening sections."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Destination: {step_0_output}\n\n"
                    "Outline:\n{previous_output}\n\n"
                    "Expand this into a detailed itinerary."
                ),
            ),
        ],
        default_model=DEFAULT_MODEL,
    ),
    "code-review": WorkflowTemplate(
        id="code-review",
        label="Legacy Code Review",
        description="Analyze a repository, produce findings, and optionally apply targeted fixes.",
        supports_tools=True,
        default_model=DEFAULT_MODEL,
        default_tool_group="read_only",
        steps=[
            TemplateStep(
                agent_name="StructureAnalyzer",
                description="Repository structure analysis agent",
                instructions=(
                    "Explore the repository structure before reviewing implementation details. "
                    "Summarize the languages, key entry points, major directories, and risky areas."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Review this repository rooted at {cwd}.\n"
                    "Task:\n{task}\n\n"
                    "Start by understanding the codebase structure and the most relevant files."
                ),
                tool_group="read_only",
                max_iterations=15,
            ),
            TemplateStep(
                agent_name="CodeReviewer",
                description="Code review agent",
                instructions=(
                    "Review the implementation with focus on: {focus_areas}. "
                    "Produce concrete findings with file paths and line references when possible."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Original task:\n{task}\n\n"
                    "Repository summary:\n{previous_output}\n\n"
                    "Now perform the code review and produce prioritized findings."
                ),
                tool_group="read_only",
                max_iterations=25,
            ),
            TemplateStep(
                agent_name="FixApplicator",
                description="Fix application agent",
                instructions=(
                    "Apply targeted fixes for the confirmed findings. "
                    "Keep changes minimal, safe, and consistent with the existing codebase."
                ),
                prompt_mode="template",
                prompt_template=(
                    "Original task:\n{task}\n\n"
                    "Review findings:\n{step_1_output}\n\n"
                    "Apply the fixes now, then summarize exactly what changed."
                ),
                tool_group="read_write",
                max_iterations=20,
                optional_flag="applyFixes",
            ),
        ],
    ),
}


def _coerce_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("content", "text", "value", "message"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return json.dumps(value)
    if hasattr(value, "messages"):
        messages = getattr(value, "messages", [])
        if isinstance(messages, list):
            for message in messages:
                text = getattr(message, "text", None)
                if isinstance(text, str) and text.strip():
                    return text.strip()
    text = getattr(value, "text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    return str(value).strip()


def _parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return default


def _parse_review_focus_areas(value: Any) -> list[str]:
    if isinstance(value, list):
        values = [str(item).strip() for item in value if str(item).strip()]
        return values
    if not isinstance(value, str):
        return []
    values = [part.strip() for part in value.replace("\n", ",").split(",")]
    return [value for value in values if value]


class MicrosoftAgentAdapter:
    def __init__(
        self,
        *,
        name: str,
        instructions: str,
        description: str,
        model: str,
        tools: list[Any] | None = None,
        api_key: str | None = None,
    ) -> None:
        self.name = name
        self.instructions = instructions
        self.description = description
        self.model = model
        self.tools = tools or []
        self.api_key = api_key

    def _build_agent(self) -> Agent:
        return Agent(
            chat_client=OpenAIChatClient(
                model_id=self.model,
                api_key=self.api_key,
            ),
            name=self.name,
            description=self.description,
            instructions=self.instructions,
            tools=self.tools,
        )

    async def run(self, prompt: str, **tool_kwargs: Any) -> str:
        result = await self._build_agent().run(prompt, **tool_kwargs)
        return _coerce_text(result)


class AsyncRunner:
    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="ms-agent-workflow-async-runner",
            daemon=True,
        )
        self._thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run(self, awaitable: Any) -> Any:
        future = asyncio.run_coroutine_threadsafe(awaitable, self._loop)
        return future.result()

    def shutdown(self) -> None:
        if not self._loop.is_running():
            return
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=_EVENT_LOOP_THREAD_JOIN_TIMEOUT_SECONDS)
        self._loop.close()


async_runner: AsyncRunner | None = None
workflow_client: DaprWorkflowClient | None = None
config_resolver: TemplateConfigResolver | None = None
runtime = wf.WorkflowRuntime()


def _run_async(awaitable: Any) -> Any:
    if async_runner is not None:
        return async_runner.run(awaitable)
    return asyncio.run(awaitable)


def _resolve_template(template_id: str | None) -> WorkflowTemplate:
    normalized = str(template_id or DEFAULT_TEMPLATE_ID).strip() or DEFAULT_TEMPLATE_ID
    template = TEMPLATES.get(normalized)
    if template is None:
        raise ValueError(f"Unknown workflow template: {normalized}")
    return template


def _format_template_text(template_text: str, values: dict[str, Any]) -> str:
    return template_text.format_map(
        SafeFormatMap({key: _coerce_text(value) for key, value in values.items()})
    )


def _build_step_context(
    *,
    task: str,
    step_outputs: list[dict[str, Any]],
    cwd: str | None,
    review_focus_areas: list[str],
    expected_output: str | None = None,
    verify_commands: str | None = None,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "task": task,
        "cwd": cwd or DEFAULT_WORKSPACE_ROOT,
        "focus_areas": ", ".join(review_focus_areas) if review_focus_areas else "general code quality",
        "review_focus_areas": ", ".join(review_focus_areas),
        "expected_output": expected_output or "",
        "verify_commands": verify_commands or "",
    }
    if step_outputs:
        values["previous_output"] = _coerce_text(step_outputs[-1].get("content"))
        values["previous_agent"] = step_outputs[-1].get("agent")
    for index, output in enumerate(step_outputs):
        values[f"step_{index}_output"] = _coerce_text(output.get("content"))
        values[f"step_{index}_agent"] = output.get("agent")
    return values


def _build_step_prompt(
    *,
    step: TemplateStep,
    task: str,
    step_context: dict[str, Any],
) -> str:
    if step.prompt_mode == "pass_through":
        return task
    if step.prompt_mode == "chain_previous":
        previous_output = str(step_context.get("previous_output") or "").strip()
        if not previous_output:
            return task
        return f"Original task:\n{task}\n\nPrevious step output:\n{previous_output}"
    if step.prompt_mode == "template" and step.prompt_template:
        return _format_template_text(step.prompt_template, step_context)
    return task


def _resolve_workspace_root(cwd: str | None) -> str:
    value = str(cwd or DEFAULT_WORKSPACE_ROOT).strip()
    return value or DEFAULT_WORKSPACE_ROOT


def _run_agent_step(
    *,
    agent_name: str,
    instructions: str,
    description: str,
    prompt: str,
    model: str | None,
    tool_group: str | None = None,
    workspace_root: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    resolved_model = str(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    tools = resolve_tool_group(tool_group)
    adapter = MicrosoftAgentAdapter(
        name=agent_name,
        instructions=instructions,
        description=description,
        model=resolved_model,
        tools=tools,
        api_key=api_key.strip() if isinstance(api_key, str) and api_key.strip() else None,
    )

    tool_kwargs: dict[str, Any] = {}
    tool_context: ToolRuntimeContext | None = None
    if tools:
        tool_context = ToolRuntimeContext.from_workspace_root(
            _resolve_workspace_root(workspace_root)
        )
        tool_kwargs["tool_context"] = tool_context
        tool_kwargs["workspace_root"] = str(tool_context.workspace_root)

    content = _run_async(adapter.run(prompt, **tool_kwargs))
    summary = tool_context.build_summary() if tool_context is not None else {}
    return {"content": content, **summary}


class WorkflowRunRequest(BaseModel):
    prompt: str = Field(min_length=1)
    workflowTemplateId: str = Field(default=DEFAULT_TEMPLATE_ID)
    model: str | None = None
    openAIApiKey: str | None = None
    waitForCompletion: bool = Field(default=False)
    timeoutMinutes: int = Field(default=10, ge=1, le=60)
    reviewFocusAreas: list[str] | str | None = None
    workspaceRef: str | None = None
    cwd: str | None = None
    applyFixes: bool | str | None = None
    maxIterations: int | None = Field(default=None, ge=1, le=200)
    instructionsOverlay: str | None = None
    expectedOutput: str | None = None
    verifyCommands: str | None = None
    toolGroup: str | None = None
    configStoreName: str | None = None
    configKeys: list[str] | str | None = None
    configMetadata: dict[str, str] | str | None = None


class TerminateWorkflowRequest(BaseModel):
    reason: str | None = None


class ExecuteRequest(BaseModel):
    step: str = Field(min_length=1)
    execution_id: str = Field(min_length=1)
    workflow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    input: dict[str, Any] = Field(default_factory=dict)
    node_outputs: dict[str, Any] | None = None
    credentials: dict[str, str] | None = None


def _normalize_status(runtime_status: str | None) -> str:
    normalized = str(runtime_status or "").strip().lower()
    if normalized in {"completed", "running", "failed", "terminated", "suspended", "pending"}:
        return normalized
    if normalized == "continuedasnew":
        return "running"
    return "unknown"


def _parse_workflow_output(state: Any) -> dict[str, Any] | None:
    serialized_output = getattr(state, "serialized_output", None)
    if not serialized_output:
        return None
    try:
        parsed = json.loads(serialized_output)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _extract_openai_api_key(credentials: dict[str, str] | None) -> str | None:
    if not credentials:
        return None
    candidate = credentials.get("OPENAI_API_KEY")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


def _build_public_result(
    *,
    instance_id: str,
    template_id: str,
    model: str | None,
    workflow_result: dict[str, Any] | None,
) -> dict[str, Any]:
    payload = workflow_result or {}
    text = _coerce_text(
        payload.get("text")
        or payload.get("finalAnswer")
        or payload.get("final_answer")
        or payload.get("content")
        or ""
    )
    resolved_template_id = str(
        payload.get("workflowTemplateId")
        or payload.get("workflow_template_id")
        or template_id
        or DEFAULT_TEMPLATE_ID
    )
    resolved_model = str(payload.get("model") or model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    steps = payload.get("steps")
    if not isinstance(steps, list):
        steps = []
    return {
        "text": text,
        "content": text,
        "finalAnswer": text,
        "workflowTemplateId": resolved_template_id,
        "model": resolved_model,
        "steps": steps,
        "reviewFindings": payload.get("reviewFindings"),
        "filesAnalyzed": payload.get("filesAnalyzed") or [],
        "fixesApplied": payload.get("fixesApplied") or [],
        "patch": payload.get("patch") or "",
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
    }


def _schedule_workflow(
    request: WorkflowRunRequest,
) -> tuple[str, dict[str, Any]]:
    if workflow_client is None:
        raise HTTPException(status_code=503, detail="Workflow client not ready")

    instance_id = workflow_client.schedule_new_workflow(
        workflow=ms_agent_workflow,
        input={
            "task": request.prompt,
            "workflowTemplateId": request.workflowTemplateId,
            "model": request.model,
            "openAIApiKey": request.openAIApiKey,
            "reviewFocusAreas": request.reviewFocusAreas,
            "workspaceRef": request.workspaceRef,
            "cwd": request.cwd,
            "applyFixes": request.applyFixes,
            "maxIterations": request.maxIterations,
            "instructionsOverlay": request.instructionsOverlay,
            "expectedOutput": request.expectedOutput,
            "verifyCommands": request.verifyCommands,
            "toolGroup": request.toolGroup,
            "configStoreName": request.configStoreName,
            "configKeys": request.configKeys,
            "configMetadata": request.configMetadata,
        },
    )

    response: dict[str, Any] = {
        "success": True,
        "workflow_id": instance_id,
        "workflowId": instance_id,
        "dapr_instance_id": instance_id,
        "daprInstanceId": instance_id,
        "status": "running",
        "status_url": f"/api/run/{instance_id}",
    }
    return instance_id, response


def _resolve_runtime_settings(
    template: WorkflowTemplate,
    input_payload: dict[str, Any],
) -> dict[str, Any]:
    template_config = (config_resolver or TemplateConfigResolver()).resolve(
        template_id=template.id,
        store_name=str(input_payload.get("configStoreName") or "").strip() or None,
        requested_keys=parse_config_keys(input_payload.get("configKeys")),
        metadata=parse_config_metadata(input_payload.get("configMetadata")),
    )

    requested_model = str(input_payload.get("model") or "").strip() or None
    requested_overlay = str(input_payload.get("instructionsOverlay") or "").strip() or None
    requested_max_iterations = input_payload.get("maxIterations")
    requested_tool_group = str(input_payload.get("toolGroup") or "").strip() or None

    max_iterations: int | None = None
    if requested_max_iterations is not None:
        try:
            parsed = int(requested_max_iterations)
        except (TypeError, ValueError):
            parsed = None
        if parsed and parsed > 0:
            max_iterations = parsed
    elif template_config.max_iterations is not None:
        max_iterations = template_config.max_iterations

    return {
        "model": requested_model or template_config.model or template.default_model or DEFAULT_MODEL,
        "instructions_overlay": requested_overlay or template_config.instructions_overlay,
        "max_iterations": max_iterations,
        "tool_group_override": requested_tool_group or template_config.tool_group,
    }


@runtime.activity(name="run_template_step")
def run_template_step(_ctx, input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = input_data or {}
    tool_group = payload.get("toolGroup")
    result = _run_agent_step(
        agent_name=str(payload.get("agentName") or "Agent"),
        instructions=str(payload.get("instructions") or "").strip(),
        description=str(payload.get("description") or "").strip(),
        prompt=str(payload.get("prompt") or "").strip(),
        model=payload.get("model"),
        tool_group=str(tool_group).strip() if tool_group else None,
        workspace_root=payload.get("cwd"),
        api_key=payload.get("openAIApiKey"),
    )
    return result


@runtime.workflow(name=WORKFLOW_NAME)
def ms_agent_workflow(
    ctx: DaprWorkflowContext, input_data: dict[str, Any] | str
) -> dict[str, Any]:
    if isinstance(input_data, str):
        input_payload = {
            "task": input_data,
            "workflowTemplateId": DEFAULT_TEMPLATE_ID,
            "model": DEFAULT_MODEL,
            "openAIApiKey": None,
        }
    else:
        input_payload = input_data

    template = _resolve_template(input_payload.get("workflowTemplateId"))
    task = str(input_payload.get("task") or input_payload.get("prompt") or "").strip()
    if not task:
        raise ValueError("task is required")

    runtime_settings = _resolve_runtime_settings(template, input_payload)
    model = runtime_settings["model"]
    openai_api_key = (
        str(input_payload.get("openAIApiKey")).strip()
        if input_payload.get("openAIApiKey")
        else None
    )
    cwd = str(input_payload.get("cwd") or DEFAULT_WORKSPACE_ROOT).strip() or DEFAULT_WORKSPACE_ROOT
    review_focus_areas = _parse_review_focus_areas(input_payload.get("reviewFocusAreas"))
    apply_fixes = _parse_bool(input_payload.get("applyFixes"), False)
    expected_output = str(input_payload.get("expectedOutput") or "").strip() or None
    verify_commands = str(input_payload.get("verifyCommands") or "").strip() or None
    instructions_overlay = runtime_settings["instructions_overlay"]
    max_iterations_override = runtime_settings["max_iterations"]
    tool_group_override = runtime_settings["tool_group_override"]

    step_outputs: list[dict[str, Any]] = []

    for index, step in enumerate(template.steps):
        if step.optional_flag == "applyFixes" and not apply_fixes:
            continue

        step_context = _build_step_context(
            task=task,
            step_outputs=step_outputs,
            cwd=cwd,
            review_focus_areas=review_focus_areas,
            expected_output=expected_output,
            verify_commands=verify_commands,
        )
        prompt = _build_step_prompt(step=step, task=task, step_context=step_context)
        instructions = _format_template_text(step.instructions, step_context)
        if instructions_overlay:
            instructions = (
                f"{instructions}\n\n"
                f"Additional runtime instructions:\n{instructions_overlay}"
            )
        effective_max_iterations = max_iterations_override or step.max_iterations
        if effective_max_iterations > 0:
            instructions = (
                f"{instructions}\n\n"
                f"Do not exceed {effective_max_iterations} reasoning or tool iterations."
            )
        tool_group = tool_group_override or step.tool_group or template.default_tool_group

        step_result = yield ctx.call_activity(
            run_template_step,
            input={
                "agentName": step.agent_name,
                "description": step.description,
                "instructions": instructions,
                "prompt": prompt,
                "model": model,
                "openAIApiKey": openai_api_key,
                "toolGroup": tool_group,
                "cwd": cwd,
            },
        )
        step_outputs.append(
            {
                "index": index,
                "agent": step.agent_name,
                "content": _coerce_text(step_result.get("content")),
                "toolGroup": tool_group,
                "filesAnalyzed": step_result.get("filesAnalyzed") or [],
                "fixesApplied": step_result.get("fixesApplied") or [],
                "patch": step_result.get("patch") or "",
            }
        )

    final_step = step_outputs[-1] if step_outputs else {"content": ""}
    aggregated_files = sorted(
        {
            path
            for output in step_outputs
            for path in (output.get("filesAnalyzed") or [])
        }
    )
    aggregated_fixes = sorted(
        {
            path
            for output in step_outputs
            for path in (output.get("fixesApplied") or [])
        }
    )
    patch = "\n".join(
        chunk
        for chunk in (str(output.get("patch") or "").strip() for output in step_outputs)
        if chunk
    ).strip()
    review_findings_agent = {
        "code-review": "CodeReviewer",
        "repo-review": "Reviewer",
    }.get(template.id)
    review_findings = (
        next(
            (
                output.get("content")
                for output in step_outputs
                if output.get("agent") == review_findings_agent
            ),
            None,
        )
        if review_findings_agent
        else None
    )
    final_text = _coerce_text(final_step.get("content"))

    return {
        "success": True,
        "workflow_template_id": template.id,
        "workflowTemplateId": template.id,
        "workflow_template_label": template.label,
        "workflowTemplateLabel": template.label,
        "model": model,
        "text": final_text,
        "content": final_text,
        "final_answer": final_text,
        "finalAnswer": final_text,
        "steps": step_outputs,
        "reviewFindings": review_findings,
        "filesAnalyzed": aggregated_files,
        "fixesApplied": aggregated_fixes,
        "patch": patch,
        "workspaceRef": input_payload.get("workspaceRef"),
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global async_runner, workflow_client, config_resolver
    if ENABLE_DAPR_AGENTS_INSTRUMENTATION:
        try:
            from dapr_agents.observability import DaprAgentsInstrumentor

            DaprAgentsInstrumentor().instrument()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to enable dapr-agents instrumentation: %s", exc)
    async_runner = AsyncRunner()
    runtime.start()
    workflow_client = DaprWorkflowClient()
    config_resolver = TemplateConfigResolver()
    logger.info(
        "Microsoft Agent Workflow service started on http://%s:%s",
        HOST,
        PORT,
    )
    try:
        yield
    finally:
        if async_runner is not None:
            async_runner.shutdown()
            async_runner = None
        runtime.shutdown()


app = FastAPI(
    title="Microsoft Agent Workflow Service",
    description="Dapr workflow service that runs Microsoft Agent Framework agents through template-driven durable workflows.",
    version=SERVICE_VERSION,
    lifespan=lifespan,
)


@app.get("/health")
def simple_health() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    return {"status": "ready"}


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "ms-agent-workflow",
        "version": SERVICE_VERSION,
        "workflowName": WORKFLOW_NAME,
        "defaultTemplateId": DEFAULT_TEMPLATE_ID,
    }


def _serialize_template(template: WorkflowTemplate) -> dict[str, Any]:
    return {
        "id": template.id,
        "label": template.label,
        "description": template.description,
        "defaultModel": template.default_model or DEFAULT_MODEL,
        "supportsTools": template.supports_tools,
        "defaultToolGroup": template.default_tool_group,
        "steps": [
            {
                "agentName": step.agent_name,
                "description": step.description,
                "promptMode": step.prompt_mode,
                "toolGroup": step.tool_group,
                "maxIterations": step.max_iterations,
                "optionalFlag": step.optional_flag,
            }
            for step in template.steps
        ],
    }


@app.get("/api/tools")
def list_tools() -> dict[str, Any]:
    return {
        "success": True,
        "tools": [
            {
                "id": template.id,
                "description": template.description,
                "label": template.label,
                "supportsTools": template.supports_tools,
                "defaultToolGroup": template.default_tool_group,
            }
            for template in TEMPLATES.values()
        ],
    }


@app.get("/api/templates")
def list_templates() -> dict[str, Any]:
    return {
        "success": True,
        "templates": [_serialize_template(template) for template in TEMPLATES.values()],
    }


@app.get("/api/runtime/introspect")
def runtime_introspect() -> dict[str, Any]:
    return {
        "success": True,
        "service": "ms-agent-workflow",
        "version": SERVICE_VERSION,
        "workflows": [
            {
                "name": WORKFLOW_NAME,
                "version": "v1",
                "aliases": [WORKFLOW_NAME],
            }
        ],
        "activities": ["run_template_step"],
        "toolGroups": {
            "read_only": ["read_file", "list_files", "grep_search"],
            "read_write": [
                "read_file",
                "list_files",
                "grep_search",
                "write_file",
                "edit_file",
            ],
            "all": [
                "read_file",
                "list_files",
                "grep_search",
                "write_file",
                "edit_file",
                "execute_command",
            ],
        },
        "templates": [_serialize_template(template) for template in TEMPLATES.values()],
    }


@app.post("/api/run")
def run_workflow(request: WorkflowRunRequest) -> dict[str, Any]:
    instance_id, response = _schedule_workflow(request)

    if request.waitForCompletion:
        state = workflow_client.wait_for_workflow_completion(
            instance_id,
            timeout_in_seconds=request.timeoutMinutes * 60,
        )
        if state is None:
            raise HTTPException(status_code=504, detail="Workflow completion timed out")
        workflow_result = _parse_workflow_output(state)
        response["status"] = _normalize_status(getattr(state.runtime_status, "name", None))
        response["result"] = workflow_result
        if workflow_result:
            response["data"] = _build_public_result(
                instance_id=instance_id,
                template_id=request.workflowTemplateId,
                model=request.model,
                workflow_result=workflow_result,
            )

    return response


@app.get("/api/run/{instance_id}")
def get_run(instance_id: str) -> dict[str, Any]:
    if workflow_client is None:
        raise HTTPException(status_code=503, detail="Workflow client not ready")

    state = workflow_client.get_workflow_state(
        instance_id=instance_id,
        fetch_payloads=True,
    )
    if state is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    workflow_result = _parse_workflow_output(state)
    status = _normalize_status(getattr(state.runtime_status, "name", None))

    return {
        "success": True,
        "instanceId": instance_id,
        "runtimeStatus": getattr(state.runtime_status, "name", None),
        "status": status,
        "createdAt": state.created_at.isoformat() if state.created_at else None,
        "lastUpdatedAt": (
            state.last_updated_at.isoformat() if state.last_updated_at else None
        ),
        "result": workflow_result,
        "data": (
            _build_public_result(
                instance_id=instance_id,
                template_id=str(
                    workflow_result.get("workflowTemplateId")
                    or workflow_result.get("workflow_template_id")
                    or DEFAULT_TEMPLATE_ID
                )
                if workflow_result
                else DEFAULT_TEMPLATE_ID,
                model=(
                    str(workflow_result.get("model"))
                    if workflow_result and workflow_result.get("model")
                    else None
                ),
                workflow_result=workflow_result,
            )
            if workflow_result
            else None
        ),
        "error": (
            workflow_result.get("error")
            if workflow_result and isinstance(workflow_result.get("error"), str)
            else None
        ),
    }


@app.post("/api/run/{instance_id}/terminate")
def terminate_run(instance_id: str, request: TerminateWorkflowRequest) -> dict[str, Any]:
    if workflow_client is None:
        raise HTTPException(status_code=503, detail="Workflow client not ready")

    workflow_client.terminate_workflow(
        instance_id=instance_id,
        output=request.reason or "terminated by caller",
    )
    return {"success": True, "instanceId": instance_id}


@app.post("/execute")
def execute_step(request: ExecuteRequest) -> dict[str, Any]:
    start_time = time.time()

    if request.step != "run":
        return {
            "success": False,
            "error": f"Unknown step: {request.step}. Available steps: run",
            "duration_ms": int((time.time() - start_time) * 1000),
        }

    try:
        run_request = WorkflowRunRequest.model_validate(
            {
                "prompt": request.input.get("prompt"),
                "workflowTemplateId": request.input.get(
                    "workflowTemplateId", DEFAULT_TEMPLATE_ID
                ),
                "model": request.input.get("model"),
                "openAIApiKey": _extract_openai_api_key(request.credentials),
                "waitForCompletion": True,
                "timeoutMinutes": request.input.get("timeoutMinutes", 10),
                "reviewFocusAreas": request.input.get("reviewFocusAreas"),
                "workspaceRef": request.input.get("workspaceRef"),
                "cwd": request.input.get("cwd"),
                "applyFixes": request.input.get("applyFixes"),
                "maxIterations": request.input.get("maxIterations"),
                "instructionsOverlay": request.input.get("instructionsOverlay"),
                "expectedOutput": request.input.get("expectedOutput"),
                "verifyCommands": request.input.get("verifyCommands"),
                "toolGroup": request.input.get("toolGroup"),
                "configStoreName": request.input.get("configStoreName"),
                "configKeys": request.input.get("configKeys"),
                "configMetadata": request.input.get("configMetadata"),
            }
        )
    except ValidationError as exc:
        return {
            "success": False,
            "error": f"Validation failed: {exc}",
            "duration_ms": int((time.time() - start_time) * 1000),
        }

    try:
        instance_id, _ = _schedule_workflow(run_request)
        state = workflow_client.wait_for_workflow_completion(
            instance_id,
            timeout_in_seconds=run_request.timeoutMinutes * 60,
        )
        if state is None:
            return {
                "success": False,
                "error": "Workflow completion timed out",
                "duration_ms": int((time.time() - start_time) * 1000),
            }

        status = _normalize_status(getattr(state.runtime_status, "name", None))
        workflow_result = _parse_workflow_output(state)
        if status != "completed":
            return {
                "success": False,
                "error": (
                    workflow_result.get("error")
                    if workflow_result and isinstance(workflow_result.get("error"), str)
                    else f"Workflow ended with status {status}"
                ),
                "data": (
                    _build_public_result(
                        instance_id=instance_id,
                        template_id=run_request.workflowTemplateId,
                        model=run_request.model,
                        workflow_result=workflow_result,
                    )
                    if workflow_result
                    else None
                ),
                "duration_ms": int((time.time() - start_time) * 1000),
            }

        return {
            "success": True,
            "data": _build_public_result(
                instance_id=instance_id,
                template_id=run_request.workflowTemplateId,
                model=run_request.model,
                workflow_result=workflow_result,
            ),
            "duration_ms": int((time.time() - start_time) * 1000),
        }
    except HTTPException as exc:
        return {
            "success": False,
            "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail),
            "duration_ms": int((time.time() - start_time) * 1000),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Execute adapter failed")
        return {
            "success": False,
            "error": str(exc),
            "duration_ms": int((time.time() - start_time) * 1000),
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=HOST, port=PORT)
