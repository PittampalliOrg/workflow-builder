"""Prompt and constants for the NotebookEdit tool.

Ported from claude-code-src/main/tools/NotebookEditTool/prompt.ts
"""

NOTEBOOK_EDIT_TOOL_NAME = "notebook_edit"

NOTEBOOK_EDIT_DESCRIPTION = "Replace the contents of a specific cell in a Jupyter notebook."

NOTEBOOK_EDIT_PROMPT = """Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The target cell is identified by cell_id, a string that accepts a 0-indexed position ('cell-N' or a plain numeric index such as '0') or the cell's own UUID. cell_id is required for edit_mode=replace and edit_mode=delete. Use edit_mode=insert to add a new cell after the cell identified by cell_id; when cell_id is omitted, the new cell is appended at the end of the notebook."""


def get_notebook_edit_description() -> str:
    return NOTEBOOK_EDIT_PROMPT
