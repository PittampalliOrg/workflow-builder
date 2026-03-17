from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from tools import (
    DEFAULT_WORKSPACE_ROOT,
    TOOL_GROUPS,
    WORKSPACE_ENABLED_TOOLS,
    ToolRuntimeContext,
    delete_path,
    dumps_json,
    edit_file,
    execute_command,
    file_stat,
    git_apply,
    git_diff,
    git_status,
    grep_search,
    list_files,
    mkdir,
    pop_tool_context,
    push_tool_context,
    read_file,
    resolve_tool_group,
    summarize_command_changes,
    write_file,
)

try:
    import dapr.ext.workflow as wf
    from dapr.ext.workflow import DaprWorkflowClient
except ImportError:  # pragma: no cover
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

    class DaprWorkflowClient:  # type: ignore[no-redef]
        def schedule_new_workflow(self, workflow: Any, input: dict[str, Any] | None = None, instance_id: str | None = None):
            raise RuntimeError("Dapr workflow client unavailable")

        def get_workflow_state(self, *args, **kwargs):
            raise RuntimeError("Dapr workflow client unavailable")

        def terminate_workflow(self, *args, **kwargs):
            return None

    wf = _StubWorkflowModule()

try:
    from dapr.clients import DaprClient
    from dapr_agents import DaprChatClient, DurableAgent, OpenAIChatClient
    from dapr_agents.agents.configs import (
        AgentExecutionConfig,
        AgentMemoryConfig,
        AgentObservabilityConfig,
        AgentRegistryConfig,
        AgentStateConfig,
        RuntimeConfigKey,
        RuntimeSubscriptionConfig,
        WorkflowRetryPolicy,
    )
    from dapr_agents.memory import ConversationDaprStateMemory
    from dapr_agents.storage.daprstores.stateservice import StateStoreError, StateStoreService
    from dapr_agents.tool.utils.serialization import serialize_tool_result
    from dapr_agents.workflow.runners.agent import AgentRunner
    from dapr_agents.types import AgentError, ToolMessage
