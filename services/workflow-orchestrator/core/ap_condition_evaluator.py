"""
AP Condition Evaluator

Evaluates branch conditions for AP Router steps.
Ported from packages/engine/src/lib/handler/router-executor.ts

Supports:
- EXECUTE_FIRST_MATCH: Execute only the first branch whose condition is true
- EXECUTE_ALL_MATCH: Execute all branches whose conditions are true
- Branch types: CONDITION (evaluate conditions), FALLBACK (true if all others false)
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


class BranchOperator:
    """Condition operators matching AP's BranchOperator enum."""
    TEXT_CONTAINS = 'TEXT_CONTAINS'
    TEXT_DOES_NOT_CONTAIN = 'TEXT_DOES_NOT_CONTAIN'
    TEXT_EXACTLY_MATCHES = 'TEXT_EXACTLY_MATCHES'
    TEXT_DOES_NOT_EXACTLY_MATCH = 'TEXT_DOES_NOT_EXACTLY_MATCH'
    TEXT_STARTS_WITH = 'TEXT_STARTS_WITH'
    TEXT_DOES_NOT_START_WITH = 'TEXT_DOES_NOT_START_WITH'
    TEXT_ENDS_WITH = 'TEXT_ENDS_WITH'
    TEXT_DOES_NOT_END_WITH = 'TEXT_DOES_NOT_END_WITH'
    TEXT_IS_EMPTY = 'TEXT_IS_EMPTY'
    TEXT_IS_NOT_EMPTY = 'TEXT_IS_NOT_EMPTY'
    NUMBER_IS_GREATER_THAN = 'NUMBER_IS_GREATER_THAN'
    NUMBER_IS_LESS_THAN = 'NUMBER_IS_LESS_THAN'
    NUMBER_IS_EQUAL_TO = 'NUMBER_IS_EQUAL_TO'
    BOOLEAN_IS_TRUE = 'BOOLEAN_IS_TRUE'
    BOOLEAN_IS_FALSE = 'BOOLEAN_IS_FALSE'
    EXISTS = 'EXISTS'
    DOES_NOT_EXIST = 'DOES_NOT_EXIST'
    LIST_CONTAINS = 'LIST_CONTAINS'
    LIST_DOES_NOT_CONTAIN = 'LIST_DOES_NOT_CONTAIN'
    LIST_IS_EMPTY = 'LIST_IS_EMPTY'
    LIST_IS_NOT_EMPTY = 'LIST_IS_NOT_EMPTY'


def evaluate_conditions(conditions: list[list[dict[str, Any]]]) -> bool:
    """
    Evaluate AP branch conditions.

    Conditions are structured as:
    - Outer list: OR groups (any group must be true)
    - Inner list: AND conditions (all conditions in a group must be true)

    Returns True if the overall condition evaluates to true.
    """
    if not conditions:
        return False

    # OR across groups
    for or_group in conditions:
        # AND within each group
        all_true = True
        for condition in or_group:
            if not _evaluate_single_condition(condition):
                all_true = False
                break
        if all_true:
            return True

    return False


def evaluate_branches(
    branches: list[dict[str, Any]],
    resolved_input: dict[str, Any],
) -> list[bool]:
    """
    Evaluate all branches and return a list of booleans indicating which should execute.

    Handles FALLBACK branches: true only if all other (non-fallback) branches are false.
    """
    # First pass: evaluate non-fallback branches
    evaluations_raw = []
    for branch in branches:
        if branch.get('branchType') == 'FALLBACK':
            evaluations_raw.append(None)  # Placeholder
        else:
            conditions = branch.get('conditions', [])
            evaluations_raw.append(evaluate_conditions(conditions))

    # Second pass: evaluate fallback branches
    evaluations = []
    for i, branch in enumerate(branches):
        if branch.get('branchType') == 'FALLBACK':
            # Fallback is true only if all non-fallback branches are false
            all_others_false = all(
                not e for j, e in enumerate(evaluations_raw)
                if j != i and e is not None
            )
            evaluations.append(all_others_false)
        else:
            evaluations.append(evaluations_raw[i] or False)

    return evaluations


def _evaluate_single_condition(condition: dict[str, Any]) -> bool:
    """Evaluate a single condition."""
    operator = condition.get('operator', '')
    first_value = condition.get('firstValue')
    second_value = condition.get('secondValue')

    try:
        if operator == BranchOperator.TEXT_CONTAINS:
            return str(second_value or '') in str(first_value or '')
        elif operator == BranchOperator.TEXT_DOES_NOT_CONTAIN:
            return str(second_value or '') not in str(first_value or '')
        elif operator == BranchOperator.TEXT_EXACTLY_MATCHES:
            return str(first_value or '') == str(second_value or '')
        elif operator == BranchOperator.TEXT_DOES_NOT_EXACTLY_MATCH:
            return str(first_value or '') != str(second_value or '')
        elif operator == BranchOperator.TEXT_STARTS_WITH:
            return str(first_value or '').startswith(str(second_value or ''))
        elif operator == BranchOperator.TEXT_DOES_NOT_START_WITH:
            return not str(first_value or '').startswith(str(second_value or ''))
        elif operator == BranchOperator.TEXT_ENDS_WITH:
            return str(first_value or '').endswith(str(second_value or ''))
        elif operator == BranchOperator.TEXT_DOES_NOT_END_WITH:
            return not str(first_value or '').endswith(str(second_value or ''))
        elif operator == BranchOperator.TEXT_IS_EMPTY:
            return not first_value or str(first_value).strip() == ''
        elif operator == BranchOperator.TEXT_IS_NOT_EMPTY:
            return bool(first_value) and str(first_value).strip() != ''
        elif operator == BranchOperator.NUMBER_IS_GREATER_THAN:
            return float(first_value or 0) > float(second_value or 0)
        elif operator == BranchOperator.NUMBER_IS_LESS_THAN:
            return float(first_value or 0) < float(second_value or 0)
        elif operator == BranchOperator.NUMBER_IS_EQUAL_TO:
            return float(first_value or 0) == float(second_value or 0)
        elif operator == BranchOperator.BOOLEAN_IS_TRUE:
            return _to_bool(first_value) is True
        elif operator == BranchOperator.BOOLEAN_IS_FALSE:
            return _to_bool(first_value) is False
        elif operator == BranchOperator.EXISTS:
            return first_value is not None
        elif operator == BranchOperator.DOES_NOT_EXIST:
            return first_value is None
        elif operator == BranchOperator.LIST_CONTAINS:
            if isinstance(first_value, list):
                return second_value in first_value
            return False
        elif operator == BranchOperator.LIST_DOES_NOT_CONTAIN:
            if isinstance(first_value, list):
                return second_value not in first_value
            return True
        elif operator == BranchOperator.LIST_IS_EMPTY:
            return not first_value or (isinstance(first_value, list) and len(first_value) == 0)
        elif operator == BranchOperator.LIST_IS_NOT_EMPTY:
            return isinstance(first_value, list) and len(first_value) > 0
        else:
            logger.warning(f"[APCondition] Unknown operator: {operator}")
            return False
    except (ValueError, TypeError) as e:
        logger.warning(f"[APCondition] Error evaluating condition: {e}")
        return False


def _to_bool(value: Any) -> bool | None:
    """Convert a value to boolean."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value.lower() in ('true', '1', 'yes'):
            return True
        if value.lower() in ('false', '0', 'no'):
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return None
