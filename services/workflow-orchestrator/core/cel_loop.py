"""CEL helpers for loop condition evaluation."""

from __future__ import annotations

from typing import Any, Mapping

import celpy
from celpy.adapter import json_to_cel

_CEL_ENV = celpy.Environment()
_CEL_PROGRAM_CACHE: dict[str, Any] = {}


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def get_loop_iteration_for_evaluation(
    loop_iterations: Mapping[str, Any],
    node_id: str,
) -> int:
    """
    Return the loop-pass count to expose as CEL `iteration`.

    `loop_iterations[node_id]` stores the last completed pass count.
    The loop condition is evaluated after a loop-body pass, so the first
    condition check should expose `iteration = 1`.
    """

    completed_passes = _to_int(loop_iterations.get(node_id, 0), default=0)
    return max(1, completed_passes + 1)


def eval_cel_boolean(expression: str, context: dict[str, Any]) -> bool:
    """Evaluate a CEL expression as a boolean with workflow loop context."""

    program = _CEL_PROGRAM_CACHE.get(expression)
    if program is None:
        ast = _CEL_ENV.compile(expression)
        program = _CEL_ENV.program(ast)
        _CEL_PROGRAM_CACHE[expression] = program

    activation = {
        "input": json_to_cel(context.get("input")),
        "state": json_to_cel(context.get("state")),
        "workflow": json_to_cel(context.get("workflow")),
        "iteration": json_to_cel(context.get("iteration", 0)),
        "last": json_to_cel(context.get("last")),
    }
    result = program.evaluate(activation)
    return bool(result)


__all__ = ["eval_cel_boolean", "get_loop_iteration_for_evaluation"]
