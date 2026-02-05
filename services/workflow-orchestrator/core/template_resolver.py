"""
Template Resolver

Resolves {{node.field}} template variables in workflow node configurations.
This allows nodes to reference outputs from previous nodes in the workflow.
"""

from __future__ import annotations

import re
from typing import Any

# Type alias for node outputs map: nodeId -> { label, data }
NodeOutputs = dict[str, dict[str, Any]]

# Regular expression to match template variables: {{nodeId.field}} or {{nodeId.field.nested}}
TEMPLATE_REGEX = re.compile(r"\{\{([^}]+)\}\}")


def get_nested_value(obj: Any, path: str) -> Any:
    """Get a nested value from an object using dot notation."""
    parts = path.split(".")
    current = obj

    for part in parts:
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        elif hasattr(current, part):
            current = getattr(current, part)
        else:
            return None

    return current


def resolve_template(template: str, node_outputs: NodeOutputs) -> Any:
    """
    Resolve a single template variable.

    Args:
        template: The full template string (e.g., "{{node1.output.message}}")
        node_outputs: Map of node outputs

    Returns:
        The resolved value or the original template if not found
    """
    # Extract the path from the template (remove {{ and }})
    path = template[2:-2].strip()
    parts = path.split(".")

    if len(parts) < 2:
        return template  # Invalid template, return as-is

    node_id = parts[0]
    field_path = ".".join(parts[1:])

    node_output = node_outputs.get(node_id)
    if not node_output:
        # Try to find by label (case-insensitive, spaces replaced with underscores)
        normalized_id = node_id.lower()
        for output in node_outputs.values():
            label = output.get("label", "")
            if label.lower().replace(" ", "_") == normalized_id:
                value = get_nested_value(output.get("data"), field_path)
                return value if value is not None else template
        return template  # Node not found, return original template

    value = get_nested_value(node_output.get("data"), field_path)
    return value if value is not None else template


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
        # If resolved to a non-string value, convert to string for this context
        return str(resolved)

    # Replace all templates in the string
    def replace_match(match: re.Match) -> str:
        resolved = resolve_template(match.group(0), node_outputs)
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
        # Check if entire string is a template - return the actual type
        single_match = re.fullmatch(r"\{\{([^}]+)\}\}", value)
        if single_match:
            return resolve_template(value, node_outputs)
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
