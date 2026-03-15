from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import dapr.ext.workflow as wf
from dapr.ext.workflow import DaprWorkflowContext, DaprWorkflowClient
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ValidationError

from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

PORT = int(os.environ.get("PORT", "8081"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_TEMPLATE_ID = os.environ.get("MS_AGENT_DEFAULT_TEMPLATE_ID", "travel-planner")
DEFAULT_MODEL = os.environ.get("OPENAI_CHAT_MODEL_ID", "gpt-5.2")
WORKFLOW_NAME = os.environ.get("MS_AGENT_CHILD_WORKFLOW_RUN_NAME", "msAgentWorkflowV1")
ENABLE_DAPR_AGENTS_INSTRUMENTATION = (
    os.environ.get("ENABLE_DAPR_AGENTS_INSTRUMENTATION", "true").strip().lower()
    == "true"
)
SERVICE_VERSION = "1.0.0"
_EVENT_LOOP_THREAD_JOIN_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class WorkflowTemplate:
    id: str
    label: str
    description: str
    extractor_instructions: str
    planner_instructions: str
    expander_instructions: str


TEMPLATES: dict[str, WorkflowTemplate] = {
    "travel-planner": WorkflowTemplate(
        id="travel-planner",
        label="Travel Planner",
        description="Sequential trip-planning workflow: extract destination, draft outline, expand itinerary.",
        extractor_instructions=(
            "Extract the main destination city from the user's request. "
            "Return only the city or destination name with no extra text."
        ),
        planner_instructions=(
            "Create a concise 3-day outline for the destination. "
            "Balance culture, food, and leisure in bullet form."
        ),
        expander_instructions=(
            "Expand the outline into a detailed 3-day itinerary. "
            "Each day must have Morning, Afternoon, and Evening sections."
        ),
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


class MicrosoftAgentAdapter:
    def __init__(
        self,
        *,
        name: str,
        instructions: str,
        description: str,
        model: str,
        api_key: str | None = None,
    ) -> None:
        self.name = name
        self.instructions = instructions
        self.description = description
        self.model = model
        self.api_key = api_key

    def _build_agent(self) -> Agent:
        return Agent(
            client=OpenAIChatClient(
                model_id=self.model,
                api_key=self.api_key,
            ),
            name=self.name,
            description=self.description,
            instructions=self.instructions,
        )

    async def run(self, prompt: str) -> str:
        result = await self._build_agent().run(prompt)
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


@lru_cache(maxsize=32)
def _get_agent_adapter(
    *,
    name: str,
    instructions: str,
    description: str,
    model: str,
    api_key: str | None,
) -> MicrosoftAgentAdapter:
    return MicrosoftAgentAdapter(
        name=name,
        instructions=instructions,
        description=description,
        model=model,
        api_key=api_key,
    )


def _run_agent_step(
    *,
    agent_name: str,
    instructions: str,
    description: str,
    prompt: str,
    model: str | None,
    api_key: str | None = None,
) -> str:
    resolved_model = str(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    adapter = _get_agent_adapter(
        name=agent_name,
        instructions=instructions,
        description=description,
        model=resolved_model,
        api_key=api_key.strip() if isinstance(api_key, str) and api_key.strip() else None,
    )
    return _run_async(adapter.run(prompt))

runtime = wf.WorkflowRuntime()


class WorkflowRunRequest(BaseModel):
    prompt: str = Field(min_length=1)
    workflowTemplateId: str = Field(default=DEFAULT_TEMPLATE_ID)
    model: str | None = None
    openAIApiKey: str | None = None
    waitForCompletion: bool = Field(default=False)
    timeoutMinutes: int = Field(default=10, ge=1, le=60)


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


@runtime.activity(name="extract_destination")
def extract_destination(_ctx, input_data: dict[str, Any] | None = None) -> dict[str, str]:
    payload = input_data or {}
    template = _resolve_template(payload.get("workflowTemplateId"))
    content = _run_agent_step(
        agent_name="DestinationExtractor",
        instructions=template.extractor_instructions,
        description=f"{template.label} destination extraction agent",
        prompt=str(payload.get("task") or "").strip(),
        model=payload.get("model"),
        api_key=payload.get("openAIApiKey"),
    )
    return {"content": content}


@runtime.activity(name="plan_outline")
def plan_outline(_ctx, input_data: dict[str, Any] | None = None) -> dict[str, str]:
    payload = input_data or {}
    template = _resolve_template(payload.get("workflowTemplateId"))
    content = _run_agent_step(
        agent_name="PlannerAgent",
        instructions=template.planner_instructions,
        description=f"{template.label} outline planning agent",
        prompt=str(payload.get("task") or "").strip(),
        model=payload.get("model"),
        api_key=payload.get("openAIApiKey"),
    )
    return {"content": content}


@runtime.activity(name="expand_itinerary")
def expand_itinerary(_ctx, input_data: dict[str, Any] | None = None) -> dict[str, str]:
    payload = input_data or {}
    template = _resolve_template(payload.get("workflowTemplateId"))
    content = _run_agent_step(
        agent_name="ItineraryAgent",
        instructions=template.expander_instructions,
        description=f"{template.label} itinerary expansion agent",
        prompt=str(payload.get("task") or "").strip(),
        model=payload.get("model"),
        api_key=payload.get("openAIApiKey"),
    )
    return {"content": content}


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
    model = str(input_payload.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    openai_api_key = (
        str(input_payload.get("openAIApiKey")).strip()
        if input_payload.get("openAIApiKey")
        else None
    )

    destination = yield ctx.call_activity(
        extract_destination,
        input={
            "task": task,
            "workflowTemplateId": template.id,
            "model": model,
            "openAIApiKey": openai_api_key,
        },
    )
    destination_text = _coerce_text(destination.get("content"))

    outline = yield ctx.call_activity(
        plan_outline,
        input={
            "task": (
                f"Destination: {destination_text}\n"
                "Create a concise 3-day outline."
            ),
            "workflowTemplateId": template.id,
            "model": model,
            "openAIApiKey": openai_api_key,
        },
    )
    outline_text = _coerce_text(outline.get("content"))

    itinerary = yield ctx.call_activity(
        expand_itinerary,
        input={
            "task": (
                f"Destination: {destination_text}\n\n"
                f"Outline:\n{outline_text}\n\n"
                "Expand this into a detailed itinerary."
            ),
            "workflowTemplateId": template.id,
            "model": model,
            "openAIApiKey": openai_api_key,
        },
    )
    itinerary_text = _coerce_text(itinerary.get("content"))

    return {
        "success": True,
        "workflow_template_id": template.id,
        "workflowTemplateId": template.id,
        "workflow_template_label": template.label,
        "workflowTemplateLabel": template.label,
        "model": model,
        "text": itinerary_text,
        "content": itinerary_text,
        "final_answer": itinerary_text,
        "finalAnswer": itinerary_text,
        "steps": [
            {"agent": "DestinationExtractor", "content": destination_text},
            {"agent": "PlannerAgent", "content": outline_text},
            {"agent": "ItineraryAgent", "content": itinerary_text},
        ],
    }


workflow_client: DaprWorkflowClient | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global async_runner, workflow_client
    if ENABLE_DAPR_AGENTS_INSTRUMENTATION:
        try:
            from dapr_agents.observability import DaprAgentsInstrumentor

            DaprAgentsInstrumentor().instrument()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to enable dapr-agents instrumentation: %s", exc)
    async_runner = AsyncRunner()
    runtime.start()
    workflow_client = DaprWorkflowClient()
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
    description="Dapr workflow service that runs a Dapr-agents activity chain backed by Microsoft Agent Framework agents.",
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


@app.get("/api/tools")
def list_tools() -> dict[str, Any]:
    return {
        "success": True,
        "tools": [
            {
                "id": template.id,
                "description": template.description,
                "label": template.label,
            }
            for template in TEMPLATES.values()
        ],
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
        "activities": [
            "extract_destination",
            "plan_outline",
            "expand_itinerary",
        ],
        "templates": [
            {
                "id": template.id,
                "label": template.label,
                "description": template.description,
            }
            for template in TEMPLATES.values()
        ],
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
