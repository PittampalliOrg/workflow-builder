"""
Template Resolver

Resolves template variables inside workflow node configurations.

Supported syntaxes:
- New (ID + display name): {{@nodeId:DisplayName.field}} or {{@nodeId:DisplayName}}
- Legacy (node ID): {{$nodeId.field}} or {{$nodeId}}
- Legacy (label / actionType / node ID): {{NodeLabel.field}} or {{nodeId.field}}

This mirrors the template format used in the Workflow Builder UI and keeps
runtime resolution compatible with standardized step outputs:
  { success: boolean, data: {...}, error?: string }
When the output is standardized, field access automatically unwraps into the
inner `data` object unless explicitly accessing `success`, `data`, or `error`.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Type alias for node outputs map: nodeId -> { label, data }
NodeOutputs = dict[str, dict[str, Any]]

# Regular expression to match template variables: {{nodeId.field}} or {{nodeId.field.nested}}
TEMPLATE_REGEX = re.compile(r"\{\{([^}]+)\}\}")

ARRAY_ACCESS_PATTERN = re.compile(r"^([^\[\]]+)\[(\d+)\]$")


def _is_standardized_output(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("success"), bool)
        and "data" in value
    )


def get_nested_value(obj: Any, path: str) -> Any:
    """Get a nested value from an object using dot notation + `[index]` arrays."""
    parts = [p for p in path.split(".") if p.strip()]
    current: Any = obj

    # Auto-unwrap standardized outputs unless explicitly accessing wrapper fields.
    if parts:
        first = parts[0]
        if _is_standardized_output(current) and first not in ("success", "data", "error"):
            current = current.get("data")

    for part in parts:
        if current is None:
            return None
        if isinstance(current, dict):
            m = ARRAY_ACCESS_PATTERN.match(part)
            if m:
                field, index_s = m.group(1), m.group(2)
                arr = current.get(field)
                if isinstance(arr, list):
                    idx = int(index_s)
                    current = arr[idx] if 0 <= idx < len(arr) else None
                else:
                    return None
            else:
                current = current.get(part)
        elif hasattr(current, part):
            current = getattr(current, part)
        elif isinstance(current, list):
            # If current is a list and we access a field, map it over elements.
            current = [
                item.get(part) if isinstance(item, dict) else getattr(item, part, None)
                for item in current
            ]
        else:
            return None

    return current


def _normalize_key(s: str) -> str:
    """Normalize a string for fuzzy matching: lowercase, strip non-alnum to underscores."""
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def resolve_template(template: str, node_outputs: NodeOutputs) -> Any:
    """
    Resolve a single template variable.

    Lookup order:
    1. Exact node ID match
    2. Label match (case-insensitive, spaces/special chars → underscores)
    3. ActionType match (e.g., "planner/plan" matches "planner_plan" or "PlannerPlan")

    Args:
        template: The full template string (e.g., "{{node1.output.message}}")
        node_outputs: Map of node outputs

    Returns:
        The resolved value or the original template if not found
    """
    # Extract the expression from the template (remove {{ and }})
    expr = template[2:-2].strip()

    # New format: @nodeId:DisplayName.field
    if expr.startswith("@"):
        without_at = expr[1:]
        colon_index = without_at.find(":")
        if colon_index == -1:
            return template
        node_id = without_at[:colon_index].strip()
        rest = without_at[colon_index + 1 :].strip()
        dot_index = rest.find(".")
        field_path = rest[dot_index + 1 :].strip() if dot_index != -1 else ""

        node_output = node_outputs.get(node_id)
        if not node_output:
            return template
        if not field_path:
            return node_output.get("data")
        value = get_nested_value(node_output.get("data"), field_path)
        return value if value is not None else template

    # Legacy ID format: $nodeId.field
    if expr.startswith("$"):
        without_dollar = expr[1:].strip()
        if not without_dollar:
            return template
        if "." in without_dollar:
            node_id, field_path = without_dollar.split(".", 1)
        else:
            node_id, field_path = without_dollar, ""

        node_output = node_outputs.get(node_id)
        if not node_output:
            return template
        if not field_path:
            return node_output.get("data")
        value = get_nested_value(node_output.get("data"), field_path)
        return value if value is not None else template

    # Legacy label/actionType/nodeId format: NodeLabel.field (or nodeId.field)
    parts = expr.split(".")
    if len(parts) < 2:
        return template

    node_id = parts[0].strip()
    field_path = ".".join(parts[1:]).strip()

    # 1. Exact node ID match
    node_output = node_outputs.get(node_id)
    if node_output:
        value = get_nested_value(node_output.get("data"), field_path)
        return value if value is not None else template

    # 2. Label match (case-insensitive, spaces/special chars → underscores)
    normalized_id = _normalize_key(node_id)
    for output in node_outputs.values():
        label = output.get("label", "")
        if label and _normalize_key(label) == normalized_id:
            value = get_nested_value(output.get("data"), field_path)
            return value if value is not None else template

    # 3. ActionType match - normalize "planner/plan" → "planner_plan" and compare
    for output in node_outputs.values():
        action_type = output.get("actionType", "")
        if action_type and _normalize_key(action_type) == normalized_id:
            value = get_nested_value(output.get("data"), field_path)
            return value if value is not None else template

    return template  # Node not found, return original template


def resolve_string_templates(s: str, node_outputs: NodeOutputs) -> str:
    """
    Resolve all template variables in a string.

    Args:
        s: The string containing templates
        node_outputs: Map of node outputs

    Returns:
        The string with all templates resolved
    """
    # Check if the entire string is a single template
    single_match = re.fullmatch(r"\{\{([^}]+)\}\}", s)
    if single_match:
        resolved = resolve_template(s, node_outputs)
        if isinstance(resolved, (dict, list)):
            return json.dumps(resolved)
        return str(resolved)

    # Replace all templates in the string
    def replace_match(match: re.Match) -> str:
        resolved = resolve_template(match.group(0), node_outputs)
        if isinstance(resolved, (dict, list)):
            return json.dumps(resolved)
        return str(resolved)

    return TEMPLATE_REGEX.sub(replace_match, s)


def resolve_templates(value: Any, node_outputs: NodeOutputs) -> Any:
    """
    Recursively resolve templates in an object or array.

    Args:
        value: The value to resolve templates in
        node_outputs: Map of node outputs

    Returns:
        The value with all templates resolved
    """
    if value is None:
        return value

    if isinstance(value, str):
        # Check if entire string is a single template
        single_match = re.fullmatch(r"\{\{([^}]+)\}\}", value)
        if single_match:
            resolved = resolve_template(value, node_outputs)
            # JSON-serialize complex objects so downstream consumers
            # (e.g. fn-activepieces Property.LongText) receive valid JSON
            # strings instead of raw objects that stringify to [object Object].
            if isinstance(resolved, (dict, list)):
                return json.dumps(resolved)
            return resolved
        # Otherwise, do string replacement
        return resolve_string_templates(value, node_outputs)

    if isinstance(value, list):
        return [resolve_templates(item, node_outputs) for item in value]

    if isinstance(value, dict):
        return {key: resolve_templates(val, node_outputs) for key, val in value.items()}

    # Primitives (number, boolean, etc.) pass through unchanged
    return value


def contains_templates(s: str) -> bool:
    """Check if a string contains template variables."""
    return bool(TEMPLATE_REGEX.search(s))
