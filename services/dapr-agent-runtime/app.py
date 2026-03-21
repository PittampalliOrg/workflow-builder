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
from datetime import timedelta
from pathlib import Path
from typing import Any
import re

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
from langgraph_engine import (
    LANGGRAPH_ENGINE_NAME,
    build_langgraph_capabilities,
    is_langgraph_available,
    run_langgraph_task,
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

        @staticmethod
        def when_any(tasks: list[Any]) -> Any:
            return tasks[0]

    class DaprWorkflowClient:  # type: ignore[no-redef]
        def schedule_new_workflow(self, workflow: Any, input: dict[str, Any] | None = None, instance_id: str | None = None):
            raise RuntimeError("Dapr workflow client unavailable")

        def get_workflow_state(self, *args, **kwargs):
            raise RuntimeError("Dapr workflow client unavailable")

        def terminate_workflow(self, *args, **kwargs):
            return None

        def raise_workflow_event(self, *args, **kwargs):
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
    from dapr_agents.observability.context_storage import (
        cleanup_workflow_context,
        store_workflow_context,
    )
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

    def store_workflow_context(instance_id: str, otel_context: dict[str, Any]) -> None:  # type: ignore[no-redef]
        return None

    def cleanup_workflow_context(instance_id: str) -> None:  # type: ignore[no-redef]
        return None

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
PLAN_ACTIVITY_NAME = os.environ.get("DAPR_AGENT_LANGGRAPH_PLAN_ACTIVITY", "langgraphPlanActivity")
EXECUTE_ACTIVITY_NAME = os.environ.get(
    "DAPR_AGENT_LANGGRAPH_EXECUTE_ACTIVITY",
    "langgraphExecuteActivity",
)
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
DAPR_AGENT_RUNTIME_CONFIG_POLL_INTERVAL_SECONDS = max(
    int(os.environ.get("DAPR_AGENT_RUNTIME_CONFIG_POLL_INTERVAL_SECONDS", "30") or "30"),
    5,
)
SERVICE_AGENT_NAME = os.environ.get("DAPR_AGENT_SERVICE_NAME", "dapr-coding-agent")
LANGGRAPH_PROFILE_SET = {
    value.strip().lower()
    for value in os.environ.get(
        "DAPR_AGENT_LANGGRAPH_PROFILES",
        "feature-delivery,implement,repair,plan-only",
    ).split(",")
    if value.strip()
}
DEFAULT_APPROVAL_TIMEOUT_MINUTES = max(
    int(os.environ.get("DAPR_AGENT_DEFAULT_APPROVAL_TIMEOUT_MINUTES", "60") or "60"),
    1,
)


PROFILE_INSTRUCTIONS: dict[str, str] = {
    "feature-delivery": (
        "You are a senior feature delivery coding agent. First inspect the repository and "
        "produce a concrete implementation plan. After approval, implement the approved plan, "
        "review your own changes, verify the result, and return durable code artifacts."
    ),
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
    "feature-delivery": "all",
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

PLAN_MODE = "plan_mode"
EXECUTE_MODE = "execute_direct"
FEATURE_DELIVERY_PLAN_MODE = "feature_delivery_plan"
FEATURE_DELIVERY_EXECUTE_MODE = "feature_delivery_execute"
PLAN_ARTIFACT_TYPE = "claude_task_graph_v1"


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
    mode: str | None = None
    engine: str | None = None
    toolBackend: str | None = None
    threadId: str | None = None
    planningThreadId: str | None = None
    executionThreadId: str | None = None
    plannerResume: dict[str, Any] | None = None
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
    approvalTimeoutMinutes: int = Field(
        default=DEFAULT_APPROVAL_TIMEOUT_MINUTES,
        ge=1,
        le=24 * 60,
    )
    executeAfterApproval: bool = Field(default=True)
    toolPolicy: str | None = None
    tools: str | list[str] | None = None
    writePolicy: str | None = None
    shellPolicy: str | None = None
    openAIApiKey: str | None = None
    sandboxName: str | None = None
    provider: str | None = None
    sandboxRepoPath: str | None = None
    repositoryUrl: str | None = None
    repositoryOwner: str | None = None
    repositoryRepo: str | None = None
    repositoryBranch: str | None = None
    repositoryToken: str | None = None
    executionId: str | None = None
    dbExecutionId: str | None = None
    artifactRef: str | None = None
    planJson: dict[str, Any] | list[dict[str, Any]] | None = None


class ApproveRequest(BaseModel):
    approved: bool = True
    action: str | None = None
    reason: str | None = None
    approvedBy: str | None = None
    payload: dict[str, Any] | None = None


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
    workspaceRef: str | None = None
    parentExecutionId: str | None = None
    cleanupWorkspace: bool = False


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
    mode: str
    profile: str
    model: str
    cwd: str
    tool_group: str
    max_turns: int
    engine: str = "dapr-agent"
    tool_backend: str | None = None
    sandbox_name: str | None = None
    sandbox_provider: str | None = None
    sandbox_repo_path: str | None = None
    repository_url: str | None = None
    repository_owner: str | None = None
    repository_repo: str | None = None
    repository_branch: str | None = None
    repository_token: str | None = None
    execute_after_approval: bool = True
    approval_event_name: str | None = None
    execution_id: str | None = None
    workspace_ref: str | None = None
    thread_id: str | None = None
    planning_thread_id: str | None = None
    execution_thread_id: str | None = None
    trace_id: str | None = None
    artifact_ref: str | None = None
    verify_commands: list[str] | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "mode": self.mode,
            "profile": self.profile,
            "model": self.model,
            "engine": self.engine,
            "toolBackend": self.tool_backend,
            "cwd": self.cwd,
            "toolGroup": self.tool_group,
            "maxTurns": self.max_turns,
            "sandboxName": self.sandbox_name,
            "provider": self.sandbox_provider,
            "sandboxRepoPath": self.sandbox_repo_path,
            "repositoryUrl": self.repository_url,
            "repositoryOwner": self.repository_owner,
            "repositoryRepo": self.repository_repo,
            "repositoryBranch": self.repository_branch,
            "repositoryToken": self.repository_token,
            "executeAfterApproval": self.execute_after_approval,
            "approvalEventName": self.approval_event_name,
            "executionId": self.execution_id,
            "workspaceRef": self.workspace_ref,
            "threadId": self.thread_id,
            "planningThreadId": self.planning_thread_id,
            "executionThreadId": self.execution_thread_id,
            "traceId": self.trace_id,
            "artifactRef": self.artifact_ref,
            "verifyCommands": list(self.verify_commands or []),
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "AgentRunContext":
        return cls(
            instance_id=str(record.get("instanceId") or ""),
            mode=_normalize_run_mode(record.get("mode")),
            profile=_normalize_profile(str(record.get("profile") or "custom")),
            model=str(record.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            engine=str(record.get("engine") or "dapr-agent").strip() or "dapr-agent",
            tool_backend=str(record.get("toolBackend") or "").strip() or None,
            cwd=_resolve_cwd(str(record.get("cwd") or "")),
            tool_group=_resolve_tool_group(str(record.get("toolGroup") or "all")),
            max_turns=max(int(record.get("maxTurns") or 30), 1),
            sandbox_name=str(record.get("sandboxName") or "").strip() or None,
            sandbox_provider=str(record.get("provider") or "").strip() or None,
            sandbox_repo_path=str(record.get("sandboxRepoPath") or "").strip() or None,
            repository_url=str(record.get("repositoryUrl") or "").strip() or None,
            repository_owner=str(record.get("repositoryOwner") or "").strip() or None,
            repository_repo=str(record.get("repositoryRepo") or "").strip() or None,
            repository_branch=str(record.get("repositoryBranch") or "").strip() or None,
            repository_token=str(record.get("repositoryToken") or "").strip() or None,
            execute_after_approval=_coerce_bool(
                record.get("executeAfterApproval"),
                True,
            ),
            approval_event_name=str(record.get("approvalEventName") or "").strip() or None,
            execution_id=str(record.get("executionId") or "").strip() or None,
            workspace_ref=str(record.get("workspaceRef") or "").strip() or None,
            thread_id=str(record.get("threadId") or "").strip() or None,
            planning_thread_id=(
                str(record.get("planningThreadId") or "").strip()
                or str(record.get("threadId") or "").strip()
                or None
            ),
            execution_thread_id=(
                str(record.get("executionThreadId") or "").strip()
                or str(record.get("threadId") or "").strip()
                or None
            ),
            trace_id=str(record.get("traceId") or "").strip() or None,
            artifact_ref=str(record.get("artifactRef") or "").strip() or None,
            verify_commands=[
                str(command).strip()
                for command in (record.get("verifyCommands") or [])
                if str(command).strip()
            ]
            or None,
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
runtime_config_poll_stop = threading.Event()
runtime_config_poll_thread: threading.Thread | None = None
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


def _normalize_run_mode(raw: object) -> str:
    normalized = str(raw or "").strip().lower()
    if normalized in {
        PLAN_MODE,
        FEATURE_DELIVERY_PLAN_MODE,
        "plan",
        "plan_only",
    }:
        return FEATURE_DELIVERY_PLAN_MODE
    if normalized in {
        FEATURE_DELIVERY_EXECUTE_MODE,
        "execute_plan",
        "feature_delivery",
        "implement_from_plan",
    }:
        return FEATURE_DELIVERY_EXECUTE_MODE
    return EXECUTE_MODE


def _is_planning_mode(mode: str) -> bool:
    return _normalize_run_mode(mode) == FEATURE_DELIVERY_PLAN_MODE


def _is_feature_execution_mode(mode: str) -> bool:
    return _normalize_run_mode(mode) == FEATURE_DELIVERY_EXECUTE_MODE


def _parse_verify_commands(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    return [line.strip() for line in value.splitlines() if line.strip()]


def _progress_phase_for_mode(mode: str, *, step: str = "active") -> str:
    normalized_mode = _normalize_run_mode(mode)
    if normalized_mode == FEATURE_DELIVERY_PLAN_MODE:
        return "planning"
    if normalized_mode == FEATURE_DELIVERY_EXECUTE_MODE:
        return "verifying" if step == "verify" else "implementing"
    return "reasoning" if step == "active" else "completed"


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
    return (
        str(otel_ctx.get("traceId") or otel_ctx.get("trace_id") or "").strip() or None
    ) or _trace_id_from_traceparent(otel_ctx.get("traceparent"))


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


def _generate_trace_context() -> dict[str, str]:
    trace_id = uuid.uuid4().hex
    span_id = uuid.uuid4().hex[:16]
    return {
        "traceparent": f"00-{trace_id}-{span_id}-01",
        "traceId": trace_id,
    }


def _workflow_context_carrier(
    instance_id: str,
    input_data: dict[str, Any] | str | None,
    trace_id: str | None,
) -> dict[str, Any]:
    carrier = (
        dict(input_data.get("_otel") or {})
        if isinstance(input_data, dict) and isinstance(input_data.get("_otel"), dict)
        else {}
    )
    if trace_id and not carrier.get("traceId"):
        carrier["traceId"] = trace_id
    if not carrier.get("instance_id"):
        carrier["instance_id"] = instance_id
    return carrier


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
            "pollIntervalSeconds": DAPR_AGENT_RUNTIME_CONFIG_POLL_INTERVAL_SECONDS,
            "pollingFallbackEnabled": True,
        }


def _effective_runtime_config_value(key: str, default: Any = None) -> Any:
    with runtime_config_lock:
        effective = dict(runtime_config_state.get("effective") or {})
    value = effective.get(str(key))
    if value is None or value == "":
        return default
    return value


def _effective_default_model() -> str:
    value = _effective_runtime_config_value(RuntimeConfigKey.LLM_MODEL, DEFAULT_MODEL)
    return str(value).strip() or DEFAULT_MODEL


def _fetch_runtime_config_items() -> dict[str, Any]:
    with DaprClient() as client:
        response = client.get_configuration(
            store_name=DAPR_AGENT_RUNTIME_CONFIG_STORE,
            keys=[str(key) for key in HOT_RELOAD_RUNTIME_KEYS],
            config_metadata=_runtime_config_metadata(),
        )
    items = getattr(response, "items", {}) or {}
    return {str(key): getattr(item, "value", None) for key, item in items.items()}


def _apply_runtime_config_items(items: dict[str, Any]) -> None:
    if not items:
        return
    agent = _get_agent()
    current_effective = dict(_snapshot_runtime_config_state().get("effective") or {})
    for key, value in items.items():
        serialized = _serialize_runtime_config_value(value)
        if current_effective.get(str(key)) == serialized:
            continue
        agent._apply_config_update(str(key), value)
        current_effective[str(key)] = serialized


def _runtime_config_poll_loop(stop_event: threading.Event) -> None:
    while not stop_event.wait(DAPR_AGENT_RUNTIME_CONFIG_POLL_INTERVAL_SECONDS):
        try:
            _apply_runtime_config_items(_fetch_runtime_config_items())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Runtime config polling failed: %s", exc)


def _otel_context_from_headers(request: Request) -> dict[str, str]:
    carrier: dict[str, str] = {}
    traceparent = request.headers.get("traceparent")
    tracestate = request.headers.get("tracestate")
    if traceparent:
        carrier["traceparent"] = traceparent
    if tracestate:
        carrier["tracestate"] = tracestate
    if not carrier.get("traceparent"):
        carrier.update(_generate_trace_context())
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
    if _is_planning_mode(request.mode or request.profile):
        return "planning"
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


def _resolve_effective_model(request: DaprAgentRunRequest) -> str:
    configured = str(request.model or "").strip()
    if configured:
        return configured
    return _effective_default_model()


def _approval_event_name(instance_id: str) -> str:
    return f"dapr_agent_plan_approval_{instance_id}".lower()


def _supports_langgraph(request: DaprAgentRunRequest) -> bool:
    configured_engine = str(request.engine or "").strip().lower()
    if configured_engine in {"langgraph", "deepagents", "deep-agent", LANGGRAPH_ENGINE_NAME.lower()}:
        return True
    if configured_engine in {"dapr-agent", "dapr_agents", "legacy"}:
        return False
    profile = _normalize_profile(request.profile)
    return profile in LANGGRAPH_PROFILE_SET and is_langgraph_available()


def _resolve_run_engine(request: DaprAgentRunRequest) -> str:
    configured_engine = str(request.engine or "").strip().lower()
    if configured_engine in {"dapr-agent", "dapr_agents", "legacy"}:
        return "dapr-agent"
    return LANGGRAPH_ENGINE_NAME if _supports_langgraph(request) else "dapr-agent"


def _extract_json_block(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    candidates = [stripped]
    fenced = re.findall(r"```json\s*(\{.*?\})\s*```", stripped, flags=re.DOTALL)
    candidates.extend(fenced)
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _fallback_plan_json(request: DaprAgentRunRequest, markdown: str) -> dict[str, Any]:
    verification_commands = _parse_verify_commands(request.verifyCommands)
    return {
        "artifactType": PLAN_ARTIFACT_TYPE,
        "goal": request.prompt,
        "summary": markdown.strip()[:500] or request.prompt,
        "tasks": [
            {
                "id": "task-1",
                "title": "Implement approved feature",
                "description": markdown.strip() or request.prompt,
                "tool": "coding-agent",
            }
        ],
        "acceptanceCriteria": [request.expectedOutput] if request.expectedOutput else [],
        "verificationCommands": verification_commands,
        "files": [],
    }


def _render_plan_markdown(plan: dict[str, Any], request: DaprAgentRunRequest) -> str:
    lines = [
        f"# Feature Plan",
        "",
        f"## Goal",
        request.prompt,
    ]
    summary = str(plan.get("summary") or "").strip()
    if summary:
        lines.extend(["", "## Summary", summary])
    tasks = plan.get("tasks")
    if isinstance(tasks, list) and tasks:
        lines.extend(["", "## Tasks"])
        for index, task in enumerate(tasks, start=1):
            if not isinstance(task, dict):
                continue
            title = str(task.get("title") or task.get("subject") or f"Task {index}").strip()
            description = str(task.get("description") or task.get("instructions") or "").strip()
            lines.append(f"{index}. {title}")
            if description:
                lines.append(f"   {description}")
    verification_commands = plan.get("verificationCommands")
    if isinstance(verification_commands, list) and verification_commands:
        lines.extend(["", "## Verification"])
        lines.extend([f"- `{str(command).strip()}`" for command in verification_commands if str(command).strip()])
    acceptance = plan.get("acceptanceCriteria")
    if isinstance(acceptance, list) and acceptance:
        lines.extend(["", "## Acceptance Criteria"])
        lines.extend([f"- {str(item).strip()}" for item in acceptance if str(item).strip()])
    return "\n".join(lines).strip()


def _extract_plan_payload(
    workflow_output: Any,
    request: DaprAgentRunRequest,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    if isinstance(workflow_output, dict):
        candidate_plan = workflow_output.get("plan")
        plan_markdown = str(
            workflow_output.get("planMarkdown")
            or workflow_output.get("content")
            or workflow_output.get("text")
            or ""
        ).strip()
        if isinstance(candidate_plan, dict):
            plan = dict(candidate_plan)
        else:
            plan = _extract_json_block(plan_markdown) or _fallback_plan_json(
                request, plan_markdown
            )
    else:
        plan_markdown = _coerce_text(workflow_output)
        plan = _extract_json_block(plan_markdown) or _fallback_plan_json(
            request, plan_markdown
        )
    plan.setdefault("artifactType", PLAN_ARTIFACT_TYPE)
    plan.setdefault("goal", request.prompt)
    plan.setdefault("verificationCommands", _parse_verify_commands(request.verifyCommands))
    rendered_markdown = _render_plan_markdown(plan, request)
    metadata = {
        "mode": _normalize_run_mode(request.mode or request.profile),
        "profile": _normalize_profile(request.profile),
        "sourceRuntime": "dapr-agent-runtime",
        "verificationCommands": plan.get("verificationCommands") or [],
        "planWarnings": []
        if _extract_json_block(plan_markdown or rendered_markdown)
        else ["Plan result was normalized from free-form agent output."],
    }
    return plan, rendered_markdown or plan_markdown, metadata


def _build_task_prompt(request: DaprAgentRunRequest) -> str:
    profile = _normalize_profile(request.profile)
    run_mode = _normalize_run_mode(request.mode or request.profile)
    segments = [
        f"Profile: {profile}",
        f"Run mode: {run_mode}",
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
    if _is_planning_mode(run_mode):
        segments.append(
            "Planning contract:\n"
            "Inspect the repository in a read-only loop. Do not make file changes. "
            "Return a final JSON object with keys: summary, tasks, acceptanceCriteria, "
            "verificationCommands, and files. Each task should describe a concrete implementation step."
        )
    elif _is_feature_execution_mode(run_mode):
        if request.artifactRef:
            segments.append(f"Approved plan artifact:\n{request.artifactRef}")
        if request.planJson:
            segments.append(
                "Approved plan JSON:\n"
                f"{json.dumps(request.planJson, indent=2, default=str)}"
            )
        segments.append(
            "Execution contract:\n"
            "Implement the approved plan directly in the repository. Review your own edits as you go, "
            "run the provided verification commands when possible, and finish with a concise summary of the code changes."
        )
    return "\n\n".join(segment for segment in segments if segment.strip())


def _resolve_langgraph_planning_thread_id(
    *,
    instance_id: str,
    request: DaprAgentRunRequest,
    execution_id: str | None,
    artifact_ref: str | None,
) -> str | None:
    explicit_thread_id = str(request.planningThreadId or "").strip() or None
    if explicit_thread_id:
        return explicit_thread_id

    run_engine = _resolve_run_engine(request)
    if run_engine != LANGGRAPH_ENGINE_NAME:
        return None

    scope = (
        execution_id
        or str(request.workspaceRef or "").strip()
        or artifact_ref
        or instance_id
    )
    return f"lg:plan:{scope}"


def _resolve_langgraph_execution_thread_id(
    *,
    instance_id: str,
    request: DaprAgentRunRequest,
    execution_id: str | None,
    artifact_ref: str | None,
) -> str | None:
    explicit_thread_id = (
        str(request.executionThreadId or "").strip()
        or str(request.threadId or "").strip()
        or None
    )
    if explicit_thread_id:
        return explicit_thread_id

    run_engine = _resolve_run_engine(request)
    if run_engine != LANGGRAPH_ENGINE_NAME:
        return None

    scope = (
        execution_id
        or str(request.workspaceRef or "").strip()
        or artifact_ref
        or instance_id
    )
    return f"lg:exec:{scope}"


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off", ""}:
            return False
    return default


def _build_result_payload(
    *,
    instance_id: str,
    request: DaprAgentRunRequest,
    workflow_output: Any,
    pending_approval: bool = False,
) -> dict[str, Any]:
    text = _coerce_text(workflow_output)
    cwd = _resolve_request_cwd(request)
    run_context = _load_run_context(instance_id)
    workflow_record = workflow_output if isinstance(workflow_output, dict) else {}
    engine_metadata = (
        workflow_record.get("engineMetadata")
        if isinstance(workflow_record.get("engineMetadata"), dict)
        else None
    )
    session_persistence = (
        str(workflow_record.get("sessionPersistence") or "").strip() or None
    )
    planning_thread_id = (
        str(workflow_record.get("planningThreadId") or "").strip()
        or (
            str(engine_metadata.get("planningThreadId") or "").strip()
            if isinstance(engine_metadata, dict)
            else ""
        )
        or (run_context.planning_thread_id if run_context else None)
    )
    execution_thread_id = (
        str(workflow_record.get("executionThreadId") or "").strip()
        or (
            str(engine_metadata.get("executionThreadId") or "").strip()
            if isinstance(engine_metadata, dict)
            else ""
        )
        or (run_context.execution_thread_id if run_context else None)
    )
    thread_id = (
        str(workflow_record.get("threadId") or "").strip()
        or (
            planning_thread_id
            if _is_planning_mode(
                request.mode or (run_context.mode if run_context is not None else request.profile)
            )
            else execution_thread_id
        )
        or (run_context.thread_id if run_context else None)
    )
    planner_status = (
        str(workflow_record.get("plannerStatus") or "").strip()
        or (
            str(engine_metadata.get("plannerStatus") or "").strip()
            if isinstance(engine_metadata, dict)
            else ""
        )
        or None
    )
    planner_checkpoint_id = (
        str(workflow_record.get("plannerCheckpointId") or "").strip()
        or (
            str(engine_metadata.get("plannerCheckpointId") or "").strip()
            if isinstance(engine_metadata, dict)
            else ""
        )
        or None
    )
    approval_payload = (
        workflow_record.get("approvalPayload")
        if isinstance(workflow_record.get("approvalPayload"), dict)
        else (
            engine_metadata.get("approvalPayload")
            if isinstance(engine_metadata, dict)
            and isinstance(engine_metadata.get("approvalPayload"), dict)
            else None
        )
    )
    run_mode = _normalize_run_mode(
        request.mode or (run_context.mode if run_context is not None else request.profile)
    )
    progress = _load_agent_progress(instance_id)
    if progress is None:
        context = run_context or _build_run_context(instance_id, request)
        progress = _default_agent_progress(context, status="completed")
    if _is_planning_mode(run_mode):
        plan, plan_markdown, plan_metadata = _extract_plan_payload(workflow_output, request)
        plan_artifact_ref = (
            run_context.artifact_ref
            if run_context and run_context.artifact_ref
            else str(request.artifactRef or "").strip() or f"plan_{instance_id}"
        )
        approval_event_name = run_context.approval_event_name if run_context else _approval_event_name(instance_id)
        phase = (
            "awaiting_approval"
            if pending_approval
            else "failed"
            if planner_status == "rejected"
            else "planned"
        )
        progress = {
            **progress,
            "status": (
                "running"
                if pending_approval
                else "failed"
                if planner_status == "rejected"
                else "completed"
            ),
            "phase": phase,
            "summary": str(plan.get("summary") or text[:280] or progress.get("summary")),
            "activeToolName": None,
            "stopReason": (
                "awaiting approval"
                if pending_approval
                else "plan rejected"
                if planner_status == "rejected"
                else "plan generated"
            ),
            "currentStepName": "approval" if pending_approval else "plan",
            "approvalEventName": approval_event_name,
            "updatedAt": _utc_now_iso(),
        }
        _persist_agent_progress(instance_id, progress)
        result = {
            "text": plan_markdown,
            "content": plan_markdown,
            "profile": _normalize_profile(request.profile),
            "mode": run_mode,
            "model": _resolve_effective_model(request),
            "threadId": thread_id,
            "planningThreadId": planning_thread_id,
            "executionThreadId": execution_thread_id,
            "plannerStatus": planner_status,
            "plannerCheckpointId": planner_checkpoint_id,
            "sessionPersistence": session_persistence,
            "engineMetadata": engine_metadata,
            "sandboxName": (
                str(workflow_record.get("sandboxName") or "").strip()
                or (run_context.sandbox_name if run_context else None)
            ),
            "provider": (
                str(workflow_record.get("provider") or "").strip()
                or (run_context.sandbox_provider if run_context else None)
            ),
            "artifactRef": plan_artifact_ref,
            "plan": plan,
            "planMarkdown": plan_markdown,
            "planMetadata": plan_metadata,
            "toolCalls": [],
            "usageTotals": {},
            "fileChanges": [],
            "changeSummary": {
                "files": [],
                "stats": {"files": 0, "additions": 0, "deletions": 0},
                "changed": False,
            },
            "patch": "",
            "patchRef": None,
            "snapshotRefs": [],
            "verification": {
                "commands": plan.get("verificationCommands") or [],
                "status": (
                    "awaiting_approval"
                    if pending_approval
                    else "failed"
                    if planner_status == "rejected"
                    else "planned"
                ),
            },
            "agentWorkflowId": instance_id,
            "daprInstanceId": instance_id,
            "traceId": run_context.trace_id if run_context else None,
            "agentProgress": progress,
            "status": phase,
            "approvalEventName": approval_event_name if pending_approval else None,
            "approvalPayload": approval_payload if pending_approval else None,
            "runSummary": {
                "profile": _normalize_profile(request.profile),
                "mode": run_mode,
                "model": _resolve_effective_model(request),
                "cwd": cwd,
                "workspaceRef": request.workspaceRef,
                "toolGroup": _resolve_effective_tool_group(request),
                "engine": run_context.engine if run_context else _resolve_run_engine(request),
                "toolBackend": run_context.tool_backend if run_context else _resolve_tool_backend(request),
                "sandboxName": run_context.sandbox_name if run_context else None,
            },
        }
        _persist_run_artifact(instance_id, result)
        return result
    summary = summarize_command_changes(cwd)
    mutation_summary = _load_workspace_mutation(instance_id) or {}
    if not summary["changeSummary"]["changed"] and isinstance(
        mutation_summary.get("changeSummary"), dict
    ):
        summary = {
            "changeSummary": _merge_change_summaries(
                None,
                mutation_summary.get("changeSummary"),
            )
        }
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
    if not patch:
        patch = str(mutation_summary.get("patch") or "")
    result = {
        "text": text,
        "content": text,
        "profile": _normalize_profile(request.profile),
        "mode": run_mode,
        "model": _resolve_effective_model(request),
        "threadId": thread_id,
        "planningThreadId": planning_thread_id,
        "executionThreadId": execution_thread_id,
        "plannerStatus": planner_status,
        "plannerCheckpointId": planner_checkpoint_id,
        "sessionPersistence": session_persistence,
        "engineMetadata": engine_metadata,
        "sandboxName": (
            str(workflow_record.get("sandboxName") or "").strip()
            or (run_context.sandbox_name if run_context else None)
        ),
        "provider": (
            str(workflow_record.get("provider") or "").strip()
            or (run_context.sandbox_provider if run_context else None)
        ),
        "toolCalls": [],
        "usageTotals": {},
        "fileChanges": summary["changeSummary"]["files"],
        "changeSummary": summary["changeSummary"],
        "patch": patch,
        "patchRef": None,
        "artifactRef": request.artifactRef,
        "plan": request.planJson if isinstance(request.planJson, dict) else None,
        "snapshotRefs": [
            file_change.get("path")
            for file_change in summary["changeSummary"]["files"]
            if isinstance(file_change, dict) and str(file_change.get("path") or "").strip()
        ],
        "verification": {
            "commands": _parse_verify_commands(request.verifyCommands),
            "status": "requested" if request.verifyCommands else "not_requested",
        },
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "traceId": run_context.trace_id if run_context else None,
        "agentProgress": progress,
        "status": "completed",
        "runSummary": {
            "profile": _normalize_profile(request.profile),
            "mode": run_mode,
            "model": _resolve_effective_model(request),
            "cwd": cwd,
            "workspaceRef": request.workspaceRef,
            "toolGroup": _resolve_effective_tool_group(request),
            "engine": run_context.engine if run_context else _resolve_run_engine(request),
            "toolBackend": run_context.tool_backend if run_context else _resolve_tool_backend(request),
            "sandboxName": run_context.sandbox_name if run_context else None,
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


def _empty_change_summary() -> dict[str, Any]:
    return {
        "files": [],
        "stats": {"files": 0, "additions": 0, "deletions": 0},
        "changed": False,
    }


def _mutation_summary_key(instance_id: str) -> str:
    return f"mutation:{instance_id}"


def _merge_change_summaries(
    current: dict[str, Any] | None,
    incoming: dict[str, Any] | None,
) -> dict[str, Any]:
    merged_by_path: dict[str, dict[str, Any]] = {}
    for candidate in (current, incoming):
        if not isinstance(candidate, dict):
            continue
        for file_entry in candidate.get("files") or []:
            if not isinstance(file_entry, dict):
                continue
            path = str(file_entry.get("path") or "").strip()
            if not path:
                continue
            merged_by_path[path] = {
                "path": path,
                "additions": int(file_entry.get("additions") or 0),
                "deletions": int(file_entry.get("deletions") or 0),
                **(
                    {"status": str(file_entry.get("status"))}
                    if str(file_entry.get("status") or "").strip()
                    else {}
                ),
            }
    files = sorted(merged_by_path.values(), key=lambda item: str(item.get("path") or ""))
    additions = sum(int(item.get("additions") or 0) for item in files)
    deletions = sum(int(item.get("deletions") or 0) for item in files)
    return {
        "files": files,
        "stats": {"files": len(files), "additions": additions, "deletions": deletions},
        "changed": bool(files),
    }


def _persist_workspace_mutation(instance_id: str, summary: dict[str, Any]) -> None:
    incoming_change_summary = summary.get("changeSummary")
    incoming_patch = str(summary.get("patch") or "").strip()
    if not isinstance(incoming_change_summary, dict) and not incoming_patch:
        return
    existing = _load_workspace_mutation(instance_id) or {}
    merged_change_summary = _merge_change_summaries(
        existing.get("changeSummary") if isinstance(existing, dict) else None,
        incoming_change_summary if isinstance(incoming_change_summary, dict) else None,
    )
    patch_chunks = [
        str(chunk).strip()
        for chunk in [
            existing.get("patch") if isinstance(existing, dict) else "",
            incoming_patch,
        ]
        if chunk is not None and str(chunk).strip()
    ]
    deduped_patch_chunks: list[str] = []
    for chunk in patch_chunks:
        if chunk not in deduped_patch_chunks:
            deduped_patch_chunks.append(chunk)
    payload = {
        "changeSummary": merged_change_summary,
        "fileChanges": [
            str(file_entry.get("path") or "").strip()
            for file_entry in merged_change_summary.get("files") or []
            if str(file_entry.get("path") or "").strip()
        ],
        "patch": "\n".join(deduped_patch_chunks).strip(),
    }
    try:
        run_state_store.save(key=_mutation_summary_key(instance_id), value=payload)
    except StateStoreError as exc:
        logger.warning("Failed to persist workspace mutation summary %s: %s", instance_id, exc)


def _load_workspace_mutation(instance_id: str) -> dict[str, Any] | None:
    try:
        payload = run_state_store.load(key=_mutation_summary_key(instance_id), default={})
    except StateStoreError as exc:
        logger.warning("Failed to load workspace mutation summary %s: %s", instance_id, exc)
        return None
    return payload if payload else None


def _persist_run_artifact(instance_id: str, result: dict[str, Any]) -> None:
    context = _load_run_context(instance_id)
    if context is None or not context.execution_id:
        return
    change_summary = result.get("changeSummary")
    if not isinstance(change_summary, dict):
        change_summary = _empty_change_summary()
    artifact = {
        "changeSetId": _change_set_id_for_instance(instance_id),
        "executionId": context.execution_id,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "cwd": context.cwd,
        "workspaceRef": context.workspace_ref,
        "threadId": context.thread_id,
        "planningThreadId": context.planning_thread_id,
        "executionThreadId": context.execution_thread_id,
        "profile": context.profile,
        "patch": str(result.get("patch") or ""),
        "changeSummary": change_summary,
        "fileChanges": result.get("fileChanges") or [],
        "artifactRef": result.get("artifactRef"),
        "plannerStatus": result.get("plannerStatus"),
        "plannerCheckpointId": result.get("plannerCheckpointId"),
        "approvalPayload": result.get("approvalPayload"),
        "snapshotRefs": result.get("snapshotRefs") or [],
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


def _status_from_persisted_state(
    instance_id: str,
    *,
    run_context: AgentRunContext | None,
    progress: dict[str, Any] | None,
    artifact: dict[str, Any] | None,
) -> dict[str, Any]:
    normalized_status = str(
        (progress or {}).get("status")
        or ("completed" if artifact else "running" if run_context else "unknown")
    ).strip().lower()
    if normalized_status not in {
        "scheduled",
        "running",
        "completed",
        "failed",
        "terminated",
        "unknown",
    }:
        normalized_status = "running" if run_context else "unknown"

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

    serialized_output = json.dumps(artifact) if artifact else None
    resolved_trace_id = (
        progress.get("traceId")
        if isinstance(progress, dict)
        else None
    ) or (run_context.trace_id if run_context else None) or _trace_id_from_payload(artifact)
    if isinstance(progress, dict) and resolved_trace_id and not progress.get("traceId"):
        progress = {**progress, "traceId": resolved_trace_id}
        _persist_agent_progress(instance_id, progress)

    return {
        "instanceId": instance_id,
        "status": normalized_status,
        "runtimeStatus": "PERSISTED_STATE",
        "traceId": resolved_trace_id,
        "threadId": run_context.thread_id if run_context else None,
        "planningThreadId": run_context.planning_thread_id if run_context else None,
        "executionThreadId": run_context.execution_thread_id if run_context else None,
        "plannerStatus": artifact.get("plannerStatus") if isinstance(artifact, dict) else None,
        "plannerCheckpointId": artifact.get("plannerCheckpointId") if isinstance(artifact, dict) else None,
        "phase": progress.get("phase") if isinstance(progress, dict) else None,
        "approvalEventName": progress.get("approvalEventName") if isinstance(progress, dict) else None,
        "approvalPayload": artifact.get("approvalPayload") if isinstance(artifact, dict) else None,
        "agentProgress": progress,
        "serializedOutput": serialized_output,
    }


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
    planning_mode = _is_planning_mode(context.mode)
    return {
        "framework": context.engine,
        "status": status,
        "phase": (
            "queued"
            if status == "scheduled"
            else _progress_phase_for_mode(context.mode)
        ),
        "summary": None,
        "currentStepName": "plan" if planning_mode else context.profile,
        "completedSteps": None,
        "totalSteps": None,
        "currentIteration": 0,
        "maxIterations": context.max_turns,
        "activeToolName": None,
        "stopReason": None,
        "agentWorkflowId": context.instance_id,
        "daprInstanceId": context.instance_id,
        "traceId": context.trace_id,
        "approvalEventName": context.approval_event_name,
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


def _record_langgraph_progress_event(
    instance_id: str,
    run_context: AgentRunContext,
    *,
    phase: str,
    event: dict[str, Any],
) -> None:
    event_type = str(event.get("event") or "").strip().lower()
    if not event_type:
        return
    progress_phase = (
        "planning" if phase == "plan" else _progress_phase_for_mode(run_context.mode)
    )
    current_step = "plan" if phase == "plan" else "implement"
    existing_progress = _load_agent_progress(instance_id) or _default_agent_progress(
        run_context,
        status="running",
    )
    next_iteration = int(existing_progress.get("currentIteration") or 0)
    recent_turns = list(existing_progress.get("recentTurns") or [])

    if event_type == "model_start":
        next_iteration += 1
        recent_turns.append(
            {
                "label": "model",
                "summary": (
                    f"Planning iteration {next_iteration}"
                    if phase == "plan"
                    else f"Reasoning iteration {next_iteration}"
                ),
                "status": "running",
            }
        )
        _update_agent_progress(
            instance_id,
            phase=progress_phase,
            status="running",
            currentStepName=current_step,
            currentIteration=next_iteration,
            activeToolName=None,
            stopReason=None,
            summary=recent_turns[-1]["summary"],
            recentTurns=recent_turns,
        )
        return

    if event_type == "model_complete":
        recent_turns.append(
            {
                "label": "model",
                "summary": (
                    f"Completed planning iteration {next_iteration or 1}"
                    if phase == "plan"
                    else f"Completed reasoning iteration {next_iteration or 1}"
                ),
                "status": "completed",
            }
        )
        _update_agent_progress(
            instance_id,
            phase=progress_phase,
            status="running",
            currentStepName=current_step,
            currentIteration=next_iteration or 1,
            activeToolName=None,
            stopReason=None,
            summary=recent_turns[-1]["summary"],
            recentTurns=recent_turns,
        )
        return

    tool_name = str(event.get("toolName") or "tool").strip() or "tool"
    if event_type == "tool_start":
        recent_turns.append(
            {
                "label": tool_name,
                "summary": f"Running {tool_name}",
                "status": "running",
            }
        )
        _update_agent_progress(
            instance_id,
            phase=progress_phase,
            status="running",
            currentStepName=current_step,
            currentIteration=next_iteration,
            activeToolName=tool_name,
            stopReason=None,
            summary=f"Running tool {tool_name}",
            recentTurns=recent_turns,
        )
        return

    if event_type == "tool_complete":
        tool_status = str(event.get("status") or "completed").strip().lower()
        status_label = "completed" if tool_status == "completed" else tool_status
        recent_turns.append(
            {
                "label": tool_name,
                "summary": f"{status_label.replace('_', ' ').capitalize()} {tool_name}",
                "status": "completed" if tool_status == "completed" else "running",
            }
        )
        _update_agent_progress(
            instance_id,
            phase=progress_phase,
            status="running",
            currentStepName=current_step,
            currentIteration=next_iteration,
            activeToolName=None,
            stopReason=None,
            summary=recent_turns[-1]["summary"],
            recentTurns=recent_turns,
        )
        return

    if event_type == "tool_error":
        message = str(event.get("error") or "").strip()
        recent_turns.append(
            {
                "label": tool_name,
                "summary": f"Failed {tool_name}",
                "status": "failed",
            }
        )
        _update_agent_progress(
            instance_id,
            phase=progress_phase,
            status="running",
            currentStepName=current_step,
            currentIteration=next_iteration,
            activeToolName=None,
            stopReason=None,
            summary=message or f"Failed tool {tool_name}",
            recentTurns=recent_turns,
        )


def _resolve_request_cwd(request: DaprAgentRunRequest) -> str:
    if request.cwd:
        return _resolve_cwd(request.cwd)
    if request.workspaceRef:
        session = _workspace_from_ref(request.workspaceRef)
        return str(session.working_directory or session.root_path)
    return _resolve_cwd(None)


def _resolve_tool_backend(request: DaprAgentRunRequest) -> str | None:
    value = str(request.toolBackend or "").strip().lower()
    if value in {"openshell", "local"}:
        return value
    return None


class CodingDurableAgent(DurableAgent):
    def _apply_config_update(self, key: str, value: Any) -> None:
        normalized_key = key.lower().replace("-", "_")
        if normalized_key in {RuntimeConfigKey.LLM_MODEL, RuntimeConfigKey.LLM_PROVIDER}:
            logger.info(
                'Agent %s applying config update: %s="%s"', self.name, key, value
            )
            coerced_value = str(value).strip()
            if not coerced_value:
                logger.warning(
                    "Agent %s: invalid empty value for key '%s'. Skipping update.",
                    self.name,
                    key,
                )
                return
            if normalized_key == RuntimeConfigKey.LLM_PROVIDER:
                provider_value = coerced_value.lower()
                object.__setattr__(self, "_runtime_llm_provider", provider_value)
                if not isinstance(self.llm, DaprChatClient):
                    try:
                        setattr(self.llm, "provider", provider_value)
                    except Exception:
                        logger.debug(
                            "Agent %s could not apply provider update to llm client",
                            self.name,
                        )
            else:
                object.__setattr__(self, "_runtime_llm_model", coerced_value)
                if not isinstance(self.llm, DaprChatClient):
                    try:
                        setattr(self.llm, "model", coerced_value)
                    except Exception:
                        logger.debug(
                            "Agent %s could not apply model update to llm client",
                            self.name,
                        )
            self._fire_config_change_callbacks(normalized_key, coerced_value)
            self._sync_metadata_after_config_update()
            return
        super()._apply_config_update(key, value)

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

    def call_llm(
        self,
        ctx: wf.WorkflowActivityContext,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        instance_id = str(payload.get("instance_id") or "")
        run_context = _load_run_context(instance_id)
        if run_context is not None:
            existing_progress = _load_agent_progress(instance_id) or _default_agent_progress(
                run_context,
                status="running",
            )
            next_iteration = int(existing_progress.get("currentIteration") or 0) + 1
            _update_agent_progress(
                instance_id,
                phase=_progress_phase_for_mode(run_context.mode),
                status="running",
                currentIteration=next_iteration,
                activeToolName=None,
                summary=(
                    f"Planning iteration {next_iteration}"
                    if _is_planning_mode(run_context.mode)
                    else f"Reasoning iteration {next_iteration}"
                ),
            )
        return super().call_llm(ctx, payload)

    def run_tool(self, ctx: wf.WorkflowActivityContext, payload: dict[str, Any]) -> dict[str, Any]:
        tool_call = payload.get("tool_call", {})
        fn_name = tool_call["function"]["name"]
        raw_args = tool_call["function"].get("arguments", "")

        instance_id = str(payload.get("instance_id") or "")
        run_context = _load_run_context(instance_id)
        if run_context is None:
            raise AgentError(f"Missing durable run context for {instance_id}")

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
        try:
            args = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError as exc:
            recent_turns[-1] = {
                "label": fn_name,
                "summary": f"Failed {fn_name}: invalid JSON arguments",
                "status": "failed",
            }
            _update_agent_progress(
                instance_id,
                phase=_progress_phase_for_mode(run_context.mode),
                status="running",
                activeToolName=None,
                summary=f"Failed tool {fn_name}",
                recentTurns=recent_turns,
            )
            raise AgentError(f"Invalid JSON in tool args: {exc}") from exc

        verify_commands = set(run_context.verify_commands or [])
        command = str(args.get("command") or "").strip()
        tool_phase = _progress_phase_for_mode(
            run_context.mode,
            step="verify" if command and command in verify_commands else "active",
        )
        _update_agent_progress(
            instance_id,
            phase=tool_phase,
            status="running",
            currentIteration=next_iteration,
            activeToolName=fn_name,
            summary=f"Running tool {fn_name}",
            recentTurns=recent_turns,
        )

        allowed_names = {
            getattr(tool, "name", None) or getattr(tool, "__name__", "")
            for tool in resolve_tool_group(run_context.tool_group)
        }
        if fn_name not in allowed_names:
            recent_turns[-1] = {
                "label": fn_name,
                "summary": f"Rejected {fn_name}: not allowed for {run_context.tool_group}",
                "status": "failed",
            }
            _update_agent_progress(
                instance_id,
                phase=_progress_phase_for_mode(run_context.mode),
                status="running",
                activeToolName=None,
                summary=f"Rejected tool {fn_name}",
                recentTurns=recent_turns,
            )
            raise AgentError(
                f"Tool '{fn_name}' is not allowed for tool group '{run_context.tool_group}'"
            )

        tool_summary: dict[str, Any] = {}

        async def _execute_tool() -> Any:
            tool_context = ToolRuntimeContext.from_workspace_root(run_context.cwd)
            token = push_tool_context(tool_context)
            try:
                result = await self.tool_executor.run_tool(
                    fn_name,
                    **args,
                )
                tool_summary.update(tool_context.build_summary())
                return result
            finally:
                pop_tool_context(token)

        try:
            result = self._run_asyncio_task(_execute_tool())
        except Exception:
            recent_turns[-1] = {
                "label": fn_name,
                "summary": f"Failed {fn_name}",
                "status": "failed",
            }
            _update_agent_progress(
                instance_id,
                phase=_progress_phase_for_mode(run_context.mode),
                status="running",
                activeToolName=None,
                summary=f"Failed tool {fn_name}",
                recentTurns=recent_turns,
            )
            raise
        if isinstance(result, dict) and isinstance(tool_summary, dict):
            if (
                str(tool_summary.get("patch") or "").strip()
                or (
                    isinstance(tool_summary.get("changeSummary"), dict)
                    and bool(tool_summary["changeSummary"].get("changed"))
                )
            ):
                _persist_workspace_mutation(instance_id, tool_summary)
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
            phase=_progress_phase_for_mode(run_context.mode),
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
        "langgraph": build_langgraph_capabilities(),
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
                model=_effective_default_model(),
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
                llm=_build_llm_client(_effective_default_model(), None),
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
                    model=_effective_default_model(),
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
    normalized_mode = _normalize_run_mode(request.mode or request.profile)
    artifact_ref = str(request.artifactRef or "").strip() or None
    if artifact_ref is None and _is_planning_mode(normalized_mode):
        artifact_ref = f"plan_{instance_id}"
    planning_thread_id = _resolve_langgraph_planning_thread_id(
        instance_id=instance_id,
        request=request,
        execution_id=execution_id,
        artifact_ref=artifact_ref,
    )
    execution_thread_id = _resolve_langgraph_execution_thread_id(
        instance_id=instance_id,
        request=request,
        execution_id=execution_id,
        artifact_ref=artifact_ref,
    )
    thread_id = (
        planning_thread_id
        if _is_planning_mode(normalized_mode)
        else execution_thread_id
    )
    workspace_session = (
        _workspace_from_ref(request.workspaceRef) if request.workspaceRef else None
    )
    repository_url = (
        str(request.repositoryUrl or "").strip()
        or (workspace_session.repository_url if workspace_session else None)
    )
    repository_owner = (
        str(request.repositoryOwner or "").strip()
        or (workspace_session.repository_owner if workspace_session else None)
    )
    repository_repo = (
        str(request.repositoryRepo or "").strip()
        or (workspace_session.repository_repo if workspace_session else None)
    )
    repository_branch = (
        str(request.repositoryBranch or "").strip()
        or (workspace_session.repository_branch if workspace_session else None)
    )
    tool_backend = _resolve_tool_backend(request)
    sandbox_name = str(request.sandboxName or "").strip() or None
    if tool_backend == "openshell" and not sandbox_name:
        sandbox_name = f"openshell-lg-{instance_id}".lower().replace("_", "-")[:63]
    sandbox_repo_path = str(request.sandboxRepoPath or "").strip() or None
    if tool_backend == "openshell" and not sandbox_repo_path:
        sandbox_repo_path = "/sandbox/repo"
    return AgentRunContext(
        instance_id=instance_id,
        mode=normalized_mode,
        profile=_normalize_profile(request.profile),
        model=_resolve_effective_model(request),
        engine=_resolve_run_engine(request),
        tool_backend=tool_backend,
        cwd=_resolve_request_cwd(request),
        tool_group=_resolve_effective_tool_group(request),
        max_turns=request.maxTurns,
        sandbox_name=sandbox_name,
        sandbox_provider=str(request.provider or "").strip() or None,
        sandbox_repo_path=sandbox_repo_path,
        repository_url=repository_url or None,
        repository_owner=repository_owner or None,
        repository_repo=repository_repo or None,
        repository_branch=repository_branch or None,
        repository_token=str(request.repositoryToken or "").strip() or None,
        execute_after_approval=_coerce_bool(request.executeAfterApproval, True),
        approval_event_name=(
            _approval_event_name(instance_id) if _is_planning_mode(normalized_mode) else None
        ),
        execution_id=execution_id,
        workspace_ref=request.workspaceRef,
        thread_id=thread_id,
        planning_thread_id=planning_thread_id,
        execution_thread_id=execution_thread_id,
        trace_id=trace_id,
        artifact_ref=artifact_ref,
        verify_commands=_parse_verify_commands(request.verifyCommands) or None,
    )


def _build_run_agent(run_context: AgentRunContext) -> CodingDurableAgent:
    support = _build_durable_support_configs()
    tool_choice = (
        str(_effective_runtime_config_value(RuntimeConfigKey.TOOL_CHOICE, "auto") or "auto").strip()
        or "auto"
    )
    return CodingDurableAgent(
        name=_build_agent_name(),
        role="autonomous coding agent",
        goal="Complete coding tasks in a durable, tool-using workflow",
        instructions=[
            "Use the available tools to inspect, edit, and verify code.",
            "When changing code, keep edits minimal and explain what changed.",
            "Prefer deterministic verification commands when they are provided.",
            "Respect the profile, workspace, and tool policy passed in the task.",
        ],
        llm=_build_llm_client(run_context.model, None),
        tools=resolve_tool_group(run_context.tool_group),
        execution=AgentExecutionConfig(
            max_iterations=max(run_context.max_turns, 1),
            tool_choice=tool_choice,
        ),
        state=support["state"],
        memory=support["memory"],
        registry=support["registry"],
        retry_policy=support["retry_policy"],
        agent_observability=support["observability"],
        agent_metadata=_build_agent_registry_metadata(model=run_context.model),
        runtime=runtime,
    )


def _resolve_runner_workflow_client() -> Any:
    candidate = getattr(runner, "workflow_client", None)
    if callable(candidate):
        return candidate()
    return candidate


def _workflow_client_for_runs() -> Any:
    return _resolve_runner_workflow_client() or workflow_client


def _workflow_input_for_request(
    request: DaprAgentRunRequest,
    *,
    trace_id: str | None,
) -> dict[str, Any]:
    payload = request.model_dump(exclude_none=True)
    carrier = (
        dict(payload.get("_otel") or {})
        if isinstance(payload.get("_otel"), dict)
        else {}
    )
    if not carrier.get("traceparent"):
        generated = _generate_trace_context()
        if trace_id:
            generated["traceId"] = trace_id
            generated["traceparent"] = (
                f"00-{trace_id}-{generated['traceparent'].split('-')[2]}-01"
            )
        carrier.update(generated)
    if trace_id:
        payload["traceId"] = trace_id
        carrier["traceId"] = trace_id
    payload["_otel"] = carrier
    return payload


def _schedule_workflow_run(
    request: DaprAgentRunRequest,
    *,
    instance_id: str,
    trace_id: str | None,
) -> None:
    client = _workflow_client_for_runs()
    client.schedule_new_workflow(
        dapr_agent_workflow,
        input=_workflow_input_for_request(request, trace_id=trace_id),
        instance_id=instance_id,
    )


def _wait_for_terminal_workflow_result(
    instance_id: str,
    *,
    timeout_seconds: int,
    return_on_approval: bool = False,
) -> dict[str, Any]:
    client = _workflow_client_for_runs()
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state = client.get_workflow_state(instance_id, fetch_payloads=True)
        runtime_status = getattr(getattr(state, "runtime_status", None), "name", "UNKNOWN")
        normalized = str(runtime_status).lower()
        progress = _load_agent_progress(instance_id) or {}
        artifact = _load_run_artifact(instance_id) or {}
        if return_on_approval and str(progress.get("phase") or "").strip().lower() == "awaiting_approval":
            return {
                "status": "awaiting_approval",
                "payload": artifact
                or {
                    "success": True,
                    "agentWorkflowId": instance_id,
                    "daprInstanceId": instance_id,
                    "traceId": progress.get("traceId"),
                    "agentProgress": progress,
                    "status": "awaiting_approval",
                    "approvalEventName": progress.get("approvalEventName"),
                },
            }
        if normalized in {"completed", "failed", "terminated"}:
            parsed_output = _parse_serialized_output(getattr(state, "serialized_output", None))
            if isinstance(parsed_output, dict):
                return {
                    "status": normalized,
                    "payload": parsed_output,
                }
            return {
                "status": normalized,
                "payload": {
                    "success": normalized == "completed",
                    "agentWorkflowId": instance_id,
                    "daprInstanceId": instance_id,
                    "traceId": progress.get("traceId"),
                    "agentProgress": progress,
                    "result": artifact,
                },
            }
        time.sleep(1)
    raise HTTPException(status_code=504, detail=f"Timed out waiting for workflow {instance_id}")


def _normalize_run_request(input_data: dict[str, Any] | str | None) -> DaprAgentRunRequest:
    if isinstance(input_data, str):
        return DaprAgentRunRequest(
            prompt=input_data,
            model=_effective_default_model(),
            mode=EXECUTE_MODE,
        )
    payload = dict(input_data or {})
    prompt = str(payload.get("prompt") or payload.get("goal") or payload.get("task") or "").strip()
    payload["prompt"] = prompt
    payload["model"] = str(payload.get("model") or "").strip() or _effective_default_model()
    payload["mode"] = _normalize_run_mode(
        payload.get("mode") or payload.get("profile")
    )
    return DaprAgentRunRequest.model_validate(payload)


def _langgraph_phase_prompt(
    request: DaprAgentRunRequest,
    *,
    phase: str,
) -> str:
    if phase == "plan":
        return _build_task_prompt(
            request.model_copy(
                update={
                    "mode": FEATURE_DELIVERY_PLAN_MODE,
                }
            )
        )
    if phase == "verify":
        commands = _parse_verify_commands(request.verifyCommands)
        return "\n\n".join(
            segment
            for segment in [
                f"Task:\n{request.prompt}",
                (
                    "Approved plan JSON:\n"
                    f"{json.dumps(request.planJson, indent=2, default=str)}"
                    if request.planJson
                    else ""
                ),
                (
                    "Verification commands:\n" + "\n".join(commands)
                    if commands
                    else ""
                ),
                "Summarize the completed work and verification outcome.",
            ]
            if segment
        )
    return _build_task_prompt(
        request.model_copy(
            update={
                "mode": FEATURE_DELIVERY_EXECUTE_MODE,
            }
        )
    )


def _run_langgraph_phase(
    *,
    request: DaprAgentRunRequest,
    instance_id: str,
    phase: str,
) -> dict[str, Any]:
    run_context = _load_run_context(instance_id) or _build_run_context(instance_id, request)
    phase_thread_id = (
        run_context.planning_thread_id
        if phase == "plan"
        else run_context.execution_thread_id
    )
    result = run_langgraph_task(
        prompt=_langgraph_phase_prompt(request, phase=phase),
        workspace_root=run_context.cwd,
        tool_group=("planning" if phase == "plan" else run_context.tool_group),
        model=run_context.model,
        profile=run_context.profile,
        phase=phase,
        thread_id=phase_thread_id,
        planner_resume=request.plannerResume if phase == "plan" else None,
        require_review=(
            bool(run_context.execute_after_approval) if phase == "plan" else False
        ),
        api_key=request.openAIApiKey,
        progress_callback=lambda event: _record_langgraph_progress_event(
            instance_id,
            run_context,
            phase=phase,
            event=event,
        ),
        openshell_config=(
            {
                "sandboxName": run_context.sandbox_name,
                "provider": run_context.sandbox_provider,
                "repoUrl": run_context.repository_url,
                "repoBranch": run_context.repository_branch,
                "repoToken": run_context.repository_token,
                "repoPath": run_context.sandbox_repo_path,
            }
            if run_context.tool_backend == "openshell"
            else None
        ),
    )
    if result.tool_summary.get("changeSummary") or result.tool_summary.get("patch"):
        _persist_workspace_mutation(instance_id, result.tool_summary)
    payload: dict[str, Any] = {
        "content": result.text,
        "text": result.text,
        "engine": LANGGRAPH_ENGINE_NAME,
        "engineMetadata": result.metadata,
        "threadId": phase_thread_id,
        "planningThreadId": run_context.planning_thread_id,
        "executionThreadId": run_context.execution_thread_id,
        "sandboxName": run_context.sandbox_name,
        "provider": run_context.sandbox_provider,
        "plannerStatus": result.metadata.get("plannerStatus"),
        "plannerCheckpointId": result.metadata.get("plannerCheckpointId"),
        "sessionPersistence": result.metadata.get("sessionPersistence"),
    }
    if result.structured_output:
        payload["structured"] = result.structured_output
    if phase == "plan":
        payload["plan"] = result.structured_output or _extract_json_block(result.text) or {}
        payload["planMarkdown"] = result.text
        payload["status"] = (
            "awaiting_approval" if result.metadata.get("resumable") else result.metadata.get("plannerStatus") or "planned"
        )
        if isinstance(result.metadata.get("approvalPayload"), dict):
            payload["approvalPayload"] = result.metadata.get("approvalPayload")
    else:
        payload["status"] = "completed"
    return payload


@runtime.activity(name=PLAN_ACTIVITY_NAME)
def langgraph_plan_activity(_ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    request = _normalize_run_request(payload)
    return _run_langgraph_phase(
        request=request,
        instance_id=str(payload.get("instanceId") or ""),
        phase="plan",
    )


@runtime.activity(name=EXECUTE_ACTIVITY_NAME)
def langgraph_execute_activity(_ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    request = _normalize_run_request(payload)
    return _run_langgraph_phase(
        request=request,
        instance_id=str(payload.get("instanceId") or ""),
        phase="execute",
    )


@runtime.workflow(name=WORKFLOW_NAME)
def dapr_agent_workflow(ctx: wf.DaprWorkflowContext, input_data: dict[str, Any] | str) -> dict[str, Any]:
    trace_id = (
        _trace_id_from_otel(input_data.get("_otel"))
        if isinstance(input_data, dict)
        else None
    ) or _trace_id_from_payload(input_data) or _current_trace_id()
    workflow_context_key = f"__workflow_context_{ctx.instance_id}__"
    workflow_context_carrier = _workflow_context_carrier(
        ctx.instance_id,
        input_data,
        trace_id,
    )
    store_workflow_context(workflow_context_key, workflow_context_carrier)
    store_workflow_context("__current_workflow_context__", workflow_context_carrier)
    request = _normalize_run_request(input_data)
    instance_id = ctx.instance_id
    run_context = _build_run_context(instance_id, request, trace_id=trace_id)
    if not ctx.is_replaying:
        _persist_run_context(run_context)
        _persist_agent_progress(
            instance_id,
            _default_agent_progress(run_context, status="running"),
        )
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
            "model": run_context.model,
            "workspaceRef": run_context.workspace_ref,
        }
    )
    try:
        if run_context.engine == LANGGRAPH_ENGINE_NAME:
            if not ctx.is_replaying:
                _update_agent_progress(
                    instance_id,
                    phase="planning" if _is_planning_mode(run_context.mode) else "implementing",
                    summary=(
                        "Generating implementation plan with LangGraph"
                        if _is_planning_mode(run_context.mode)
                        else f"Starting {run_context.profile} run with LangGraph"
                    ),
                    currentStepName="plan" if _is_planning_mode(run_context.mode) else run_context.profile,
                )
            workflow_payload = {
                **normalized_request.model_dump(exclude_none=True),
                "instanceId": instance_id,
            }
            if _is_planning_mode(run_context.mode):
                planning_result = yield ctx.call_activity(
                    langgraph_plan_activity,
                    input=workflow_payload,
                )
                pending_approval = False
                plan_payload: dict[str, Any] | None = None
                while True:
                    pending_approval = (
                        str(planning_result.get("status") or "").strip().lower()
                        == "awaiting_approval"
                    )
                    plan_payload = _build_result_payload(
                        instance_id=instance_id,
                        request=normalized_request,
                        workflow_output=planning_result,
                        pending_approval=pending_approval,
                    )
                    if not pending_approval:
                        break
                    if not ctx.is_replaying:
                        _update_agent_progress(
                            instance_id,
                            phase="awaiting_approval",
                            status="running",
                            summary="Plan ready for approval",
                            currentStepName="approval",
                            stopReason="awaiting approval",
                        )
                    approval_event = ctx.wait_for_external_event(run_context.approval_event_name)
                    timeout_wait = ctx.create_timer(
                        timedelta(minutes=max(request.approvalTimeoutMinutes, 1))
                    )
                    completed_task = yield wf.when_any([approval_event, timeout_wait])
                    if completed_task == timeout_wait:
                        _update_agent_progress(
                            instance_id,
                            phase="failed",
                            status="failed",
                            summary="Plan approval timed out",
                            currentStepName="approval",
                            stopReason="approval timeout",
                        )
                        return {
                            **plan_payload,
                            "success": False,
                            "status": "failed",
                            "error": f"Plan approval timed out after {request.approvalTimeoutMinutes} minutes",
                        }
                    approval_result = approval_event.get_result() or {}
                    planner_resume = (
                        dict(approval_result)
                        if isinstance(approval_result, dict)
                        else {"approved": False, "reason": "Plan was rejected"}
                    )
                    if not str(planner_resume.get("action") or "").strip():
                        planner_resume["action"] = (
                            "approve" if bool(planner_resume.get("approved", False)) else "reject"
                        )
                    planning_result = yield ctx.call_activity(
                        langgraph_plan_activity,
                        input={
                            **workflow_payload,
                            "plannerResume": planner_resume,
                        },
                    )
                    if str(planning_result.get("status") or "").strip().lower() == "rejected":
                        plan_payload = _build_result_payload(
                            instance_id=instance_id,
                            request=normalized_request,
                            workflow_output=planning_result,
                            pending_approval=False,
                        )
                        reason = (
                            planner_resume.get("reason")
                            if isinstance(planner_resume, dict)
                            else None
                        ) or "Plan was rejected"
                        _update_agent_progress(
                            instance_id,
                            phase="failed",
                            status="failed",
                            summary=reason,
                            currentStepName="approval",
                            stopReason="plan rejected",
                        )
                        return {
                            **plan_payload,
                            "success": False,
                            "status": "rejected",
                            "approval": planner_resume,
                            "error": reason,
                        }
                if plan_payload is None:
                    raise RuntimeError("LangGraph planning did not return a result payload")
                if not bool(run_context.execute_after_approval):
                    return plan_payload
                normalized_request = normalized_request.model_copy(
                    update={
                        "mode": FEATURE_DELIVERY_EXECUTE_MODE,
                        "artifactRef": plan_payload.get("artifactRef"),
                        "planJson": plan_payload.get("plan"),
                    }
                )
                if not ctx.is_replaying:
                    _update_agent_progress(
                        instance_id,
                        phase="implementing",
                        status="running",
                        summary="Plan approved. Executing with LangGraph",
                        currentStepName="execute",
                        stopReason=None,
                    )
            execute_result = yield ctx.call_activity(
                langgraph_execute_activity,
                input={
                    **normalized_request.model_dump(exclude_none=True),
                    "instanceId": instance_id,
                },
            )
            return _build_result_payload(
                instance_id=instance_id,
                request=normalized_request,
                workflow_output=execute_result,
            )
        agent_result = yield from _build_run_agent(run_context).agent_workflow(
            ctx,
            {"task": _build_task_prompt(normalized_request)},
        )
        return _build_result_payload(
            instance_id=instance_id,
            request=normalized_request,
            workflow_output=agent_result,
        )
    finally:
        cleanup_workflow_context(workflow_context_key)
        cleanup_workflow_context("__current_workflow_context__")


async def _run_agent_request(
    request: DaprAgentRunRequest,
    *,
    instance_id: str,
    wait: bool,
    trace_id: str | None = None,
) -> dict[str, Any] | str | None:
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
            "model": run_context.model,
            "workspaceRef": run_context.workspace_ref,
        }
    )
    _schedule_workflow_run(
        normalized_request,
        instance_id=instance_id,
        trace_id=trace_id,
    )
    if not wait:
        return instance_id
    terminal = _wait_for_terminal_workflow_result(
        instance_id,
        timeout_seconds=normalized_request.timeoutMinutes * 60,
        return_on_approval=_is_planning_mode(normalized_request.mode),
    )
    return terminal["payload"]


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
        global _agent_subscribed, runtime_config_poll_thread
        agent = _get_agent()
        if not _agent_subscribed:
            runner.subscribe(agent)
            _agent_subscribed = True
        _apply_runtime_config_items(_fetch_runtime_config_items())
        runtime_config_poll_stop.clear()
        if runtime_config_poll_thread is None or not runtime_config_poll_thread.is_alive():
            runtime_config_poll_thread = threading.Thread(
                target=_runtime_config_poll_loop,
                args=(runtime_config_poll_stop,),
                name="runtime-config-poller",
                daemon=True,
            )
            runtime_config_poll_thread.start()
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to eagerly initialize dapr-agent runtime: %s", exc)
    try:
        yield
    finally:
        runtime_config_poll_stop.set()
        if runtime_config_poll_thread is not None:
            runtime_config_poll_thread.join(timeout=2)
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
            "langgraph",
            "deep-agents",
            "workspace-tools",
            "persistent-memory",
            "state-store-backed-sessions",
            "agent-registry",
        ],
        "registeredWorkflows": [_workflow_descriptor(WORKFLOW_NAME)],
        "registeredActivities": [
            _activity_descriptor(PLAN_ACTIVITY_NAME),
            _activity_descriptor(EXECUTE_ACTIVITY_NAME),
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
            "modes": [
                FEATURE_DELIVERY_PLAN_MODE,
                FEATURE_DELIVERY_EXECUTE_MODE,
                EXECUTE_MODE,
            ],
            "workspaceTools": WORKSPACE_ENABLED_TOOLS,
            "toolGroups": list(TOOL_GROUPS.keys()),
            "langgraph": build_langgraph_capabilities(),
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
            "defaultModel": _effective_default_model(),
            "instrumentationEnabled": ENABLE_DAPR_AGENTS_INSTRUMENTATION,
            "workspaceBindings": sum(len(refs) for refs in sessions_by_execution.values()),
            "langgraph": build_langgraph_capabilities(),
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
        workflow_output = asyncio.run(
            _run_agent_request(
                request,
                instance_id=instance_id,
                wait=True,
                trace_id=trace_id,
            )
        )
        if isinstance(workflow_output, dict):
            output_status = str(workflow_output.get("status") or "").strip().lower()
            return {
                "success": bool(workflow_output.get("success", output_status in {"completed", "planned", "awaiting_approval"})),
                "result": workflow_output,
                **workflow_output,
            }
        normalized_request = request.model_copy(
            update={
                "cwd": _resolve_request_cwd(request),
                "profile": _normalize_profile(request.profile),
                "model": _resolve_effective_model(request),
            }
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
    run_context = _load_run_context(instance_id)
    return {
        "success": True,
        "status": "running",
        "workflow_id": instance_id,
        "workflowId": instance_id,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "threadId": run_context.thread_id if run_context else None,
        "planningThreadId": run_context.planning_thread_id if run_context else None,
        "executionThreadId": run_context.execution_thread_id if run_context else None,
        "traceId": trace_id,
        "agentProgress": _load_agent_progress(instance_id),
        "status_url": f"/api/run/{instance_id}",
    }


@app.get("/api/run/{instance_id}")
def api_run_status(instance_id: str) -> dict[str, Any]:
    workflow_client_instance = _resolve_runner_workflow_client()
    run_context = _load_run_context(instance_id)
    progress = _load_agent_progress(instance_id)
    artifact = _load_run_artifact(instance_id)

    state = None
    runtime_status = "UNKNOWN"
    serialized_output = None
    if workflow_client_instance is not None:
        try:
            state = workflow_client_instance.get_workflow_state(instance_id, fetch_payloads=True)
            runtime_status = getattr(getattr(state, "runtime_status", None), "name", "UNKNOWN")
            serialized_output = getattr(state, "serialized_output", None)
        except Exception as exc:
            logger.warning(
                "Failed to fetch workflow state for %s, falling back to persisted state: %s",
                instance_id,
                exc,
            )

    if state is None:
        if run_context is None and progress is None and artifact is None:
            if workflow_client_instance is None:
                raise HTTPException(status_code=503, detail="Workflow client unavailable")
            raise HTTPException(status_code=404, detail="Run not found")
        return _status_from_persisted_state(
            instance_id,
            run_context=run_context,
            progress=progress,
            artifact=artifact,
        )

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
        "threadId": run_context.thread_id if run_context else None,
        "planningThreadId": run_context.planning_thread_id if run_context else None,
        "executionThreadId": run_context.execution_thread_id if run_context else None,
        "plannerStatus": artifact.get("plannerStatus") if isinstance(artifact, dict) else None,
        "plannerCheckpointId": artifact.get("plannerCheckpointId") if isinstance(artifact, dict) else None,
        "phase": progress.get("phase") if isinstance(progress, dict) else None,
        "approvalEventName": progress.get("approvalEventName") if isinstance(progress, dict) else None,
        "approvalPayload": artifact.get("approvalPayload") if isinstance(artifact, dict) else None,
        "agentProgress": progress,
        "serializedOutput": serialized_output,
    }


@app.post("/api/run/{instance_id}/approve")
def api_run_approve(instance_id: str, request: ApproveRequest) -> dict[str, Any]:
    run_context = _load_run_context(instance_id)
    if run_context is None or not run_context.approval_event_name:
        raise HTTPException(status_code=404, detail="Approval-capable run not found")
    client = _workflow_client_for_runs()
    approval_payload = dict(request.payload or {})
    action = str(request.action or "").strip().lower()
    if action not in {"approve", "reject", "edit"}:
        action = "approve" if request.approved else "reject"
    approval_payload.update(
        {
            "action": action,
            "approved": request.approved if action != "edit" else approval_payload.get("approved"),
            "reason": request.reason or approval_payload.get("reason"),
            "approvedBy": request.approvedBy or approval_payload.get("approvedBy") or "api",
            "respondedBy": request.approvedBy or approval_payload.get("respondedBy") or "api",
        }
    )
    client.raise_workflow_event(
        instance_id=instance_id,
        event_name=run_context.approval_event_name,
        data=approval_payload,
    )
    action = str(approval_payload.get("action") or "").strip().lower()
    _update_agent_progress(
        instance_id,
        phase=(
            "planning"
            if action == "edit"
            else "implementing"
            if request.approved and run_context.execute_after_approval
            else "completed"
        ),
        status=(
            "running"
            if action in {"approve", "edit"} and run_context.execute_after_approval
            else "failed"
        ),
        summary=(
            "Planner resume requested"
            if action == "edit"
            else "Approval received"
            if request.approved
            else (request.reason or "Plan rejected")
        ),
        currentStepName="approval",
        stopReason=None if action in {"approve", "edit"} else "plan rejected",
    )
    return {
        "success": True,
        "instanceId": instance_id,
        "approvalEventName": run_context.approval_event_name,
        "approval": approval_payload,
    }


@app.post("/api/run/{instance_id}/terminate")
def api_run_terminate(instance_id: str, request: TerminateRequest) -> dict[str, Any]:
    client = _workflow_client_for_runs()
    client.terminate_workflow(instance_id, output=request.reason or "terminated")
    _update_agent_progress(
        instance_id,
        status="terminated",
        phase="failed",
        activeToolName=None,
        stopReason=request.reason or "terminated",
        summary=request.reason or "terminated",
    )
    if request.cleanupWorkspace:
        if request.workspaceRef:
            workspace_cleanup(
                WorkspaceCleanupRequest(workspaceRef=request.workspaceRef)
            )
        elif request.parentExecutionId:
            workspace_cleanup(
                WorkspaceCleanupRequest(executionId=request.parentExecutionId)
            )
    return {"success": True, "instanceId": instance_id, "terminated": True}


@app.post("/execute")
def execute_step(request: ExecuteRequest) -> dict[str, Any]:
    step = request.step.strip().lower()
    if step != "run":
        return {"success": False, "error": f"Unsupported step: {request.step}"}
    run_request = DaprAgentRunRequest(
        prompt=str(request.input.get("prompt") or request.input.get("goal") or "").strip(),
        mode=str(request.input.get("mode") or "").strip() or None,
        engine=str(request.input.get("engine") or "").strip() or None,
        threadId=str(request.input.get("threadId") or "").strip() or None,
        planningThreadId=str(request.input.get("planningThreadId") or "").strip() or None,
        executionThreadId=str(request.input.get("executionThreadId") or "").strip() or None,
        plannerResume=request.input.get("plannerResume")
        if isinstance(request.input.get("plannerResume"), dict)
        else None,
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
        approvalTimeoutMinutes=int(
            request.input.get("approvalTimeoutMinutes") or DEFAULT_APPROVAL_TIMEOUT_MINUTES
        ),
        executeAfterApproval=_coerce_bool(
            request.input.get("executeAfterApproval"),
            True,
        ),
        toolPolicy=str(request.input.get("toolPolicy") or "").strip() or None,
        writePolicy=str(request.input.get("writePolicy") or "").strip() or None,
        shellPolicy=str(request.input.get("shellPolicy") or "").strip() or None,
        artifactRef=str(request.input.get("artifactRef") or "").strip() or None,
        planJson=request.input.get("planJson")
        if isinstance(request.input.get("planJson"), dict)
        else None,
        openAIApiKey=_extract_openai_api_key(request.credentials),
    )
    payload = api_run(run_request)
    return {"success": True, "data": payload, "duration_ms": 0}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
