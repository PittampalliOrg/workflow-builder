"""Expression evaluation helpers for Serverless Workflow 1.0.

The supported workflow runtime uses jq expressions wrapped in `${ ... }`
consistently across task inputs, conditions, loop collections, and outputs.
This module intentionally does not support legacy `{{ ... }}` templating.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

try:
    import jq
except ModuleNotFoundError:  # pragma: no cover - exercised in deployed image
    jq = None


class SWExpressionError(RuntimeError):
    """Raised when an SW expression cannot be evaluated."""


def is_expression_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith("${") and value.strip().endswith("}")


def _strip_expression(value: str) -> str:
    return value.strip()[2:-1].strip()


@lru_cache(maxsize=256)
def _compile(program: str):
    if jq is None:
        raise SWExpressionError(
            "SW jq expression support requires the Python 'jq' package to be installed",
        )
    try:
        return jq.compile(program)
    except Exception as exc:  # pragma: no cover - depends on libjq internals
        raise SWExpressionError(f"Invalid jq expression: {program}") from exc


def evaluate_expression(expression: str, context: Any) -> Any:
    """Evaluate an exact `${ ... }` expression against the provided context."""
    if not is_expression_string(expression):
        return expression

    program = _strip_expression(expression)
    if not program:
        raise SWExpressionError("Empty jq expression is not supported")

    try:
        outputs = _compile(program).input_value(context).all()
    except SWExpressionError:
        raise
    except Exception as exc:  # pragma: no cover - depends on libjq internals
        raise SWExpressionError(f"Failed to evaluate jq expression: {expression}") from exc

    if not outputs:
        return None
    if len(outputs) == 1:
        return outputs[0]
    return outputs


def evaluate_structure(value: Any, context: Any) -> Any:
    """Recursively evaluate exact `${ ... }` values inside a JSON-like structure."""
    if value is None:
        return value
    if isinstance(value, str):
        return evaluate_expression(value, context) if is_expression_string(value) else value
    if isinstance(value, list):
        return [evaluate_structure(item, context) for item in value]
    if isinstance(value, dict):
        return {
            key: evaluate_structure(item, context)
            for key, item in value.items()
        }
    return value


def evaluate_condition(value: Any, context: Any) -> bool:
    """Evaluate a task condition to a boolean."""
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1"}:
            return True
        if lowered in {"false", "0", ""}:
            return False
    resolved = evaluate_expression(value, context) if is_expression_string(value) else value
    return bool(resolved)


def resolve_input_definition(definition: Any, context: Any, *, default_input: Any) -> Any:
    """Resolve workflow/task `input.from` into the effective task input."""
    if not isinstance(definition, dict):
        return default_input
    source = definition.get("from")
    if source is None:
        return default_input
    return evaluate_structure(source, context)


def resolve_output_definition(definition: Any, context: Any, *, default_output: Any) -> Any:
    """Resolve task/workflow `output.as` into the effective output value."""
    if not isinstance(definition, dict):
        return default_output
    output_mapping = definition.get("as")
    if output_mapping is None:
        return default_output
    return evaluate_structure(output_mapping, context)
