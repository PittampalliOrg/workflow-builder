from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

import pytest  # noqa: E402

from src.openshell_runtime import (  # noqa: E402
    LocalWorkspaceRuntime,
    OpenShellRuntime,
    bind_runtime,
    effective_sandbox_name,
    new_runtime,
    require_local_runtime_for_shared_workspace,
    reset_runtime,
)


def _runtime(tmp_path) -> LocalWorkspaceRuntime:
    rt = LocalWorkspaceRuntime()
    rt.set_cwd(str(tmp_path))
    return rt


def test_mode_selection(monkeypatch) -> None:
    monkeypatch.setenv("DAPR_AGENT_PY_WORKSPACE_MODE", "local")
    assert isinstance(new_runtime(), LocalWorkspaceRuntime)
    monkeypatch.setenv("DAPR_AGENT_PY_WORKSPACE_MODE", "openshell")
    assert type(new_runtime()) is OpenShellRuntime
    monkeypatch.delenv("DAPR_AGENT_PY_WORKSPACE_MODE", raising=False)
    assert type(new_runtime()) is OpenShellRuntime  # default = openshell


def test_shared_workspace_on_openshell_runtime_fails_loud() -> None:
    # A ws_script_ session that fell back to OpenShellRuntime must be refused, not run
    # against a throwaway sandbox whose writes never reach the shared subtree.
    with pytest.raises(RuntimeError, match="requires LocalWorkspaceRuntime"):
        require_local_runtime_for_shared_workspace(
            OpenShellRuntime(), "ws_script_exec-1"
        )


def test_shared_workspace_on_local_runtime_is_allowed() -> None:
    # LocalWorkspaceRuntime bound to the shared workspace is the correct pairing.
    require_local_runtime_for_shared_workspace(
        LocalWorkspaceRuntime(), "ws_script_exec-1"
    )


def test_non_shared_workspace_never_fails() -> None:
    # Pod-local / non-ws_script sessions are unaffected on either runtime.
    require_local_runtime_for_shared_workspace(OpenShellRuntime(), None)
    require_local_runtime_for_shared_workspace(OpenShellRuntime(), "workspace/other")


def test_local_runtime_ignores_any_sandbox_name() -> None:
    # A stray sandbox name must never route a local-mode session to a remote sandbox.
    assert effective_sandbox_name(LocalWorkspaceRuntime(), "ws-script-exec-1") == ""
    assert effective_sandbox_name(LocalWorkspaceRuntime(), "dapr-agent-py-juicefs") == ""
    assert effective_sandbox_name(LocalWorkspaceRuntime(), None) == ""


def test_openshell_runtime_keeps_its_sandbox_name() -> None:
    assert (
        effective_sandbox_name(OpenShellRuntime(), "sbx-1") == "sbx-1"
    )


def test_default_cwd_is_local_root(monkeypatch) -> None:
    monkeypatch.setenv("DAPR_AGENT_PY_LOCAL_WORKSPACE_ROOT", "/tmp")
    monkeypatch.delenv("OPENSHELL_CWD", raising=False)
    rt = LocalWorkspaceRuntime()
    assert rt.cwd == "/tmp"
    assert rt.sandbox_name == "local"


def test_platform_fallback_cwd_stays_on_workspace_root(monkeypatch) -> None:
    # The turn handler stamps cwd="/sandbox" as a fallback on every message
    # (main.py) and bind_runtime forwards it as if explicit. In local mode
    # that would strand writes on the pod-local emptyDir, so the fallback
    # must be ignored in favor of the workspace root.
    monkeypatch.setenv("DAPR_AGENT_PY_LOCAL_WORKSPACE_ROOT", "/tmp/ws")
    monkeypatch.delenv("OPENSHELL_CWD", raising=False)
    rt = LocalWorkspaceRuntime()
    rt.set_cwd("/sandbox")
    assert rt.cwd == "/tmp/ws"
    rt.set_cwd("/sandbox/")
    assert rt.cwd == "/tmp/ws"
    rt.set_cwd(None)
    assert rt.cwd == "/tmp/ws"


def test_explicit_workflow_cwd_still_wins(monkeypatch) -> None:
    # A deliberate `with.cwd` other than the platform fallback is preserved.
    monkeypatch.setenv("DAPR_AGENT_PY_LOCAL_WORKSPACE_ROOT", "/tmp/ws")
    monkeypatch.delenv("OPENSHELL_CWD", raising=False)
    rt = LocalWorkspaceRuntime()
    rt.set_cwd("/sandbox/work/repo")
    assert rt.cwd == "/sandbox/work/repo"


