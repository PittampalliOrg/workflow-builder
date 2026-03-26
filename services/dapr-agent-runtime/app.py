from __future__ import annotations

import base64
import asyncio
import json
import logging
import os
import shlex
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any
import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from tools import (
    DEFAULT_WORKSPACE_ROOT,
    _run_git_completed,
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
    OpenShellToolContext,
    build_langgraph_capabilities,
    is_langgraph_available,
    run_langgraph_task,
)
try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    PlaywrightError = Exception
    PlaywrightTimeoutError = TimeoutError
    sync_playwright = None

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
GITEA_INTERNAL_CLONE_BASE_URL = (
    os.environ.get("GITEA_INTERNAL_CLONE_BASE_URL")
    or "http://gitea-http.gitea.svc.cluster.local:3000"
).strip().rstrip("/")
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
WORKFLOW_BUILDER_BASE_URL = (
    os.environ.get(
        "WORKFLOW_BUILDER_BASE_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
)
WORKFLOW_BUILDER_INTERNAL_API_TOKEN = (
    os.environ.get("WORKFLOW_BUILDER_INTERNAL_API_TOKEN")
    or os.environ.get("INTERNAL_API_TOKEN")
    or ""
).strip()


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
DEFAULT_BROWSER_WORKSPACE_ROOT = Path("/home/gem/workspaces")
K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
K8S_PORT = int(os.environ.get("KUBERNETES_SERVICE_PORT", "443"))
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
K8S_CLAIM_API_GROUP = "extensions.agents.x-k8s.io"
K8S_CLAIM_API_VERSION = "v1alpha1"
K8S_CLAIM_PLURAL = "sandboxclaims"
SANDBOX_NAMESPACE = os.environ.get("SANDBOX_NAMESPACE", "agent-sandbox")
SANDBOX_USE_DAPR_INVOCATION = os.environ.get("SANDBOX_USE_DAPR_INVOCATION", "false").lower() == "true"
BROWSER_ARTIFACT_BLOB_PREFIX = (
    os.environ.get("WORKFLOW_BROWSER_ARTIFACT_BLOB_PREFIX", "workflow-browser-artifacts")
    .rstrip("/")
)
BROWSER_ARTIFACT_DATABASE_URL = (
    os.environ.get("WORKSPACE_RECON_DATABASE_URL", "").strip()
    or os.environ.get("DATABASE_URL", "").strip()
)
DEFAULT_BROWSER_CAPTURE_TIMEOUT_MS = 120_000
BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS = 8_000
DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 3_600_000
DEFAULT_BROWSER_PROVISION_TIMEOUT_MS = int(
    os.environ.get("SANDBOX_PROVISION_TIMEOUT_MS", "180000")
)

BROWSER_SANDBOX_TEMPLATES: dict[str, dict[str, Any]] = {
    "aio-browser": {
        "port": 8080,
        "healthPath": "v1/docs",
        "executePath": "v1/shell/exec",
        "workingDirectory": "/home/gem",
    },
}


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


class BrowserMaterializeChangeArtifactRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    workspaceRef: str = Field(min_length=1)
    sourceExecutionId: str | None = None
    durableInstanceId: str | None = None
    preferredOperation: str | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class BrowserCaptureStepRequest(BaseModel):
    id: str | None = None
    label: str | None = None
    path: str | None = None
    url: str | None = None
    waitForSelector: str | None = None
    waitForText: str | None = None
    delayMs: int | None = None
    fullPage: bool | None = None


class BrowserCaptureFlowRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    workspaceRef: str = Field(min_length=1)
    workflowId: str = Field(min_length=1)
    nodeId: str = Field(min_length=1)
    nodeName: str | None = None
    baseUrl: str = Field(min_length=1)
    steps: list[BrowserCaptureStepRequest]
    timeoutMs: int | None = None
    metadata: dict[str, Any] | None = None


class BrowserValidateRequest(BaseModel):
    executionId: str = Field(min_length=1)
    dbExecutionId: str | None = None
    sandboxName: str = Field(min_length=1)
    repoPath: str = "/sandbox/repo"
    installCommand: str = Field(min_length=1)
    devServerCommand: str = Field(min_length=1)
    baseUrl: str = Field(min_length=1, default="http://127.0.0.1:3009")
    steps: list[BrowserCaptureStepRequest] | str = Field(default_factory=list)
    timeoutMs: int | None = None
    workflowId: str | None = None
    nodeId: str | None = None
    nodeName: str | None = None


class WorkspaceCapabilityValidationRequest(BaseModel):
    workspaceRef: str = Field(min_length=1)
    requiredCapabilities: list[str] | str | None = None
    preferredExecutionProfile: str | None = None
    sandboxProfileRef: str | None = None
    verifyCommands: list[str] | str | None = None
    toolBackend: str | None = None


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
    parentExecutionId: str | None = None
    artifactRef: str | None = None
    planJson: dict[str, Any] | list[dict[str, Any]] | None = None
    requiredCapabilities: list[str] | str | None = None
    preferredExecutionProfile: str | None = None
    preferredSandboxProfile: str | None = None
    workspaceProfile: dict[str, Any] | None = None


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
    db_execution_id: str | None = None
    parent_execution_id: str | None = None
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
    backend: str = "local"
    command_timeout_ms: int | None = None
    sandbox_template: str | None = None
    sandbox_details: dict[str, Any] | None = None
    repository_url: str | None = None
    repository_owner: str | None = None
    repository_repo: str | None = None
    repository_branch: str | None = None
    available_capabilities: list[str] = field(default_factory=list)
    required_capabilities: list[str] = field(default_factory=list)
    preferred_execution_profile: str | None = None
    repository_signals: dict[str, Any] = field(default_factory=dict)

    def to_record(self) -> dict[str, Any]:
        return {
            "workspaceRef": self.workspace_ref,
            "executionId": self.execution_id,
            "rootPath": str(self.root_path),
            "workingDirectory": str(self.working_directory or self.root_path),
            "enabledTools": list(self.enabled_tools),
            "backend": self.backend,
            "commandTimeoutMs": self.command_timeout_ms,
            "sandboxTemplate": self.sandbox_template,
            "sandboxDetails": dict(self.sandbox_details or {}),
            "repositoryUrl": self.repository_url,
            "repositoryOwner": self.repository_owner,
            "repositoryRepo": self.repository_repo,
            "repositoryBranch": self.repository_branch,
            "availableCapabilities": list(self.available_capabilities),
            "requiredCapabilities": list(self.required_capabilities),
            "preferredExecutionProfile": self.preferred_execution_profile,
            "repositorySignals": dict(self.repository_signals),
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
            backend=str(record.get("backend") or "local").strip() or "local",
            command_timeout_ms=(
                int(record.get("commandTimeoutMs"))
                if record.get("commandTimeoutMs") is not None
                else None
            ),
            sandbox_template=str(record.get("sandboxTemplate") or "").strip() or None,
            sandbox_details=(
                dict(record.get("sandboxDetails"))
                if isinstance(record.get("sandboxDetails"), dict)
                else None
            ),
            repository_url=str(record.get("repositoryUrl") or "").strip() or None,
            repository_owner=str(record.get("repositoryOwner") or "").strip() or None,
            repository_repo=str(record.get("repositoryRepo") or "").strip() or None,
            repository_branch=str(record.get("repositoryBranch") or "").strip() or None,
            available_capabilities=[
                str(item).strip().lower()
                for item in (record.get("availableCapabilities") or [])
                if str(item).strip()
            ],
            required_capabilities=[
                str(item).strip().lower()
                for item in (record.get("requiredCapabilities") or [])
                if str(item).strip()
            ],
            preferred_execution_profile=(
                str(record.get("preferredExecutionProfile") or "").strip() or None
            ),
            repository_signals=(
                dict(record.get("repositorySignals"))
                if isinstance(record.get("repositorySignals"), dict)
                else {}
            ),
        )


@dataclass
class WorkflowBrowserCaptureStep:
    id: str
    label: str
    url: str
    title: str | None = None
    wait_for_selector: str | None = None
    wait_for_text: str | None = None
    delay_ms: int | None = None
    captured_at: str | None = None
    status: str = "completed"
    screenshot_storage_ref: str | None = None
    error: str | None = None


def _build_workspace_profile(
    session: WorkspaceSession,
    *,
    backend: str | None = None,
    sandbox_profile_ref: str | None = None,
    sandbox_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    execution_profile = _resolve_execution_profile(
        session.preferred_execution_profile,
        session.repository_signals,
    )
    profile_payload = {
        "workspaceRef": session.workspace_ref,
        "executionId": session.execution_id,
        "rootPath": str(session.root_path),
        "workingDirectory": str(session.working_directory or session.root_path),
        "backend": str(backend or session.backend or "local").strip() or "local",
        "availableCapabilities": list(session.available_capabilities),
        "requiredCapabilities": list(session.required_capabilities),
        "preferredExecutionProfile": session.preferred_execution_profile,
        "executionProfile": execution_profile,
        "repositorySignals": dict(session.repository_signals),
    }
    if sandbox_profile_ref:
        profile_payload["sandboxProfileRef"] = sandbox_profile_ref
    if isinstance(sandbox_profile, dict):
        sandbox_image = str(sandbox_profile.get("sandboxImage") or "").strip()
        if sandbox_image:
            profile_payload["sandboxImage"] = sandbox_image
    return profile_payload


def _validate_workspace_capabilities(
    session: WorkspaceSession,
    *,
    required_capabilities: list[str] | None = None,
    preferred_execution_profile: str | None = None,
    verify_commands: list[str] | None = None,
    tool_backend: str | None = None,
    sandbox_profile_ref: str | None = None,
) -> dict[str, Any]:
    normalized_tool_backend = str(tool_backend or "").strip().lower() or "local"
    sandbox_profile = _resolve_sandbox_profile(
        sandbox_profile_ref,
        preferred_execution_profile or session.preferred_execution_profile,
    )
    session.available_capabilities = _detect_available_capabilities(
        normalized_tool_backend,
        sandbox_profile,
    )
    if session.working_directory and Path(session.working_directory).exists():
        session.repository_signals = _detect_repository_signals(
            Path(session.working_directory)
        )
    execution_profile = _resolve_execution_profile(
        preferred_execution_profile or session.preferred_execution_profile,
        session.repository_signals,
    )
    inferred_required = _required_capabilities_for_profile(
        execution_profile,
        session.repository_signals,
    )
    command_required = _infer_capabilities_from_commands(verify_commands or [])
    normalized_required = sorted(
        {
            *session.required_capabilities,
            *(required_capabilities or []),
            *inferred_required,
            *command_required,
        }
    )
    session.required_capabilities = normalized_required
    session.preferred_execution_profile = (
        str(preferred_execution_profile).strip()
        if isinstance(preferred_execution_profile, str)
        and str(preferred_execution_profile).strip()
        else session.preferred_execution_profile
    )
    missing_capabilities = [
        capability
        for capability in normalized_required
        if capability not in session.available_capabilities
    ]
    _persist_workspace_session(session)
    workspace_profile = _build_workspace_profile(
        session,
        backend=normalized_tool_backend,
        sandbox_profile_ref=(
            str(sandbox_profile_ref or "").strip()
            or str((sandbox_profile or {}).get("id") or "").strip()
            or None
        ),
        sandbox_profile=sandbox_profile,
    )
    return {
        "success": len(missing_capabilities) == 0,
        "workspaceRef": session.workspace_ref,
        "executionId": session.execution_id,
        "workspaceProfile": workspace_profile,
        "availableCapabilities": list(session.available_capabilities),
        "requiredCapabilities": normalized_required,
        "missingCapabilities": missing_capabilities,
        "preferredExecutionProfile": session.preferred_execution_profile,
        "executionProfile": workspace_profile["executionProfile"],
        "repositorySignals": dict(session.repository_signals),
    }


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
    required_capabilities: list[str] = field(default_factory=list)
    preferred_execution_profile: str | None = None
    workspace_profile: dict[str, Any] | None = None

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
            "requiredCapabilities": list(self.required_capabilities),
            "preferredExecutionProfile": self.preferred_execution_profile,
            "workspaceProfile": dict(self.workspace_profile or {}),
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
            required_capabilities=[
                str(capability).strip().lower()
                for capability in (record.get("requiredCapabilities") or [])
                if str(capability).strip()
            ],
            preferred_execution_profile=(
                str(record.get("preferredExecutionProfile") or "").strip() or None
            ),
            workspace_profile=(
                dict(record.get("workspaceProfile"))
                if isinstance(record.get("workspaceProfile"), dict)
                else None
            ),
        )


workspace_sessions: dict[str, WorkspaceSession] = {}
sessions_by_execution: dict[str, set[str]] = {}
_langgraph_event_counters: dict[str, int] = {}
_langgraph_event_lock = threading.Lock()
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


def _event_payload_id(instance_id: str, suffix: str) -> str:
    return f"{instance_id}:{suffix}"


def _next_langgraph_event_sequence(instance_id: str) -> int:
    with _langgraph_event_lock:
        next_value = int(_langgraph_event_counters.get(instance_id) or 0) + 1
        _langgraph_event_counters[instance_id] = next_value
        return next_value


def _publish_agent_events(
    run_context: AgentRunContext | None,
    events: list[dict[str, Any]],
) -> None:
    if run_context is None or not run_context.execution_id or not events:
        return
    if not WORKFLOW_BUILDER_INTERNAL_API_TOKEN:
        logger.debug(
            "Skipping workflow-builder agent event publish for %s: internal token missing",
            run_context.instance_id,
        )
        return

    url = (
        f"{WORKFLOW_BUILDER_BASE_URL}/api/internal/agent/workflows/executions/"
        f"{run_context.execution_id}/events"
    )
    payload = json.dumps(
        {
            "daprInstanceId": run_context.instance_id,
            "events": events,
        }
    ).encode("utf-8")

    for attempt in range(1, 4):
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": WORKFLOW_BUILDER_INTERNAL_API_TOKEN,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                if 200 <= response.status < 300:
                    return
        except Exception as exc:
            if attempt == 3:
                logger.warning(
                    "Failed to publish workflow agent events for %s: %s",
                    run_context.instance_id,
                    exc,
                )
            else:
                time.sleep(0.2 * attempt)


def _emit_agent_event(
    run_context: AgentRunContext | None,
    *,
    event_id: str,
    event_type: str,
    phase: str | None = None,
    **payload: Any,
) -> None:
    if run_context is None:
        return
    event = {
        "id": event_id,
        "ts": _utc_now_iso(),
        "type": event_type,
        "runId": run_context.instance_id,
        **({"phase": phase} if phase else {}),
        **payload,
    }
    _publish_agent_events(run_context, [event])


def _sandbox_output_text(result: Any) -> tuple[str, int | None]:
    if isinstance(result, dict):
        stdout = str(result.get("stdout") or "").strip()
        stderr = str(result.get("stderr") or "").strip()
        output = "\n".join(part for part in [stdout, stderr] if part)
        exit_code = result.get("exitCode")
        return output, int(exit_code) if isinstance(exit_code, int) else None
    if isinstance(result, str):
        return result.strip(), None
    return json.dumps(result, default=str), None


def _progress_event_mapping(event: Any) -> dict[str, Any]:
    return event if isinstance(event, dict) else {}


def _progress_nested_mapping(event: dict[str, Any], key: str) -> dict[str, Any]:
    value = event.get(key)
    return value if isinstance(value, dict) else {}


def _compact_progress_event_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    if isinstance(value, dict):
        return {
            str(key): _compact_progress_event_value(item)
            for key, item in value.items()
            if _compact_progress_event_value(item) is not None
        }
    if isinstance(value, (list, tuple)):
        compacted = [
            _compact_progress_event_value(item)
            for item in value
        ]
        filtered = [item for item in compacted if item is not None]
        return filtered or None
    return str(value)


def _first_progress_value(*values: Any) -> Any:
    for value in values:
        compacted = _compact_progress_event_value(value)
        if compacted is not None:
            return compacted
    return None


def _progress_tool_name(event: dict[str, Any]) -> str:
    tool = _progress_nested_mapping(event, "tool")
    meta = _progress_nested_mapping(event, "meta")
    name = _first_progress_value(
        event.get("toolName"),
        event.get("tool_name"),
        event.get("name"),
        event.get("label"),
        event.get("tool"),
        tool.get("name"),
        tool.get("toolName"),
        meta.get("toolName"),
        meta.get("tool_name"),
        meta.get("name"),
    )
    return str(name or "tool").strip() or "tool"


def _progress_tool_args(event: dict[str, Any]) -> Any:
    tool = _progress_nested_mapping(event, "tool")
    meta = _progress_nested_mapping(event, "meta")
    direct = _first_progress_value(
        event.get("toolArgs"),
        event.get("toolInput"),
        event.get("input"),
        event.get("args"),
        event.get("arguments"),
        event.get("kwargs"),
        event.get("parameters"),
        event.get("params"),
        tool.get("args"),
        tool.get("input"),
        meta.get("toolArgs"),
        meta.get("input"),
        meta.get("args"),
        meta.get("arguments"),
    )
    if direct is not None:
        return direct
    command = _first_progress_value(
        event.get("command"),
        event.get("cmd"),
        meta.get("command"),
        meta.get("cmd"),
    )
    cwd = _first_progress_value(event.get("cwd"), meta.get("cwd"))
    timeout_seconds = _first_progress_value(
        event.get("timeout_seconds"),
        event.get("timeoutSeconds"),
        meta.get("timeout_seconds"),
        meta.get("timeoutSeconds"),
    )
    if command is None and cwd is None and timeout_seconds is None:
        return None
    payload: dict[str, Any] = {}
    if command is not None:
        payload["command"] = command
    if cwd is not None:
        payload["cwd"] = cwd
    if timeout_seconds is not None:
        payload["timeout_seconds"] = timeout_seconds
    return payload or None


def _progress_tool_result(event: dict[str, Any]) -> Any:
    tool = _progress_nested_mapping(event, "tool")
    meta = _progress_nested_mapping(event, "meta")
    direct = _first_progress_value(
        event.get("toolResult"),
        event.get("result"),
        event.get("output"),
        event.get("response"),
        meta.get("toolResult"),
        meta.get("result"),
        meta.get("output"),
        tool.get("result"),
        tool.get("output"),
    )
    if direct is not None:
        return direct
    error_text = _first_progress_value(
        event.get("error"),
        event.get("errorText"),
        meta.get("error"),
        meta.get("errorText"),
    )
    if error_text is not None:
        return {"error": error_text}
    command = _first_progress_value(
        event.get("command"),
        event.get("cmd"),
        meta.get("command"),
        meta.get("cmd"),
    )
    stdout = _first_progress_value(
        event.get("stdout"),
        meta.get("stdout"),
    )
    stderr = _first_progress_value(
        event.get("stderr"),
        meta.get("stderr"),
    )
    exit_code = _first_progress_value(
        event.get("exitCode"),
        event.get("exit_code"),
        event.get("returncode"),
        meta.get("exitCode"),
        meta.get("exit_code"),
        meta.get("returncode"),
    )
    if command is None and stdout is None and stderr is None and exit_code is None:
        return None
    payload: dict[str, Any] = {}
    if command is not None:
        payload["command"] = command
    if stdout is not None:
        payload["stdout"] = stdout
    if stderr is not None:
        payload["stderr"] = stderr
    if exit_code is not None:
        payload["exitCode"] = exit_code
    return payload or None


def _progress_event_exit_code(event: dict[str, Any]) -> int | None:
    value = _first_progress_value(
        event.get("exitCode"),
        event.get("exit_code"),
        event.get("returncode"),
        _progress_nested_mapping(event, "meta").get("exitCode"),
        _progress_nested_mapping(event, "meta").get("exit_code"),
        _progress_nested_mapping(event, "meta").get("returncode"),
    )
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit() or (
            stripped.startswith("-") and stripped[1:].isdigit()
        ):
            return int(stripped)
    return None


def _progress_event_command(event: dict[str, Any]) -> str | None:
    value = _first_progress_value(
        event.get("command"),
        event.get("cmd"),
        _progress_nested_mapping(event, "meta").get("command"),
        _progress_nested_mapping(event, "meta").get("cmd"),
    )
    if isinstance(value, str):
        return value
    tool_args = _progress_tool_args(event)
    if isinstance(tool_args, dict):
        command = tool_args.get("command") or tool_args.get("cmd")
        if isinstance(command, str) and command.strip():
            return command.strip()
    return None


def _progress_event_output_text(event: dict[str, Any]) -> str:
    explicit_output = _first_progress_value(
        event.get("output"),
        _progress_nested_mapping(event, "meta").get("output"),
    )
    if isinstance(explicit_output, str) and explicit_output.strip():
        return explicit_output.strip()
    tool_result = _progress_tool_result(event)
    output_text, _ = _sandbox_output_text(tool_result)
    return output_text


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
    if session.backend == "k8s":
        _destroy_k8s_workspace(session)
    else:
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
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, str):
        return []
    trimmed = value.strip()
    if not trimmed:
        return []
    try:
        parsed = json.loads(trimmed)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except json.JSONDecodeError:
        pass
    return [line.strip() for line in trimmed.splitlines() if line.strip()]


