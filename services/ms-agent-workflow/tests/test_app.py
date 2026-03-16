from types import SimpleNamespace

import app
from app import (
    ExecuteRequest,
    TEMPLATES,
    _build_public_result,
    _build_step_prompt,
    _coerce_text,
    _resolve_runtime_settings,
    execute_step,
    list_templates,
    runtime_introspect,
)
from config import TemplateRuntimeConfig


def test_templates_include_travel_planner() -> None:
    assert "travel-planner" in TEMPLATES
    assert "code-review" in TEMPLATES


def test_coerce_text_prefers_content() -> None:
    assert _coerce_text({"content": "Paris"}) == "Paris"


def test_build_public_result_exposes_text_and_instance_ids() -> None:
    result = _build_public_result(
        instance_id="wf-123",
        template_id="travel-planner",
        model="gpt-5.2",
        workflow_result={
            "content": "Day 1: North End",
            "steps": [{"agent": "PlannerAgent", "content": "Outline"}],
        },
    )

    assert result["text"] == "Day 1: North End"
    assert result["workflowTemplateId"] == "travel-planner"
    assert result["agentWorkflowId"] == "wf-123"
    assert result["daprInstanceId"] == "wf-123"


def test_build_public_result_exposes_code_review_artifacts() -> None:
    result = _build_public_result(
        instance_id="wf-789",
        template_id="code-review",
        model="gpt-5.2",
        workflow_result={
            "content": "Applied targeted fixes",
            "reviewFindings": "Potential null dereference in auth flow",
            "filesAnalyzed": ["src/auth.ts"],
            "fixesApplied": ["src/auth.ts"],
            "patch": "--- a/src/auth.ts\n+++ b/src/auth.ts",
            "steps": [],
        },
    )

    assert result["reviewFindings"] == "Potential null dereference in auth flow"
    assert result["filesAnalyzed"] == ["src/auth.ts"]
    assert result["fixesApplied"] == ["src/auth.ts"]
    assert result["patch"].startswith("--- a/src/auth.ts")


def test_build_step_prompt_supports_template_mode() -> None:
    step = TEMPLATES["travel-planner"].steps[1]
    prompt = _build_step_prompt(
        step=step,
        task="Plan a trip to Kyoto",
        step_context={"previous_output": "Kyoto", "step_0_output": "Kyoto"},
    )

    assert prompt == "Destination: Kyoto\nCreate a concise 3-day outline."


def test_resolve_runtime_settings_prefers_per_run_input(monkeypatch) -> None:
    template = TEMPLATES["code-review"]

    class FakeResolver:
        def resolve(self, **_kwargs):
            return TemplateRuntimeConfig(
                model="gpt-configured",
                instructions_overlay="Configured overlay",
                max_iterations=9,
                tool_group="read_only",
            )

    monkeypatch.setattr(app, "config_resolver", FakeResolver())

    settings = _resolve_runtime_settings(
        template,
        {
            "model": "gpt-request",
            "instructionsOverlay": "Request overlay",
            "maxIterations": 15,
            "toolGroup": "all",
        },
    )

    assert settings["model"] == "gpt-request"
    assert settings["instructions_overlay"] == "Request overlay"
    assert settings["max_iterations"] == 15
    assert settings["tool_group_override"] == "all"


def test_runtime_introspect_reports_generic_activity() -> None:
    response = runtime_introspect()

    assert response["activities"] == ["run_template_step"]
    assert "code-review" in [template["id"] for template in response["templates"]]


def test_list_templates_includes_code_review_tooling() -> None:
    response = list_templates()
    code_review = next(
        template for template in response["templates"] if template["id"] == "code-review"
    )

    assert code_review["supportsTools"] is True
    assert code_review["steps"][0]["toolGroup"] == "read_only"


def test_execute_step_returns_normalized_success_payload(monkeypatch) -> None:
    def fake_schedule(_request):
        return "wf-456", {"success": True}

    class FakeWorkflowClient:
        def wait_for_workflow_completion(self, instance_id: str, timeout_in_seconds: int):
            assert instance_id == "wf-456"
            assert timeout_in_seconds == 300
            return SimpleNamespace(
                runtime_status=SimpleNamespace(name="COMPLETED"),
                serialized_output=(
                    '{"content":"Boston itinerary","workflowTemplateId":"travel-planner","steps":[]}'
                ),
            )

    monkeypatch.setattr(app, "_schedule_workflow", fake_schedule)
    monkeypatch.setattr(app, "workflow_client", FakeWorkflowClient())

    response = execute_step(
        ExecuteRequest(
            step="run",
            execution_id="exec-1",
            workflow_id="workflow-1",
            node_id="node-1",
            input={
                "prompt": "Plan a trip to Boston",
                "workflowTemplateId": "travel-planner",
                "timeoutMinutes": 5,
            },
            credentials={"OPENAI_API_KEY": "test-key"},
        )
    )

    assert response["success"] is True
    assert response["data"]["text"] == "Boston itinerary"
    assert response["data"]["agentWorkflowId"] == "wf-456"
    assert isinstance(response["duration_ms"], int)
