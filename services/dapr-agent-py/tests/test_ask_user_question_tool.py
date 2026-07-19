"""Tests for the AskUserQuestion tool (args model wire schema + pub/sub behavior)."""

from __future__ import annotations

import json
import os
import sys
from unittest import mock

import pytest
from pydantic import ValidationError

# ask_user modules don't depend on dapr_agents -- import them directly
# by adjusting sys.path to avoid triggering src.tools.__init__ which
# imports dapr_agents.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "tools"))

from ask_user.tool import AskUserQuestionArgs, Option, Question, ask_user
from ask_user.prompt import ASK_USER_TOOL_NAME, get_ask_user_description


def _branch(schema: dict, type_name: str) -> dict:
    """Find the ``type_name`` branch of an anyOf (Optional[...]) schema."""
    for sub in schema.get("anyOf", [schema]):
        if sub.get("type") == type_name:
            return sub
    raise AssertionError(f"no {type_name!r} branch in {schema!r}")


def _defs(schema: dict) -> dict:
    return schema.get("$defs", {})


# ============================================================================
# Wire schema shape
# ============================================================================


class TestWireSchema:
    def test_top_level_shape(self):
        schema = AskUserQuestionArgs.model_json_schema()
        assert schema["additionalProperties"] is False
        assert schema["required"] == ["questions"]
        questions = schema["properties"]["questions"]
        assert questions["type"] == "array"
        assert questions["minItems"] == 1
        assert questions["maxItems"] == 4
        assert questions["description"]

    def test_nested_models_forbid_extra(self):
        defs = _defs(AskUserQuestionArgs.model_json_schema())
        assert defs["Question"]["additionalProperties"] is False
        assert defs["Option"]["additionalProperties"] is False

    def test_question_fields(self):
        question = _defs(AskUserQuestionArgs.model_json_schema())["Question"]
        assert question["required"] == ["question"]
        props = question["properties"]
        assert set(props) == {"question", "header", "options", "multi_select"}
        for prop in props.values():
            assert prop["description"], "every field must carry a description"
        assert _branch(props["header"], "string")["maxLength"] == 12
        options = _branch(props["options"], "array")
        assert options["minItems"] == 2
        assert options["maxItems"] == 4
        assert props["multi_select"]["type"] == "boolean"
        assert props["multi_select"]["default"] is False

    def test_option_fields(self):
        option = _defs(AskUserQuestionArgs.model_json_schema())["Option"]
        assert option["required"] == ["label"]
        props = option["properties"]
        assert set(props) == {"label", "description"}
        for prop in props.values():
            assert prop["description"]

    def test_tool_name_is_wire_name(self):
        assert ASK_USER_TOOL_NAME == "AskUserQuestion"


# ============================================================================
# Args model validation
# ============================================================================


class TestArgsModelValidation:
    def test_minimal_valid(self):
        args = AskUserQuestionArgs(questions=[{"question": "Proceed?"}])
        assert args.questions[0].multi_select is False
        assert args.questions[0].header is None
        assert args.questions[0].options is None

    def test_full_valid(self):
        args = AskUserQuestionArgs(
            questions=[
                {
                    "question": "Which auth approach?",
                    "header": "Auth",
                    "multi_select": True,
                    "options": [
                        {"label": "OAuth (Recommended)", "description": "Standard flow."},
                        {"label": "API keys"},
                    ],
                }
            ]
        )
        assert args.questions[0].options[1].description is None

    def test_zero_questions_rejected(self):
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(questions=[])

    def test_five_questions_rejected(self):
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(questions=[{"question": f"Q{i}?"} for i in range(5)])

    def test_single_option_rejected(self):
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(
                questions=[{"question": "Pick?", "options": [{"label": "Only one"}]}]
            )

    def test_long_header_rejected(self):
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(
                questions=[{"question": "Pick?", "header": "x" * 13}]
            )

    def test_extra_property_rejected(self):
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(questions=[{"question": "Q?", "background": True}])
        with pytest.raises(ValidationError):
            AskUserQuestionArgs(questions=[{"question": "Q?"}], background=True)

    def test_nested_models_direct(self):
        q = Question(
            question="Pick one?",
            header="Style",
            options=[Option(label="A"), Option(label="B", description="Trade-offs.")],
        )
        assert q.multi_select is False
        assert q.model_dump(exclude_none=True) == {
            "question": "Pick one?",
            "header": "Style",
            "options": [{"label": "A"}, {"label": "B", "description": "Trade-offs."}],
            "multi_select": False,
        }