except ImportError:  # pragma: no cover
    class DaprClient:  # type: ignore[no-redef]
        def __enter__(self) -> "DaprClient":
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def get_configuration(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("Dapr client unavailable")

    class OpenAIChatClient:  # type: ignore[no-redef]
        def __init__(self, **_kwargs) -> None:
            pass

    class DaprChatClient(OpenAIChatClient):  # type: ignore[no-redef]
        pass

    @dataclass
    class AgentExecutionConfig:  # type: ignore[no-redef]
        max_iterations: int = 10
        tool_choice: str | None = "auto"

    @dataclass
    class AgentMemoryConfig:  # type: ignore[no-redef]
        store: Any | None = None

    @dataclass
    class AgentRegistryConfig:  # type: ignore[no-redef]
        store: Any | None = None
        team_name: str | None = None

    @dataclass
    class AgentStateConfig:  # type: ignore[no-redef]
        store: Any | None = None
        state_key_prefix: str | None = None

    class RuntimeConfigKey:  # type: ignore[no-redef]
        AGENT_ROLE = "agent_role"
        AGENT_GOAL = "agent_goal"
        AGENT_INSTRUCTIONS = "agent_instructions"
        AGENT_SYSTEM_PROMPT = "agent_system_prompt"
        AGENT_STYLE_GUIDELINES = "agent_style_guidelines"
        MAX_ITERATIONS = "max_iterations"
        TOOL_CHOICE = "tool_choice"
        LLM_PROVIDER = "llm_provider"
        LLM_MODEL = "llm_model"

    @dataclass
    class RuntimeSubscriptionConfig:  # type: ignore[no-redef]
        store_name: str
        default_key: str | None = None
        keys: list[str] | None = None
        metadata: dict[str, str] | None = None
        on_config_change: Any | None = None

    @dataclass
    class WorkflowRetryPolicy:  # type: ignore[no-redef]
        max_attempts: int | None = 1
        initial_backoff_seconds: int | None = 5
        max_backoff_seconds: int | None = 30
        backoff_multiplier: float | None = 1.5
        retry_timeout: int | None = None

    class AgentObservabilityConfig:  # type: ignore[no-redef]
        @classmethod
        def from_env(cls) -> "AgentObservabilityConfig":
            return cls()

    @dataclass
    class ConversationDaprStateMemory:  # type: ignore[no-redef]
        store_name: str = "statestore"
        agent_name: str = "default"

    class StateStoreError(RuntimeError):  # type: ignore[no-redef]
        pass

    class StateStoreService:  # type: ignore[no-redef]
        _storage: dict[str, dict[str, Any]] = {}

        def __init__(self, *, store_name: str, key_prefix: str = "", **_kwargs: Any) -> None:
            self.store_name = store_name
            self.key_prefix = key_prefix

        def _qualify(self, key: str) -> str:
            return f"{self.key_prefix}{key}"

        def load(self, *, key: str, default: dict[str, Any] | None = None, **_kwargs: Any) -> dict[str, Any]:
            return dict(self._storage.get(self._qualify(key), default or {}))

        def save(self, *, key: str, value: Any, **_kwargs: Any) -> None:
            if isinstance(value, dict):
                self._storage[self._qualify(key)] = dict(value)
                return
            raise StateStoreError(f"Unsupported value type: {type(value)}")

        def delete(self, *, key: str, **_kwargs: Any) -> None:
            self._storage.pop(self._qualify(key), None)

    class DurableAgent:  # type: ignore[no-redef]
        def __init__(self, **kwargs) -> None:
            self.execution = kwargs.get("execution", AgentExecutionConfig())
            self.name = kwargs.get("name", "dapr-agent")
            self.registry = kwargs.get("registry")
            self.state = kwargs.get("state")
            self.memory = kwargs.get("memory")

        def start(self) -> None:
            return None

    class AgentRunner:  # type: ignore[no-redef]
        def __init__(self, **_kwargs) -> None:
            self._states: dict[str, str] = {}

        async def run(
            self,
            _agent: Any,
            payload: str | dict[str, Any] | None = None,
            *,
            instance_id: str | None = None,
            wait: bool = True,
            **_kwargs: Any,
        ) -> str | None:
            chosen = instance_id or uuid.uuid4().hex
            content = payload if isinstance(payload, str) else json.dumps(payload or {})
            self._states[chosen] = json.dumps({"role": "assistant", "content": content})
            return self._states[chosen] if wait else chosen

        def run_sync(self, *args: Any, **kwargs: Any) -> str | None:
            return asyncio.run(self.run(*args, **kwargs))

        @property
        def workflow_client(self) -> Any:
            class _Client:
                def __init__(self, outer: AgentRunner) -> None:
                    self.outer = outer

                def get_workflow_state(self, instance_id: str, fetch_payloads: bool = True):
                    output = self.outer._states.get(instance_id)
                    return type(
                        "WorkflowState",
                        (),
                        {
                            "runtime_status": type("RuntimeStatus", (), {"name": "COMPLETED"})(),
                            "serialized_output": output,
                        },
                    )()

                def terminate_workflow(self, instance_id: str, output: str | None = None) -> None:
                    self.outer._states[instance_id] = output or ""

            return _Client(self)

        def terminate_workflow(self, instance_id: str, *, output: Any = None) -> None:
            self._states[instance_id] = output or ""

    class AgentError(RuntimeError):  # type: ignore[no-redef]
        pass

    class ToolMessage:  # type: ignore[no-redef]
        def __init__(self, **kwargs: Any) -> None:
            self._data = kwargs

        def model_dump(self) -> dict[str, Any]:
            return dict(self._data)

    def serialize_tool_result(result: Any) -> Any:  # type: ignore[no-redef]
        return result


logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

PORT = int(os.environ.get("PORT", "8082"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_MODEL = os.environ.get("OPENAI_CHAT_MODEL_ID", "gpt-5.4")
SERVICE_VERSION = "0.1.0"
AGENT_TOOL_GROUP = os.environ.get("DAPR_AGENT_TOOL_GROUP", "all")
WORKSPACE_ROOT = Path(DEFAULT_WORKSPACE_ROOT).expanduser().resolve()
WORKFLOW_NAME = os.environ.get("DAPR_AGENT_CHILD_WORKFLOW_RUN_NAME", "daprAgentRunWorkflowV1")
ENABLE_DAPR_AGENTS_INSTRUMENTATION = (
    os.environ.get("ENABLE_DAPR_AGENTS_INSTRUMENTATION", "true").strip().lower()
    == "true"
)
DAPR_HTTP_HOST = os.environ.get("DAPR_HTTP_HOST", "127.0.0.1")
DAPR_HTTP_PORT = os.environ.get("DAPR_HTTP_PORT", "3500")
MIN_DAPR_RUNTIME_VERSION = os.environ.get("MIN_DAPR_RUNTIME_VERSION", "1.17.0")
DAPR_AGENT_STATE_STORE_NAME = os.environ.get("DAPR_AGENT_STATE_STORE_NAME", "workflowstatestore")
DAPR_AGENT_MEMORY_STORE_NAME = os.environ.get("DAPR_AGENT_MEMORY_STORE_NAME", DAPR_AGENT_STATE_STORE_NAME)
DAPR_AGENT_REGISTRY_STORE_NAME = os.environ.get("DAPR_AGENT_REGISTRY_STORE_NAME", DAPR_AGENT_STATE_STORE_NAME)
DAPR_AGENT_REGISTRY_TEAM_NAME = os.environ.get("DAPR_AGENT_REGISTRY_TEAM_NAME", "coding-agents")
DAPR_AGENT_STATE_KEY_PREFIX = os.environ.get("DAPR_AGENT_STATE_KEY_PREFIX", "dapr-agent-runtime:")
DAPR_AGENT_WORKSPACE_STATE_KEY_PREFIX = os.environ.get(
    "DAPR_AGENT_WORKSPACE_STATE_KEY_PREFIX",
    f"{DAPR_AGENT_STATE_KEY_PREFIX}workspace:",
)
DAPR_AGENT_RUN_STATE_KEY_PREFIX = os.environ.get(
    "DAPR_AGENT_RUN_STATE_KEY_PREFIX",
    f"{DAPR_AGENT_STATE_KEY_PREFIX}run:",
)
DAPR_AGENT_ENABLE_MEMORY = os.environ.get("DAPR_AGENT_ENABLE_MEMORY", "true").strip().lower() == "true"
DAPR_AGENT_ENABLE_REGISTRY = os.environ.get("DAPR_AGENT_ENABLE_REGISTRY", "true").strip().lower() == "true"
DAPR_AGENT_LLM_BACKEND = os.environ.get("DAPR_AGENT_LLM_BACKEND", "auto").strip().lower()
DAPR_AGENT_LLM_COMPONENT = os.environ.get("DAPR_AGENT_LLM_COMPONENT") or os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT"
)
DAPR_AGENT_RUNTIME_CONFIG_STORE = os.environ.get(
    "DAPR_AGENT_RUNTIME_CONFIG_STORE",
    "runtime-config",
)
DAPR_AGENT_RUNTIME_CONFIG_LABEL = os.environ.get(
    "DAPR_AGENT_RUNTIME_CONFIG_LABEL",
    "dapr-agent-runtime",
)
SERVICE_AGENT_NAME = os.environ.get("DAPR_AGENT_SERVICE_NAME", "dapr-coding-agent")


PROFILE_INSTRUCTIONS: dict[str, str] = {
    "review": (
        "You are a senior code reviewer. Inspect the repository, identify the most important "
        "risks or defects, and return concise engineer-facing findings with file references."
    ),
    "implement": (
        "You are a senior implementation agent. Make the requested code changes directly, "
        "keep edits minimal, and verify the result with relevant commands when possible."
    ),
    "repair": (
        "You are a senior repair agent. Reproduce the issue from the available context, "
        "apply the smallest robust fix, and verify that the failure is resolved."
    ),
    "plan-only": (
        "You are a planning agent. Produce a concrete implementation plan and do not make file changes."
    ),
    "custom": (
        "You are a durable coding agent. Complete the task directly using the available coding tools."
    ),
}

PROFILE_TOOL_GROUPS: dict[str, str] = {
    "review": "read_only",
    "implement": "all",
    "repair": "all",
    "plan-only": "read_only",
    "custom": "all",
}

HOT_RELOAD_RUNTIME_KEYS = [
    RuntimeConfigKey.AGENT_ROLE,
    RuntimeConfigKey.AGENT_GOAL,
    RuntimeConfigKey.AGENT_INSTRUCTIONS,
    RuntimeConfigKey.AGENT_SYSTEM_PROMPT,
    RuntimeConfigKey.AGENT_STYLE_GUIDELINES,
    RuntimeConfigKey.MAX_ITERATIONS,
    RuntimeConfigKey.TOOL_CHOICE,
    RuntimeConfigKey.LLM_PROVIDER,
    RuntimeConfigKey.LLM_MODEL,
]


class WorkspaceProfileRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    name: str | None = None
    rootPath: str | None = None
    enabledTools: list[str] | str | None = None
    requireReadBeforeWrite: bool | str | None = None
    commandTimeoutMs: int | None = None
    sandboxTemplate: str | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class WorkspaceCloneRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    workspaceRef: str = Field(min_length=1)
    repositoryUrl: str = Field(min_length=1)
    repositoryOwner: str | None = None
    repositoryRepo: str | None = None
    repositoryBranch: str = Field(min_length=1)
    repositoryUsername: str | None = None
    repositoryToken: str | None = None
    githubToken: str | None = None
    targetDir: str | None = None
    timeoutMs: int | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class WorkspaceCommandRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    workspaceRef: str = Field(min_length=1)
    command: str = Field(min_length=1)
    cwd: str | None = None
    timeoutMs: int | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class WorkspaceFileRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    workspaceRef: str = Field(min_length=1)
    operation: str = Field(min_length=1)
    path: str | None = None
    pattern: str | None = None
    content: str | None = None
    old_string: str | None = None
    new_string: str | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class WorkspaceCleanupRequest(BaseModel):
    executionId: str | None = None
    workspaceRef: str | None = None


class DaprAgentRunRequest(BaseModel):
    prompt: str = Field(min_length=1)
    profile: str = Field(default="implement")
    model: str | None = None
    waitForCompletion: bool = Field(default=False)
    timeoutMinutes: int = Field(default=30, ge=1, le=120)
    maxTurns: int = Field(default=30, ge=1, le=200)
    workspaceRef: str | None = None
    cwd: str | None = None
    stopCondition: str | None = None
    instructionsOverlay: str | None = None
    expectedOutput: str | None = None
    verifyCommands: str | None = None
    approvalMode: str | None = None
    toolPolicy: str | None = None
    tools: str | list[str] | None = None
    writePolicy: str | None = None
    shellPolicy: str | None = None
    openAIApiKey: str | None = None
    executionId: str | None = None
    dbExecutionId: str | None = None


class ExecuteRequest(BaseModel):
    step: str = Field(min_length=1)
    execution_id: str = Field(min_length=1)
    workflow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    input: dict[str, Any] = Field(default_factory=dict)
    node_outputs: dict[str, Any] | None = None
    credentials: dict[str, str] | None = None


class TerminateRequest(BaseModel):
    reason: str | None = None


@dataclass
class WorkspaceSession:
    workspace_ref: str
    execution_id: str
    root_path: Path
    working_directory: Path | None
    enabled_tools: list[str]
    repository_url: str | None = None
    repository_owner: str | None = None
    repository_repo: str | None = None
    repository_branch: str | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "workspaceRef": self.workspace_ref,
            "executionId": self.execution_id,
            "rootPath": str(self.root_path),
            "workingDirectory": str(self.working_directory or self.root_path),
            "enabledTools": list(self.enabled_tools),
            "repositoryUrl": self.repository_url,
            "repositoryOwner": self.repository_owner,
            "repositoryRepo": self.repository_repo,
            "repositoryBranch": self.repository_branch,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "WorkspaceSession":
        return cls(
            workspace_ref=str(record.get("workspaceRef") or ""),
            execution_id=str(record.get("executionId") or ""),
            root_path=Path(str(record.get("rootPath") or WORKSPACE_ROOT)).expanduser().resolve(),
            working_directory=Path(
                str(record.get("workingDirectory") or record.get("rootPath") or WORKSPACE_ROOT)
            ).expanduser().resolve(),
            enabled_tools=[str(item) for item in record.get("enabledTools") or []],
            repository_url=str(record.get("repositoryUrl") or "").strip() or None,
            repository_owner=str(record.get("repositoryOwner") or "").strip() or None,
            repository_repo=str(record.get("repositoryRepo") or "").strip() or None,
            repository_branch=str(record.get("repositoryBranch") or "").strip() or None,
        )


@dataclass
class AgentRunContext:
    instance_id: str
    profile: str
    cwd: str
    tool_group: str
    max_turns: int
    execution_id: str | None = None
    workspace_ref: str | None = None
    trace_id: str | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "profile": self.profile,
            "cwd": self.cwd,
            "toolGroup": self.tool_group,
            "maxTurns": self.max_turns,
            "executionId": self.execution_id,
            "workspaceRef": self.workspace_ref,
            "traceId": self.trace_id,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "AgentRunContext":
        return cls(
            instance_id=str(record.get("instanceId") or ""),
            profile=_normalize_profile(str(record.get("profile") or "custom")),
            cwd=_resolve_cwd(str(record.get("cwd") or "")),
            tool_group=_resolve_tool_group(str(record.get("toolGroup") or "all")),
            max_turns=max(int(record.get("maxTurns") or 30), 1),
            execution_id=str(record.get("executionId") or "").strip() or None,
            workspace_ref=str(record.get("workspaceRef") or "").strip() or None,
            trace_id=str(record.get("traceId") or "").strip() or None,
        )


workspace_sessions: dict[str, WorkspaceSession] = {}
sessions_by_execution: dict[str, set[str]] = {}
runtime = wf.WorkflowRuntime()
workflow_client = DaprWorkflowClient()
runner = AgentRunner(name="dapr-agent-runtime", timeout_in_seconds=3600)
_agent_lock = threading.Lock()
_agent: DurableAgent | None = None
_agent_subscribed = False
run_context_cache: dict[str, AgentRunContext] = {}
runtime_config_state: dict[str, Any] = {
    "storeName": DAPR_AGENT_RUNTIME_CONFIG_STORE,
    "label": DAPR_AGENT_RUNTIME_CONFIG_LABEL,
    "subscribedKeys": [str(key) for key in HOT_RELOAD_RUNTIME_KEYS],
    "enabled": True,
    "lastAppliedAt": None,
    "lastUpdatedKey": None,
    "effective": {},
}
runtime_config_lock = threading.Lock()
workspace_state_store = StateStoreService(
    store_name=DAPR_AGENT_STATE_STORE_NAME,
    key_prefix=DAPR_AGENT_WORKSPACE_STATE_KEY_PREFIX,
)
run_state_store = StateStoreService(
    store_name=DAPR_AGENT_STATE_STORE_NAME,
    key_prefix=DAPR_AGENT_RUN_STATE_KEY_PREFIX,
)


def _workspace_session_key(workspace_ref: str) -> str:
    return f"session:{workspace_ref}"


def _execution_sessions_key(execution_id: str) -> str:
    return f"execution:{execution_id}"


def _persist_workspace_session(session: WorkspaceSession) -> None:
    workspace_sessions[session.workspace_ref] = session
    sessions_by_execution.setdefault(session.execution_id, set()).add(session.workspace_ref)
    try:
        workspace_state_store.save(
            key=_workspace_session_key(session.workspace_ref),
            value=session.to_record(),
        )
        workspace_state_store.save(
            key=_execution_sessions_key(session.execution_id),
            value={
                "executionId": session.execution_id,
                "workspaceRefs": sorted(sessions_by_execution.get(session.execution_id, set())),
            },
        )
    except StateStoreError as exc:
        logger.warning("Failed to persist workspace session %s: %s", session.workspace_ref, exc)


def _load_workspace_session(workspace_ref: str) -> WorkspaceSession | None:
    cached = workspace_sessions.get(workspace_ref)
    if cached is not None:
        return cached
    try:
        record = workspace_state_store.load(
            key=_workspace_session_key(workspace_ref),
            default={},
        )
    except StateStoreError as exc:
        logger.warning("Failed to load workspace session %s: %s", workspace_ref, exc)
        return None
    if not record:
        return None
    session = WorkspaceSession.from_record(record)
    workspace_sessions[session.workspace_ref] = session
    sessions_by_execution.setdefault(session.execution_id, set()).add(session.workspace_ref)
    return session


def _load_execution_workspace_refs(execution_id: str) -> set[str]:
    cached = sessions_by_execution.get(execution_id)
    if cached:
        return set(cached)
    try:
        record = workspace_state_store.load(
            key=_execution_sessions_key(execution_id),
            default={},
        )
    except StateStoreError as exc:
        logger.warning("Failed to load execution workspace refs for %s: %s", execution_id, exc)
        return set()
    refs = {str(item) for item in record.get("workspaceRefs") or [] if str(item).strip()}
    if refs:
        sessions_by_execution[execution_id] = set(refs)
    return refs


def _delete_workspace_session(workspace_ref: str) -> None:
    session = workspace_sessions.pop(workspace_ref, None)
    if session is None:
        session = _load_workspace_session(workspace_ref)
    if session is None:
        return
    workspace_sessions.pop(workspace_ref, None)
    execution_refs = sessions_by_execution.setdefault(session.execution_id, set())
    execution_refs.discard(workspace_ref)
    try:
        workspace_state_store.delete(key=_workspace_session_key(workspace_ref))
        if execution_refs:
            workspace_state_store.save(
                key=_execution_sessions_key(session.execution_id),
                value={
                    "executionId": session.execution_id,
                    "workspaceRefs": sorted(execution_refs),
                },
            )
        else:
            workspace_state_store.delete(key=_execution_sessions_key(session.execution_id))
            sessions_by_execution.pop(session.execution_id, None)
    except StateStoreError as exc:
        logger.warning("Failed to delete workspace session %s: %s", workspace_ref, exc)
    shutil.rmtree(session.root_path, ignore_errors=True)


def _ensure_workspace_root() -> None:
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def _normalize_profile(raw: str | None) -> str:
    normalized = str(raw or "implement").strip().lower()
    return normalized if normalized in PROFILE_INSTRUCTIONS else "custom"


def _trace_id_from_traceparent(traceparent: object) -> str | None:
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1].strip()
    return trace_id or None


def _trace_id_from_otel(otel_ctx: object) -> str | None:
    if not isinstance(otel_ctx, dict):
        return None
    return _trace_id_from_traceparent(otel_ctx.get("traceparent"))


def _current_trace_id() -> str | None:
    try:
        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        if span is None:
            return None
        span_context = span.get_span_context()
        if span_context is None or not getattr(span_context, "is_valid", False):
            return None
        trace_id = getattr(span_context, "trace_id", 0)
        if not trace_id:
            return None
        return f"{trace_id:032x}"
    except Exception:
        return None


def _trace_id_from_payload(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    trace_id = str(payload.get("traceId") or payload.get("trace_id") or "").strip()
    if trace_id:
        return trace_id
    agent_progress = payload.get("agentProgress")
    if isinstance(agent_progress, dict):
        nested_trace_id = str(agent_progress.get("traceId") or "").strip()
        if nested_trace_id:
            return nested_trace_id
    return None


def _parse_serialized_output(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _runtime_config_metadata() -> dict[str, str]:
    metadata: dict[str, str] = {}
    if DAPR_AGENT_RUNTIME_CONFIG_LABEL:
        metadata["label"] = DAPR_AGENT_RUNTIME_CONFIG_LABEL
    return metadata


def _serialize_runtime_config_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, dict)):
        return value
    return str(value)


def _record_runtime_config_change(key: str, value: Any) -> None:
    serialized = _serialize_runtime_config_value(value)
    with runtime_config_lock:
        effective = dict(runtime_config_state.get("effective") or {})
        effective[str(key)] = serialized
        runtime_config_state.update(
            {
                "enabled": True,
                "lastAppliedAt": _utc_now_iso(),
                "lastUpdatedKey": str(key),
                "effective": effective,
            }
        )


def _build_runtime_subscription_config() -> RuntimeSubscriptionConfig:
    return RuntimeSubscriptionConfig(
        store_name=DAPR_AGENT_RUNTIME_CONFIG_STORE,
        keys=[str(key) for key in HOT_RELOAD_RUNTIME_KEYS],
        metadata=_runtime_config_metadata(),
        on_config_change=_record_runtime_config_change,
    )


def _snapshot_runtime_config_state() -> dict[str, Any]:
    with runtime_config_lock:
        return {
            "enabled": bool(runtime_config_state.get("enabled", True)),
            "storeName": runtime_config_state.get("storeName"),
            "label": runtime_config_state.get("label"),
            "subscribedKeys": list(runtime_config_state.get("subscribedKeys") or []),
            "lastAppliedAt": runtime_config_state.get("lastAppliedAt"),
            "lastUpdatedKey": runtime_config_state.get("lastUpdatedKey"),
            "effective": dict(runtime_config_state.get("effective") or {}),
        }


def _otel_context_from_headers(request: Request) -> dict[str, str]:
    carrier: dict[str, str] = {}
    traceparent = request.headers.get("traceparent")
    tracestate = request.headers.get("tracestate")
    if traceparent:
        carrier["traceparent"] = traceparent
    if tracestate:
        carrier["tracestate"] = tracestate
    return carrier


def _resolve_tool_group(policy: str | None) -> str:
    normalized = str(policy or AGENT_TOOL_GROUP).strip().lower()
    if normalized in TOOL_GROUPS:
        return normalized
    if normalized in {"read", "read_only"}:
        return "read_only"
    if normalized in {"write", "read_write"}:
        return "read_write"
    return "all"


def _resolve_effective_tool_group(request: DaprAgentRunRequest) -> str:
    configured = str(request.toolPolicy or "").strip().lower()
    if configured:
        return _resolve_tool_group(configured)
    legacy_tools = request.tools
    parsed_tools: list[str] = []
    if isinstance(legacy_tools, str):
        raw_value = legacy_tools.strip()
        if raw_value:
            try:
                decoded = json.loads(raw_value)
            except json.JSONDecodeError:
                decoded = [item.strip() for item in raw_value.split(",") if item.strip()]
            if isinstance(decoded, list):
                parsed_tools = [str(item).strip().lower() for item in decoded if str(item).strip()]
    elif isinstance(legacy_tools, list):
        parsed_tools = [str(item).strip().lower() for item in legacy_tools if str(item).strip()]
    if parsed_tools:
        normalized = set(parsed_tools)
        if "bash" in normalized:
            return "all"
        if normalized & {"write", "edit", "delete"}:
            return "read_write"
        if normalized & {"read", "list", "git"}:
            return "read_only"
    return PROFILE_TOOL_GROUPS.get(_normalize_profile(request.profile), AGENT_TOOL_GROUP)


def _build_task_prompt(request: DaprAgentRunRequest) -> str:
    profile = _normalize_profile(request.profile)
    segments = [
        f"Profile: {profile}",
        f"Profile instructions: {PROFILE_INSTRUCTIONS[profile]}",
        f"Task:\n{request.prompt}",
    ]
    if request.cwd:
        segments.append(
            "Repository root:\n"
            f"{request.cwd}\n"
            "Operate only within this repository root. When using tools, pass repository-relative paths such as '.' or 'src/app.ts'."
        )
    if request.expectedOutput:
        segments.append(f"Expected output:\n{request.expectedOutput}")
    if request.stopCondition:
        segments.append(f"Stop condition:\n{request.stopCondition}")
    if request.verifyCommands:
        segments.append(f"Verify commands:\n{request.verifyCommands}")
    if request.instructionsOverlay:
        segments.append(f"Additional instructions:\n{request.instructionsOverlay}")
    if request.approvalMode:
        segments.append(f"Approval mode:\n{request.approvalMode}")
    if request.writePolicy:
        segments.append(f"Write policy:\n{request.writePolicy}")
    if request.shellPolicy:
        segments.append(f"Shell policy:\n{request.shellPolicy}")
    return "\n\n".join(segment for segment in segments if segment.strip())


def _build_result_payload(
    *,
    instance_id: str,
    request: DaprAgentRunRequest,
    workflow_output: Any,
) -> dict[str, Any]:
    text = _coerce_text(workflow_output)
    cwd = _resolve_request_cwd(request)
    summary = summarize_command_changes(cwd)
    run_context = _load_run_context(instance_id)
    progress = _load_agent_progress(instance_id)
    if progress is None:
        context = run_context or _build_run_context(instance_id, request)
        progress = _default_agent_progress(context, status="completed")
    progress = {
        **progress,
        "status": "completed",
        "phase": "completed",
        "summary": text[:280] or progress.get("summary"),
        "activeToolName": None,
        "stopReason": "workflow completed",
        "updatedAt": _utc_now_iso(),
    }
    _persist_agent_progress(instance_id, progress)
    patch = ""
    try:
        tool_context = ToolRuntimeContext.from_workspace_root(cwd)
        token = push_tool_context(tool_context)
        try:
            patch = git_diff(".").get("diff", "")
        finally:
            pop_tool_context(token)
    except Exception:
        patch = ""
    result = {
        "text": text,
        "content": text,
        "profile": _normalize_profile(request.profile),
        "model": request.model or DEFAULT_MODEL,
        "toolCalls": [],
        "usageTotals": {},
        "fileChanges": summary["changeSummary"]["files"],
        "changeSummary": summary["changeSummary"],
        "patch": patch,
        "patchRef": None,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "traceId": run_context.trace_id if run_context else None,
        "agentProgress": progress,
        "runSummary": {
            "profile": _normalize_profile(request.profile),
            "cwd": cwd,
            "workspaceRef": request.workspaceRef,
            "toolGroup": _resolve_effective_tool_group(request),
        },
    }
    _persist_run_artifact(instance_id, result)
    return result


def _coerce_text(workflow_output: Any) -> str:
    if not workflow_output:
        return ""
    if isinstance(workflow_output, dict):
        for key in ("content", "text", "finalAnswer"):
            value = workflow_output.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(workflow_output)
    try:
        parsed = json.loads(workflow_output)
    except json.JSONDecodeError:
        return workflow_output.strip()
    if isinstance(parsed, dict):
        for key in ("content", "text", "finalAnswer"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(parsed)
    return str(parsed).strip()


def _resolve_cwd(raw_cwd: str | None) -> str:
    value = str(raw_cwd or WORKSPACE_ROOT).strip() or str(WORKSPACE_ROOT)
    return str(Path(value).expanduser().resolve())


def _workspace_from_ref(workspace_ref: str) -> WorkspaceSession:
    session = workspace_sessions.get(workspace_ref) or _load_workspace_session(workspace_ref)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown workspaceRef: {workspace_ref}")
    return session


def _default_workspace_root(execution_id: str, requested_root: str | None) -> Path:
    if requested_root:
        candidate = Path(requested_root)
        if not candidate.is_absolute():
            candidate = WORKSPACE_ROOT / candidate
    else:
        candidate = WORKSPACE_ROOT / execution_id
    return candidate.expanduser().resolve()


def _build_agent_name() -> str:
    return SERVICE_AGENT_NAME


def _run_context_key(instance_id: str) -> str:
    return f"run:{instance_id}"


def _run_progress_key(instance_id: str) -> str:
    return f"progress:{instance_id}"


def _run_artifact_key(instance_id: str) -> str:
    return f"artifact:{instance_id}"


def _execution_runs_key(execution_id: str) -> str:
    return f"execution:{execution_id}:runs"


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _persist_run_context(context: AgentRunContext) -> None:
    run_context_cache[context.instance_id] = context
    try:
        run_state_store.save(
            key=_run_context_key(context.instance_id),
            value=context.to_record(),
        )
        if context.execution_id:
            record = run_state_store.load(
                key=_execution_runs_key(context.execution_id),
                default={"executionId": context.execution_id, "runIds": []},
            )
            run_ids = {
                str(item).strip()
                for item in record.get("runIds") or []
                if str(item).strip()
            }
            run_ids.add(context.instance_id)
            run_state_store.save(
                key=_execution_runs_key(context.execution_id),
                value={
                    "executionId": context.execution_id,
                    "runIds": sorted(run_ids),
                },
            )
    except StateStoreError as exc:
        logger.warning("Failed to persist run context %s: %s", context.instance_id, exc)


def _load_run_context(instance_id: str) -> AgentRunContext | None:
    cached = run_context_cache.get(instance_id)
    if cached is not None:
        return cached
    try:
        record = run_state_store.load(
            key=_run_context_key(instance_id),
            default={},
        )
    except StateStoreError as exc:
        logger.warning("Failed to load run context %s: %s", instance_id, exc)
        return None
    if not record:
        return None
    context = AgentRunContext.from_record(record)
    run_context_cache[context.instance_id] = context
    return context


def _delete_run_context(instance_id: str) -> None:
    context = run_context_cache.pop(instance_id, None) or _load_run_context(instance_id)
    try:
        run_state_store.delete(key=_run_context_key(instance_id))
        if context and context.execution_id:
            record = run_state_store.load(
                key=_execution_runs_key(context.execution_id),
                default={"executionId": context.execution_id, "runIds": []},
            )
            run_ids = {
                str(item).strip()
                for item in record.get("runIds") or []
                if str(item).strip()
            }
            run_ids.discard(instance_id)
            if run_ids:
                run_state_store.save(
                    key=_execution_runs_key(context.execution_id),
                    value={
                        "executionId": context.execution_id,
                        "runIds": sorted(run_ids),
                    },
                )
            else:
                run_state_store.delete(key=_execution_runs_key(context.execution_id))
    except StateStoreError as exc:
        logger.warning("Failed to delete run context %s: %s", instance_id, exc)


def _load_execution_run_ids(execution_id: str) -> list[str]:
    if not execution_id:
        return []
    try:
        record = run_state_store.load(
            key=_execution_runs_key(execution_id),
            default={},
        )
    except StateStoreError as exc:
        logger.warning("Failed to load run ids for execution %s: %s", execution_id, exc)
        return []
    return [
        str(item).strip()
        for item in record.get("runIds") or []
        if str(item).strip()
    ]


def _change_set_id_for_instance(instance_id: str) -> str:
    return f"{instance_id}-patch"


def _persist_run_artifact(instance_id: str, result: dict[str, Any]) -> None:
    context = _load_run_context(instance_id)
    if context is None or not context.execution_id:
        return
    change_summary = result.get("changeSummary")
    if not isinstance(change_summary, dict):
        change_summary = {"files": [], "stats": {"files": 0, "additions": 0, "deletions": 0}, "changed": False}
    artifact = {
        "changeSetId": _change_set_id_for_instance(instance_id),
        "executionId": context.execution_id,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "cwd": context.cwd,
        "workspaceRef": context.workspace_ref,
        "profile": context.profile,
        "patch": str(result.get("patch") or ""),
        "changeSummary": change_summary,
        "fileChanges": result.get("fileChanges") or [],
        "createdAt": _utc_now_iso(),
    }
    try:
        run_state_store.save(key=_run_artifact_key(instance_id), value=artifact)
    except StateStoreError as exc:
        logger.warning("Failed to persist run artifact %s: %s", instance_id, exc)


def _load_run_artifact(instance_id: str) -> dict[str, Any] | None:
    try:
        artifact = run_state_store.load(key=_run_artifact_key(instance_id), default={})
    except StateStoreError as exc:
        logger.warning("Failed to load run artifact %s: %s", instance_id, exc)
        return None
    return artifact if artifact else None


def _safe_workspace_file_snapshot(root: str, relative_path: str) -> dict[str, Any] | None:
    workspace_root = Path(root).expanduser().resolve()
    requested = (workspace_root / relative_path).expanduser().resolve()
    if requested != workspace_root and workspace_root not in requested.parents:
        return None
    if not requested.exists() or not requested.is_file():
        return None
    try:
        content = requested.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = requested.read_bytes().decode("utf-8", errors="replace")
    stat = requested.stat()
    return {
        "path": relative_path,
        "content": content,
        "sizeBytes": stat.st_size,
        "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
    }


def _default_agent_progress(context: AgentRunContext, *, status: str = "scheduled") -> dict[str, Any]:
    return {
        "framework": "dapr-agent",
        "status": status,
        "phase": "queued" if status == "scheduled" else "starting",
        "summary": None,
        "currentStepName": context.profile,
        "completedSteps": None,
        "totalSteps": None,
        "currentIteration": 0,
        "maxIterations": context.max_turns,
        "activeToolName": None,
        "stopReason": None,
        "agentWorkflowId": context.instance_id,
        "daprInstanceId": context.instance_id,
        "traceId": context.trace_id,
        "updatedAt": _utc_now_iso(),
        "recentTurns": [],
    }


def _persist_agent_progress(instance_id: str, progress: dict[str, Any]) -> None:
    try:
        run_state_store.save(key=_run_progress_key(instance_id), value=progress)
    except StateStoreError as exc:
        logger.warning("Failed to persist run progress %s: %s", instance_id, exc)


def _load_agent_progress(instance_id: str) -> dict[str, Any] | None:
    try:
        progress = run_state_store.load(key=_run_progress_key(instance_id), default={})
    except StateStoreError as exc:
        logger.warning("Failed to load run progress %s: %s", instance_id, exc)
        return None
    return progress if progress else None


def _update_agent_progress(instance_id: str, **updates: Any) -> dict[str, Any] | None:
    run_context = _load_run_context(instance_id)
    if run_context is None:
        return None
    progress = _load_agent_progress(instance_id) or _default_agent_progress(run_context)
    recent_turns = updates.pop("recentTurns", None)
    if isinstance(recent_turns, list):
        progress["recentTurns"] = recent_turns[-4:]
    progress.update({key: value for key, value in updates.items() if value is not None or key in {"summary", "stopReason", "activeToolName"}})
    progress["updatedAt"] = _utc_now_iso()
    _persist_agent_progress(instance_id, progress)
    return progress


def _delete_agent_progress(instance_id: str) -> None:
    try:
        run_state_store.delete(key=_run_progress_key(instance_id))
    except StateStoreError as exc:
        logger.warning("Failed to delete run progress %s: %s", instance_id, exc)


def _resolve_request_cwd(request: DaprAgentRunRequest) -> str:
    if request.cwd:
        return _resolve_cwd(request.cwd)
    if request.workspaceRef:
        session = _workspace_from_ref(request.workspaceRef)
        return str(session.working_directory or session.root_path)
    return _resolve_cwd(None)


class CodingDurableAgent(DurableAgent):
    def _load_initial_configuration(self, keys: list[str]) -> None:
        try:
            metadata = dict(getattr(self.configuration, "metadata", {}) or {})
            with DaprClient() as client:
                response = client.get_configuration(
                    store_name=self.configuration.store_name,  # type: ignore[union-attr]
                    keys=keys,
                    config_metadata=metadata,
                )
            if response.items:
                self._config_handler("initial-load", response)
                logger.info(
                    "Agent %s loaded initial configuration for keys: %s",
                    self.name,
                    list(response.items.keys()),
                )
            else:
                logger.info(
                    "Agent %s: no initial configuration values found in store '%s' "
                    "for keys %s.",
                    self.name,
                    getattr(self.configuration, "store_name", "?"),
                    keys,
                )
        except Exception as e:
            logger.warning(
                "Agent %s could not load initial configuration from '%s': %s. "
                "Starting with defaults.",
                self.name,
                getattr(self.configuration, "store_name", "?"),
                e,
            )

    def run_tool(self, ctx: wf.WorkflowActivityContext, payload: dict[str, Any]) -> dict[str, Any]:
        tool_call = payload.get("tool_call", {})
        fn_name = tool_call["function"]["name"]
        raw_args = tool_call["function"].get("arguments", "")
        try:
            args = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError as exc:
            raise AgentError(f"Invalid JSON in tool args: {exc}") from exc

        instance_id = str(payload.get("instance_id") or "")
        run_context = _load_run_context(instance_id)
        if run_context is None:
            raise AgentError(f"Missing durable run context for {instance_id}")

        allowed_names = {
            getattr(tool, "name", None) or getattr(tool, "__name__", "")
            for tool in resolve_tool_group(run_context.tool_group)
        }
        if fn_name not in allowed_names:
            raise AgentError(
                f"Tool '{fn_name}' is not allowed for tool group '{run_context.tool_group}'"
            )

        existing_progress = _load_agent_progress(instance_id) or _default_agent_progress(
            run_context,
            status="running",
        )
        next_iteration = int(existing_progress.get("currentIteration") or 0) + 1
        recent_turns = list(existing_progress.get("recentTurns") or [])
        recent_turns.append(
            {
                "label": fn_name,
                "summary": f"Calling {fn_name}",
                "status": "running",
            }
        )
        _update_agent_progress(
            instance_id,
            phase="tool_call",
            status="running",
            currentIteration=next_iteration,
            activeToolName=fn_name,
            summary=f"Running tool {fn_name}",
            recentTurns=recent_turns,
        )

        async def _execute_tool() -> Any:
            tool_context = ToolRuntimeContext.from_workspace_root(run_context.cwd)
            token = push_tool_context(tool_context)
            try:
                return await self.tool_executor.run_tool(
                    fn_name,
                    **args,
                )
            finally:
                pop_tool_context(token)

        result = self._run_asyncio_task(_execute_tool())
        logger.debug("Tool %s returned: %s (type: %s)", fn_name, result, type(result))
        serialized_result = serialize_tool_result(result)
        tool_result = ToolMessage(
            content=serialized_result,
            role="tool",
            name=fn_name,
            tool_call_id=tool_call["id"],
        )
        self.text_formatter.print_message(tool_result)
        recent_turns[-1] = {
            "label": fn_name,
            "summary": f"Completed {fn_name}",
            "status": "completed",
        }
        _update_agent_progress(
            instance_id,
            phase="reasoning",
            status="running",
            activeToolName=None,
            summary=f"Completed tool {fn_name}",
            recentTurns=recent_turns,
        )
        return tool_result.model_dump()


def _workflow_descriptor(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "version": "v1",
        "aliases": [name],
        "isLatest": True,
        "source": "service-introspection",
    }


def _activity_descriptor(name: str) -> dict[str, Any]:
    return {"name": name, "source": "service-introspection"}


def _build_agent_registry_metadata(
    *,
    model: str,
) -> dict[str, Any]:
    return {
        "profiles": sorted(PROFILE_INSTRUCTIONS.keys()),
        "framework": "Dapr Agents",
        "durable": True,
        "workflowName": WORKFLOW_NAME,
        "toolGroup": "dynamic",
        "defaultModel": model,
        "supportsWorkspaceTools": True,
        "stateStore": DAPR_AGENT_STATE_STORE_NAME,
        "memoryStore": DAPR_AGENT_MEMORY_STORE_NAME if DAPR_AGENT_ENABLE_MEMORY else None,
        "registryStore": DAPR_AGENT_REGISTRY_STORE_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
        "runtimeConfigStore": DAPR_AGENT_RUNTIME_CONFIG_STORE,
    }


def _build_registry_entries() -> list[dict[str, Any]]:
    return [
        {
            "name": _build_agent_name(),
            "metadata": _build_agent_registry_metadata(
                model=DEFAULT_MODEL,
            ),
        }
    ]


def _build_profile_descriptors() -> list[dict[str, Any]]:
    return [
        {
            "id": profile,
            "instructions": instructions,
            "defaultToolGroup": PROFILE_TOOL_GROUPS.get(profile, AGENT_TOOL_GROUP),
        }
        for profile, instructions in sorted(PROFILE_INSTRUCTIONS.items())
    ]


def _fetch_dapr_runtime_status() -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    runtime_status: dict[str, Any] = {
        "daprHost": DAPR_HTTP_HOST,
        "daprHttpPort": DAPR_HTTP_PORT,
        "minRuntimeVersion": MIN_DAPR_RUNTIME_VERSION,
    }
    try:
        with urllib.request.urlopen(
            f"http://{DAPR_HTTP_HOST}:{DAPR_HTTP_PORT}/v1.0/metadata",
            timeout=3,
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        runtime_status = {
            **runtime_status,
            "appId": payload.get("id"),
            "runtimeVersion": payload.get("runtimeVersion"),
            "extended": payload,
        }
    except Exception as exc:  # pragma: no cover - depends on sidecar availability
        errors.append(str(exc))
    return runtime_status, errors


def _use_dapr_llm_backend() -> bool:
    if DAPR_AGENT_LLM_BACKEND == "openai":
        return False
    if DAPR_AGENT_LLM_BACKEND == "dapr":
        return bool(DAPR_AGENT_LLM_COMPONENT)
    return bool(DAPR_AGENT_LLM_COMPONENT)


def _build_llm_client(model: str, api_key: str | None) -> Any:
    if _use_dapr_llm_backend() and DAPR_AGENT_LLM_COMPONENT:
        return DaprChatClient(model=model, component_name=DAPR_AGENT_LLM_COMPONENT)
    return OpenAIChatClient(
        model=model,
        api_key=api_key or os.environ.get("OPENAI_API_KEY"),
    )


def _build_durable_support_configs() -> dict[str, Any]:
    state = AgentStateConfig(
        store=StateStoreService(
            store_name=DAPR_AGENT_STATE_STORE_NAME,
            key_prefix=f"{DAPR_AGENT_STATE_KEY_PREFIX}runs:",
        ),
        state_key_prefix="run:",
    )
    memory = (
        AgentMemoryConfig(
            store=ConversationDaprStateMemory(
                store_name=DAPR_AGENT_MEMORY_STORE_NAME,
                agent_name=_build_agent_name(),
            )
        )
        if DAPR_AGENT_ENABLE_MEMORY
        else None
    )
    registry = (
        AgentRegistryConfig(
            store=StateStoreService(store_name=DAPR_AGENT_REGISTRY_STORE_NAME),
            team_name=DAPR_AGENT_REGISTRY_TEAM_NAME,
        )
        if DAPR_AGENT_ENABLE_REGISTRY
        else None
    )
    return {
        "state": state,
        "memory": memory,
        "registry": registry,
        "retry_policy": WorkflowRetryPolicy(
            max_attempts=3,
            initial_backoff_seconds=2,
            max_backoff_seconds=20,
            backoff_multiplier=2.0,
            retry_timeout=300,
        ),
        "observability": AgentObservabilityConfig.from_env(),
        "configuration": _build_runtime_subscription_config(),
    }


def _get_agent() -> DurableAgent:
    with _agent_lock:
        global _agent
        if _agent is None:
            support = _build_durable_support_configs()
            _agent = CodingDurableAgent(
                name=_build_agent_name(),
                role="autonomous coding agent",
                goal="Complete coding tasks in a durable, tool-using workflow",
                instructions=[
                    "Use the available tools to inspect, edit, and verify code.",
                    "When changing code, keep edits minimal and explain what changed.",
                    "Prefer deterministic verification commands when they are provided.",
                    "Respect the profile, workspace, and tool policy passed in the task.",
                ],
                llm=_build_llm_client(DEFAULT_MODEL, None),
                tools=resolve_tool_group("all"),
                execution=AgentExecutionConfig(
                    max_iterations=200,
                    tool_choice="auto",
                ),
                state=support["state"],
                memory=support["memory"],
                registry=support["registry"],
                retry_policy=support["retry_policy"],
                agent_observability=support["observability"],
                configuration=support["configuration"],
                agent_metadata=_build_agent_registry_metadata(
                    model=DEFAULT_MODEL,
                ),
                runtime=runtime,
            )
            try:
                _agent.start()
            except RuntimeError as exc:
                logger.warning("Failed to start durable agent %s: %s", _agent.name, exc)
        return _agent


def _build_run_context(
    instance_id: str,
    request: DaprAgentRunRequest,
    *,
    trace_id: str | None = None,
) -> AgentRunContext:
    execution_id = (
        str(request.dbExecutionId or request.executionId or "").strip() or None
    )
    return AgentRunContext(
        instance_id=instance_id,
        profile=_normalize_profile(request.profile),
        cwd=_resolve_request_cwd(request),
        tool_group=_resolve_effective_tool_group(request),
        max_turns=request.maxTurns,
        execution_id=execution_id,
        workspace_ref=request.workspaceRef,
        trace_id=trace_id,
    )


def _resolve_runner_workflow_client() -> Any:
    candidate = getattr(runner, "workflow_client", None)
    if callable(candidate):
        return candidate()
    return candidate


def _normalize_run_request(input_data: dict[str, Any] | str | None) -> DaprAgentRunRequest:
    if isinstance(input_data, str):
        return DaprAgentRunRequest(prompt=input_data)
    payload = dict(input_data or {})
    prompt = str(payload.get("prompt") or payload.get("goal") or payload.get("task") or "").strip()
    payload["prompt"] = prompt
    return DaprAgentRunRequest.model_validate(payload)


@runtime.workflow(name=WORKFLOW_NAME)
def dapr_agent_workflow(ctx: wf.DaprWorkflowContext, input_data: dict[str, Any] | str) -> dict[str, Any]:
    trace_id = (
        _trace_id_from_otel(input_data.get("_otel"))
        if isinstance(input_data, dict)
        else None
    ) or _trace_id_from_payload(input_data) or _current_trace_id()
    request = _normalize_run_request(input_data)
    instance_id = ctx.instance_id
    run_context = _build_run_context(instance_id, request, trace_id=trace_id)
    _persist_run_context(run_context)
    _persist_agent_progress(instance_id, _default_agent_progress(run_context, status="running"))
    _update_agent_progress(
        instance_id,
        phase="reasoning",
        summary=f"Starting {run_context.profile} run",
        currentStepName=run_context.profile,
    )
    normalized_request = request.model_copy(
        update={
            "cwd": run_context.cwd,
            "profile": run_context.profile,
            "workspaceRef": run_context.workspace_ref,
        }
    )
    agent_result = yield from _get_agent().agent_workflow(
        ctx,
        {"task": _build_task_prompt(normalized_request)},
    )
    return _build_result_payload(
        instance_id=instance_id,
        request=normalized_request,
        workflow_output=agent_result,
    )


async def _run_agent_request(
    request: DaprAgentRunRequest,
    *,
    instance_id: str,
    wait: bool,
    trace_id: str | None = None,
) -> str | None:
    run_context = _build_run_context(instance_id, request, trace_id=trace_id)
    _persist_run_context(run_context)
    _persist_agent_progress(instance_id, _default_agent_progress(run_context, status="running"))
    _update_agent_progress(
        instance_id,
        phase="reasoning",
        summary=f"Starting {run_context.profile} run",
        currentStepName=run_context.profile,
    )
    prompt = _build_task_prompt(
        request.model_copy(update={"cwd": run_context.cwd, "profile": run_context.profile})
    )
    agent = _get_agent()
    return await runner.run(
        agent,
        payload={"task": prompt},
        instance_id=instance_id,
        wait=wait,
        timeout_in_seconds=request.timeoutMinutes * 60,
        fetch_payloads=True,
        log=True,
    )


def _extract_openai_api_key(credentials: dict[str, str] | None) -> str | None:
    if not credentials:
        return None
    candidate = credentials.get("OPENAI_API_KEY")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _ensure_workspace_root()
    if ENABLE_DAPR_AGENTS_INSTRUMENTATION:
        try:
            from dapr_agents.observability import DaprAgentsInstrumentor

            DaprAgentsInstrumentor().instrument()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to enable dapr-agents instrumentation: %s", exc)
    try:
        global _agent_subscribed
        agent = _get_agent()
        if not _agent_subscribed:
            runner.subscribe(agent)
            _agent_subscribed = True
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to eagerly initialize dapr-agent runtime: %s", exc)
    try:
        yield
    finally:
        try:
            if _agent is not None and _agent_subscribed:
                runner.shutdown(_agent)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to cleanly shutdown dapr-agent runtime: %s", exc)
        runtime.shutdown()


app = FastAPI(title="dapr-agent-runtime", lifespan=lifespan)


@app.get("/health")
@app.get("/healthz")
@app.get("/readyz")
@app.get("/api/health")
def health() -> dict[str, Any]:
    runtime_status, errors = _fetch_dapr_runtime_status()
    return {
        "ok": True,
        "service": "dapr-agent-runtime",
        "version": SERVICE_VERSION,
        "workflowName": WORKFLOW_NAME,
        "runtimeStatus": runtime_status,
        "errors": errors,
    }


@app.get("/api/tools")
def list_tools() -> dict[str, Any]:
    return {
        "service": "dapr-agent-runtime",
        "toolGroups": {name: [tool.__name__ for tool in tools] for name, tools in TOOL_GROUPS.items()},
        "workspaceEnabledTools": WORKSPACE_ENABLED_TOOLS,
        "profiles": PROFILE_TOOL_GROUPS,
    }


@app.get("/api/runtime/introspect")
def runtime_introspect() -> dict[str, Any]:
    runtime_status, errors = _fetch_dapr_runtime_status()
    return {
        "service": "dapr-agent-runtime",
        "version": SERVICE_VERSION,
        "runtime": "python-dapr-agents",
        "ready": True,
        "runtimeStatus": runtime_status,
        "features": [
            "durable-agent",
            "workspace-tools",
            "persistent-memory",
            "state-store-backed-sessions",
            "agent-registry",
        ],
        "registeredWorkflows": [_workflow_descriptor(WORKFLOW_NAME)],
        "registeredActivities": [
            _activity_descriptor("workspace_profile"),
            _activity_descriptor("workspace_clone"),
            _activity_descriptor("workspace_command"),
            _activity_descriptor("workspace_file"),
            _activity_descriptor("workspace_cleanup"),
        ],
        "errors": errors,
        "workflowName": WORKFLOW_NAME,
        "profiles": sorted(PROFILE_INSTRUCTIONS.keys()),
        "profileToolGroups": PROFILE_TOOL_GROUPS,
        "toolGroups": list(TOOL_GROUPS.keys()),
        "capabilities": {
            "profiles": _build_profile_descriptors(),
            "workspaceTools": WORKSPACE_ENABLED_TOOLS,
            "toolGroups": list(TOOL_GROUPS.keys()),
        },
        "registry": {
            "enabled": DAPR_AGENT_ENABLE_REGISTRY,
            "storeName": DAPR_AGENT_REGISTRY_STORE_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
            "teamName": DAPR_AGENT_REGISTRY_TEAM_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
            "registeredAgents": _build_registry_entries(),
        },
        "publishedProfiles": _build_profile_descriptors(),
        "runtimeConfig": _snapshot_runtime_config_state(),
        "additional": {
            "stateStoreName": DAPR_AGENT_STATE_STORE_NAME,
            "memoryStoreName": DAPR_AGENT_MEMORY_STORE_NAME if DAPR_AGENT_ENABLE_MEMORY else None,
            "workspaceStateStoreName": DAPR_AGENT_STATE_STORE_NAME,
            "llmBackend": DAPR_AGENT_LLM_BACKEND,
            "effectiveLlmBackend": "dapr" if _use_dapr_llm_backend() else "openai",
            "llmComponent": DAPR_AGENT_LLM_COMPONENT,
            "instrumentationEnabled": ENABLE_DAPR_AGENTS_INSTRUMENTATION,
            "workspaceBindings": sum(len(refs) for refs in sessions_by_execution.values()),
        },
    }


@app.post("/api/workspaces/profile")
def workspace_profile(request: WorkspaceProfileRequest) -> dict[str, Any]:
    root_path = _default_workspace_root(request.executionId, request.rootPath)
    root_path.mkdir(parents=True, exist_ok=True)
    workspace_ref = f"workspace-{uuid.uuid4().hex[:12]}"
    enabled_tools_raw = request.enabledTools
    enabled_tools = enabled_tools_raw if isinstance(enabled_tools_raw, list) else ["read", "write", "edit", "list", "bash"]
    session = WorkspaceSession(
        workspace_ref=workspace_ref,
        execution_id=request.executionId,
        root_path=root_path,
        working_directory=root_path,
        enabled_tools=[str(item) for item in enabled_tools],
    )
    _persist_workspace_session(session)
    return {
        "workspaceRef": workspace_ref,
        "executionId": request.executionId,
        "rootPath": str(root_path),
        "backend": "local",
        "workingDirectory": str(root_path),
    }


@app.post("/api/workspaces/clone")
def workspace_clone(request: WorkspaceCloneRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    target_dir = str(request.targetDir or request.repositoryRepo or "repo").strip() or "repo"
    clone_path = (session.root_path / target_dir).resolve()
    if clone_path.exists():
        shutil.rmtree(clone_path)
    clone_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if request.repositoryToken and request.repositoryUsername:
        prefix = "https://"
        if request.repositoryUrl.startswith(prefix):
            env["GIT_ASKPASS"] = "echo"
    completed = subprocess.run(
        [
            "git",
            "clone",
            "--depth",
            "1",
            "--branch",
            request.repositoryBranch,
            request.repositoryUrl,
            str(clone_path),
        ],
        text=True,
        capture_output=True,
        timeout=(request.timeoutMs or 120000) / 1000,
        check=False,
        env=env,
    )
    if completed.returncode != 0:
        raise HTTPException(status_code=400, detail=completed.stderr.strip() or "git clone failed")
    commit_hash = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=clone_path,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    ).stdout.strip()
    file_count = len([p for p in clone_path.rglob("*") if p.is_file()])
    session.repository_url = request.repositoryUrl
    session.repository_owner = request.repositoryOwner
    session.repository_repo = request.repositoryRepo
    session.repository_branch = request.repositoryBranch
    session.working_directory = clone_path.resolve()
    _persist_workspace_session(session)
    return {
        "clonePath": str(clone_path),
        "repository": f"{request.repositoryOwner or ''}/{request.repositoryRepo or ''}".strip("/"),
        "branch": request.repositoryBranch,
        "commitHash": commit_hash,
        "fileCount": file_count,
        "workingDirectory": str(session.working_directory),
        **summarize_command_changes(clone_path),
    }


@app.post("/api/workspaces/command")
def workspace_command(request: WorkspaceCommandRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    context = ToolRuntimeContext.from_workspace_root(
        session.working_directory or session.root_path
    )
    working_directory = context.resolve_path(request.cwd or ".")
    completed = subprocess.run(
        ["bash", "-lc", request.command],
        cwd=working_directory,
        text=True,
        capture_output=True,
        timeout=(request.timeoutMs or 30000) / 1000,
        check=False,
    )
    return {
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "exitCode": completed.returncode,
        "success": completed.returncode == 0,
        **summarize_command_changes(working_directory),
    }


@app.post("/api/workspaces/file")
def workspace_file(request: WorkspaceFileRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    context = ToolRuntimeContext.from_workspace_root(
        session.working_directory or session.root_path
    )
    operation = request.operation.strip().lower()
    token = push_tool_context(context)
    try:
        if operation == "read":
            if not request.path:
                raise HTTPException(status_code=400, detail="path is required for read")
            return {"content": read_file(request.path)}
        if operation == "write":
            if not request.path:
                raise HTTPException(status_code=400, detail="path is required for write")
            return {
                **write_file(request.path, request.content or ""),
                **context.build_summary(),
            }
        if operation == "edit":
            if not request.path:
                raise HTTPException(status_code=400, detail="path is required for edit")
            return {
                **edit_file(
                    request.path,
                    request.old_string or "",
                    request.new_string or "",
                ),
                **context.build_summary(),
            }
        if operation == "list":
            return {"files": list_files(request.path or ".", request.pattern or "**/*")}
        if operation == "grep":
            return {"matches": grep_search(request.content or request.pattern or "", request.path or ".")}
        if operation == "stat":
            return file_stat(request.path or ".")
        if operation == "delete":
            if not request.path:
                raise HTTPException(status_code=400, detail="path is required for delete")
            return {
                **delete_path(request.path),
                **context.build_summary(),
            }
        if operation == "mkdir":
            if not request.path:
                raise HTTPException(status_code=400, detail="path is required for mkdir")
            return mkdir(request.path)
        if operation == "git_status":
            return git_status(request.path or ".")
        if operation == "git_diff":
            return git_diff(request.path or ".")
        if operation == "git_apply":
            return {
                **git_apply(request.content or "", request.path or "."),
                **context.build_summary(),
            }
        raise HTTPException(status_code=400, detail=f"Unsupported operation: {request.operation}")
    finally:
        pop_tool_context(token)


@app.post("/api/workspaces/cleanup")
def workspace_cleanup(request: WorkspaceCleanupRequest) -> dict[str, Any]:
    cleaned: list[str] = []
    refs: set[str] = set()
    if request.workspaceRef:
        refs.add(request.workspaceRef)
    if request.executionId:
        refs |= _load_execution_workspace_refs(request.executionId)
    for ref in refs:
        if _load_workspace_session(ref) is None:
            continue
        _delete_workspace_session(ref)
        cleaned.append(ref)
    return {"cleanedWorkspaceRefs": cleaned}


@app.get("/api/workspaces/executions/{execution_id}/changes")
def workspace_execution_changes(execution_id: str) -> dict[str, Any]:
    run_ids = _load_execution_run_ids(execution_id)
    artifacts = [
        artifact
        for run_id in run_ids
        if (artifact := _load_run_artifact(run_id)) is not None
    ]
    changes = [
        {
            "changeSetId": artifact.get("changeSetId"),
            "executionId": execution_id,
            "agentWorkflowId": artifact.get("agentWorkflowId"),
            "daprInstanceId": artifact.get("daprInstanceId"),
            "createdAt": artifact.get("createdAt"),
            "changeSummary": artifact.get("changeSummary"),
        }
        for artifact in artifacts
    ]
    return {
        "success": True,
        "executionId": execution_id,
        "count": len(changes),
        "changes": changes,
    }


@app.get("/api/workspaces/changes/{change_set_id}")
def workspace_change_artifact(change_set_id: str) -> dict[str, Any]:
    instance_id = (
        change_set_id[: -len("-patch")]
        if change_set_id.endswith("-patch")
        else change_set_id
    )
    artifact = _load_run_artifact(instance_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Change artifact not found")
    metadata = {
        "changeSetId": artifact.get("changeSetId"),
        "executionId": artifact.get("executionId"),
        "agentWorkflowId": artifact.get("agentWorkflowId"),
        "daprInstanceId": artifact.get("daprInstanceId"),
        "createdAt": artifact.get("createdAt"),
        "changeSummary": artifact.get("changeSummary"),
    }
    return {
        "success": True,
        "metadata": metadata,
        "patch": artifact.get("patch") or "",
    }


@app.get("/api/workspaces/executions/{execution_id}/patch")
def workspace_execution_patch(
    execution_id: str,
    durableInstanceId: str | None = None,
) -> dict[str, Any]:
    run_ids = (
        [durableInstanceId]
        if durableInstanceId
        else _load_execution_run_ids(execution_id)
    )
    artifacts = [
        artifact
        for run_id in run_ids
        if (artifact := _load_run_artifact(run_id)) is not None
    ]
    if durableInstanceId and not artifacts:
        raise HTTPException(status_code=404, detail="Patch artifact not found")
    change_sets = [
        {
            "changeSetId": artifact.get("changeSetId"),
            "executionId": execution_id,
            "agentWorkflowId": artifact.get("agentWorkflowId"),
            "daprInstanceId": artifact.get("daprInstanceId"),
            "createdAt": artifact.get("createdAt"),
            "changeSummary": artifact.get("changeSummary"),
        }
        for artifact in artifacts
    ]
    combined_patch = "\n\n".join(
        patch
        for patch in [str(artifact.get("patch") or "").strip() for artifact in artifacts]
        if patch
    )
    return {
        "success": True,
        "executionId": execution_id,
        "durableInstanceId": durableInstanceId,
        "patch": combined_patch,
        "changeSets": change_sets,
    }


@app.get("/api/workspaces/executions/{execution_id}/files/snapshot")
def workspace_execution_file_snapshot(
    execution_id: str,
    path: str,
    durableInstanceId: str | None = None,
) -> dict[str, Any]:
    relative_path = str(path or "").strip()
    if not relative_path:
        raise HTTPException(status_code=400, detail="path is required")
    run_ids = (
        [durableInstanceId]
        if durableInstanceId
        else _load_execution_run_ids(execution_id)
    )
    for run_id in run_ids:
        context = _load_run_context(run_id)
        if context is None:
            continue
        snapshot = _safe_workspace_file_snapshot(context.cwd, relative_path)
        if snapshot is not None:
            return {
                "success": True,
                "executionId": execution_id,
                "path": relative_path,
                "durableInstanceId": run_id,
                "snapshot": snapshot,
            }
    raise HTTPException(status_code=404, detail="File snapshot not found for execution")


@app.post("/api/run")
def api_run(request: DaprAgentRunRequest, http_request: Request) -> dict[str, Any]:
    instance_id = f"dapr-agent-run-{uuid.uuid4().hex[:12]}"
    otel_ctx = _otel_context_from_headers(http_request)
    trace_id = _trace_id_from_otel(otel_ctx) or _current_trace_id()
    if request.waitForCompletion:
        run_context = _build_run_context(instance_id, request, trace_id=trace_id)
        _persist_run_context(run_context)
        _persist_agent_progress(instance_id, _default_agent_progress(run_context, status="running"))
        _update_agent_progress(
            instance_id,
            phase="reasoning",
            summary=f"Starting {run_context.profile} run",
            currentStepName=run_context.profile,
        )
        normalized_request = request.model_copy(update={"cwd": run_context.cwd, "profile": run_context.profile})
        workflow_output = runner.run_sync(
            _get_agent(),
            payload={"task": _build_task_prompt(normalized_request)},
            instance_id=instance_id,
            timeout_in_seconds=request.timeoutMinutes * 60,
            fetch_payloads=True,
            log=True,
        )
        result = _build_result_payload(
            instance_id=instance_id,
            request=normalized_request,
            workflow_output=workflow_output,
        )
        return {"success": True, "result": result, **result}

    asyncio.run(
        _run_agent_request(
            request,
            instance_id=instance_id,
            wait=False,
            trace_id=trace_id,
        )
    )
    return {
        "success": True,
        "status": "running",
        "workflow_id": instance_id,
        "workflowId": instance_id,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "traceId": trace_id,
        "agentProgress": _load_agent_progress(instance_id),
        "status_url": f"/api/run/{instance_id}",
    }


@app.get("/api/run/{instance_id}")
def api_run_status(instance_id: str) -> dict[str, Any]:
    workflow_client_instance = _resolve_runner_workflow_client()
    if workflow_client_instance is None:
        raise HTTPException(status_code=503, detail="Workflow client unavailable")
    state = workflow_client_instance.get_workflow_state(instance_id, fetch_payloads=True)
    runtime_status = getattr(getattr(state, "runtime_status", None), "name", "UNKNOWN")
    run_context = _load_run_context(instance_id)
    progress = _load_agent_progress(instance_id)
    serialized_output = getattr(state, "serialized_output", None)
    parsed_output = _parse_serialized_output(serialized_output)
    normalized_status = str(runtime_status).lower()
    if progress is None and run_context is not None:
        progress = _default_agent_progress(run_context, status=normalized_status)
    if progress is not None and normalized_status in {"completed", "failed", "terminated"}:
        progress = {
            **progress,
            "status": normalized_status,
            "phase": "completed" if normalized_status == "completed" else "failed",
            "activeToolName": None,
            "stopReason": progress.get("stopReason")
            or ("workflow completed" if normalized_status == "completed" else normalized_status),
            "updatedAt": _utc_now_iso(),
        }
        _persist_agent_progress(instance_id, progress)
    resolved_trace_id = (
        progress.get("traceId")
        if isinstance(progress, dict)
        else None
    ) or (run_context.trace_id if run_context else None) or _trace_id_from_payload(parsed_output)
    if isinstance(progress, dict) and resolved_trace_id and not progress.get("traceId"):
        progress = {**progress, "traceId": resolved_trace_id}
        _persist_agent_progress(instance_id, progress)
    return {
        "instanceId": instance_id,
        "status": normalized_status,
        "runtimeStatus": runtime_status,
        "traceId": resolved_trace_id,
        "phase": progress.get("phase") if isinstance(progress, dict) else None,
        "agentProgress": progress,
        "serializedOutput": serialized_output,
    }


@app.post("/api/run/{instance_id}/terminate")
def api_run_terminate(instance_id: str, request: TerminateRequest) -> dict[str, Any]:
    runner.terminate_workflow(instance_id, output=request.reason or "terminated")
    _update_agent_progress(
        instance_id,
        status="terminated",
        phase="failed",
        activeToolName=None,
        stopReason=request.reason or "terminated",
        summary=request.reason or "terminated",
    )
    _delete_run_context(instance_id)
    return {"success": True, "instanceId": instance_id, "terminated": True}


@app.post("/execute")
def execute_step(request: ExecuteRequest) -> dict[str, Any]:
    step = request.step.strip().lower()
    if step != "run":
        return {"success": False, "error": f"Unsupported step: {request.step}"}
    run_request = DaprAgentRunRequest(
        prompt=str(request.input.get("prompt") or request.input.get("goal") or "").strip(),
        profile=str(request.input.get("profile") or request.input.get("mode") or "implement"),
        model=str(request.input.get("model") or "").strip() or None,
        waitForCompletion=True,
        timeoutMinutes=int(request.input.get("timeoutMinutes") or 30),
        maxTurns=int(request.input.get("maxTurns") or 30),
        workspaceRef=str(request.input.get("workspaceRef") or "").strip() or None,
        cwd=str(request.input.get("cwd") or "").strip() or None,
        stopCondition=str(request.input.get("stopCondition") or "").strip() or None,
        instructionsOverlay=str(request.input.get("instructionsOverlay") or "").strip() or None,
        expectedOutput=str(request.input.get("expectedOutput") or "").strip() or None,
        verifyCommands=str(request.input.get("verifyCommands") or "").strip() or None,
        approvalMode=str(request.input.get("approvalMode") or "").strip() or None,
        toolPolicy=str(request.input.get("toolPolicy") or "").strip() or None,
        writePolicy=str(request.input.get("writePolicy") or "").strip() or None,
        shellPolicy=str(request.input.get("shellPolicy") or "").strip() or None,
        openAIApiKey=_extract_openai_api_key(request.credentials),
    )
    payload = api_run(run_request)
    return {"success": True, "data": payload, "duration_ms": 0}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
