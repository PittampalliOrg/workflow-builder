"""Prompt and constants for the NotebookEdit tool.

Ported from claude-code-src/main/tools/NotebookEditTool/prompt.ts
"""

NOTEBOOK_EDIT_TOOL_NAME = "notebook_edit"

NOTEBOOK_EDIT_DESCRIPTION = "Replace the contents of a specific cell in a Jupyter notebook."

NOTEBOOK_EDIT_PROMPT = """Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number."""


def get_notebook_edit_description() -> str:
    return NOTEBOOK_EDIT_PROMPT
