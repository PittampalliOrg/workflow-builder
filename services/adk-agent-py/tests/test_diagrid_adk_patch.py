from dataclasses import dataclass
from pathlib import Path
import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.telemetry import diagrid_adk  # noqa: E402


def _fake_module() -> types.ModuleType:
    module = types.ModuleType("fake_diagrid_workflow")
    module.call_llm_activity = lambda ctx, input_data: {
        "message": {"role": "model", "content": "done", "tool_calls": []},
        "is_final": True,
        "error": None,
    }
    module.execute_tool_activity = lambda ctx, input_data: {}
    module.agent_workflow = lambda ctx, input_data: None
    return module


def test_install_patch_replaces_runner_globals_and_is_idempotent(monkeypatch):
    diagrid_adk._PATCHED = False

    diagrid = types.ModuleType("diagrid")
    agent = types.ModuleType("diagrid.agent")
    adk = types.ModuleType("diagrid.agent.adk")
    workflow = _fake_module()
    runner = types.ModuleType("diagrid.agent.adk.runner")
    runner.agent_workflow = workflow.agent_workflow
    runner.call_llm_activity = workflow.call_llm_activity
    runner.execute_tool_activity = workflow.execute_tool_activity

    diagrid.agent = agent
    agent.adk = adk
    adk.workflow = workflow
    adk.runner = runner

    for name, module in {
        "diagrid": diagrid,
        "diagrid.agent": agent,
        "diagrid.agent.adk": adk,
        "diagrid.agent.adk.workflow": workflow,
        "diagrid.agent.adk.runner": runner,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    original_call_llm = workflow.call_llm_activity

    diagrid_adk.install_diagrid_adk_telemetry_patch()

    assert workflow.call_llm_activity is not original_call_llm
    assert runner.agent_workflow is workflow.agent_workflow
    assert runner.call_llm_activity is workflow.call_llm_activity
    assert runner.execute_tool_activity is workflow.execute_tool_activity
    first_call_llm = workflow.call_llm_activity

    diagrid_adk.install_diagrid_adk_telemetry_patch()

    assert workflow.call_llm_activity is first_call_llm


def test_call_llm_activity_publishes_iteration_start_usage_and_tool_use(monkeypatch):
    module = _fake_module()
    module.call_llm_activity = lambda ctx, input_data: {
        "message": {
            "role": "model",
            "content": None,
            "tool_calls": [
                {"id": "call-1", "name": "Bash", "args": {"command": "date"}},
            ],
        },
        "is_final": False,
        "error": None,
    }
    monkeypatch.setattr(diagrid_adk, "get_tracer", lambda: None)
    monkeypatch.setattr(diagrid_adk, "_pop_gemini_usage", lambda: {"input_tokens": 5})

    calls = []
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_iteration",
        lambda tel, cfg, max_iterations=None: calls.append(
            ("iteration", tel, cfg, max_iterations)
        ),
    )
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_llm_start",
        lambda tel, cfg: calls.append(("llm_start", tel, cfg)),
    )
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_llm_usage",
        lambda tel, cfg, usage, **kwargs: calls.append(
            ("llm_usage", tel, cfg, usage, kwargs)
        ),
    )
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_tool_use",
        lambda tel, tool_call: calls.append(("tool_use", tel, tool_call)),
    )

    diagrid_adk._patch_workflow_module(module)
    output = module.call_llm_activity(
        None,
        {
            "agent_config": {"model": "gemini-2.5-flash", "provider": "gemini"},
            "_telemetry_context": {
                "agent.session.id": "sess-1",
                "workflow.instance_id": "child-1",
                "agent.iteration": 0,
                "agent.max_iterations": 3,
            },
        },
    )

    assert output["is_final"] is False
    assert [call[0] for call in calls] == [
        "iteration",
        "llm_start",
        "llm_usage",
        "tool_use",
    ]
    assert calls[0][3] == 3
    assert calls[2][3] == {"input_tokens": 5}
    assert calls[3][2]["id"] == "call-1"


def test_execute_tool_activity_publishes_result_and_event_actions(monkeypatch):
    module = _fake_module()
    monkeypatch.setattr(diagrid_adk, "get_tracer", lambda: None)

    @dataclass
    class Actions:
        state_delta: dict

    monkeypatch.setattr(
        diagrid_adk,
        "_execute_tool_activity_with_actions",
        lambda module, input_data: (
            {
                "tool_result": {
                    "tool_call_id": "call-1",
                    "tool_name": "Bash",
                    "result": "ok",
                    "error": None,
                }
            },
            Actions(state_delta={"done": True}),
        ),
    )

    calls = []
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_tool_result",
        lambda tel, result, **kwargs: calls.append(
            ("tool_result", tel, result, kwargs)
        ),
    )
    monkeypatch.setattr(
        diagrid_adk,
        "publish_adk_event_actions",
        lambda tel, tool_call, actions: calls.append(
            ("actions", tel, tool_call, actions)
        ),
    )

    diagrid_adk._patch_workflow_module(module)
    output = module.execute_tool_activity(
        None,
        {
            "tool_call": {"id": "call-1", "name": "Bash", "args": {"command": "date"}},
            "_telemetry_context": {
                "agent.session.id": "sess-1",
                "workflow.instance_id": "child-1",
                "agent.iteration": 0,
            },
        },
    )

    assert output["tool_result"]["result"] == "ok"
    assert [call[0] for call in calls] == ["tool_result", "actions"]
    assert calls[0][2]["tool_call_id"] == "call-1"
    assert calls[1][2]["id"] == "call-1"
