"""Behavior-equivalence tests for the durable-agent runtime registry (Phase 1).

These assert that ``core.runtime_registry.resolve`` reproduces the EXACT
``(name, target)`` output of the pre-registry ``_resolve_native_agent_runtime``
precedence ladder for a full matrix of inputs — the "no behavior change"
guarantee for the dispatch refactor in ``workflows/sw_workflow.py``.

``_reference_resolve`` below is a frozen verbatim copy of the OLD logic; the
registry is asserted equal to it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import runtime_registry  # noqa: E402
from core.config import config  # noqa: E402


# --- frozen reference: the OLD _resolve_native_agent_runtime ----------------
def _reference_targets() -> dict[str, dict[str, str]]:
    return {
        "dapr-agent-py": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.DAPR_AGENT_PY_APP_ID,
            "instance_prefix": "durable",
        },
        "dapr-agent-py-testing": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.DAPR_AGENT_PY_TESTING_APP_ID,
            "instance_prefix": "durable-testing",
        },
        "browser-use-agent": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.BROWSER_USE_AGENT_APP_ID,
            "instance_prefix": "durable-browser-use",
        },
        "adk-agent-py": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.ADK_AGENT_PY_APP_ID,
            "instance_prefix": "durable-adk",
        },
        "claude-agent-py": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.CLAUDE_AGENT_PY_APP_ID,
            "instance_prefix": "durable-claude",
        },
        "claude-code-cli": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.CLAUDE_CODE_CLI_APP_ID,
            "instance_prefix": "durable-claude-cli",
        },
        "codex-cli": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.CODEX_CLI_APP_ID,
            "instance_prefix": "durable-codex-cli",
        },
        "agy-cli": {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": config.AGY_CLI_APP_ID,
            "instance_prefix": "durable-agy-cli",
        },
    }


def _reference_resolve(flattened_args, agent_config):
    targets = _reference_targets()
    agent_app_id = (
        flattened_args.get("agentAppId").strip()
        if isinstance(flattened_args.get("agentAppId"), str)
        and flattened_args.get("agentAppId").strip()
        else agent_config.get("agentAppId").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("agentAppId"), str)
        and agent_config.get("agentAppId").strip()
        else ""
    )
    if agent_app_id:
        return agent_app_id, {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": agent_app_id,
            "instance_prefix": "durable",
        }
    runtime = (
        flattened_args.get("agentRuntime").strip()
        if isinstance(flattened_args.get("agentRuntime"), str)
        and flattened_args.get("agentRuntime").strip()
        else flattened_args.get("runtime").strip()
        if isinstance(flattened_args.get("runtime"), str)
        and flattened_args.get("runtime").strip()
        else agent_config.get("runtime").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("runtime"), str)
        and agent_config.get("runtime").strip()
        else agent_config.get("agentRuntime").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("agentRuntime"), str)
        and agent_config.get("agentRuntime").strip()
        else "dapr-agent-py"
    )
    if runtime in targets:
        return runtime, targets[runtime]
    agent_slug = (
        flattened_args.get("agentSlug").strip()
        if isinstance(flattened_args.get("agentSlug"), str)
        and flattened_args.get("agentSlug").strip()
        else agent_config.get("slug").strip()
        if isinstance(agent_config, dict)
        and isinstance(agent_config.get("slug"), str)
        and agent_config.get("slug").strip()
        else ""
    )
    if agent_slug:
        derived = f"agent-runtime-{agent_slug}"
        return derived, {
            "workflow_name": config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME,
            "app_id": derived,
            "instance_prefix": "durable",
        }
    allowed = ", ".join(sorted(targets))
    raise RuntimeError(
        f"Unsupported durable/run agentRuntime '{runtime}' and no agentAppId/agentSlug in body. "
        f"Allowed legacy runtimes: {allowed}"
    )


_CORE_KEYS = ("workflow_name", "app_id", "instance_prefix")

# Full precedence matrix: each entry is (flattened_args, agent_config).
_MATRIX = [
    # agentAppId precedence (flattened, agent_config, both, whitespace)
    ({"agentAppId": "agent-runtime-pool-coding"}, None),
    ({"agentAppId": "  agent-runtime-foo  "}, {"runtime": "claude-agent-py"}),
    ({}, {"agentAppId": "agent-runtime-bar"}),
    ({"agentAppId": "win"}, {"agentAppId": "lose"}),
    ({"agentAppId": "win", "agentRuntime": "claude-agent-py", "agentSlug": "x"}, {"slug": "y"}),
    # enum: every registered runtime via each source field
    ({"agentRuntime": "dapr-agent-py"}, None),
    ({"agentRuntime": "dapr-agent-py-testing"}, None),
    ({"agentRuntime": "browser-use-agent"}, None),
    ({"agentRuntime": "adk-agent-py"}, None),
    ({"agentRuntime": "claude-agent-py"}, None),
    ({"agentRuntime": "claude-code-cli"}, None),
    ({"agentRuntime": "codex-cli"}, None),
    ({"agentRuntime": "agy-cli"}, None),
    ({"runtime": "claude-agent-py"}, None),
    ({}, {"runtime": "adk-agent-py"}),
    ({}, {"agentRuntime": "browser-use-agent"}),
    # agentRuntime beats runtime beats agent_config
    ({"agentRuntime": "claude-agent-py", "runtime": "dapr-agent-py"}, {"runtime": "adk-agent-py"}),
    # default to dapr-agent-py
    ({}, None),
    ({}, {}),
    ({"runtime": "   "}, {"runtime": "  "}),
    # unknown runtime falls through to slug
    ({"agentRuntime": "totally-unknown", "agentSlug": "my-agent"}, None),
    ({"runtime": "nope"}, {"slug": "cfg-slug"}),
    # slug whitespace + flattened beats agent_config.slug
    ({"agentSlug": "  spaced  "}, None),
    ({"agentSlug": "flat"}, {"slug": "cfg"}),
]


@pytest.mark.parametrize("flattened_args,agent_config", _MATRIX)
def test_registry_resolve_matches_reference(flattened_args, agent_config):
    ref_name, ref_target = _reference_resolve(flattened_args, agent_config)
    name, descriptor = runtime_registry.resolve(flattened_args, agent_config)
    target = descriptor.to_target_dict()

    assert name == ref_name
    assert {k: target[k] for k in _CORE_KEYS} == ref_target
    # Additive two-name fields carry the same values the dispatch site used as
    # literals before the refactor.
    assert target["dispatch_workflow_name"] == "session_workflow"
    assert target["bridge_gate_token"] == config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME
    assert target["workflow_name"] == target["bridge_gate_token"]


def test_unknown_runtime_no_slug_raises_same_message():
    flattened_args, agent_config = {"agentRuntime": "totally-unknown"}, None
    with pytest.raises(RuntimeError) as ref_exc:
        _reference_resolve(flattened_args, agent_config)
    with pytest.raises(RuntimeError) as new_exc:
        runtime_registry.resolve(flattened_args, agent_config)
    assert str(new_exc.value) == str(ref_exc.value)
    assert (
        "adk-agent-py, agy-cli, browser-use-agent, claude-agent-py, "
        "claude-code-cli, codex-cli, dapr-agent-py, dapr-agent-py-testing"
    ) in str(new_exc.value)


def test_registry_ids_match_legacy_target_set():
    assert sorted(runtime_registry.registry.ids()) == sorted(_reference_targets())


def test_benchmark_runtimes():
    ids = {d.id for d in runtime_registry.registry.list_benchmark_runtimes()}
    assert ids == {
        "dapr-agent-py",
        "adk-agent-py",
        "claude-agent-py",
        "claude-code-cli",
        "codex-cli",
        "agy-cli",
    }


def test_descriptor_capabilities_present_and_typed():
    for descriptor in runtime_registry.registry.list_runtimes():
        caps = descriptor.capabilities
        assert caps["durabilityGranularity"] in {"per-activity", "per-turn", "per-session"}
        assert isinstance(caps["supportsMcp"], bool)
        assert isinstance(caps["supportedProviders"], list)
    # The verified reference runtime is per-activity + multi-provider.
    dapr = runtime_registry.registry.by_id("dapr-agent-py")
    assert dapr.capabilities["durabilityGranularity"] == "per-activity"
    assert dapr.capabilities["multiProvider"] is True
    # claude-agent-py: per-turn, MCP wired in Phase 0, Anthropic-only, unverified.
    claude = runtime_registry.registry.by_id("claude-agent-py")
    assert claude.capabilities["durabilityGranularity"] == "per-turn"
    assert claude.capabilities["supportsMcp"] is True
    assert claude.capabilities["supportedProviders"] == ["anthropic"]
    assert claude.capabilities_verified is False


def test_app_ids_resolved_from_config():
    assert runtime_registry.registry.by_id("claude-agent-py").app_id == config.CLAUDE_AGENT_PY_APP_ID
    assert runtime_registry.registry.by_id("dapr-agent-py").app_id == config.DAPR_AGENT_PY_APP_ID