def test_bind_runtime_fallback_cwd_local_mode(monkeypatch) -> None:
    monkeypatch.setenv("DAPR_AGENT_PY_WORKSPACE_MODE", "local")
    monkeypatch.setenv("DAPR_AGENT_PY_LOCAL_WORKSPACE_ROOT", "/tmp/ws")
    monkeypatch.delenv("OPENSHELL_CWD", raising=False)
    rt, token = bind_runtime(sandbox_name=None, cwd="/sandbox", session_id="s1")
    try:
        assert isinstance(rt, LocalWorkspaceRuntime)
        assert rt.cwd == "/tmp/ws"
    finally:
        reset_runtime(token)


def test_execute_runs_local_shell(tmp_path) -> None:
    rt = _runtime(tmp_path)
    res = rt.execute("echo hello && pwd")
    assert res["ok"] is True
    assert res["exit_code"] == 0
    assert "hello" in res["stdout"]
    # command runs in the configured cwd
    assert str(tmp_path) in res["stdout"]


def test_execute_nonzero_exit(tmp_path) -> None:
    rt = _runtime(tmp_path)
    res = rt.execute("exit 7")
    assert res["ok"] is False
    assert res["exit_code"] == 7


def test_write_then_read_text(tmp_path) -> None:
    rt = _runtime(tmp_path)
    w = rt.write_text(str(tmp_path / "a" / "b.txt"), "line1\nline2\n")
    assert w["ok"] is True
    assert (tmp_path / "a" / "b.txt").read_text() == "line1\nline2\n"
    r = rt.read_text(str(tmp_path / "a" / "b.txt"))
    assert r["ok"] is True
    assert r["content"] == "line1\nline2\n"


def test_read_file_lines_offset_limit(tmp_path) -> None:
    rt = _runtime(tmp_path)
    p = tmp_path / "f.txt"
    p.write_text("".join(f"l{i}\n" for i in range(1, 11)))
    r = rt.read_file_lines(str(p), offset=2, limit=3)
    assert r["ok"] is True
    assert r["lines"] == ["l3", "l4", "l5"]
    assert r["total_lines"] == 10
    assert r["start_line"] == 3 and r["end_line"] == 5


def test_stat_path(tmp_path) -> None:
    rt = _runtime(tmp_path)
    p = tmp_path / "s.txt"
    p.write_text("abc")
    st = rt.stat_path(str(p))
    assert st["ok"] is True and st["exists"] is True
    assert st["is_file"] is True and st["size"] == 3
    missing = rt.stat_path(str(tmp_path / "nope.txt"))
    assert missing["ok"] is True and missing["exists"] is False


def test_glob_files(tmp_path) -> None:
    rt = _runtime(tmp_path)
    (tmp_path / "x.py").write_text("a")
    (tmp_path / "y.py").write_text("b")
    (tmp_path / "z.txt").write_text("c")
    g = rt.glob_files("*.py", str(tmp_path), max_results=10)
    assert g["ok"] is True
    assert g["total"] == 2
    assert all(m.endswith(".py") for m in g["matches"])


def test_run_python_with_payload(tmp_path) -> None:
    rt = _runtime(tmp_path)
    res = rt.run_python(
        "import json,sys; d=json.loads(sys.stdin.read()); print(d['x']*2)",
        {"x": 21},
    )
    assert res["ok"] is True
    assert res["stdout"].strip() == "42"


def test_read_bytes_base64_small(tmp_path) -> None:
    import base64

    rt = _runtime(tmp_path)
    p = tmp_path / "img.bin"
    data = bytes(range(256)) * 4  # 1 KiB, small path
    p.write_bytes(data)
    res = rt.read_bytes_base64(str(p))
    assert res["ok"] is True
    assert base64.b64decode(res["base64"]) == data


def test_read_bytes_base64_chunked(tmp_path) -> None:
    import base64

    rt = _runtime(tmp_path)
    p = tmp_path / "big.bin"
    data = os.urandom(600 * 1024)  # >256 KiB → chunked path
    p.write_bytes(data)
    res = rt.read_bytes_base64(str(p))
    assert res["ok"] is True
    assert base64.b64decode(res["base64"]) == data


def test_relative_path_resolves_against_cwd(tmp_path) -> None:
    rt = _runtime(tmp_path)
    rt.write_text("rel.txt", "hi")  # relative → resolved against cwd
    assert (tmp_path / "rel.txt").read_text() == "hi"
