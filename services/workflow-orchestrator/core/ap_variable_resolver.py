"""
AP Variable Resolver

Resolves Activepieces template expressions like:
  {{steps.step_name.output.field}}
  {{trigger.output.field}}

AP uses `{{steps.<stepName>.<path>}}` to reference outputs of previous steps.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Pattern to match AP template expressions: {{steps.step_1.output.foo}} or {{trigger.output.bar}}
AP_TEMPLATE_PATTERN = re.compile(r'\{\{(.*?)\}\}')


def resolve_ap_value(value: Any, step_outputs: dict[str, Any]) -> Any:
    """
    Recursively resolve AP template expressions in a value.

    Args:
        value: The value to resolve (can be string, dict, list, or primitive)
        step_outputs: Map of step_name -> step output data

    Returns:
        The resolved value with all templates replaced
    """
    if isinstance(value, str):
        return _resolve_string(value, step_outputs)
    elif isinstance(value, dict):
        return {k: resolve_ap_value(v, step_outputs) for k, v in value.items()}
    elif isinstance(value, list):
        return [resolve_ap_value(item, step_outputs) for item in value]
    else:
        return value


def _resolve_string(template: str, step_outputs: dict[str, Any]) -> Any:
    """
    Resolve a string that may contain AP template expressions.

    If the entire string is a single template expression, return the raw resolved
    value (preserving type). Otherwise, do string interpolation.
    """
    # Check if the entire string is a single template expression
    stripped = template.strip()
    match = re.fullmatch(r'\{\{(.*?)\}\}', stripped)
    if match:
        path = match.group(1).strip()
        resolved = _resolve_path(path, step_outputs)
        if resolved is not None:
            return resolved
        return template  # Return original if unresolvable

    # Multiple templates or mixed content — do string interpolation
    def replace_match(m: re.Match) -> str:
        path = m.group(1).strip()
        resolved = _resolve_path(path, step_outputs)
        if resolved is None:
            return m.group(0)  # Keep original if unresolvable
        return str(resolved)

    return AP_TEMPLATE_PATTERN.sub(replace_match, template)


def _resolve_path(path: str, step_outputs: dict[str, Any]) -> Any:
    """
    Resolve a dotted path like 'steps.step_1.output.field' against step_outputs.

    AP paths typically look like:
    - steps.step_1.output.field
    - steps.step_1.output['field']
    - trigger.output.field

    We normalize to: step_name -> traverse into output
    """
    parts = path.split('.')

    if len(parts) < 2:
        return None

    # Handle "steps.step_name.rest..." format
    if parts[0] == 'steps' and len(parts) >= 2:
        step_name = parts[1]
        remaining = parts[2:]
    elif parts[0] == 'trigger':
        step_name = 'trigger'
        remaining = parts[1:]
    else:
        # Maybe it's a direct step name reference
        step_name = parts[0]
        remaining = parts[1:]

    step_data = step_outputs.get(step_name)
    if step_data is None:
        logger.debug(f"[APResolver] Step '{step_name}' not found in outputs")
        return None

    # Traverse remaining path
    current = step_data
    for part in remaining:
        if isinstance(current, dict):
            # Handle bracket notation: field['key']
            bracket_match = re.match(r"(\w+)\['(.+?)'\]", part)
            if bracket_match:
                field = bracket_match.group(1)
                key = bracket_match.group(2)
                current = current.get(field, {})
                if isinstance(current, dict):
                    current = current.get(key)
                elif isinstance(current, list):
                    try:
                        current = current[int(key)]
                    except (ValueError, IndexError):
                        return None
            else:
                current = current.get(part)
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None

        if current is None:
            return None

    return current
