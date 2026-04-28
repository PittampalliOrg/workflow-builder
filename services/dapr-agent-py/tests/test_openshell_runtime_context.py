from __future__ import annotations

import asyncio
import importlib
import os
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"


def _install_src_package() -> None:
    src_pkg = sys.modules.get("src") or types.ModuleType("src")
    src_pkg.__path__ = [str(SRC_DIR)]
    sys.modules["src"] = src_pkg

    tools_pkg = sys.modules.get("src.tools") or types.ModuleType("src.tools")
    tools_pkg.__path__ = [str(SRC_DIR / "tools")]
    sys.modules["src.tools"] = tools_pkg


def _load_runtime(monkeypatch):
    fake_openshell = types.ModuleType("openshell")

    class SandboxClient:
        @classmethod
        def from_active_cluster(cls):
            raise AssertionError("test should not connect to OpenShell")

    class SandboxSession:
        pass

    fake_openshell.SandboxClient = SandboxClient
    fake_openshell.SandboxSession = SandboxSession
    monkeypatch.setitem(sys.modules, "openshell", fake_openshell)
    _install_src_package()
    sys.modules.pop("src.openshell_runtime", None)
    return importlib.import_module("src.openshell_runtime")


def test_bound_runtime_is_context_local(monkeypatch):
    runtime_mod = _load_runtime(monkeypatch)

    async def worker(name: str, cwd: str) -> None:
        runtime, token = runtime_mod.bind_runtime(
            sandbox_name=name,
            cwd=cwd,
            session_id=f"session-{name}",
        )
        try:
            await asyncio.sleep(0)
            current = runtime_mod.get_runtime()
            assert current is runtime
            assert current.configured_sandbox_name == name
            assert current.resolve_path("file.txt") == f"{cwd}/file.txt"
            assert current.session_id == f"session-{name}"
        finally:
            runtime_mod.reset_runtime(token)

    async def main() -> None:
        await asyncio.gather(
            worker("sandbox-a", "/sandbox/a"),
            worker("sandbox-b", "/sandbox/b"),
        )

    asyncio.run(main())


def test_binding_runtime_does_not_mutate_process_environment(monkeypatch):
    runtime_mod = _load_runtime(monkeypatch)
    monkeypatch.delenv("OPENSHELL_SANDBOX_NAME", raising=False)
    monkeypatch.delenv("OPENSHELL_CWD", raising=False)

    _runtime, token = runtime_mod.bind_runtime(
        sandbox_name="sandbox-a",
        cwd="/sandbox/repo",
        session_id="session-a",
    )
    try:
        assert os.environ.get("OPENSHELL_SANDBOX_NAME") is None
        assert os.environ.get("OPENSHELL_CWD") is None
    finally:
        runtime_mod.reset_runtime(token)


def test_security_expand_path_uses_bound_runtime(monkeypatch):
    runtime_mod = _load_runtime(monkeypatch)
    sys.modules.pop("src.tools._security", None)
    security = importlib.import_module("src.tools._security")

    _runtime, token = runtime_mod.bind_runtime(
        sandbox_name="sandbox-a",
        cwd="/sandbox/repo",
        session_id="session-a",
    )
    try:
        assert security.expand_path("src/app.py") == "/sandbox/repo/src/app.py"
    finally:
        runtime_mod.reset_runtime(token)
