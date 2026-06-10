"""Test bootstrap: service root on sys.path + a minimal `dapr.ext.workflow`
stub when the real SDK (or its grpc native deps) is unavailable, so the
lightweight tests run without a Dapr sidecar or compiled grpc wheels."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

# Unit tests never talk to a live herdr server.
os.environ.setdefault("HERDR_DISABLE", "1")


def _install_dapr_stub() -> None:
    try:
        import dapr.ext.workflow  # noqa: F401

        return
    except Exception:
        pass
    # Drop any partially-initialized dapr modules from the failed import.
    for name in [m for m in list(sys.modules) if m == "dapr" or m.startswith("dapr.")]:
        sys.modules.pop(name)

    wf = types.ModuleType("dapr.ext.workflow")

    class DaprWorkflowContext:  # noqa: D401 - typing stand-in only
        pass

    class RetryPolicy:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def when_any(_tasks):
        raise NotImplementedError(
            "stubbed when_any — tests monkeypatch src.session_workflow.wf_when_any"
        )

    class WorkflowRuntime:
        def register_workflow(self, *args, **kwargs):
            return None

        def register_activity(self, *args, **kwargs):
            return None

        def start(self):
            return None

        def shutdown(self):
            return None

    class DaprWorkflowClient:
        def terminate_workflow(self, *args, **kwargs):
            return None

        def suspend_workflow(self, *args, **kwargs):
            return None

        def resume_workflow(self, *args, **kwargs):
            return None

        def purge_workflow(self, *args, **kwargs):
            return None

    wf.DaprWorkflowContext = DaprWorkflowContext
    wf.RetryPolicy = RetryPolicy
    wf.when_any = when_any
    wf.WorkflowRuntime = WorkflowRuntime
    wf.DaprWorkflowClient = DaprWorkflowClient

    dapr_mod = types.ModuleType("dapr")
    ext_mod = types.ModuleType("dapr.ext")
    dapr_mod.ext = ext_mod
    ext_mod.workflow = wf
    sys.modules["dapr"] = dapr_mod
    sys.modules["dapr.ext"] = ext_mod
    sys.modules["dapr.ext.workflow"] = wf


_install_dapr_stub()