KNOWN_WORKSPACE_CAPABILITIES = {
    "git": ("git",),
    "bash": ("bash", "sh"),
    "node": ("node",),
    "pnpm": ("pnpm",),
    "npm": ("npm",),
    "python": ("python3", "python"),
    "uv": ("uv",),
    "corepack": ("corepack",),
    "npx": ("npx",),
}

OPENSHELL_DECLARED_CAPABILITIES = [
    "bash",
    "git",
    "node",
    "npm",
    "corepack",
    "python",
]
_APP_FILE_PATH = Path(__file__).resolve()
_REPO_ROOT_CANDIDATE = (
    _APP_FILE_PATH.parents[2]
    if len(_APP_FILE_PATH.parents) > 2
    else _APP_FILE_PATH.parent
)
SANDBOX_PROFILE_CATALOG_PATH = _REPO_ROOT_CANDIDATE / "config" / "sandbox-profiles.json"
_sandbox_profile_catalog_cache: dict[str, dict[str, Any]] | None = None
DEFAULT_SANDBOX_PROFILE_CATALOG: dict[str, dict[str, Any]] = {
    "base": {
        "id": "base",
        "backend": "local",
        "declaredCapabilities": ["bash", "git"],
        "sandboxImage": None,
    },
    "node-pnpm": {
        "id": "node-pnpm",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "node", "pnpm", "npm"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "node-npm": {
        "id": "node-npm",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "node", "npm", "pnpm"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "python": {
        "id": "python",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "python"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "python-uv": {
        "id": "python-uv",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "python", "uv"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
}

EXECUTION_PROFILE_CAPABILITIES = {
    "base": ["git", "bash"],
    "node-pnpm": ["git", "bash", "node", "pnpm", "npm"],
    "node-npm": ["git", "bash", "node", "npm", "pnpm"],
    "python": ["git", "bash", "python"],
    "python-uv": ["git", "bash", "python", "uv"],
}


def _normalize_capability_list(value: object) -> list[str]:
    items: list[str] = []
    if isinstance(value, list):
        items = [str(item).strip().lower() for item in value]
    elif isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            try:
                parsed = json.loads(trimmed)
                if isinstance(parsed, list):
                    items = [str(item).strip().lower() for item in parsed]
                else:
                    items = [part.strip().lower() for part in trimmed.split(",")]
            except json.JSONDecodeError:
                items = [part.strip().lower() for part in trimmed.split(",")]
    return sorted({item for item in items if item})


def _load_sandbox_profile_catalog() -> dict[str, dict[str, Any]]:
    global _sandbox_profile_catalog_cache
    if _sandbox_profile_catalog_cache is not None:
        return _sandbox_profile_catalog_cache
    catalog_path: Path | None = None
    for candidate in (
        SANDBOX_PROFILE_CATALOG_PATH,
        Path.cwd() / "config" / "sandbox-profiles.json",
    ):
        if candidate.exists():
            catalog_path = candidate
            break
    try:
        parsed = (
            json.loads(catalog_path.read_text(encoding="utf-8"))
            if catalog_path is not None
            else {}
        )
    except Exception:
        parsed = {}
    profiles = parsed.get("profiles") if isinstance(parsed, dict) else {}
    if not isinstance(profiles, dict):
        profiles = {}
    _sandbox_profile_catalog_cache = {
        str(profile_id): value
        for profile_id, value in profiles.items()
        if isinstance(value, dict)
    }
    if not _sandbox_profile_catalog_cache:
        _sandbox_profile_catalog_cache = dict(DEFAULT_SANDBOX_PROFILE_CATALOG)
    return _sandbox_profile_catalog_cache


def _resolve_sandbox_profile(
    sandbox_profile_ref: str | None,
    preferred_execution_profile: str | None,
) -> dict[str, Any] | None:
    profile_key = (
        str(sandbox_profile_ref or "").strip()
        or str(preferred_execution_profile or "").strip()
        or None
    )
    if profile_key is None:
        return None
    return _load_sandbox_profile_catalog().get(profile_key)


def _finalize_available_capabilities(capabilities: set[str]) -> list[str]:
    normalized = {
        str(capability).strip().lower()
        for capability in capabilities
        if str(capability).strip()
    }
    if "node" in normalized and (
        "pnpm" in normalized
        or "corepack" in normalized
        or "npx" in normalized
        or "npm" in normalized
    ):
        normalized.add("pnpm")
    return sorted(normalized)


def _detect_available_capabilities(
    tool_backend: str | None = None,
    sandbox_profile: dict[str, Any] | None = None,
) -> list[str]:
    declared_capabilities = _normalize_capability_list(
        sandbox_profile.get("declaredCapabilities") if isinstance(sandbox_profile, dict) else None
    )
    if declared_capabilities:
        return _finalize_available_capabilities(set(declared_capabilities))
    normalized_tool_backend = str(tool_backend or "").strip().lower()
    if normalized_tool_backend == "openshell":
        return _finalize_available_capabilities(set(OPENSHELL_DECLARED_CAPABILITIES))
    available = {
        capability
        for capability, binaries in KNOWN_WORKSPACE_CAPABILITIES.items()
        if any(shutil.which(binary) for binary in binaries)
    }
    return _finalize_available_capabilities(available)


def _detect_repository_signals(root: Path) -> dict[str, Any]:
    package_json_path = root / "package.json"
    pnpm_lock_path = root / "pnpm-lock.yaml"
    package_lock_path = root / "package-lock.json"
    pyproject_path = root / "pyproject.toml"
    uv_lock_path = root / "uv.lock"

    package_manager: str | None = None
    if pnpm_lock_path.exists():
        package_manager = "pnpm"
    elif package_lock_path.exists():
        package_manager = "npm"

    if package_json_path.exists():
        try:
            package_json = json.loads(package_json_path.read_text(encoding="utf-8"))
            package_manager_value = str(package_json.get("packageManager") or "").strip()
            if package_manager_value.startswith("pnpm@"):
                package_manager = "pnpm"
            elif package_manager_value.startswith("npm@"):
                package_manager = "npm"
        except Exception:
            pass

    runtime_family = "generic"
    if uv_lock_path.exists():
        runtime_family = "python"
        package_manager = package_manager or "uv"
    elif pyproject_path.exists():
        runtime_family = "python"
    elif package_json_path.exists():
        runtime_family = "node"

    return {
        "runtimeFamily": runtime_family,
        "packageManager": package_manager,
        "hasPackageJson": package_json_path.exists(),
        "hasPyprojectToml": pyproject_path.exists(),
        "hasUvLock": uv_lock_path.exists(),
        "hasPnpmLock": pnpm_lock_path.exists(),
        "hasPackageLock": package_lock_path.exists(),
    }


def _resolve_execution_profile(
    preferred_profile: str | None,
    repository_signals: dict[str, Any] | None,
) -> str:
    preferred = str(preferred_profile or "").strip().lower()
    if preferred:
        return preferred
    signals = repository_signals or {}
    package_manager = str(signals.get("packageManager") or "").strip().lower()
    runtime_family = str(signals.get("runtimeFamily") or "").strip().lower()
    if package_manager == "pnpm":
        return "node-pnpm"
    if package_manager == "npm":
        return "node-npm"
    if package_manager == "uv":
        return "python-uv"
    if runtime_family == "python":
        return "python"
    return "base"


def _required_capabilities_for_profile(
    execution_profile: str,
    repository_signals: dict[str, Any] | None,
) -> list[str]:
    profile_caps = list(EXECUTION_PROFILE_CAPABILITIES.get(execution_profile, []))
    if not profile_caps:
        return []
    signals = repository_signals or {}
    package_manager = str(signals.get("packageManager") or "").strip().lower()
    if execution_profile == "node-pnpm" and package_manager != "pnpm":
        return ["git", "bash", "node"] if signals.get("hasPackageJson") else ["git", "bash"]
    if execution_profile == "node-npm" and package_manager != "npm":
        return ["git", "bash", "node"] if signals.get("hasPackageJson") else ["git", "bash"]
    if execution_profile == "python-uv" and package_manager != "uv":
        return ["git", "bash", "python"] if signals.get("hasPyprojectToml") else ["git", "bash"]
    return profile_caps


def _infer_capabilities_from_commands(commands: list[str]) -> list[str]:
    inferred: set[str] = set()
    for command in commands:
        if not command.strip():
            continue
        try:
            first = shlex.split(command)[0].strip().lower()
        except Exception:
            first = command.strip().split()[0].strip().lower()
        if first == "pnpm":
            inferred.update({"node", "pnpm"})
        elif first in {"npm", "npx"}:
            inferred.update({"node", "npm"})
        elif first == "node":
            inferred.add("node")
        elif first in {"python", "python3"}:
            inferred.add("python")
        elif first == "uv":
            inferred.update({"python", "uv"})
        elif first == "git":
            inferred.add("git")
        elif first in {"bash", "sh"}:
            inferred.add("bash")
    return sorted(inferred)


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
    tool_backend = str(request.toolBackend or "").strip().lower()
    segments = [
        f"Profile: {profile}",
        f"Run mode: {run_mode}",
        f"Profile instructions: {PROFILE_INSTRUCTIONS[profile]}",
        f"Task:\n{request.prompt}",
    ]
    if tool_backend == "openshell" and request.sandboxRepoPath:
        segments.append(
            "Repository root inside sandbox:\n"
            f"{request.sandboxRepoPath}\n"
            "Operate only within this sandbox repository root. When using tools, pass repository-relative paths such as '.' or 'src/app.ts'."
        )
    elif request.cwd:
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, "run_complete"),
            event_type="run_complete",
            phase="planned",
            status="success",
            text=plan_markdown,
        )
        return result
    change_root = _change_tracking_root(cwd)
    summary = summarize_command_changes(change_root)
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
        tool_context = ToolRuntimeContext.from_workspace_root(change_root)
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
        "fileSnapshots": _build_persisted_file_snapshots(
            change_root,
            patch,
            summary["changeSummary"],
        ),
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
    _publish_execution_change_artifact(
        run_context,
        change_summary=summary["changeSummary"],
        patch=patch,
        file_snapshots=result["fileSnapshots"],
    )
    _persist_run_artifact(instance_id, result)
    _emit_agent_event(
        run_context,
        event_id=_event_payload_id(instance_id, "run_complete"),
        event_type="run_complete",
        phase="completed",
        status="success",
        text=text,
    )
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


def _browser_workspace_root(
    execution_id: str,
    requested_root: str | None,
    sandbox_template: str | None,
) -> Path:
    template = str(sandbox_template or "").strip()
    if template != "aio-browser":
        return _default_workspace_root(execution_id, requested_root)
    if requested_root:
        candidate = Path(requested_root)
        if not candidate.is_absolute():
            candidate = DEFAULT_BROWSER_WORKSPACE_ROOT / requested_root
    else:
        candidate = DEFAULT_BROWSER_WORKSPACE_ROOT / execution_id
    return candidate.expanduser().resolve()


def _shell_escape(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _build_authenticated_git_url(
    repository_url: str,
    username: str | None,
    token: str | None,
) -> str:
    trimmed_url = repository_url.strip()
    if not trimmed_url:
        return trimmed_url
    trimmed_username = str(username or "").strip()
    trimmed_token = str(token or "").strip()
    if not trimmed_username or not trimmed_token:
        return trimmed_url
    try:
        parsed = urllib.parse.urlsplit(trimmed_url)
    except ValueError:
        return trimmed_url
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return trimmed_url
    if parsed.username or parsed.password:
        return trimmed_url
    quoted_username = urllib.parse.quote(trimmed_username, safe="")
    quoted_token = urllib.parse.quote(trimmed_token, safe="")
    host = parsed.hostname
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    netloc = f"{quoted_username}:{quoted_token}@{host}"
    return urllib.parse.urlunsplit(
        (parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment)
    )


def _read_k8s_token() -> str:
    return Path(K8S_TOKEN_PATH).read_text(encoding="utf-8").strip()


def _read_k8s_ca() -> str | None:
    path = Path(K8S_CA_PATH)
    if not path.exists():
        return None
    return str(path)


def _k8s_request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    content_type: str = "application/json",
) -> dict[str, Any]:
    url = f"https://{K8S_HOST}:{K8S_PORT}{path}"
    request = urllib.request.Request(url=url, method=method.upper())
    request.add_header("Authorization", f"Bearer {_read_k8s_token()}")
    request.add_header("Accept", "application/json")
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        request.add_header("Content-Type", content_type)
    else:
        payload = None
    context = ssl.create_default_context(cafile=_read_k8s_ca())
    try:
        with urllib.request.urlopen(request, data=payload, context=context, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"K8s API {method.upper()} {path} failed with {exc.code}: {message}"
        ) from exc


def _wait_for_sandbox_ready(claim_name: str, *, timeout_ms: int) -> dict[str, str]:
    deadline = time.time() + (timeout_ms / 1000)
    claim_path = (
        f"/apis/{K8S_CLAIM_API_GROUP}/{K8S_CLAIM_API_VERSION}/namespaces/"
        f"{SANDBOX_NAMESPACE}/{K8S_CLAIM_PLURAL}/{claim_name}"
    )
    while time.time() < deadline:
        claim = _k8s_request("GET", claim_path)
        status = claim.get("status") if isinstance(claim.get("status"), dict) else {}
        binding = status.get("binding") if isinstance(status.get("binding"), dict) else {}
        sandbox_ref = status.get("sandbox") if isinstance(status.get("sandbox"), dict) else {}
        sandbox_name = str(
            binding.get("name")
            or sandbox_ref.get("name")
            or sandbox_ref.get("Name")
            or ""
        ).strip()
        if sandbox_name:
            sandbox_path = (
                f"/apis/agents.x-k8s.io/v1alpha1/namespaces/{SANDBOX_NAMESPACE}/sandboxes/"
                f"{sandbox_name}"
            )
            sandbox = _k8s_request("GET", sandbox_path)
            sandbox_metadata = (
                sandbox.get("metadata") if isinstance(sandbox.get("metadata"), dict) else {}
            )
            sandbox_annotations = (
                sandbox_metadata.get("annotations")
                if isinstance(sandbox_metadata.get("annotations"), dict)
                else {}
            )
            sandbox_status = (
                sandbox.get("status") if isinstance(sandbox.get("status"), dict) else {}
            )
            ready_conditions = (
                sandbox_status.get("conditions")
                if isinstance(sandbox_status.get("conditions"), list)
                else []
            )
            sandbox_ready = any(
                isinstance(condition, dict)
                and str(condition.get("type") or "").strip() == "Ready"
                and str(condition.get("status") or "").strip().lower() == "true"
                for condition in ready_conditions
            )
            pod_name = str(
                sandbox_status.get("podName")
                or sandbox_annotations.get("agents.x-k8s.io/pod-name")
                or ""
            ).strip()
            service_host = str(sandbox_status.get("podIp") or "").strip()
            if pod_name:
                pod_path = f"/api/v1/namespaces/{SANDBOX_NAMESPACE}/pods/{pod_name}"
                try:
                    pod = _k8s_request("GET", pod_path)
                except Exception:
                    pod = {}
                pod_status = pod.get("status") if isinstance(pod.get("status"), dict) else {}
                pod_phase = str(pod_status.get("phase") or "").strip()
                pod_ip = str(pod_status.get("podIP") or pod_status.get("podIp") or "").strip()
                if pod_phase.lower() == "running" and pod_ip:
                    service_host = pod_ip
            if not service_host and sandbox_ready:
                service_host = str(sandbox_status.get("serviceFQDN") or "").strip()
                if not service_host:
                    service_name = str(sandbox_status.get("service") or "").strip()
                    if service_name:
                        service_host = f"{service_name}.{SANDBOX_NAMESPACE}.svc.cluster.local"
            if pod_name and service_host:
                # Read dapr.io/app-id annotation from the pod metadata
                pod_metadata = pod.get("metadata") if isinstance(pod.get("metadata"), dict) else {}
                pod_annotations = (
                    pod_metadata.get("annotations")
                    if isinstance(pod_metadata.get("annotations"), dict)
                    else {}
                )
                dapr_app_id = str(pod_annotations.get("dapr.io/app-id") or "").strip()
                return {
                    "sandboxName": sandbox_name,
                    "podName": pod_name,
                    "podIp": service_host,
                    "daprAppId": dapr_app_id or None,
                }
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for sandbox claim {claim_name} to bind")


def _http_json(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    timeout_seconds: float = 30,
) -> dict[str, Any]:
    request = urllib.request.Request(url=url, method=method.upper())
    request.add_header("Accept", "application/json")
    if body is not None:
        request.add_header("Content-Type", "application/json")
        payload = json.dumps(body).encode("utf-8")
    else:
        payload = None
    try:
        with urllib.request.urlopen(request, data=payload, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"HTTP {exc.code} from {method.upper()} {url}: {error_body[:500]}"
        ) from exc


def _wait_for_browser_http_ready(session: WorkspaceSession, *, timeout_ms: int) -> None:
    details = session.sandbox_details or {}
    pod_ip = str(details.get("podIp") or "").strip()
    port = int(details.get("port") or 0)
    health_path = str(details.get("healthPath") or "").strip().lstrip("/")
    if not pod_ip or port <= 0 or not health_path:
        raise RuntimeError("Browser workspace session is missing sandbox connectivity details")
    deadline = time.time() + (timeout_ms / 1000)
    last_error: Exception | None = None
    url = f"http://{pod_ip}:{port}/{health_path}"
    while time.time() < deadline:
        try:
            request = urllib.request.Request(url=url, method="GET")
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.status < 400:
                    return
        except Exception as exc:  # pragma: no cover - exercised via monkeypatch tests
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(f"Sandbox HTTP server not ready: {last_error}")


def _wait_for_shell_ready(
    pod_ip: str,
    port: int,
    execute_path: str,
    *,
    timeout_seconds: int = 30,
) -> None:
    """Verify the shell executor is functional, not just the HTTP server."""
    url = f"http://{pod_ip}:{port}/{execute_path}"
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            result = _http_json(
                "POST",
                url,
                body={"command": "true", "timeout": 5},
                timeout_seconds=10,
            )
            data = result.get("data") if isinstance(result.get("data"), dict) else result
            if data.get("exit_code", data.get("exitCode", -1)) == 0:
                logger.info("Shell executor ready at %s", url)
                return
        except Exception as exc:
            last_error = exc
        time.sleep(1)
    raise RuntimeError(f"Shell executor not ready after {timeout_seconds}s: {last_error}")


def _create_browser_sandbox_session(
    *,
    execution_id: str,
    name: str | None,
    root_path: Path,
    enabled_tools: list[str],
    command_timeout_ms: int | None,
    sandbox_template: str,
) -> WorkspaceSession:
    template = BROWSER_SANDBOX_TEMPLATES.get(sandbox_template)
    if template is None:
        raise HTTPException(status_code=400, detail=f"Unsupported sandbox template: {sandbox_template}")
    sandbox_working_directory = Path(
        str(template.get("workingDirectory") or "/").strip() or "/"
    )
    claim_name = f"browser-{uuid.uuid4().hex[:12]}"
    claim_path = (
        f"/apis/{K8S_CLAIM_API_GROUP}/{K8S_CLAIM_API_VERSION}/namespaces/"
        f"{SANDBOX_NAMESPACE}/{K8S_CLAIM_PLURAL}"
    )
    _k8s_request(
        "POST",
        claim_path,
        {
            "apiVersion": f"{K8S_CLAIM_API_GROUP}/{K8S_CLAIM_API_VERSION}",
            "kind": "SandboxClaim",
            "metadata": {
                "name": claim_name,
                "namespace": SANDBOX_NAMESPACE,
                "labels": {
                    "app.kubernetes.io/managed-by": "dapr-agent-runtime",
                },
            },
            "spec": {
                "sandboxTemplateRef": {
                    "name": sandbox_template,
                },
            },
        },
    )
    ready = _wait_for_sandbox_ready(
        claim_name,
        timeout_ms=DEFAULT_BROWSER_PROVISION_TIMEOUT_MS,
    )
    workspace_ref = f"workspace-{uuid.uuid4().hex[:12]}"
    session = WorkspaceSession(
        workspace_ref=workspace_ref,
        execution_id=execution_id,
        root_path=root_path,
        working_directory=sandbox_working_directory,
        enabled_tools=[str(item) for item in enabled_tools],
        backend="k8s",
        command_timeout_ms=command_timeout_ms or DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
        sandbox_template=sandbox_template,
        sandbox_details={
            "claimName": claim_name,
            "sandboxName": ready["sandboxName"],
            "podName": ready["podName"],
            "podIp": ready["podIp"],
            "daprAppId": ready.get("daprAppId"),
            "namespace": SANDBOX_NAMESPACE,
            "templateName": sandbox_template,
            "port": template["port"],
            "healthPath": template["healthPath"],
            "executePath": template["executePath"],
            "workingDirectory": str(sandbox_working_directory),
        },
        available_capabilities=["bash", "git", "browser", "screenshot"],
        repository_signals={},
    )
    _wait_for_browser_http_ready(session, timeout_ms=30_000)
    # Verify shell executor is functional (not just HTTP server)
    shell_details = session.sandbox_details or {}
    _wait_for_shell_ready(
        pod_ip=str(shell_details.get("podIp") or ""),
        port=int(shell_details.get("port") or 0),
        execute_path=str(shell_details.get("executePath") or "").strip().lstrip("/"),
        timeout_seconds=30,
    )
    if SANDBOX_USE_DAPR_INVOCATION and ready.get("daprAppId"):
        # Wait for Dapr sidecar to be ready
        pod_ip = ready["podIp"]
        dapr_health_url = f"http://{pod_ip}:{3500}/v1.0/healthz"
        dapr_timeout = time.time() + 60  # 60s timeout for sidecar
        while time.time() < dapr_timeout:
            try:
                req = urllib.request.Request(url=dapr_health_url, method="GET")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status < 400:
                        logger.info("Dapr sidecar ready for %s", ready.get("daprAppId"))
                        break
            except Exception:
                pass
            time.sleep(1)
        else:
            logger.warning("Dapr sidecar not ready after 60s, falling back to direct HTTP")
    # Bootstrap workspace directory with retry (shell may not be fully stable yet)
    bootstrap_last_error: Exception | None = None
    for bootstrap_attempt in range(3):
        try:
            bootstrap_result = _run_k8s_workspace_command(
                session,
                command=f"mkdir -p {_shell_escape(str(root_path))}",
                cwd=sandbox_working_directory,
                timeout_ms=30_000,
            )
            if bootstrap_result["success"]:
                break
            bootstrap_last_error = RuntimeError(
                bootstrap_result["stderr"] or bootstrap_result["stdout"] or "mkdir failed"
            )
        except Exception as exc:
            bootstrap_last_error = exc
        if bootstrap_attempt < 2:
            logger.warning(
                "Browser sandbox bootstrap attempt %d failed: %s, retrying in 5s...",
                bootstrap_attempt + 1,
                bootstrap_last_error,
            )
            time.sleep(5)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to prepare browser workspace root after 3 attempts: {bootstrap_last_error}",
        )
    session.working_directory = root_path
    return session


def _destroy_k8s_workspace(session: WorkspaceSession) -> None:
    if session.backend != "k8s":
        return
    details = session.sandbox_details or {}
    claim_name = str(details.get("claimName") or "").strip()
    namespace = str(details.get("namespace") or SANDBOX_NAMESPACE).strip() or SANDBOX_NAMESPACE
    if not claim_name:
        return
    claim_path = (
        f"/apis/{K8S_CLAIM_API_GROUP}/{K8S_CLAIM_API_VERSION}/namespaces/"
        f"{namespace}/{K8S_CLAIM_PLURAL}/{claim_name}"
    )
    try:
        _k8s_request("DELETE", claim_path)
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed deleting sandbox claim %s: %s", claim_name, exc)


def _resolve_workspace_path(session: WorkspaceSession, relative_path: str) -> Path:
    candidate = Path(relative_path)
    if candidate.is_absolute():
        return candidate
    base = session.working_directory or session.root_path
    return (base / relative_path).resolve()


def _run_k8s_workspace_command(
    session: WorkspaceSession,
    *,
    command: str,
    cwd: Path | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    details = session.sandbox_details or {}
    pod_ip = str(details.get("podIp") or "").strip()
    port = int(details.get("port") or 0)
    execute_path = str(details.get("executePath") or "").strip().lstrip("/")
    if not pod_ip or port <= 0 or not execute_path:
        raise HTTPException(status_code=400, detail="Workspace sandbox session is incomplete")
    timeout_value = timeout_ms or session.command_timeout_ms or DEFAULT_BROWSER_COMMAND_TIMEOUT_MS
    logger.info(
        "k8s_workspace_command timeout_ms=%s session_cmd_timeout=%s resolved=%s",
        timeout_ms, session.command_timeout_ms, timeout_value,
    )
    target_cwd = cwd or session.working_directory or session.root_path
    wrapped_command = f"cd {_shell_escape(str(target_cwd))} && {command}"
    payload = {
        "command": wrapped_command,
        "timeout": max(int(timeout_value / 1000), 1),
    }
    started_at = time.time()
    dapr_app_id = details.get("daprAppId")
    if SANDBOX_USE_DAPR_INVOCATION and dapr_app_id:
        url = f"http://localhost:{DAPR_HTTP_PORT}/v1.0/invoke/{dapr_app_id}.{SANDBOX_NAMESPACE}/method/{execute_path}"
    else:
        url = f"http://{pod_ip}:{port}/{execute_path}"
    response = _http_json(
        "POST",
        url,
        body=payload,
        timeout_seconds=max(timeout_value / 1000, 1) + 5,
    )
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    shell_response = _resolve_k8s_shell_command_result(
        pod_ip=pod_ip,
        port=port,
        execute_path=execute_path,
        response=response,
        timeout_value=timeout_value,
    )
    result = {
        "stdout": shell_response["stdout"],
        "stderr": shell_response["stderr"],
        "exitCode": shell_response["exitCode"],
        "success": shell_response["success"],
        "executionTimeMs": int((time.time() - started_at) * 1000),
        "timedOut": shell_response["timedOut"],
    }
    # Publish sandbox command completion event
    if SANDBOX_USE_DAPR_INVOCATION and DAPR_HTTP_PORT:
        try:
            pubsub_url = f"http://localhost:{DAPR_HTTP_PORT}/v1.0/publish/sandbox-pubsub/sandbox.command.completed"
            event_data = {
                "sandboxName": details.get("sandboxName"),
                "podName": details.get("podName"),
                "daprAppId": details.get("daprAppId"),
                "exitCode": result.get("exitCode", -1),
                "executionTimeMs": result.get("executionTimeMs", 0),
            }
            _http_json("POST", pubsub_url, body=event_data, timeout_seconds=5)
        except Exception as e:
            logger.debug("Failed to publish sandbox event: %s", e)
    return result


def _resolve_k8s_shell_command_result(
    *,
    pod_ip: str,
    port: int,
    execute_path: str,
    response: dict[str, Any],
    timeout_value: int,
) -> dict[str, Any]:
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    if not isinstance(data, dict):
        data = {}

    status = str(data.get("status") or "").strip().lower()
    session_id = str(data.get("session_id") or data.get("sessionId") or "").strip()
    # Treat "no_change_timeout" as still-running: the sandbox shell executor
    # kills commands that produce no stdout for ~120s, but the command may
    # still be alive in the session.  Poll for the real completion status.
    if status in ("running", "no_change_timeout") and session_id:
        return _poll_k8s_shell_session(
            pod_ip=pod_ip,
            port=port,
            execute_path=execute_path,
            session_id=session_id,
            initial_response=response,
            timeout_value=timeout_value,
        )

    return _normalize_k8s_shell_command_response(response)


def _normalize_k8s_shell_command_response(
    response: dict[str, Any],
    *,
    fallback_status: str | None = None,
) -> dict[str, Any]:
    data = response.get("data") if isinstance(response.get("data"), dict) else response
    if not isinstance(data, dict):
        data = {}

    stdout = str(data.get("output") or data.get("stdout") or "")
    stderr = str(data.get("stderr") or "")
    status = str(data.get("status") or fallback_status or "").strip().lower()

    exit_code_value = data.get("exit_code")
    if exit_code_value is None:
        exit_code_value = data.get("exitCode")
    if exit_code_value is None and status not in {"running", "no_change_timeout", "hard_timeout", "terminated"}:
        exit_code_value = 0 if response.get("success") else 1

    exit_code: int | None = None
    if exit_code_value is not None:
        exit_code = int(exit_code_value)

    timed_out = status in {"no_change_timeout", "hard_timeout"}
    if exit_code is None:
        exit_code = 124 if timed_out else 1

    if timed_out and not stderr:
        stderr = response.get("message") or "Command timed out"
    elif status == "terminated" and not stderr and exit_code != 0:
        stderr = response.get("message") or "Command terminated"

    return {
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
        "success": exit_code == 0,
        "timedOut": timed_out,
    }


def _poll_k8s_shell_session(
    *,
    pod_ip: str,
    port: int,
    execute_path: str,
    session_id: str,
    initial_response: dict[str, Any],
    timeout_value: int,
) -> dict[str, Any]:
    base_url = f"http://{pod_ip}:{port}"
    wait_path = execute_path.rsplit("/", 1)[0] + "/wait"
    view_path = execute_path.rsplit("/", 1)[0] + "/view"
    deadline = time.monotonic() + max(timeout_value, 1) / 1000
    last_status = str(
        (
            initial_response.get("data")
            if isinstance(initial_response.get("data"), dict)
            else {}
        ).get("status")
        or "running"
    ).strip().lower()
    view_response: dict[str, Any] = initial_response

    while time.monotonic() < deadline:
        remaining_seconds = max(int(deadline - time.monotonic()), 1)
        wait_response = _http_json(
            "POST",
            f"{base_url}/{wait_path}",
            body={"id": session_id, "seconds": min(remaining_seconds, 10)},
            timeout_seconds=min(remaining_seconds, 10) + 5,
        )
        wait_data = wait_response.get("data") if isinstance(wait_response.get("data"), dict) else {}
        last_status = str(wait_data.get("status") or last_status or "").strip().lower()

        view_response = _http_json(
            "POST",
            f"{base_url}/{view_path}",
            body={"id": session_id},
            timeout_seconds=10,
        )
        view_data = view_response.get("data") if isinstance(view_response.get("data"), dict) else {}
        view_status = str(view_data.get("status") or "").strip().lower()
        if view_status:
            last_status = view_status

        if last_status and last_status not in ("running", "no_change_timeout"):
            return _normalize_k8s_shell_command_response(view_response, fallback_status=last_status)

        # When status is no_change_timeout, the wait endpoint returns instantly.
        # Sleep to avoid tight-looping and overwhelming the sandbox.
        if last_status == "no_change_timeout":
            time.sleep(5)

    return _normalize_k8s_shell_command_response(
        {
            "success": False,
            "message": f"Command timed out after {max(int(timeout_value / 1000), 1)}s",
            "data": {
                **(
                    view_response.get("data")
                    if isinstance(view_response.get("data"), dict)
                    else {}
                ),
                "status": "hard_timeout",
                "session_id": session_id,
            },
        },
        fallback_status="hard_timeout",
    )


def _write_remote_file(session: WorkspaceSession, target_path: Path, content: str) -> None:
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    parent_dir = target_path.parent
    command = (
        f"mkdir -p {_shell_escape(str(parent_dir))} && "
        f"printf %s {_shell_escape(encoded)} | base64 -d > {_shell_escape(str(target_path))}"
    )
    result = _run_k8s_workspace_command(session, command=command, cwd=session.root_path)
    if not result["success"]:
        raise RuntimeError(result["stderr"] or f"Failed writing {target_path}")


def _delete_remote_path(session: WorkspaceSession, target_path: Path) -> None:
    result = _run_k8s_workspace_command(
        session,
        command=f"rm -rf {_shell_escape(str(target_path))}",
        cwd=session.root_path,
    )
    if not result["success"]:
        raise RuntimeError(result["stderr"] or f"Failed deleting {target_path}")


def _resolve_browser_step_url(base_url: str, step: BrowserCaptureStepRequest) -> str:
    explicit_url = str(step.url or "").strip()
    if explicit_url:
        return explicit_url
    raw_path = str(step.path or "").strip()
    if not raw_path:
        return base_url
    return urllib.parse.urljoin(f"{base_url.rstrip('/')}/", raw_path)


def _capture_browser_step_with_retry(
    page: Any,
    *,
    target_url: str,
    wait_for_selector: str | None,
    wait_for_text: str | None,
    delay_ms: int | None,
    full_page: bool,
    timeout_ms: int,
) -> bytes:
    deadline = time.monotonic() + max(timeout_ms, 1) / 1000
    # Per-attempt cap: keep retries short so we get many attempts.
    attempt_timeout_ms = max(
        1_000,
        min(timeout_ms, BROWSER_CAPTURE_STEP_ATTEMPT_TIMEOUT_MS),
    )
    # Floor: stop retrying when remaining time is below this threshold
    # rather than issuing a doomed sub-second attempt.
    min_viable_attempt_ms = max(2_000, attempt_timeout_ms // 2)
    last_error: Exception | None = None
    attempt = 0
    while True:
        remaining_ms = max(int((deadline - time.monotonic()) * 1000), 0)
        if remaining_ms < min_viable_attempt_ms:
            break
        attempt += 1
        current_timeout_ms = min(attempt_timeout_ms, remaining_ms)
        logger.info(
            "browser_capture attempt=%d target=%s timeout=%dms remaining=%dms",
            attempt, target_url, current_timeout_ms, remaining_ms,
        )
        try:
            page.goto(
                target_url,
                wait_until="domcontentloaded",
                timeout=current_timeout_ms,
            )
            if wait_for_selector:
                page.wait_for_selector(wait_for_selector, timeout=current_timeout_ms)
            if wait_for_text:
                page.wait_for_function(
                    "(needle) => document.body && document.body.innerText.includes(needle)",
                    arg=wait_for_text,
                    timeout=current_timeout_ms,
                )
            if delay_ms and delay_ms > 0:
                page.wait_for_timeout(delay_ms)
            logger.info("browser_capture attempt=%d succeeded", attempt)
            return page.screenshot(full_page=full_page, type="png")
        except (PlaywrightTimeoutError, PlaywrightError, Exception) as exc:
            last_error = exc
            logger.warning(
                "browser_capture attempt=%d failed: %s (remaining=%dms)",
                attempt, str(exc)[:200], remaining_ms,
            )
            remaining_after = max(int((deadline - time.monotonic()) * 1000), 0)
            if remaining_after < min_viable_attempt_ms:
                break
            page.wait_for_timeout(min(1_000, remaining_after))
    raise RuntimeError(
        f"Browser capture timed out after {attempt} attempts "
        f"(budget={timeout_ms}ms): {last_error or 'deadline exceeded'}"
    )


def _browser_connection_info(session: WorkspaceSession) -> str:
    details = session.sandbox_details or {}
    pod_ip = str(details.get("podIp") or "").strip()
    port = int(details.get("port") or 0)
    if not pod_ip or port <= 0:
        raise RuntimeError("Browser workspace session is missing pod connectivity")
    payload = _http_json("GET", f"http://{pod_ip}:{port}/v1/browser/info", timeout_seconds=10)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    for key in (
        "debugger_url",
        "debuggerUrl",
        "ws_url",
        "wsUrl",
        "websocket_url",
        "websocketUrl",
        "cdp_url",
        "cdpUrl",
    ):
        value = str(data.get(key) or "").strip()
        if value:
            parsed = urllib.parse.urlparse(value)
            if parsed.hostname in {"127.0.0.1", "localhost", "0.0.0.0"}:
                return urllib.parse.urlunparse(parsed._replace(netloc=f"{pod_ip}:{parsed.port or port}"))
            return value
    raise RuntimeError("Sandbox browser info did not include a CDP endpoint")


def _browser_artifact_storage_ref(execution_id: str, artifact_id: str, index: int) -> str:
    safe_execution_id = re.sub(r"[^a-zA-Z0-9._-]", "-", execution_id)
    return f"{BROWSER_ARTIFACT_BLOB_PREFIX}/{safe_execution_id}/{artifact_id}/step-{index + 1}.png"


def _save_workflow_browser_artifact(
    *,
    workflow_execution_id: str,
    workflow_id: str,
    node_id: str,
    workspace_ref: str | None,
    base_url: str,
    metadata: dict[str, Any] | None,
    steps: list[WorkflowBrowserCaptureStep],
    screenshots: list[bytes],
    status: str,
) -> dict[str, Any]:
    if psycopg is None:
        raise RuntimeError("psycopg is required for browser artifact persistence")
    if not BROWSER_ARTIFACT_DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required for browser artifact persistence")
    artifact_id = f"bwf_{uuid.uuid4().hex[:12]}"
    manifest = {
        "baseUrl": base_url,
        "startedAt": min(
            [step.captured_at for step in steps if step.captured_at] or [_utc_now_iso()]
        ),
        "completedAt": _utc_now_iso(),
        "status": status,
        "steps": [],
        "metadata": metadata or None,
    }
    for index, step in enumerate(steps):
        screenshot_storage_ref = step.screenshot_storage_ref
        if step.status == "completed" and screenshot_storage_ref is None and index < len(screenshots):
            screenshot_storage_ref = _browser_artifact_storage_ref(
                workflow_execution_id,
                artifact_id,
                index,
            )
        manifest["steps"].append(
            {
                "id": step.id,
                "label": step.label,
                "url": step.url,
                "title": step.title,
                "waitForSelector": step.wait_for_selector,
                "waitForText": step.wait_for_text,
                "delayMs": step.delay_ms,
                "capturedAt": step.captured_at,
                "status": step.status,
                "screenshotStorageRef": screenshot_storage_ref,
                "error": step.error,
            }
        )
    with psycopg.connect(BROWSER_ARTIFACT_DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            screenshot_index = 0
            for step_record in manifest["steps"]:
                if step_record.get("status") != "completed":
                    continue
                if screenshot_index >= len(screenshots):
                    break
                storage_ref = str(step_record.get("screenshotStorageRef") or "").strip()
                if not storage_ref:
                    continue
                cursor.execute(
                    """
                    insert into workflow_browser_artifact_blob_payloads (
                        storage_ref,
                        payload_text,
                        content_type
                    ) values (%s, %s, %s)
                    on conflict (storage_ref) do update
                    set payload_text = excluded.payload_text,
                        content_type = excluded.content_type
                    """,
                    (
                        storage_ref,
                        base64.b64encode(screenshots[screenshot_index]).decode("ascii"),
                        "image/png",
                    ),
                )
                screenshot_index += 1
            cursor.execute(
                """
                insert into workflow_browser_artifacts (
                    id,
                    workflow_execution_id,
                    workflow_id,
                    node_id,
                    workspace_ref,
                    artifact_type,
                    artifact_version,
                    status,
                    manifest_json
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    artifact_id,
                    workflow_execution_id,
                    workflow_id,
                    node_id,
                    workspace_ref,
                    "capture_flow_v1",
                    1,
                    status,
                    json.dumps(manifest),
                ),
            )
        connection.commit()
    return {
        "id": artifact_id,
        "workflowExecutionId": workflow_execution_id,
        "workflowId": workflow_id,
        "nodeId": node_id,
        "workspaceRef": workspace_ref,
        "artifactType": "capture_flow_v1",
        "artifactVersion": 1,
        "status": status,
        "manifestJson": manifest,
    }


def _build_agent_name() -> str:
    return SERVICE_AGENT_NAME


def _run_context_key(instance_id: str) -> str:
    return f"run:{instance_id}"


def _run_progress_key(instance_id: str) -> str:
    return f"progress:{instance_id}"


def _run_artifact_key(instance_id: str) -> str:
    return f"artifact:{instance_id}"


def _change_artifact_publish_key(instance_id: str) -> str:
    return f"artifact-published:{instance_id}"


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


def _normalize_change_file_status(raw_status: Any) -> str:
    value = str(raw_status or "").strip().lower()
    if value in {"a", "added", "untracked"}:
        return "A"
    if value in {"d", "deleted", "remove", "removed"}:
        return "D"
    if value in {"r", "renamed", "rename"}:
        return "R"
    return "M"


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


def _change_tracking_root(cwd: str) -> str:
    try:
        candidate = Path(cwd).expanduser().resolve()
    except Exception:
        return str(Path(cwd).expanduser())
    if not candidate.exists():
        return str(candidate)
    completed = _run_git_completed(["rev-parse", "--show-toplevel"], cwd=candidate)
    if completed.returncode == 0 and completed.stdout.strip():
        return str(Path(completed.stdout.strip()).expanduser().resolve())
    return str(candidate)


def _git_head_revision(root: str) -> str | None:
    candidate = Path(root).expanduser().resolve()
    if not candidate.exists():
        return None
    completed = _run_git_completed(["rev-parse", "HEAD"], cwd=candidate)
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def _normalized_change_files(change_summary: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(change_summary, dict):
        return []
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str | None]] = set()
    for file_entry in change_summary.get("files") or []:
        if not isinstance(file_entry, dict):
            continue
        path = str(file_entry.get("path") or "").strip()
        if not path:
            continue
        old_path = str(file_entry.get("oldPath") or "").strip() or None
        status = _normalize_change_file_status(file_entry.get("status"))
        dedupe_key = (path, old_path)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized.append(
            {
                "path": path,
                "status": status,
                **({"oldPath": old_path} if old_path else {}),
            }
        )
    return normalized


def _persisted_snapshot_inputs(
    file_snapshots: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    if not isinstance(file_snapshots, list):
        return snapshots
    for snapshot in file_snapshots:
        if not isinstance(snapshot, dict):
            continue
        path = str(snapshot.get("path") or "").strip()
        if not path:
            continue
        old_path = str(snapshot.get("oldPath") or "").strip() or None
        snapshots.append(
            {
                "path": path,
                "status": _normalize_change_file_status(snapshot.get("status")),
                **({"oldPath": old_path} if old_path else {}),
                "isBinary": bool(snapshot.get("isBinary")),
                **(
                    {"language": str(snapshot.get("language")).strip()}
                    if str(snapshot.get("language") or "").strip()
                    else {}
                ),
                "oldContent": (
                    snapshot.get("oldContent")
                    if isinstance(snapshot.get("oldContent"), str)
                    or snapshot.get("oldContent") is None
                    else None
                ),
                "newContent": (
                    snapshot.get("newContent")
                    if isinstance(snapshot.get("newContent"), str)
                    or snapshot.get("newContent") is None
                    else None
                ),
            }
        )
    return snapshots


def _publish_execution_change_artifact(
    run_context: AgentRunContext | None,
    *,
    change_summary: dict[str, Any] | None,
    patch: str,
    file_snapshots: list[dict[str, Any]] | None,
    operation: str = "agent-execute",
) -> None:
    if run_context is None or not run_context.execution_id or not run_context.workspace_ref:
        return
    if not WORKFLOW_BUILDER_INTERNAL_API_TOKEN:
        logger.debug(
            "Skipping durable execution change persistence for %s: internal token missing",
            run_context.instance_id,
        )
        return

    normalized_files = _normalized_change_files(change_summary)
    normalized_snapshots = _persisted_snapshot_inputs(file_snapshots)
    if not patch.strip() and not normalized_files and not normalized_snapshots:
        return

    try:
        already_published = run_state_store.load(
            key=_change_artifact_publish_key(run_context.instance_id),
            default={},
        )
    except StateStoreError:
        already_published = {}
    if isinstance(already_published, dict) and already_published.get("published"):
        return

    stats = (
        change_summary.get("stats")
        if isinstance(change_summary, dict) and isinstance(change_summary.get("stats"), dict)
        else {}
    )
    revision = _git_head_revision(run_context.cwd)
    payload = json.dumps(
        {
            "workspaceRef": run_context.workspace_ref,
            "operation": operation,
            "sequence": 1,
            "patch": patch,
            "files": normalized_files,
            "additions": int(stats.get("additions") or 0),
            "deletions": int(stats.get("deletions") or 0),
            "durableInstanceId": run_context.instance_id,
            "includeInExecutionPatch": True,
            "baseRevision": revision,
            "headRevision": revision,
            "fileSnapshots": normalized_snapshots,
        }
    ).encode("utf-8")
    url = (
        f"{WORKFLOW_BUILDER_BASE_URL}/api/internal/agent/workflows/executions/"
        f"{run_context.execution_id}/changes"
    )

    for attempt in range(1, 4):
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": WORKFLOW_BUILDER_INTERNAL_API_TOKEN,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                if 200 <= response.status < 300:
                    try:
                        run_state_store.save(
                            key=_change_artifact_publish_key(run_context.instance_id),
                            value={"published": True, "ts": _utc_now_iso()},
                        )
                    except StateStoreError as exc:
                        logger.warning(
                            "Failed to persist change artifact publish marker %s: %s",
                            run_context.instance_id,
                            exc,
                        )
                    logger.info(
                        "Persisted durable execution change artifact for %s with %s files and %s bytes of patch",
                        run_context.instance_id,
                        len(normalized_files),
                        len(patch.encode("utf-8")),
                    )
                    return
        except Exception as exc:
            if attempt == 3:
                logger.warning(
                    "Failed to persist durable execution change artifact for %s: %s",
                    run_context.instance_id,
                    exc,
                )
            else:
                time.sleep(0.2 * attempt)


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
        "fileSnapshots": result.get("fileSnapshots") or [],
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


def _parse_patch_file_entries(patch: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        old_path = str(current.get("oldPath") or "").strip() or None
        new_path = str(current.get("newPath") or "").strip() or None
        if not old_path and not new_path:
            current = None
            return
        if old_path and new_path and old_path != new_path:
            status = "R"
        elif not old_path and new_path:
            status = "A"
        elif old_path and not new_path:
            status = "D"
        else:
            status = "M"
        entries.append(
            {
                "path": new_path or old_path,
                "oldPath": old_path,
                "newPath": new_path,
                "status": status,
            }
        )
        current = None

    for line in patch.splitlines():
        if line.startswith("diff --git "):
            flush()
            parts = line.split()
            old_path = parts[2][2:] if len(parts) > 2 and parts[2].startswith("a/") else None
            new_path = parts[3][2:] if len(parts) > 3 and parts[3].startswith("b/") else None
            current = {"oldPath": old_path, "newPath": new_path}
            continue
        if current is None:
            continue
        if line.startswith("rename from "):
            current["oldPath"] = line.removeprefix("rename from ").strip() or None
        elif line.startswith("rename to "):
            current["newPath"] = line.removeprefix("rename to ").strip() or None
        elif line.startswith("--- "):
            value = line[4:].strip()
            current["oldPath"] = None if value == "/dev/null" else re.sub(r"^a/", "", value)
        elif line.startswith("+++ "):
            value = line[4:].strip()
            current["newPath"] = None if value == "/dev/null" else re.sub(r"^b/", "", value)

    flush()
    return entries


def _read_text_file(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_bytes().decode("utf-8", errors="replace")


def _read_git_head_file(workspace_root: Path, relative_path: str | None) -> str | None:
    normalized = str(relative_path or "").strip()
    if not normalized:
        return None
    completed = _run_git_completed(["show", f"HEAD:{normalized}"], cwd=workspace_root)
    if completed.returncode != 0:
        return None
    return completed.stdout


def _build_persisted_file_snapshots(
    workspace_root: str,
    patch: str,
    change_summary: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    root = Path(workspace_root).expanduser().resolve()
    if not root.exists():
        return []

    patch_entries = _parse_patch_file_entries(patch)
    if not patch_entries and isinstance(change_summary, dict):
        for file_entry in change_summary.get("files") or []:
            if not isinstance(file_entry, dict):
                continue
            path = str(file_entry.get("path") or "").strip()
            if not path:
                continue
            raw_status = str(file_entry.get("status") or "").strip().lower()
            if raw_status == "untracked":
                status = "A"
            elif raw_status in {"deleted", "d"}:
                status = "D"
            else:
                status = "M"
            patch_entries.append(
                {
                    "path": path,
                    "oldPath": None if status == "A" else path,
                    "newPath": None if status == "D" else path,
                    "status": status,
                }
            )

    snapshots: list[dict[str, Any]] = []
    seen_paths: set[tuple[str, str | None]] = set()
    for entry in patch_entries:
        path = str(entry.get("path") or "").strip()
        old_path = str(entry.get("oldPath") or "").strip() or None
        new_path = str(entry.get("newPath") or "").strip() or None
        status = str(entry.get("status") or "M").strip() or "M"
        if not path:
            continue
        dedupe_key = (path, old_path)
        if dedupe_key in seen_paths:
            continue
        seen_paths.add(dedupe_key)
        old_content = None if status == "A" else _read_git_head_file(root, old_path or path)
        new_content = (
            None
            if status == "D"
            else _read_text_file(root / (new_path or path))
        )
        snapshots.append(
            {
                "path": path,
                "oldPath": old_path,
                "status": status,
                "oldContent": old_content,
                "newContent": new_content,
            }
        )

    return snapshots


def _load_persisted_file_snapshot(
    execution_id: str,
    relative_path: str,
    *,
    durable_instance_id: str | None = None,
) -> dict[str, Any] | None:
    run_ids = (
        [durable_instance_id]
        if durable_instance_id
        else _load_execution_run_ids(execution_id)
    )
    requested_path = str(relative_path or "").strip()
    if not requested_path:
        return None
    for run_id in run_ids:
        artifact = _load_run_artifact(run_id)
        if not isinstance(artifact, dict):
            continue
        file_snapshots = artifact.get("fileSnapshots")
        if not isinstance(file_snapshots, list):
            continue
        for snapshot in file_snapshots:
            if not isinstance(snapshot, dict):
                continue
            snapshot_path = str(snapshot.get("path") or "").strip()
            snapshot_old_path = str(snapshot.get("oldPath") or "").strip()
            if requested_path not in {snapshot_path, snapshot_old_path}:
                continue
            return {
                "executionId": execution_id,
                "path": snapshot_path or requested_path,
                "oldPath": snapshot_old_path or None,
                "status": str(snapshot.get("status") or "M"),
                "oldContent": snapshot.get("oldContent"),
                "newContent": snapshot.get("newContent"),
            }
    return None


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


# ---------------------------------------------------------------------------
# SSE stream infrastructure — per-instance event queues
# ---------------------------------------------------------------------------
_stream_queues: dict[str, list[asyncio.Queue[dict[str, Any] | None]]] = {}
_stream_event_counter: dict[str, int] = {}
_stream_lock = threading.Lock()
_MAX_STREAM_QUEUE_SIZE = 500


def _push_stream_event(instance_id: str, event: dict[str, Any]) -> None:
    """Push an event to all SSE subscribers for this instance."""
    with _stream_lock:
        queues = _stream_queues.get(instance_id)
        if not queues:
            return
        counter = _stream_event_counter.get(instance_id, 0) + 1
        _stream_event_counter[instance_id] = counter
        event = {**event, "_seq": counter}
        for q in queues:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop oldest if queue is full
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    pass


def _register_stream_queue(instance_id: str) -> asyncio.Queue[dict[str, Any] | None]:
    """Register a new SSE subscriber queue for an instance."""
    q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=_MAX_STREAM_QUEUE_SIZE)
    with _stream_lock:
        _stream_queues.setdefault(instance_id, []).append(q)
    return q


def _unregister_stream_queue(instance_id: str, q: asyncio.Queue[dict[str, Any] | None]) -> None:
    """Remove an SSE subscriber queue."""
    with _stream_lock:
        queues = _stream_queues.get(instance_id)
        if queues:
            try:
                queues.remove(q)
            except ValueError:
                pass
            if not queues:
                _stream_queues.pop(instance_id, None)
                _stream_event_counter.pop(instance_id, None)


def _close_all_stream_queues(instance_id: str) -> None:
    """Signal completion to all SSE subscribers for an instance."""
    with _stream_lock:
        queues = _stream_queues.get(instance_id, [])
        for q in queues:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass


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

    # Push to SSE stream subscribers
    stream_event = {
        "type": event_type,
        "ts": _utc_now_iso(),
        "phase": phase,
        **{k: v for k, v in event.items() if k != "event"},
    }
    _push_stream_event(instance_id, stream_event)
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
    event_seq = _next_langgraph_event_sequence(instance_id)
    event_suffix = f"langgraph:{phase}:{event_type}:{event_seq}"

    if event_type == "model_start":
        turn = next_iteration + 1
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="model_start",
            phase=progress_phase,
            turn=turn,
            text=recent_turns[-1]["summary"],
        )
        return

    if event_type == "model_complete":
        turn = next_iteration or 1
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="model_complete",
            phase=progress_phase,
            turn=turn,
        )
        return

    tool_name = _progress_tool_name(event)
    tool_args = _progress_tool_args(event)
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="tool_start",
            phase=progress_phase,
            toolName=tool_name,
            toolArgs=tool_args,
        )
        return

    if event_type == "tool_complete":
        tool_status = str(event.get("status") or "completed").strip().lower()
        tool_result = _progress_tool_result(event)
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="tool_complete",
            phase=progress_phase,
            toolName=tool_name,
            toolArgs=tool_args,
            toolResult=tool_result,
            status=tool_status or "completed",
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="tool_error",
            phase=progress_phase,
            toolName=tool_name,
            toolArgs=tool_args,
            error=message or f"Failed tool {tool_name}",
        )
        return

    if event_type == "sandbox_output":
        exit_code = _progress_event_exit_code(event)
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, event_suffix),
            event_type="sandbox_output",
            phase=progress_phase,
            command=_progress_event_command(event),
            output=_progress_event_output_text(event),
            exitCode=exit_code,
            status=(
                "nonzero_exit"
                if exit_code is not None and exit_code != 0
                else "success"
            ),
        )


def _resolve_request_cwd(request: DaprAgentRunRequest) -> str:
    if request.cwd:
        return _resolve_cwd(request.cwd)
    if request.workspaceRef:
        session = _workspace_from_ref(request.workspaceRef)
        return str(session.working_directory or session.root_path)
    return _resolve_cwd(None)


def _derive_repository_url(
    repository_url: str | None,
    repository_owner: str | None,
    repository_repo: str | None,
) -> str | None:
    explicit = str(repository_url or "").strip()
    if explicit:
        return explicit
    owner = str(repository_owner or "").strip()
    repo = str(repository_repo or "").strip()
    if not owner or not repo:
        return None
    return f"{GITEA_INTERNAL_CLONE_BASE_URL}/{owner}/{repo}.git"


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
            phase = _progress_phase_for_mode(run_context.mode)
            _update_agent_progress(
                instance_id,
                phase=phase,
                status="running",
                currentIteration=next_iteration,
                activeToolName=None,
                summary=(
                    f"Planning iteration {next_iteration}"
                    if _is_planning_mode(run_context.mode)
                    else f"Reasoning iteration {next_iteration}"
                ),
            )
            _emit_agent_event(
                run_context,
                event_id=_event_payload_id(instance_id, f"model_start:{next_iteration}"),
                event_type="model_start",
                phase=phase,
                turn=next_iteration,
                text=(
                    f"Planning iteration {next_iteration}"
                    if _is_planning_mode(run_context.mode)
                    else f"Reasoning iteration {next_iteration}"
                ),
            )
        result = super().call_llm(ctx, payload)
        if run_context is not None:
            current_iteration = int(
                (_load_agent_progress(instance_id) or {}).get("currentIteration") or 0
            )
            _emit_agent_event(
                run_context,
                event_id=_event_payload_id(instance_id, f"model_complete:{current_iteration}"),
                event_type="model_complete",
                phase=_progress_phase_for_mode(run_context.mode),
                turn=current_iteration,
            )
        return result

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
        tool_call_id = str(tool_call.get("id") or uuid.uuid4().hex)
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, f"tool_start:{tool_call_id}"),
            event_type="tool_start",
            phase=tool_phase,
            toolName=fn_name,
            toolArgs=args,
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
        except Exception as exc:
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
            _emit_agent_event(
                run_context,
                event_id=_event_payload_id(instance_id, f"tool_error:{tool_call_id}"),
                event_type="tool_error",
                phase=_progress_phase_for_mode(run_context.mode),
                toolName=fn_name,
                toolArgs=args,
                error=str(exc) or f"Failed tool {fn_name}",
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
        if fn_name == "execute_command" and command:
            output_text, exit_code = _sandbox_output_text(result)
            _emit_agent_event(
                run_context,
                event_id=_event_payload_id(instance_id, f"sandbox_output:{tool_call_id}"),
                event_type="sandbox_output",
                phase=tool_phase,
                command=command,
                output=output_text,
                exitCode=exit_code,
                status="nonzero_exit" if isinstance(exit_code, int) and exit_code != 0 else "success",
            )
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
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, f"tool_complete:{tool_call_id}"),
            event_type="tool_complete",
            phase=tool_phase,
            toolName=fn_name,
            toolArgs=args,
            toolResult=serialized_result,
            status=(
                "nonzero_exit"
                if fn_name == "execute_command"
                and isinstance(result, dict)
                and int(result.get("exitCode") or 0) != 0
                else "success"
            ),
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
    repository_owner = (
        str(request.repositoryOwner or "").strip()
        or (workspace_session.repository_owner if workspace_session else None)
    )
    repository_repo = (
        str(request.repositoryRepo or "").strip()
        or (workspace_session.repository_repo if workspace_session else None)
    )
    repository_url = _derive_repository_url(
        str(request.repositoryUrl or "").strip()
        or (workspace_session.repository_url if workspace_session else None),
        repository_owner,
        repository_repo,
    )
    repository_branch = (
        str(request.repositoryBranch or "").strip()
        or (workspace_session.repository_branch if workspace_session else None)
    )
    tool_backend = _resolve_tool_backend(request)
    sandbox_name = str(request.sandboxName or "").strip() or None
    if not sandbox_name:
        sandbox_name = f"openshell-lg-{instance_id}".lower().replace("_", "-")[:63]
    sandbox_repo_path = str(request.sandboxRepoPath or "").strip() or None
    if tool_backend == "openshell" and not sandbox_repo_path:
        sandbox_repo_path = "/sandbox/repo"
    required_capabilities = _normalize_capability_list(request.requiredCapabilities)
    workspace_profile = (
        dict(request.workspaceProfile)
        if isinstance(request.workspaceProfile, dict)
        else (
            _build_workspace_profile(workspace_session)
            if workspace_session is not None
            else None
        )
    )
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
        required_capabilities=required_capabilities,
        preferred_execution_profile=(
            str(request.preferredExecutionProfile or "").strip() or None
        ),
        workspace_profile=workspace_profile,
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
            approval_payload = (
                artifact
                if artifact
                else {
                    "success": True,
                    "agentWorkflowId": instance_id,
                    "daprInstanceId": instance_id,
                    "traceId": progress.get("traceId"),
                    "agentProgress": progress,
                    "status": "awaiting_approval",
                    "approvalEventName": progress.get("approvalEventName"),
                }
            )
            return {
                "status": "awaiting_approval",
                "payload": {
                    **approval_payload,
                    "success": bool(approval_payload.get("success", True)),
                    "status": str(approval_payload.get("status") or "awaiting_approval"),
                    "agentWorkflowId": approval_payload.get("agentWorkflowId") or instance_id,
                    "daprInstanceId": approval_payload.get("daprInstanceId") or instance_id,
                    "traceId": approval_payload.get("traceId") or progress.get("traceId"),
                    "agentProgress": approval_payload.get("agentProgress") or progress,
                    "approvalEventName": approval_payload.get("approvalEventName")
                    or progress.get("approvalEventName"),
                    "approvalPayload": approval_payload.get("approvalPayload")
                    or artifact.get("approvalPayload"),
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
        sandbox_name_hint=run_context.sandbox_name,
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
    # Extract parent instance ID for parent→child mapping (enables BFF SSE resolution)
    parent_instance_id = (
        (input_data.get("parentExecutionId") if isinstance(input_data, dict) else None)
        or request.parentExecutionId
        or ""
    )
    run_context = _build_run_context(instance_id, request, trace_id=trace_id)
    if not ctx.is_replaying:
        _persist_run_context(run_context)
        if parent_instance_id:
            run_state_store.save(
                key=f"parent-child-map:{parent_instance_id}",
                value={"childInstanceId": instance_id, "ts": _utc_now_iso()},
            )
            logger.info("[parent-child-map] Saved mapping: %s -> %s", parent_instance_id, instance_id)
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
        _push_stream_event(instance_id, {
            "type": "run_started",
            "ts": _utc_now_iso(),
            "phase": "reasoning",
            "meta": {"profile": run_context.profile, "engine": run_context.engine},
        })
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, "run_started"),
            event_type="run_started",
            phase=_progress_phase_for_mode(run_context.mode),
            status="running",
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
    except Exception as exc:
        _update_agent_progress(
            instance_id,
            phase="failed",
            status="failed",
            activeToolName=None,
            stopReason=str(exc),
            summary=str(exc),
        )
        _emit_agent_event(
            run_context,
            event_id=_event_payload_id(instance_id, "run_error"),
            event_type="run_error",
            phase="failed",
            status="error",
            error=str(exc),
        )
        raise
    finally:
        cleanup_workflow_context(workflow_context_key)
        cleanup_workflow_context("__current_workflow_context__")
        # Signal SSE subscribers that the run is done
        _push_stream_event(instance_id, {"type": "run_complete", "ts": _utc_now_iso()})
        _close_all_stream_queues(instance_id)
        # Clean up parent→child mapping
        if parent_instance_id:
            try:
                run_state_store.delete(key=f"parent-child-map:{parent_instance_id}")
            except Exception:
                pass


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
    sandbox_template = str(request.sandboxTemplate or "").strip() or None
    root_path = _browser_workspace_root(
        request.executionId,
        request.rootPath,
        sandbox_template,
    )
    enabled_tools_raw = request.enabledTools
    enabled_tools = enabled_tools_raw if isinstance(enabled_tools_raw, list) else ["read", "write", "edit", "list", "bash"]
    if sandbox_template == "aio-browser":
        session = _create_browser_sandbox_session(
            execution_id=request.executionId,
            name=request.name,
            root_path=root_path,
            enabled_tools=[str(item) for item in enabled_tools],
            command_timeout_ms=request.commandTimeoutMs,
            sandbox_template=sandbox_template,
        )
    else:
        root_path.mkdir(parents=True, exist_ok=True)
        workspace_ref = f"workspace-{uuid.uuid4().hex[:12]}"
        session = WorkspaceSession(
            workspace_ref=workspace_ref,
            execution_id=request.executionId,
            root_path=root_path,
            working_directory=root_path,
            enabled_tools=[str(item) for item in enabled_tools],
            backend="local",
            command_timeout_ms=request.commandTimeoutMs,
            sandbox_template=sandbox_template,
            available_capabilities=_detect_available_capabilities(),
            repository_signals=_detect_repository_signals(root_path),
        )
    _persist_workspace_session(session)
    return _build_workspace_profile(session)


@app.post("/api/workspaces/clone")
def workspace_clone(request: WorkspaceCloneRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    target_dir = str(request.targetDir or request.repositoryRepo or "repo").strip() or "repo"
    clone_path = (session.root_path / target_dir).resolve()
    clone_url = _build_authenticated_git_url(
        request.repositoryUrl,
        request.repositoryUsername,
        request.repositoryToken,
    )
    if session.backend == "k8s":
        completed = _run_k8s_workspace_command(
            session,
            command=(
                "export GIT_TERMINAL_PROMPT=0 && "
                f"rm -rf {_shell_escape(str(clone_path))} && "
                f"mkdir -p {_shell_escape(str(clone_path.parent))} && "
                f"git clone --depth 1 --branch {_shell_escape(request.repositoryBranch)} "
                f"{_shell_escape(clone_url)} {_shell_escape(str(clone_path))}"
            ),
            cwd=session.root_path,
            timeout_ms=request.timeoutMs or 300_000,
        )
        if not completed["success"]:
            raise HTTPException(status_code=400, detail=completed["stderr"] or "git clone failed")
        commit_hash_result = _run_k8s_workspace_command(
            session,
            command="git rev-parse HEAD",
            cwd=clone_path,
            timeout_ms=30_000,
        )
        file_count_result = _run_k8s_workspace_command(
            session,
            command="find . -type f | wc -l",
            cwd=clone_path,
            timeout_ms=30_000,
        )
        commit_hash = str(commit_hash_result["stdout"]).strip()
        try:
            file_count = int(str(file_count_result["stdout"]).strip() or "0")
        except ValueError:
            file_count = 0
    else:
        if clone_path.exists():
            shutil.rmtree(clone_path)
        clone_path.parent.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        completed = subprocess.run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                request.repositoryBranch,
                clone_url,
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
    if session.backend == "local":
        session.repository_signals = _detect_repository_signals(session.working_directory)
    _persist_workspace_session(session)
    return {
        "clonePath": str(clone_path),
        "repository": f"{request.repositoryOwner or ''}/{request.repositoryRepo or ''}".strip("/"),
        "branch": request.repositoryBranch,
        "commitHash": commit_hash,
        "fileCount": file_count,
        "workingDirectory": str(session.working_directory),
        "workspaceProfile": _build_workspace_profile(session),
        **(summarize_command_changes(clone_path) if session.backend == "local" else _empty_change_summary()),
    }


@app.post("/api/workspaces/capabilities/validate")
def workspace_capabilities_validate(
    request: WorkspaceCapabilityValidationRequest,
) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    return _validate_workspace_capabilities(
        session,
        required_capabilities=_normalize_capability_list(
            request.requiredCapabilities
        ),
        sandbox_profile_ref=(str(request.sandboxProfileRef or "").strip() or None),
        preferred_execution_profile=(
            str(request.preferredExecutionProfile or "").strip() or None
        ),
        verify_commands=_parse_verify_commands(request.verifyCommands),
        tool_backend=(str(request.toolBackend or "").strip() or None),
    )


@app.post("/api/workspaces/command")
def workspace_command(request: WorkspaceCommandRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    if session.backend == "k8s":
        working_directory = (
            _resolve_workspace_path(session, request.cwd)
            if request.cwd
            else (session.working_directory or session.root_path)
        )
        result = _run_k8s_workspace_command(
            session,
            command=request.command,
            cwd=working_directory,
            timeout_ms=request.timeoutMs,
        )
        return {
            "stdout": result["stdout"],
            "stderr": result["stderr"],
            "exitCode": result["exitCode"],
            "success": result["success"],
            "executionTimeMs": result["executionTimeMs"],
            "timedOut": result["timedOut"],
            "workspaceProfile": _build_workspace_profile(session),
        }
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


@app.post("/api/browser/materialize-change-artifact")
def browser_materialize_change_artifact(
    request: BrowserMaterializeChangeArtifactRequest,
) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    if session.backend != "k8s":
        raise HTTPException(
            status_code=400,
            detail="Browser materialization requires a k8s-backed browser workspace",
        )
    source_execution_id = (
        str(request.sourceExecutionId or "").strip()
        or str(request.dbExecutionId or "").strip()
        or request.executionId
    )
    run_ids = (
        [request.durableInstanceId]
        if request.durableInstanceId
        else _load_execution_run_ids(source_execution_id)
    )
    selected_run_id: str | None = None
    selected_artifact: dict[str, Any] | None = None
    for run_id in run_ids:
        artifact = _load_run_artifact(run_id)
        if not isinstance(artifact, dict):
            continue
        file_snapshots = artifact.get("fileSnapshots")
        if isinstance(file_snapshots, list) and file_snapshots:
            selected_run_id = run_id
            selected_artifact = artifact
            break
    if selected_artifact is None or selected_run_id is None:
        raise HTTPException(
            status_code=404,
            detail=f"No durable change artifact found for execution {source_execution_id}",
        )

    restored_paths: list[str] = []
    deleted_paths: list[str] = []
    for snapshot in selected_artifact.get("fileSnapshots") or []:
        if not isinstance(snapshot, dict):
            continue
        relative_path = str(snapshot.get("path") or "").strip()
        if not relative_path:
            continue
        target_path = _resolve_workspace_path(session, relative_path)
        status = str(snapshot.get("status") or "M").strip().upper()
        if status == "D":
            _delete_remote_path(session, target_path)
            deleted_paths.append(str(target_path))
            continue
        new_content = snapshot.get("newContent")
        if not isinstance(new_content, str):
            raise HTTPException(
                status_code=400,
                detail=f"Binary file materialization is not supported for {relative_path}",
            )
        _write_remote_file(session, target_path, new_content)
        restored_paths.append(str(target_path))
        old_path = str(snapshot.get("oldPath") or "").strip()
        if old_path and old_path != relative_path:
            old_target_path = _resolve_workspace_path(session, old_path)
            _delete_remote_path(session, old_target_path)
            deleted_paths.append(str(old_target_path))

    return {
        "workspaceRef": session.workspace_ref,
        "changeSetId": str(selected_artifact.get("changeSetId") or f"{selected_run_id}-patch"),
        "operation": "dapr-agent-run",
        "restoredPaths": restored_paths,
        "deletedPaths": deleted_paths,
        "sandbox": {
            "backend": session.backend,
            "rootPath": str(session.root_path),
            "workingDirectory": str(session.working_directory or session.root_path),
            "details": dict(session.sandbox_details or {}),
        },
    }


@app.post("/api/browser/capture-flow")
def browser_capture_flow(request: BrowserCaptureFlowRequest) -> dict[str, Any]:
    if sync_playwright is None:
        raise HTTPException(status_code=500, detail="playwright is required for browser capture")
    session = _workspace_from_ref(request.workspaceRef)
    if session.backend != "k8s":
        raise HTTPException(
            status_code=400,
            detail="Browser capture requires a k8s-backed browser workspace",
        )
    if not request.steps:
        raise HTTPException(status_code=400, detail="steps must be a non-empty array")
    cdp_url = _browser_connection_info(session)
    timeout_ms = request.timeoutMs or DEFAULT_BROWSER_CAPTURE_TIMEOUT_MS
    logger.info(
        "browser_capture_flow workspace=%s steps=%d timeout=%dms cdp=%s",
        request.workspaceRef, len(request.steps), timeout_ms, cdp_url[:60],
    )
    screenshots: list[bytes] = []
    step_records: list[WorkflowBrowserCaptureStep] = []
    overall_status = "completed"
    logger.info(
        "Starting browser capture flow for execution=%s workspace=%s steps=%s timeout_ms=%s",
        request.dbExecutionId or request.executionId,
        request.workspaceRef,
        len(request.steps),
        timeout_ms,
    )
    try:
        with sync_playwright() as playwright:
            logger.info("Connecting to browser CDP for workspace=%s", request.workspaceRef)
            browser = playwright.chromium.connect_over_cdp(cdp_url, timeout=timeout_ms)
            try:
                context = browser.contexts[0] if browser.contexts else browser.new_context()
                page = context.pages[0] if context.pages else context.new_page()
                for index, step in enumerate(request.steps):
                    step_id = str(step.id or f"step-{index + 1}").strip() or f"step-{index + 1}"
                    label = str(step.label or f"Step {index + 1}").strip() or f"Step {index + 1}"
                    target_url = _resolve_browser_step_url(request.baseUrl, step)
                    logger.info(
                        "Capturing browser step id=%s label=%s url=%s workspace=%s",
                        step_id,
                        label,
                        target_url,
                        request.workspaceRef,
                    )
                    try:
                        png = _capture_browser_step_with_retry(
                            page,
                            target_url=target_url,
                            wait_for_selector=step.waitForSelector,
                            wait_for_text=step.waitForText,
                            delay_ms=step.delayMs,
                            full_page=(step.fullPage is not False),
                            timeout_ms=timeout_ms,
                        )
                        screenshots.append(png)
                        step_records.append(
                            WorkflowBrowserCaptureStep(
                                id=step_id,
                                label=label,
                                url=page.url,
                                title=page.title(),
                                wait_for_selector=step.waitForSelector,
                                wait_for_text=step.waitForText,
                                delay_ms=step.delayMs,
                                captured_at=_utc_now_iso(),
                                status="completed",
                            )
                        )
                    except (PlaywrightTimeoutError, PlaywrightError, Exception) as exc:
                        logger.warning(
                            "Browser capture step failed id=%s label=%s workspace=%s error=%s",
                            step_id,
                            label,
                            request.workspaceRef,
                            exc,
                        )
                        overall_status = "partial" if screenshots else "failed"
                        step_records.append(
                            WorkflowBrowserCaptureStep(
                                id=step_id,
                                label=label,
                                url=target_url,
                                wait_for_selector=step.waitForSelector,
                                wait_for_text=step.waitForText,
                                delay_ms=step.delayMs,
                                status="failed",
                                error=str(exc),
                            )
                        )
                        break
            finally:
                logger.info("Closing browser for workspace=%s", request.workspaceRef)
                browser.close()
    except Exception as exc:
        logger.exception(
            "Browser capture flow crashed for execution=%s workspace=%s",
            request.dbExecutionId or request.executionId,
            request.workspaceRef,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    artifact = _save_workflow_browser_artifact(
        workflow_execution_id=str(request.dbExecutionId or request.executionId),
        workflow_id=request.workflowId,
        node_id=request.nodeId,
        workspace_ref=session.workspace_ref,
        base_url=request.baseUrl,
        metadata=request.metadata,
        steps=step_records,
        screenshots=screenshots,
        status=overall_status,
    )
    logger.info(
        "Completed browser capture flow for execution=%s workspace=%s status=%s steps=%s artifact_id=%s",
        request.dbExecutionId or request.executionId,
        request.workspaceRef,
        overall_status,
        len(step_records),
        artifact["id"],
    )
    return {
        "artifact": artifact,
        "artifactId": artifact["id"],
        "stepCount": len(step_records),
        "status": overall_status,
        "sandbox": {
            "backend": session.backend,
            "rootPath": str(session.root_path),
            "workingDirectory": str(session.working_directory or session.root_path),
            "details": dict(session.sandbox_details or {}),
        },
    }


@app.post("/api/browser/validate")
def browser_validate(request: BrowserValidateRequest) -> dict[str, Any]:
    """Composite endpoint: install, start dev server, and capture screenshots in the coding sandbox."""
    timeout_ms = request.timeoutMs or 2_700_000
    timeout_seconds = max(timeout_ms // 1000, 60)
    execution_id = str(request.dbExecutionId or request.executionId).strip()
    logger.info(
        "browser_validate sandbox=%s repo=%s timeout=%ds execution=%s",
        request.sandboxName, request.repoPath, timeout_seconds, execution_id,
    )

    context = OpenShellToolContext(
        sandbox_name=request.sandboxName[:63],
        repo_path=request.repoPath,
    )

    # --- Step 1: Install dependencies ---
    try:
        logger.info("browser_validate install: sandbox=%s command=%s", request.sandboxName, request.installCommand[:120])
        install_result = context.run_command(
            request.installCommand,
            timeout_seconds=min(timeout_seconds, 900),
        )
        install_exit_code = install_result.get("exitCode", install_result.get("exit_code", -1))
        if install_exit_code != 0:
            error_msg = f"Install failed with exit code {install_exit_code}: {str(install_result.get('stderr') or install_result.get('stdout', ''))[:500]}"
            logger.warning("browser_validate install failed: %s", error_msg)
            return {"success": False, "error": error_msg, "phase": "install"}
    except Exception as exc:
        logger.exception("browser_validate install crashed: sandbox=%s", request.sandboxName)
        return {"success": False, "error": f"Install error: {str(exc)[:500]}", "phase": "install"}

    # --- Step 2: Start dev server in background ---
    try:
        logger.info("browser_validate devserver: sandbox=%s command=%s", request.sandboxName, request.devServerCommand[:120])
        context.run_command(
            request.devServerCommand,
            timeout_seconds=min(timeout_seconds, 60),
        )
    except Exception as exc:
        logger.warning("browser_validate devserver launch returned error (may be expected for background): %s", str(exc)[:200])

    # --- Step 3: Wait for dev server to be ready ---
    # Dev server binds in the sandbox user's network namespace; poll must also run as sandbox user.
    ready_poll_command = f"for i in $(seq 1 90); do if curl -s -o /dev/null -w '%{{http_code}}' {request.baseUrl} 2>/dev/null | grep -qE '^(200|304)'; then echo ready; exit 0; fi; sleep 2; done; echo timeout; exit 1"
    try:
        poll_result = context.run_command(ready_poll_command, timeout_seconds=200)
        stdout = str(poll_result.get("stdout") or "").strip()
        if "ready" not in stdout:
            logger.warning("browser_validate devserver not ready: %s", stdout[:200])
            return {"success": False, "error": f"Dev server did not become ready: {stdout[:200]}", "phase": "devserver-poll"}
    except Exception as exc:
        logger.warning("browser_validate devserver poll failed: %s", str(exc)[:200])
        return {"success": False, "error": f"Dev server poll error: {str(exc)[:300]}", "phase": "devserver-poll"}

    # --- Step 4: Run in-sandbox Playwright capture ---
    steps = request.steps
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except json.JSONDecodeError:
            return {"success": False, "error": "Invalid JSON in steps field", "phase": "capture"}
    steps_json = json.dumps([
        {
            "url": step.url or step.path or "/",
            "waitForSelector": step.waitForSelector,
            "waitForText": step.waitForText,
            "delayMs": step.delayMs,
        }
        if isinstance(step, BrowserCaptureStepRequest)
        else step
        for step in (steps or [{"url": "/", "waitForSelector": "body", "delayMs": 2500}])
    ])

    output_dir = "/tmp/wf-screenshots"

    # Playwright browsers are pre-installed in the sandbox image at /opt/pw-browsers.
    # Upload the capture script via base64 encoding to avoid heredoc quoting issues
    # with OpenShell's command API.
    encoded_script = base64.b64encode(_INLINE_CAPTURE_SCRIPT.strip().encode()).decode()
    upload_command = f"echo '{encoded_script}' | base64 -d > /sandbox/capture_screenshots.py && chmod +x /sandbox/capture_screenshots.py"
    try:
        context.run_command(upload_command, timeout_seconds=30)
    except Exception as exc:
        logger.warning("browser_validate upload capture script failed: %s", str(exc)[:200])

    pw_env = "PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers"
    capture_command = (
        f"{pw_env} python3 /sandbox/capture_screenshots.py "
        f"--base-url {shlex.quote(request.baseUrl)} "
        f"--steps {shlex.quote(steps_json)} "
        f"--output-dir {output_dir}"
    )

    # Run the capture via Xvfb (provides a virtual display for Chromium)
    xvfb_capture = f"xvfb-run --auto-servernum --server-args='-screen 0 1280x720x24' {capture_command}"
    screenshots: list[bytes] = []
    step_records: list[WorkflowBrowserCaptureStep] = []
    overall_status = "completed"
    try:
        capture_result = context.run_command(xvfb_capture, timeout_seconds=min(timeout_seconds, 300))
        capture_stdout = str(capture_result.get("stdout") or "").strip()
        capture_exit = capture_result.get("exitCode", capture_result.get("exit_code", -1))

        if capture_exit != 0:
            # Fallback: try without xvfb
            logger.info("browser_validate xvfb capture failed, trying headless directly")
            capture_result = context.run_command(capture_command, timeout_seconds=min(timeout_seconds, 300))
            capture_stdout = str(capture_result.get("stdout") or "").strip()
            capture_exit = capture_result.get("exitCode", capture_result.get("exit_code", -1))

        if capture_exit == 0 and "CAPTURE_OK" in capture_stdout:
            # Read manifest and convert PNGs to base64 files inside the sandbox,
            # then read the base64 text files (avoids binary data in stdout).
            try:
                convert_cmd = (
                    f"cd {output_dir} && "
                    f"for f in step-*.png; do "
                    f"  python3 -c \"import base64,sys; sys.stdout.write(base64.b64encode(open('$f','rb').read()).decode())\" > \"$f.b64\"; "
                    f"done && cat manifest.json"
                )
                manifest_result = context.run_command(convert_cmd, timeout_seconds=60)
                manifest_text = str(manifest_result.get("stdout") or "").strip()
                result_data = json.loads(manifest_text)
                if result_data.get("success"):
                    for ss in result_data.get("screenshots", []):
                        step_index = ss.get("step", 1) - 1
                        png_path = ss.get("path", "")
                        if not png_path:
                            continue
                        b64_file = f"{png_path}.b64"
                        # Read base64 in chunks to work around OpenShell stdout size limits.
                        # The API drops leading bytes on large outputs, so we split into 4KB chunks.
                        try:
                            size_result = context.run_command(
                                f"wc -c < {shlex.quote(b64_file)}",
                                timeout_seconds=10,
                            )
                            file_size = int(str(size_result.get("stdout") or "0").strip())
                            chunk_size = 4000
                            chunks: list[str] = []
                            for offset in range(0, file_size, chunk_size):
                                chunk_result = context.run_command(
                                    f"dd if={shlex.quote(b64_file)} bs=1 skip={offset} count={chunk_size} 2>/dev/null",
                                    timeout_seconds=15,
                                )
                                chunk = str(chunk_result.get("stdout") or "")
                                if chunk:
                                    chunks.append(chunk)
                            b64_text = "".join(chunks).strip()
                            if b64_text:
                                screenshots.append(base64.b64decode(b64_text))
                        except Exception as read_exc:
                            logger.warning("browser_validate read b64 failed step=%d: %s", step_index + 1, str(read_exc)[:200])
                            continue
                        step_label = f"Step {step_index + 1}"
                        if isinstance(steps, list) and step_index < len(steps):
                            s = steps[step_index]
                            if isinstance(s, BrowserCaptureStepRequest):
                                step_label = s.label or step_label
                            elif isinstance(s, dict):
                                step_label = s.get("label", step_label)
                        step_records.append(WorkflowBrowserCaptureStep(
                            id=f"step-{step_index + 1}",
                            label=step_label,
                            url=ss.get("url", ""),
                            captured_at=_utc_now_iso(),
                            status="completed",
                        ))
            except json.JSONDecodeError:
                logger.warning("browser_validate could not parse capture output: %s", capture_stdout[:200])
                overall_status = "failed"
        else:
            overall_status = "failed"
            logger.warning("browser_validate capture failed exit=%s stdout=%s", capture_exit, capture_stdout[:300])
    except Exception as exc:
        logger.exception("browser_validate capture crashed: sandbox=%s", request.sandboxName)
        overall_status = "failed"

    # --- Step 5: Persist screenshots as browser artifacts ---
    artifact: dict[str, Any] | None = None
    if screenshots and request.workflowId and request.nodeId:
        try:
            artifact = _save_workflow_browser_artifact(
                workflow_execution_id=execution_id,
                workflow_id=request.workflowId,
                node_id=request.nodeId,
                workspace_ref=None,
                base_url=request.baseUrl,
                metadata={"source": "browser-validate-in-sandbox", "sandboxName": request.sandboxName},
                steps=step_records,
                screenshots=screenshots,
                status=overall_status,
            )
        except Exception as exc:
            logger.exception("browser_validate artifact save failed: %s", str(exc)[:200])

    logger.info(
        "browser_validate completed sandbox=%s status=%s screenshots=%d artifact=%s",
        request.sandboxName, overall_status, len(screenshots),
        artifact["id"] if artifact else None,
    )
    return {
        "success": overall_status in ("completed", "partial"),
        "artifactId": artifact["id"] if artifact else None,
        "screenshots": len(screenshots),
        "status": overall_status,
        "error": None if overall_status == "completed" else f"Capture status: {overall_status}",
        "sandbox": {"sandboxName": request.sandboxName, "repoPath": request.repoPath},
    }


# Inline capture script for uploading to sandbox when the external file isn't available
_INLINE_CAPTURE_SCRIPT = r'''#!/usr/bin/env python3
"""In-sandbox screenshot capture. Writes manifest to output_dir/manifest.json."""
import argparse, base64, json, os, sys
from playwright.sync_api import sync_playwright

def capture(base_url, steps, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
            headless=True,
        )
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        for i, step in enumerate(steps):
            url = step.get("url") or step.get("path") or "/"
            if not url.startswith("http"):
                url = f"{base_url.rstrip('/')}/{url.lstrip('/')}"
            page.goto(url, wait_until="networkidle", timeout=30000)
            if step.get("waitForSelector"):
                page.wait_for_selector(step["waitForSelector"], timeout=15000)
            if step.get("waitForText"):
                page.get_by_text(step["waitForText"]).wait_for(timeout=15000)
            if step.get("delayMs"):
                page.wait_for_timeout(step["delayMs"])
            path = os.path.join(output_dir, f"step-{i + 1}.png")
            page.screenshot(path=path, full_page=True)
            results.append({"step": i + 1, "url": url, "path": path})
        browser.close()
    # Write manifest as a file (not stdout) to avoid large base64 data in command output
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({"success": True, "screenshots": results}, f)
    print(f"CAPTURE_OK {len(results)}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--steps", required=True)
    parser.add_argument("--output-dir", default="/tmp/screenshots")
    args = parser.parse_args()
    try:
        capture(args.base_url, json.loads(args.steps), args.output_dir)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
'''


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
    persisted_snapshot = _load_persisted_file_snapshot(
        execution_id,
        relative_path,
        durable_instance_id=durableInstanceId,
    )
    if persisted_snapshot is not None:
        return {
            "success": True,
            "executionId": execution_id,
            "path": relative_path,
            "durableInstanceId": durableInstanceId,
            "snapshot": persisted_snapshot,
        }
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


def _start_agent_run(
    request: DaprAgentRunRequest,
    http_request: Request,
    *,
    mode_override: str | None = None,
) -> dict[str, Any]:
    if mode_override:
        request = request.model_copy(update={"mode": mode_override})
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


@app.post("/api/plan")
def api_plan(request: DaprAgentRunRequest, http_request: Request) -> dict[str, Any]:
    return _start_agent_run(
        request.model_copy(
            update={
                "mode": PLAN_MODE,
                "waitForCompletion": True,
            }
        ),
        http_request,
    )


@app.post("/api/run")
def api_run(request: DaprAgentRunRequest, http_request: Request) -> dict[str, Any]:
    return _start_agent_run(request, http_request)


@app.post("/api/run-sandboxed")
def api_run_sandboxed(
    request: DaprAgentRunRequest,
    http_request: Request,
) -> dict[str, Any]:
    return _start_agent_run(
        request.model_copy(
            update={
                "mode": EXECUTE_MODE,
            }
        ),
        http_request,
    )


@app.get("/api/run/resolve-child")
def api_resolve_child(parentId: str) -> dict[str, Any]:
    """Resolve a child workflow instance ID from the parent orchestrator instance ID."""
    mapping = run_state_store.load(key=f"parent-child-map:{parentId}", default={})
    if not mapping:
        raise HTTPException(status_code=404, detail="No child mapping found")
    child_id = mapping.get("childInstanceId")
    if not child_id:
        raise HTTPException(status_code=404, detail="No child mapping found")
    return {"childInstanceId": child_id, "parentId": parentId}


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


@app.get("/api/run/{instance_id}/stream")
async def api_run_stream(instance_id: str, request: Request) -> StreamingResponse:
    """SSE endpoint streaming real-time agent events for a run."""
    run_context = _load_run_context(instance_id)
    progress = _load_agent_progress(instance_id)
    # Also check Dapr workflow state if no local context yet (race condition)
    if run_context is None and progress is None:
        workflow_client_instance = _resolve_runner_workflow_client()
        if workflow_client_instance is not None:
            try:
                state = workflow_client_instance.get_workflow_state(instance_id, fetch_payloads=False)
                runtime_status = getattr(getattr(state, "runtime_status", None), "name", "UNKNOWN")
                if runtime_status.upper() in ("RUNNING", "PENDING", "SUSPENDED"):
                    progress = {"status": "running", "phase": "starting"}
            except Exception:
                pass
        if progress is None:
            raise HTTPException(status_code=404, detail="Run not found")

    # Check for Last-Event-ID reconnection
    last_event_id = request.headers.get("Last-Event-ID")
    last_seq = 0
    if last_event_id:
        try:
            last_seq = int(last_event_id)
        except (ValueError, TypeError):
            last_seq = 0

    queue = _register_stream_queue(instance_id)

    async def event_generator():
        try:
            # Send initial state snapshot
            yield _sse_format(
                "agent_event",
                {
                    "type": "state_snapshot",
                    "ts": _utc_now_iso(),
                    "phase": progress.get("phase") if isinstance(progress, dict) else None,
                    "meta": {
                        "agentProgress": progress,
                        "lastSeq": last_seq,
                    },
                },
                event_id="0",
            )

            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    # Send keepalive comment
                    yield ": keepalive\n\n"
                    continue

                if event is None:
                    # None signals run completion
                    yield _sse_format(
                        "agent_event",
                        {"type": "run_complete", "ts": _utc_now_iso()},
                        event_id="done",
                    )
                    break

                seq = event.pop("_seq", 0)
                if seq <= last_seq:
                    continue

                yield _sse_format("agent_event", event, event_id=str(seq))

        except asyncio.CancelledError:
            pass
        finally:
            _unregister_stream_queue(instance_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sse_format(event: str, data: dict[str, Any], *, event_id: str | None = None) -> str:
    """Format a Server-Sent Event."""
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data, default=str)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines)


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
        toolBackend=str(request.input.get("toolBackend") or "").strip() or None,
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
        sandboxName=str(request.input.get("sandboxName") or "").strip() or None,
        provider=str(request.input.get("provider") or "").strip() or None,
        sandboxRepoPath=str(request.input.get("sandboxRepoPath") or "").strip() or None,
        repositoryUrl=str(request.input.get("repositoryUrl") or "").strip() or None,
        repositoryOwner=str(request.input.get("repositoryOwner") or "").strip() or None,
        repositoryRepo=str(request.input.get("repositoryRepo") or "").strip() or None,
        repositoryBranch=str(request.input.get("repositoryBranch") or "").strip() or None,
        repositoryToken=str(request.input.get("repositoryToken") or "").strip() or None,
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
        executionId=(
            str(request.input.get("executionId") or request.parent_execution_id or request.execution_id).strip()
            or None
        ),
        dbExecutionId=(
            str(request.input.get("dbExecutionId") or request.db_execution_id or "").strip()
            or None
        ),
        parentExecutionId=(
            str(request.input.get("parentExecutionId") or request.parent_execution_id or request.execution_id).strip()
            or None
        ),
        artifactRef=str(request.input.get("artifactRef") or "").strip() or None,
        planJson=request.input.get("planJson")
        if isinstance(request.input.get("planJson"), dict)
        else None,
        requiredCapabilities=request.input.get("requiredCapabilities"),
        preferredExecutionProfile=(
            str(request.input.get("preferredExecutionProfile") or "").strip()
            or None
        ),
        preferredSandboxProfile=(
            str(request.input.get("preferredSandboxProfile") or "").strip()
            or None
        ),
        workspaceProfile=request.input.get("workspaceProfile")
        if isinstance(request.input.get("workspaceProfile"), dict)
        else None,
        openAIApiKey=_extract_openai_api_key(request.credentials),
    )
    payload = api_run(run_request)
    return {"success": True, "data": payload, "duration_ms": 0}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
