from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parent.parent / "core" / "cel_loop.py"
)
SPEC = importlib.util.spec_from_file_location("cel_loop", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
CEL_LOOP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CEL_LOOP)

eval_cel_boolean = CEL_LOOP.eval_cel_boolean
get_loop_iteration_for_evaluation = CEL_LOOP.get_loop_iteration_for_evaluation


def _default_context(**overrides):
    context = {
        "input": {"score": 0.92, "authors": ["SpongeBob", "Patrick"]},
        "state": {
            "customer": {"tier": "gold"},
            "flags": {"beta": False},
            "employees": ["SpongeBob", "Patrick Star"],
            "emails": ["one@example.com", "two@example.com"],
            "counter": 4,
        },
        "workflow": {
            "id": "wf-123",
            "name": "CEL Example",
            "input": {"query": "hello"},
            "input_as_text": '{"query":"hello"}',
        },
        "iteration": 3,
        "last": {"success": True, "data": {"message": "ok"}},
    }
    context.update(overrides)
    return context


def test_cel_expression_examples():
    examples = [
        ("input.score >= 0.8", True),
        ('state.customer.tier == "gold"', True),
        ('"Patrick Star" in state.employees', True),
        ("state.emails.all(email, email.contains(\"@\"))", True),
        ("input.score > (state.flags.beta ? 0.9 : 0.8)", True),
        ("input.authors[size(input.authors) - 1] == \"Patrick\"", True),
        ("iteration < 10", True),
        ("iteration > 10", False),
        ("last == null ? false : last.success == true", True),
        ("workflow.input_as_text.contains(\"hello\")", True),
    ]

    for expression, expected in examples:
        assert (
            eval_cel_boolean(expression, _default_context()) is expected
        ), f"expression={expression}"


def test_iteration_count_is_one_based_at_loop_check():
    loop_iterations = {}
    assert get_loop_iteration_for_evaluation(loop_iterations, "loop-a") == 1

    loop_iterations["loop-a"] = 1
    assert get_loop_iteration_for_evaluation(loop_iterations, "loop-a") == 2

    loop_iterations["loop-a"] = 9
    assert get_loop_iteration_for_evaluation(loop_iterations, "loop-a") == 10


def test_while_iteration_less_than_10_runs_exactly_10_passes():
    # While node lowers "iteration < 10" to loop-until CEL: "!(iteration < 10)"
    stop_expression = "!(iteration < 10)"
    node_id = "loop-a"
    loop_iterations: dict[str, int] = {}
    runs = 0

    while True:
        runs += 1
        iteration = get_loop_iteration_for_evaluation(loop_iterations, node_id)
        should_stop = eval_cel_boolean(
            stop_expression,
            _default_context(iteration=iteration),
        )
        if should_stop:
            break
        loop_iterations[node_id] = iteration

    assert runs == 10
