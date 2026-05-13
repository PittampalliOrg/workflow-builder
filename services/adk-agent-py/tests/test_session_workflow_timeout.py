from pathlib import Path
import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

workflow_module = types.ModuleType("dapr.ext.workflow")


class _RetryPolicy:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


workflow_module.DaprWorkflowContext = object
workflow_module.RetryPolicy = _RetryPolicy
workflow_module.when_any = lambda tasks: tasks

dapr_module = types.ModuleType("dapr")
ext_module = types.ModuleType("dapr.ext")
ext_module.workflow = workflow_module
dapr_module.ext = ext_module
sys.modules.setdefault("dapr", dapr_module)
sys.modules.setdefault("dapr.ext", ext_module)
sys.modules.setdefault("dapr.ext.workflow", workflow_module)

openshell_module = types.ModuleType("openshell")
openshell_module.SandboxClient = object
openshell_module.SandboxSession = object
sys.modules.setdefault("openshell", openshell_module)

from src.constants import SESSION_TURN_TIMEOUT_SECONDS  # noqa: E402
from src.runner.session_workflow import _session_turn_timeout_seconds  # noqa: E402


def test_session_turn_timeout_defaults_to_runtime_constant():
    assert _session_turn_timeout_seconds({}) == SESSION_TURN_TIMEOUT_SECONDS


def test_session_turn_timeout_honors_top_level_timeout_minutes():
    assert _session_turn_timeout_seconds({"timeoutMinutes": 120}) == 120 * 60


def test_session_turn_timeout_honors_agent_config_timeout_minutes():
    assert _session_turn_timeout_seconds({"agentConfig": {"timeoutMinutes": "45"}}) == 45 * 60


def test_session_turn_timeout_never_shrinks_below_default():
    assert _session_turn_timeout_seconds({"timeoutMinutes": 1}) == SESSION_TURN_TIMEOUT_SECONDS
