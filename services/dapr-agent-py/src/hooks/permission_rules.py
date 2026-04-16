"""Parser/evaluator for the `if` field on hook commands.

TS syntax (see claude-code-src/main/schemas/hooks.ts:19-27):
    "Bash(git *)"         -> matches tool Bash with command starting "git "
    "Read(*.ts)"          -> matches tool Read with any .ts file
    "Edit"                -> matches any Edit invocation
    "Bash(git *) and !Bash(git push*)" -> conjunction + negation

Evaluation is pure and deterministic. Never uses eval().
Matching is permissive: missing fields => no match, never crash.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from typing import Any

_RULE_RE = re.compile(r"^\s*(?P<tool>[A-Za-z_][A-Za-z0-9_-]*)\s*(?:\((?P<arg>.*)\))?\s*$")
_TOKEN_RE = re.compile(r"\s+(?:and|AND|&&)\s+|\s+(?:or|OR|\|\|)\s+")


@dataclass(frozen=True)
class _Term:
    negate: bool
    tool: str
    arg_pattern: str | None  # None means "any args"


@dataclass(frozen=True)
class _Clause:
    terms: tuple[_Term, ...]  # AND-joined
    op: str  # "and"


def _parse_single(raw: str) -> _Term | None:
    text = raw.strip()
    if not text:
        return None
    negate = False
    if text.startswith("!"):
        negate = True
        text = text[1:].strip()
    match = _RULE_RE.match(text)
    if not match:
        return None
    return _Term(
        negate=negate,
        tool=match.group("tool"),
        arg_pattern=match.group("arg"),
    )


def parse(rule: str) -> list[_Term]:
    """Parse an `if` rule into a flat list of AND-joined terms.

    v1 supports the common case: `A and B and not C` or single terms.
    `or` is not currently emitted by real TS plugins, so v1 treats `or`
    as `and` (conservative — never fires when either side fails). A later
    patch can split on `or` into a disjunction if needed.
    """
    if not rule or not rule.strip():
        return []
    parts = _TOKEN_RE.split(rule)
    terms: list[_Term] = []
    for part in parts:
        parsed = _parse_single(part)
        if parsed is not None:
            terms.append(parsed)
    return terms


def _glob_match(pattern: str, value: str) -> bool:
    return fnmatch.fnmatchcase(value, pattern)


def _extract_arg_value(tool_name: str, tool_input: dict[str, Any]) -> str:
    """Pick the most-relevant scalar for matching against the `if` arg pattern.

    Mirrors what TS does: Bash -> command string; file-ish tools ->
    file_path/path; else json-encoded value.
    """
    name = (tool_name or "").lower()
    if name == "bash":
        return str(tool_input.get("command") or "")
    for key in ("file_path", "path", "notebook_path", "pattern", "url"):
        if key in tool_input:
            return str(tool_input.get(key) or "")
    return ""


def evaluate(rule: str, tool_name: str, tool_input: dict[str, Any]) -> bool:
    """Return True if the hook should run for (tool_name, tool_input).

    Empty/missing rule -> True (no filter). Unparseable rule -> True
    (defensive: don't silently skip the hook).
    """
    terms = parse(rule)
    if not terms:
        return True
    arg_value = _extract_arg_value(tool_name, tool_input)
    for term in terms:
        hit = term.tool == tool_name
        if hit and term.arg_pattern is not None:
            hit = _glob_match(term.arg_pattern, arg_value)
        if term.negate:
            hit = not hit
        if not hit:
            return False
    return True
