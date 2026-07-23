from __future__ import annotations

import importlib

from activities import prepare_script_call as prepare_module

sw_workflow_module = importlib.import_module("workflows.sw_workflow")


def test_dynamic_script_sandbox_turn_budget_reaches_session_bridge(monkeypatch):
    captured: dict = {}

    monkeypatch.setattr(
        sw_workflow_module,
        "_resolve_native_agent_runtime",
        lambda _args, _config: (
            "pydantic-ai-agent-py",
            {
                "app_id": "agent-runtime-test",
                "dispatch_workflow_name": "session_workflow",
            },
        ),
    )

    def spawn_session(_ctx, payload):
        captured.update(payload)
        return {
            "agentAppId": "agent-runtime-test",
            "agentId": "agent-1",
            "childInput": {
                "sessionId": payload["sessionId"],
                "maxIterations": payload["maxIterations"],
            },
        }

    monkeypatch.setattr(prepare_module, "spawn_session_for_workflow", spawn_session)

    result = prepare_module.prepare_script_call(
        None,
        {
            "callId": "call-1",
            "executionId": "execution-1",
            "parentInstanceId": "parent-1",
            "workflowId": "workflow-1",
            "userId": "user-1",
            "projectId": "project-1",
            "meta": {"name": "budget contract"},
            "defaults": {},
            "limits": {},
            "spec": {
                "kind": "agent",
                "prompt": "Build the UI",
                "opts": {
                    "agentType": "pydantic-ai-agent-py",
                    "sandbox": {
                        "workspaceRef": "workspace-1",
                        "maxTurns": 20,
                    },
                },
            },
        },
    )

    assert captured["maxIterations"] == 20
    assert result["bridgePayload"]["maxIterations"] == 20
    assert result["childInput"]["maxIterations"] == 20
