"""FileEdit tool -- exact string replacement editing with quote normalization.

Ported from claude-code-src/main/tools/FileEditTool/FileEditTool.ts;
model-facing surface aligned with kimi-code v2's Edit tool.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_edit_tool_description
from .utils import find_actual_string


class EditArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str = Field(
        description=(
            "Path of the file to edit. Relative paths resolve against the working "
            "directory. Read the file with Read before editing it."
        )
    )
    old_string: str = Field(
        min_length=1,
        description=(
            "The exact text to replace, taken from the Read output view (drop the "
            "line-number prefix and tab; match only file content). Must be unique "
            "in the file unless replace_all is set."
        ),
    )
    new_string: str = Field(
        description="The replacement text. Must differ from old_string."
    )
    replace_all: bool = Field(
        default=False,
        description=(
            "Replace every occurrence of old_string (default false). Use only when "
            "every occurrence should change — for example, renaming a symbol "
            "throughout the file."
        ),
    )


def file_edit(
    path: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
) -> str:
    resolved = expand_path(path)
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
