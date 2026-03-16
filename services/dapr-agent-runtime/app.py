from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import threading
import urllib.request
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from tools import (
    DEFAULT_WORKSPACE_ROOT,
    TOOL_GROUPS,
    WORKSPACE_ENABLED_TOOLS,
    ToolRuntimeContext,
    bind_tool_group,
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
        def start(self) -> None:
            return None

        def shutdown(self) -> None:
            return None

    class _StubWorkflowModule:
        WorkflowRuntime = _StubWorkflowRuntime

    class DaprWorkflowClient:  # type: ignore[no-redef]
        def get_workflow_state(self, *args, **kwargs):
            raise RuntimeError("Dapr workflow client unavailable")

        def terminate_workflow(self, *args, **kwargs):
            return None

    wf = _StubWorkflowModule()

try:
    from dapr_agents import DaprChatClient, DurableAgent, OpenAIChatClient
    from dapr_agents.agents.configs import (
        AgentExecutionConfig,
        AgentMemoryConfig,
        AgentObservabilityConfig,
        AgentRegistryConfig,
        AgentStateConfig,
        WorkflowRetryPolicy,
    )
    from dapr_agents.memory import ConversationDaprStateMemory
    from dapr_agents.storage.daprstores.stateservice import StateStoreError, StateStoreService
    from dapr_agents.workflow.runners.agent import AgentRunner
except ImportError:  # pragma: no cover
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


logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

PORT = int(os.environ.get("PORT", "8082"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_MODEL = os.environ.get("OPENAI_CHAT_MODEL_ID", "gpt-4o")
SERVICE_VERSION = "0.1.0"
AGENT_TOOL_GROUP = os.environ.get("DAPR_AGENT_TOOL_GROUP", "all")
WORKSPACE_ROOT = Path(DEFAULT_WORKSPACE_ROOT).expanduser().resolve()
WORKFLOW_NAME = os.environ.get("DAPR_AGENT_CHILD_WORKFLOW_RUN_NAME", "daprAgentRunWorkflowV1")
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
DAPR_AGENT_ENABLE_MEMORY = os.environ.get("DAPR_AGENT_ENABLE_MEMORY", "true").strip().lower() == "true"
DAPR_AGENT_ENABLE_REGISTRY = os.environ.get("DAPR_AGENT_ENABLE_REGISTRY", "true").strip().lower() == "true"
DAPR_AGENT_LLM_BACKEND = os.environ.get("DAPR_AGENT_LLM_BACKEND", "openai").strip().lower()
DAPR_AGENT_LLM_COMPONENT = os.environ.get("DAPR_AGENT_LLM_COMPONENT") or os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT"
)


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
    writePolicy: str | None = None
    shellPolicy: str | None = None
    openAIApiKey: str | None = None


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
            enabled_tools=[str(item) for item in record.get("enabledTools") or []],
            repository_url=str(record.get("repositoryUrl") or "").strip() or None,
            repository_owner=str(record.get("repositoryOwner") or "").strip() or None,
            repository_repo=str(record.get("repositoryRepo") or "").strip() or None,
            repository_branch=str(record.get("repositoryBranch") or "").strip() or None,
        )


workspace_sessions: dict[str, WorkspaceSession] = {}
sessions_by_execution: dict[str, set[str]] = {}
runtime = wf.WorkflowRuntime()
workflow_client = DaprWorkflowClient()
runner = AgentRunner(name="dapr-agent-runtime", timeout_in_seconds=3600)
_agent_lock = threading.Lock()
_agent_cache: dict[tuple[str, str, str], DurableAgent] = {}
workspace_state_store = StateStoreService(
    store_name=DAPR_AGENT_STATE_STORE_NAME,
    key_prefix=DAPR_AGENT_WORKSPACE_STATE_KEY_PREFIX,
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
            "Operate only within this repository root and prefer absolute paths when using tools."
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
    workflow_output: str | None,
) -> dict[str, Any]:
    text = _coerce_text(workflow_output)
    cwd = _resolve_cwd(request.cwd)
    summary = summarize_command_changes(cwd)
    patch = ""
    try:
        patch = git_diff(path=cwd).get("diff", "")
    except Exception:
        patch = ""
    return {
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
        "traceId": None,
        "runSummary": {
            "profile": _normalize_profile(request.profile),
            "cwd": cwd,
            "workspaceRef": request.workspaceRef,
            "toolGroup": _resolve_effective_tool_group(request),
        },
    }


def _coerce_text(workflow_output: str | None) -> str:
    if not workflow_output:
        return ""
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


def _build_agent_name(profile: str) -> str:
    return f"dapr-agent-{profile}"


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
    profile: str,
    model: str,
    tool_group: str,
) -> dict[str, Any]:
    return {
        "profile": profile,
        "framework": "Dapr Agents",
        "durable": True,
        "workflowName": WORKFLOW_NAME,
        "toolGroup": tool_group,
        "defaultModel": model,
        "supportsWorkspaceTools": True,
        "stateStore": DAPR_AGENT_STATE_STORE_NAME,
        "memoryStore": DAPR_AGENT_MEMORY_STORE_NAME if DAPR_AGENT_ENABLE_MEMORY else None,
        "registryStore": DAPR_AGENT_REGISTRY_STORE_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
    }


