"""The dapr-agent-py workspace RUNTIME MODE must be coupled to the shared JuiceFS
CSI mount, so a mounted session always runs LocalWorkspaceRuntime (writes land in the
ws_script_ subtree) and never OpenShellRuntime (throwaway remote sandbox)."""
from __future__ import annotations

from src.app import (
    AgentWorkflowHostRequest,
    ExecutionClassConfig,
    build_agent_workflow_host_sandbox_manifest,
)

DAPR_IMAGE = "ghcr.io/example/dapr-agent-py-sandbox:git-1"
CLI_IMAGE = "ghcr.io/example/cli-agent-py-sandbox:git-1"


def _juicefs_class(**overrides) -> ExecutionClassConfig:
    fields = {
        "localQueue": "interactive-agent",
        "sharedWorkspaceStoreCsiDriver": "csi.juicefs.com",
        "sharedWorkspaceStoreSecretName": "juicefs-wfbcli",
        "sharedWorkspaceStoreMountPath": "/sandbox/work",
    }
    fields.update(overrides)
    return ExecutionClassConfig(**fields)


def _request(**overrides) -> AgentWorkflowHostRequest:
    fields = {
        "sessionId": "session-1",
        "agentAppId": "agent-session-1",
        "executionClass": "dapr-agent-py-juicefs",
        "timeoutSeconds": 900,
        "agentImage": DAPR_IMAGE,
        "sharedWorkspaceKey": "ws_script_exec-1",
    }
    fields.update(overrides)
    return AgentWorkflowHostRequest(**fields)


def _container_env(manifest: dict) -> dict[str, str]:
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    return {e["name"]: e.get("value") for e in container.get("env", []) if "value" in e}


def test_mounted_juicefs_session_forces_local_workspace_mode():
    # The class agentHostEnv sets it too, but assert it's present even when the class
    # OMITS it (config drift) — the mount-coupled forcing must still win.
    manifest = build_agent_workflow_host_sandbox_manifest(
        _request(),
        namespace="workflow-builder",
        class_config=_juicefs_class(agentHostEnv={}),
    )
    env = _container_env(manifest)
    assert env.get("DAPR_AGENT_PY_WORKSPACE_MODE") == "local"
    assert env.get("DAPR_AGENT_PY_LOCAL_WORKSPACE_ROOT") == "/sandbox/work"


def test_forced_mode_overrides_a_stale_class_env():
    # A drifted class that pins openshell must be overridden — the mount is authoritative.
    manifest = build_agent_workflow_host_sandbox_manifest(
        _request(),
        namespace="workflow-builder",
        class_config=_juicefs_class(
            agentHostEnv={"DAPR_AGENT_PY_WORKSPACE_MODE": "openshell"}
        ),
    )
    assert _container_env(manifest).get("DAPR_AGENT_PY_WORKSPACE_MODE") == "local"


def test_no_shared_workspace_key_does_not_force_local():
    # A pod-local dapr-agent-py session (no shared mount) keeps its default runtime.
    manifest = build_agent_workflow_host_sandbox_manifest(
        _request(sharedWorkspaceKey=None),
        namespace="workflow-builder",
        class_config=_juicefs_class(agentHostEnv={}),
    )
    assert "DAPR_AGENT_PY_WORKSPACE_MODE" not in _container_env(manifest)


def test_cli_image_is_not_given_the_dapr_workspace_mode():
    # cli-agent-py handles its own workspace; the dapr-agent-py env must not leak onto it.
    manifest = build_agent_workflow_host_sandbox_manifest(
        _request(agentImage=CLI_IMAGE),
        namespace="workflow-builder",
        class_config=_juicefs_class(agentHostEnv={}),
    )
    assert "DAPR_AGENT_PY_WORKSPACE_MODE" not in _container_env(manifest)
