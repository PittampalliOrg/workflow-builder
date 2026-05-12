"""Quote normalization utilities for FileEdit.

Ported from claude-code-src/main/tools/FileEditTool/utils.ts
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Quote normalization
# ---------------------------------------------------------------------------

_CURLY_QUOTES = {
    "\u2018": "'",  # left single curly -> straight
    "\u2019": "'",  # right single curly -> straight
    "\u201c": '"',  # left double curly -> straight
    "\u201d": '"',  # right double curly -> straight
}


def normalize_quotes(s: str) -> str:
    """Replace curly quotes with their straight equivalents."""
    for curly, straight in _CURLY_QUOTES.items():
        s = s.replace(curly, straight)
    return s


def find_actual_string(content: str, search: str) -> str | None:
    """Find *search* in *content*, trying exact match first then quote-normalized.

    Returns the actual substring found in *content* (which may differ in quote
    style), or ``None`` if not found at all.
    """
    if search in content:
        return search

    normalized_search = normalize_quotes(search)
    normalized_content = normalize_quotes(content)

    idx = normalized_content.find(normalized_search)
    if idx >= 0:
        # Map the index back to the original content.  Because quote
        # normalization is a 1-to-1 character mapping the index is stable.
        return content[idx : idx + len(search)]

    return None
