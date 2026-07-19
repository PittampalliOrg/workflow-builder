"""Static guard: model-facing tool text must not leak internal python names.

The model only ever sees the registered tool names (Bash, Read, Write, Edit,
Glob, Grep, TodoWrite, Agent, AskUser, WebFetch, ...). The internal python
function names behind them (bash_run, file_read, agent_spawn, ...) are an
implementation detail; kimi-code's trained tool surface steers on the
registered names, so letting an internal name slip into a description or an
``Error:`` string degrades tool use. These tests walk every
``src/tools/*/prompt.py`` getter (and every ``tool.py`` error literal) and
fail if one appears.

Prompt modules are imported under an isolated synthetic package (not
``src.tools``) so this guard executes *only* prompt.py files — never the
package ``__init__.py`` / tool.py chain, which pulls in runtime deps like
dapr_agents and src.openshell_runtime. Cross-prompt relative imports
(e.g. bash_tool's ``from ..file_read.prompt import ...``) still resolve,
because every tools subpackage is pre-registered under the synthetic root.
"""

from __future__ import annotations

import ast
import importlib
import pathlib
import re
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS_DIR = ROOT / "src" / "tools"

# Internal python function names (see src/tools/__init__.py for the mapping to
# registered tool names). Word-boundary matched to avoid false positives.
INTERNAL_NAMES = (
    "bash_run",
    "file_read",
    "file_write",
    "file_edit",
    "glob_search",
    "grep_search",
    "todo_write",
    "agent_spawn",
    "ask_user",
)
_DENY_RE = re.compile(r"\b(" + "|".join(INTERNAL_NAMES) + r")\b")
# web_fetch is also a package/module name, so only flag it in OTHER tools'
# model-facing text.
_WEB_FETCH_RE = re.compile(r"\bweb_fetch\b")

_GUARD_ROOT = "_tooldesc_guard"


def _find_leaks(text: str, package: str) -> list[str]:
    leaks = _DENY_RE.findall(text)
    if package != "web_fetch" and _WEB_FETCH_RE.search(text):
        leaks.append("web_fetch")
    return leaks


def _report(failures: list[str]) -> str:
    return (
        "Model-facing tool text must use registered tool names, not internal "
        "python function names:\n" + "\n".join(failures)
    )


def _prompt_packages() -> list[str]:
    return sorted(p.parent.name for p in TOOLS_DIR.glob("*/prompt.py"))


def _load_prompt_texts() -> dict[str, dict[str, str]]:
    """Import every prompt module in isolation and call its getters.

    Returns {package: {getter_name: description_text}}.
    """
    texts: dict[str, dict[str, str]] = {}
    try:
        root_stub = types.ModuleType(_GUARD_ROOT)
        root_stub.__path__ = [str(TOOLS_DIR)]  # type: ignore[attr-defined]
        sys.modules[_GUARD_ROOT] = root_stub
        for package in _prompt_packages():
            pkg_stub = types.ModuleType(f"{_GUARD_ROOT}.{package}")
            pkg_stub.__path__ = [str(TOOLS_DIR / package)]  # type: ignore[attr-defined]
            sys.modules[f"{_GUARD_ROOT}.{package}"] = pkg_stub
        for package in _prompt_packages():
            module = importlib.import_module(f"{_GUARD_ROOT}.{package}.prompt")
            getters = sorted(
                name
                for name in dir(module)
                if name.startswith("get_")
                and name.endswith("_description")
                and callable(getattr(module, name))
            )
            assert getters, f"{package}/prompt.py: no get_*_description() getter found"
            texts[package] = {}
            for getter in getters:
                text = getattr(module, getter)()
                assert isinstance(text, str), (
                    f"{package}/prompt.py {getter}() returned non-str"
                )
                texts[package][getter] = text
    finally:
        for name in [
            n
            for n in sys.modules
            if n == _GUARD_ROOT or n.startswith(_GUARD_ROOT + ".")
        ]:
            sys.modules.pop(name, None)
    return texts


def test_prompt_descriptions_do_not_leak_internal_function_names() -> None:
    failures: list[str] = []
    for package, getters in _load_prompt_texts().items():
        for getter, text in getters.items():
            for leak in _find_leaks(text, package):
                failures.append(f"{package}/prompt.py {getter}(): {leak!r}")
    assert not failures, _report(failures)


def test_tool_error_strings_do_not_leak_internal_function_names() -> None:
    failures: list[str] = []
    for tool_py in sorted(TOOLS_DIR.glob("*/tool.py")):
        package = tool_py.parent.name
        tree = ast.parse(tool_py.read_text())
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                continue
            # House convention: model-facing failures are 'Error: ...' strings.
            if not node.value.lstrip().startswith("Error"):
                continue
            for leak in _find_leaks(node.value, package):
                location = f"{tool_py.relative_to(ROOT)}:{node.lineno}"
                failures.append(f"{location}: {leak!r}")
    assert not failures, _report(failures)
