"""Tests for the cap_files helper inside CHECKPOINT_SCRIPT."""
from __future__ import annotations

import os
import re
import sys
import types
from textwrap import dedent


def _load_code_checkpoint_module():
    # Stub openshell_runtime so we can import code_checkpoint without Dapr deps.
    # Build a `src` package pointing at the real services/dapr-agent-py/src dir
    # so that `from src.openshell_runtime import ...` resolves to our stub.
    # Snapshot + restore every src* module so the stub swap cannot leak into
    # other test files (permanent replacement poisoned later collection).
    import importlib.util
    from pathlib import Path

    src_dir = Path(__file__).resolve().parent.parent / "src"
    saved = {k: v for k, v in sys.modules.items() if k == "src" or k.startswith("src.")}
    try:
        # Register a minimal `src` package
        src_pkg = types.ModuleType("src")
        src_pkg.__path__ = [str(src_dir)]
        sys.modules["src"] = src_pkg

        stub = types.ModuleType("src.openshell_runtime")
        stub.DEFAULT_CWD = "/sandbox"

        class _RT:  # minimal placeholder
            pass

        stub.OpenShellRuntime = _RT
        sys.modules["src.openshell_runtime"] = stub

        spec = importlib.util.spec_from_file_location(
            "src.code_checkpoint", src_dir / "code_checkpoint.py"
        )
        code_checkpoint = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(code_checkpoint)
        return code_checkpoint
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


def _load_cap_files():
    """Extract cap_files + CHANGED_FILES_CAP from CHECKPOINT_SCRIPT and exec in a fresh namespace."""
    code_checkpoint = _load_code_checkpoint_module()

    # cap_files + the CAP constant live inside the heredoc script. Extract and
    # exec only those definitions into an isolated namespace.
    src = code_checkpoint.CHECKPOINT_SCRIPT
    match = re.search(
        r"CHANGED_FILES_CAP\s*=\s*\d+.*?def cap_files\(files\):.*?return truncated,\s*total\n",
        src,
        re.DOTALL,
    )
    assert match, "cap_files definition not found in CHECKPOINT_SCRIPT"
    ns: dict = {}
    exec(dedent(match.group(0)), ns)
    return ns["cap_files"], ns["CHANGED_FILES_CAP"]


def test_checkpoint_scripts_use_python36_subprocess_keywords():
    code_checkpoint = _load_code_checkpoint_module()
    scripts = [code_checkpoint.CHECKPOINT_SCRIPT, code_checkpoint.RESTORE_SCRIPT]
    assert all("universal_newlines=True" in script for script in scripts)
    assert all("text=True" not in script for script in scripts)


def test_cap_files_noop_below_threshold():
    cap_files, cap = _load_cap_files()
    files = [{"path": f"f{i}.txt", "status": "A"} for i in range(10)]
    capped, total = cap_files(files)
    assert total == 10
    assert len(capped) == 10
    assert capped == files
    assert all(entry.get("status") != "truncated" for entry in capped)


def test_cap_files_boundary_exact_cap():
    cap_files, cap = _load_cap_files()
    files = [{"path": f"f{i}.txt", "status": "A"} for i in range(cap)]
    capped, total = cap_files(files)
    assert total == cap
    assert len(capped) == cap
    assert all(entry.get("status") != "truncated" for entry in capped)


def test_cap_files_truncates_above_threshold():
    cap_files, cap = _load_cap_files()
    files = [{"path": f"f{i}.txt", "status": "A"} for i in range(cap + 50)]
    capped, total = cap_files(files)
    # fileCount reports the real total
    assert total == cap + 50
    # payload holds first cap entries + one synthetic marker
    assert len(capped) == cap + 1
    assert capped[:cap] == files[:cap]
    marker = capped[-1]
    assert marker["status"] == "truncated"
    assert marker["count"] == 50
    assert marker["path"] is None
    assert marker["previousPath"] is None


def test_cap_files_large_payload():
    cap_files, cap = _load_cap_files()
    files = [{"path": f"f{i}.txt", "status": "M"} for i in range(5000)]
    capped, total = cap_files(files)
    assert total == 5000
    assert len(capped) == cap + 1
    assert capped[-1]["count"] == 5000 - cap
