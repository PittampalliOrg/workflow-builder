from types import SimpleNamespace

import app
from app import ExecuteRequest, TEMPLATES, _build_public_result, _coerce_text, execute_step


def test_templates_include_travel_planner() -> None:
    assert "travel-planner" in TEMPLATES


def test_coerce_text_prefers_content() -> None:
    assert _coerce_text({"content": "Paris"}) == "Paris"


def test_build_public_result_exposes_text_and_instance_ids() -> None:
    result = _build_public_result(
        instance_id="wf-123",
        template_id="travel-planner",
        model="gpt-4o-mini",
        workflow_result={
            "content": "Day 1: North End",
            "steps": [{"agent": "PlannerAgent", "content": "Outline"}],
        },
    )

    assert result["text"] == "Day 1: North End"
    assert result["workflowTemplateId"] == "travel-planner"
    assert result["agentWorkflowId"] == "wf-123"
    assert result["daprInstanceId"] == "wf-123"


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