def _build_registry_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for profile in sorted(PROFILE_INSTRUCTIONS.keys()):
        tool_group = PROFILE_TOOL_GROUPS.get(profile, AGENT_TOOL_GROUP)
        entries.append(
            {
                "name": _build_agent_name(profile),
                "metadata": _build_agent_registry_metadata(
                    profile=profile,
                    model=DEFAULT_MODEL,
                    tool_group=tool_group,
                ),
            }
        )
    return entries


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


def _build_llm_client(model: str, api_key: str | None) -> Any:
    if DAPR_AGENT_LLM_BACKEND == "dapr" and DAPR_AGENT_LLM_COMPONENT:
        return DaprChatClient(model=model, component_name=DAPR_AGENT_LLM_COMPONENT)
    return OpenAIChatClient(
        model=model,
        api_key=api_key or os.environ.get("OPENAI_API_KEY"),
    )


def _build_durable_support_configs(profile: str) -> dict[str, Any]:
    state = AgentStateConfig(
        store=StateStoreService(
            store_name=DAPR_AGENT_STATE_STORE_NAME,
            key_prefix=f"{DAPR_AGENT_STATE_KEY_PREFIX}runs:{profile}:",
        ),
        state_key_prefix=f"{profile}:",
    )
    memory = (
        AgentMemoryConfig(
            store=ConversationDaprStateMemory(
                store_name=DAPR_AGENT_MEMORY_STORE_NAME,
                agent_name=_build_agent_name(profile),
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
    }


def _get_agent(request: DaprAgentRunRequest) -> DurableAgent:
    profile = _normalize_profile(request.profile)
    model = str(request.model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    workspace_root = _resolve_cwd(request.cwd)
    tool_group = _resolve_effective_tool_group(request)
    cache_key = (profile, model, workspace_root, tool_group)

    with _agent_lock:
        agent = _agent_cache.get(cache_key)
        if agent is None:
            support = _build_durable_support_configs(profile)
            agent = DurableAgent(
                name=_build_agent_name(profile),
                role="autonomous coding agent",
                goal="Complete coding tasks in a durable, tool-using workflow",
                instructions=[
                    "Use the available tools to inspect, edit, and verify code.",
                    "When changing code, keep edits minimal and explain what changed.",
                    "Prefer deterministic verification commands when they are provided.",
                ],
                llm=_build_llm_client(model, request.openAIApiKey),
                tools=bind_tool_group(tool_group, workspace_root),
                execution=AgentExecutionConfig(
                    max_iterations=max(int(request.maxTurns or 30), 1),
                    tool_choice="auto",
                ),
                state=support["state"],
                memory=support["memory"],
                registry=support["registry"],
                retry_policy=support["retry_policy"],
                agent_observability=support["observability"],
                agent_metadata=_build_agent_registry_metadata(
                    profile=profile,
                    model=model,
                    tool_group=tool_group,
                ),
                runtime=runtime,
            )
            try:
                agent.start()
            except RuntimeError as exc:
                logger.warning("Failed to start durable agent %s: %s", agent.name, exc)
            _agent_cache[cache_key] = agent
        return agent


async def _run_agent_request(
    request: DaprAgentRunRequest,
    *,
    instance_id: str,
    wait: bool,
) -> str | None:
    prompt = _build_task_prompt(request)
    agent = _get_agent(request)
    return await runner.run(
        agent,
        payload=prompt,
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
    runtime.start()
    try:
        for profile in sorted(PROFILE_INSTRUCTIONS.keys()):
            _get_agent(
                DaprAgentRunRequest(
                    prompt="Initialize durable coding agent runtime",
                    profile=profile,
                )
            )
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to eagerly initialize dapr-agent runtime: %s", exc)
    try:
        yield
    finally:
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
        "registry": {
            "enabled": DAPR_AGENT_ENABLE_REGISTRY,
            "storeName": DAPR_AGENT_REGISTRY_STORE_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
            "teamName": DAPR_AGENT_REGISTRY_TEAM_NAME if DAPR_AGENT_ENABLE_REGISTRY else None,
            "registeredAgents": _build_registry_entries(),
        },
        "additional": {
            "stateStoreName": DAPR_AGENT_STATE_STORE_NAME,
            "memoryStoreName": DAPR_AGENT_MEMORY_STORE_NAME if DAPR_AGENT_ENABLE_MEMORY else None,
            "workspaceStateStoreName": DAPR_AGENT_STATE_STORE_NAME,
            "llmBackend": DAPR_AGENT_LLM_BACKEND,
            "llmComponent": DAPR_AGENT_LLM_COMPONENT,
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
    session.root_path = clone_path.parent.resolve()
    _persist_workspace_session(session)
    return {
        "clonePath": str(clone_path),
        "repository": f"{request.repositoryOwner or ''}/{request.repositoryRepo or ''}".strip("/"),
        "branch": request.repositoryBranch,
        "commitHash": commit_hash,
        "fileCount": file_count,
        **summarize_command_changes(clone_path),
    }


@app.post("/api/workspaces/command")
def workspace_command(request: WorkspaceCommandRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    completed = subprocess.run(
        request.command,
        cwd=session.root_path,
        shell=True,
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
        **summarize_command_changes(session.root_path),
    }


@app.post("/api/workspaces/file")
def workspace_file(request: WorkspaceFileRequest) -> dict[str, Any]:
    session = _workspace_from_ref(request.workspaceRef)
    context = ToolRuntimeContext.from_workspace_root(session.root_path)
    operation = request.operation.strip().lower()
    if operation == "read":
        if not request.path:
            raise HTTPException(status_code=400, detail="path is required for read")
        return {"content": read_file(request.path, tool_context=context)}
    if operation == "write":
        if not request.path:
            raise HTTPException(status_code=400, detail="path is required for write")
        return {
            **write_file(request.path, request.content or "", tool_context=context),
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
                tool_context=context,
            ),
            **context.build_summary(),
        }
    if operation == "list":
        return {"files": list_files(request.path or ".", tool_context=context)}
    raise HTTPException(status_code=400, detail=f"Unsupported operation: {request.operation}")


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


@app.post("/api/run")
def api_run(request: DaprAgentRunRequest) -> dict[str, Any]:
    instance_id = f"dapr-agent-run-{uuid.uuid4().hex[:12]}"
    if request.waitForCompletion:
        workflow_output = runner.run_sync(
            _get_agent(request),
            payload=_build_task_prompt(request),
            instance_id=instance_id,
            timeout_in_seconds=request.timeoutMinutes * 60,
            fetch_payloads=True,
            log=True,
        )
        result = _build_result_payload(
            instance_id=instance_id,
            request=request,
            workflow_output=workflow_output,
        )
        return {"success": True, "result": result, **result}

    asyncio.run(_run_agent_request(request, instance_id=instance_id, wait=False))
    return {
        "success": True,
        "status": "running",
        "workflow_id": instance_id,
        "workflowId": instance_id,
        "agentWorkflowId": instance_id,
        "daprInstanceId": instance_id,
        "status_url": f"/api/run/{instance_id}",
    }


@app.get("/api/run/{instance_id}")
def api_run_status(instance_id: str) -> dict[str, Any]:
    state = runner.workflow_client.get_workflow_state(instance_id, fetch_payloads=True)
    runtime_status = getattr(getattr(state, "runtime_status", None), "name", "UNKNOWN")
    return {
        "instanceId": instance_id,
        "status": str(runtime_status).lower(),
        "runtimeStatus": runtime_status,
        "serializedOutput": getattr(state, "serialized_output", None),
    }


@app.post("/api/run/{instance_id}/terminate")
def api_run_terminate(instance_id: str, request: TerminateRequest) -> dict[str, Any]:
    runner.terminate_workflow(instance_id, output=request.reason or "terminated")
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
