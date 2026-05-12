"""NotebookEdit tool -- edit Jupyter notebook cells."""

from __future__ import annotations

import json
import uuid

from src.openshell_runtime import get_runtime
from .._security import expand_path


def notebook_edit(
    notebook_path: str,
    new_source: str,
    cell_type: str = "code",
    edit_mode: str = "replace",
    cell_id: str | None = None,
) -> str:
    """Edit Jupyter notebook cells. Supports replace, insert, and delete operations on notebook cells."""
    resolved = expand_path(notebook_path)
    runtime = get_runtime()

    if not resolved.endswith(".ipynb"):
        return f"Error: '{resolved}' is not a Jupyter notebook (.ipynb) file."

    stat = runtime.stat_path(resolved)
    if not stat.get("ok"):
        return f"Error reading notebook: {stat.get('error') or stat}"
    if not stat.get("exists"):
        return f"Error: Notebook not found: {resolved}"

    if edit_mode not in ("replace", "insert", "delete"):
        return f"Error: edit_mode must be 'replace', 'insert', or 'delete', got '{edit_mode}'."

    if cell_type not in ("code", "markdown"):
        return f"Error: cell_type must be 'code' or 'markdown', got '{cell_type}'."

    try:
        read_result = runtime.read_text(resolved)
        if not read_result.get("ok"):
            return f"Error reading notebook: {read_result.get('error') or read_result}"
        raw = str(read_result.get("content") or "")
        notebook = json.loads(raw)
    except json.JSONDecodeError as exc:
        return f"Error reading notebook: {exc}"

    cells = notebook.get("cells", [])
    if not cells and edit_mode != "insert":
        return "Error: Notebook has no cells."

    # --- Locate target cell ---
    target_idx: int | None = None

    if cell_id is not None:
        # Try numeric index first (cell-N format)
        if cell_id.startswith("cell-"):
            try:
                idx = int(cell_id[5:])
                if 0 <= idx < len(cells):
                    target_idx = idx
            except ValueError:
                pass

        # Try UUID match
        if target_idx is None:
            for i, cell in enumerate(cells):
                cid = cell.get("id") or cell.get("metadata", {}).get("id")
                if cid == cell_id:
                    target_idx = i
                    break

        # Try plain integer
        if target_idx is None:
            try:
                idx = int(cell_id)
                if 0 <= idx < len(cells):
                    target_idx = idx
            except ValueError:
                pass

        if target_idx is None:
            return f"Error: Cell '{cell_id}' not found. Available cells: 0-{len(cells) - 1}"
    else:
        if edit_mode == "insert":
            # Insert at the end when no cell_id specified
            target_idx = len(cells) - 1 if cells else -1
        else:
            return "Error: cell_id is required for replace and delete operations."

    # --- Apply edit ---
    source_lines = new_source.split("\n")
    # Notebook format stores source as list of lines with trailing newlines
    nb_source = [line + "\n" for line in source_lines[:-1]]
    if source_lines:
        nb_source.append(source_lines[-1])  # last line without trailing newline

    if edit_mode == "replace":
        cells[target_idx]["source"] = nb_source
        cells[target_idx]["cell_type"] = cell_type
        if cell_type == "code":
            cells[target_idx]["execution_count"] = None
            cells[target_idx]["outputs"] = []
        result_msg = f"Replaced cell {cell_id or target_idx}"

    elif edit_mode == "insert":
        new_cell: dict = {
            "cell_type": cell_type,
            "source": nb_source,
            "metadata": {},
            "id": str(uuid.uuid4())[:8],
        }
        if cell_type == "code":
            new_cell["execution_count"] = None
            new_cell["outputs"] = []
        insert_at = (target_idx + 1) if target_idx >= 0 else 0
        cells.insert(insert_at, new_cell)
        result_msg = f"Inserted new {cell_type} cell after position {target_idx}"

    elif edit_mode == "delete":
        removed_id = cells[target_idx].get("id", target_idx)
        cells.pop(target_idx)
        result_msg = f"Deleted cell {removed_id}"

    notebook["cells"] = cells

    try:
        write_result = runtime.write_text(
            resolved,
            json.dumps(notebook, indent=1, ensure_ascii=False) + "\n",
        )
    except Exception as exc:
        return f"Error writing notebook: {exc}"
    if not write_result.get("ok"):
        return f"Error writing notebook: {write_result.get('error') or write_result}"

    return f"Successfully {result_msg} in {resolved}"

from .prompt import get_notebook_edit_description
notebook_edit.__doc__ = get_notebook_edit_description()