# ============================================================================
# Function-level validation (returns 'Error: ...', never raises)
# ============================================================================


class TestFunctionValidation:
    def test_zero_questions(self):
        assert ask_user([]).startswith("Error:")

    def test_five_questions(self):
        result = ask_user([{"question": f"Q{i}?"} for i in range(5)])
        assert result.startswith("Error:") and "1-4" in result

    def test_empty_question_text(self):
        assert ask_user([{"question": "  "}]).startswith("Error:")

    def test_single_option(self):
        result = ask_user([{"question": "Pick?", "options": [{"label": "Solo"}]}])
        assert result.startswith("Error:") and "2-4 options" in result

    def test_long_header(self):
        result = ask_user([{"question": "Pick?", "header": "x" * 13}])
        assert result.startswith("Error:") and "12 characters" in result

    def test_empty_option_label(self):
        result = ask_user(
            [{"question": "Pick?", "options": [{"label": "A"}, {"label": " "}]}]
        )
        assert result.startswith("Error:") and "no label" in result

    def test_duplicate_question_text(self):
        result = ask_user([{"question": "Same?"}, {"question": "Same?"}])
        assert result.startswith("Error:") and "Duplicate question" in result

    def test_duplicate_option_label(self):
        result = ask_user(
            [{"question": "Pick?", "options": [{"label": "A"}, {"label": "A"}]}]
        )
        assert result.startswith("Error:") and "Duplicate option label" in result


# ============================================================================
# Publish behavior
# ============================================================================


@pytest.fixture(autouse=True)
def _clean_dapr_env(monkeypatch):
    for var in ("DAPR_PUBSUB_NAME", "DAPR_BROADCAST_TOPIC", "DAPR_HOST", "DAPR_HTTP_PORT"):
        monkeypatch.delenv(var, raising=False)


QUESTIONS = [
    {
        "question": "Which auth approach should we use?",
        "header": "Auth",
        "options": [
            {"label": "OAuth (Recommended)", "description": "Standard flow."},
            {"label": "API keys"},
        ],
    },
    {"question": "Proceed with the migration?", "multi_select": True},
]


class TestPublish:
    def test_payload_shape_and_url(self):
        with mock.patch("urllib.request.urlopen") as m:
            result = ask_user(QUESTIONS)

        assert result.startswith("Published 2 question(s) for the user:")
        assert "[Auth] Which auth approach should we use?" in result
        assert "2. Proceed with the migration?" in result
        assert "Awaiting user response via event." in result

        req = m.call_args[0][0]
        assert m.call_args.kwargs["timeout"] == 5
        assert req.full_url == (
            "http://127.0.0.1:3500/v1.0/publish/pubsub/dapr-agent-py.broadcast"
        )
        body = json.loads(req.data.decode("utf-8"))
        assert body["type"] == "user_question"
        assert body["questions"] == [
            {
                "question": "Which auth approach should we use?",
                "multi_select": False,
                "header": "Auth",
                "options": [
                    {"label": "OAuth (Recommended)", "description": "Standard flow."},
                    {"label": "API keys"},
                ],
            },
            {"question": "Proceed with the migration?", "multi_select": True},
        ]

    def test_accepts_model_instances(self):
        args = AskUserQuestionArgs(questions=[{"question": "Proceed?"}])
        with mock.patch("urllib.request.urlopen") as m:
            result = ask_user(args.questions)
        assert result.startswith("Published 1 question(s)")
        body = json.loads(m.call_args[0][0].data.decode("utf-8"))
        assert body["questions"] == [{"question": "Proceed?", "multi_select": False}]

    def test_publish_failure_returns_warning(self):
        with mock.patch("urllib.request.urlopen", side_effect=Exception("boom")):
            result = ask_user([{"question": "Proceed?"}])
        assert result.startswith("Warning: Could not publish question via pub/sub")
        assert "boom" in result
        assert "Proceed?" in result


# ============================================================================
# Model-facing description
# ============================================================================


class TestDescription:
    def test_docstring_assigned(self):
        assert ask_user.__doc__ == get_ask_user_description()

    def test_adapted_for_runtime(self):
        doc = get_ask_user_description()
        # Fire-and-forget: no background/task_id guidance from kimi-code.
        assert "background" not in doc
        assert "task_id" not in doc
        # Structured-options conventions kept.
        assert '"Other" option' in doc
        assert "(Recommended)" in doc
        # Autonomous-operation guidance added.
        assert "prefer deciding on your own rather than asking" in doc
