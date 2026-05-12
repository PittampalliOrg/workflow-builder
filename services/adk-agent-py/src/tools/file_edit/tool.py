"""FileEdit tool -- exact string replacement editing with quote normalization.

Ported from claude-code-src/main/tools/FileEditTool/FileEditTool.ts
"""

from __future__ import annotations

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_edit_tool_description
from .utils import find_actual_string


def file_edit(
    file_path: str,
    old_string: str | None = None,
    new_string: str | None = None,
    replace_all: bool = False,
    old_str: str | None = None,
    new_str: str | None = None,
) -> str:
    if old_string is None:
        old_string = old_str
    if new_string is None:
        new_string = new_str
    if old_string is None or new_string is None:
        return "Error: old_string and new_string are required."

    resolved = expand_path(file_path)
    runtime = get_runtime()

    if old_string == new_string:
        return "Error: old_string and new_string are identical -- no changes to make."

    try:
        stat = runtime.stat_path(resolved)
    except Exception as exc:
        return f"Error reading file stats: {exc}"
    if not stat.get("ok"):
        return f"Error reading file stats: {stat.get('error') or stat}"

    if not stat.get("exists"):
        if old_string == "":
            # Creating a new file with new_string as content
            try:
                result = runtime.write_text(resolved, new_string)
            except Exception as exc:
                return f"Error creating file: {exc}"
            if not result.get("ok"):
                return f"Error creating file: {result.get('error') or result}"
            return f"Created new file {resolved}"
        return f"Error: File not found: {resolved}"

    if stat.get("is_dir"):
        return f"Error: '{resolved}' is a directory, not a file."

    try:
        read_result = runtime.read_text(resolved)
    except Exception as exc:
        return f"Error reading file: {exc}"
    if not read_result.get("ok"):
        return f"Error reading file: {read_result.get('error') or read_result}"
    content = str(read_result.get("content") or "")

    if old_string == "":
        if content:
            return "Error: old_string is empty but file already has content. Provide the text to replace."
        # File exists but is empty -- write new content
        try:
            write_result = runtime.write_text(resolved, new_string)
        except Exception as exc:
            return f"Error writing file: {exc}"
        if not write_result.get("ok"):
            return f"Error writing file: {write_result.get('error') or write_result}"
        return f"Wrote content to empty file {resolved}"

    # Try to find old_string (with quote normalization fallback)
    actual = find_actual_string(content, old_string)
    if actual is None:
        return (
            f"Error: old_string not found in {resolved}. "
            f"Make sure the string matches exactly (including whitespace and indentation)."
        )

    # Uniqueness check
    count = content.count(actual)
    if count > 1 and not replace_all:
        return (
            f"Error: Found {count} occurrences of old_string in {resolved}. "
            f"Use replace_all=True to replace all occurrences, or provide more "
            f"surrounding context to make the match unique."
        )

    # Apply replacement
    if replace_all:
        updated = content.replace(actual, new_string)
        replaced_count = count
    else:
        updated = content.replace(actual, new_string, 1)
        replaced_count = 1

    try:
        write_result = runtime.write_text(resolved, updated)
    except Exception as exc:
        return f"Error writing file: {exc}"
    if not write_result.get("ok"):
        return f"Error writing file: {write_result.get('error') or write_result}"

    return f"Replaced {replaced_count} occurrence(s) in {resolved}"


file_edit.__doc__ = get_edit_tool_description()
