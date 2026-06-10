"""Runtime capability conformance harness (DurableSessionRuntime — roadmap item 6).

The STATIC half of capability honesty (no cluster needed): asserts the registry
descriptors are structurally consistent + match a code-derived expectation table,
and exercises the hard/soft enforcement split that gates ``capabilitiesVerified``.

The DYNAMIC half — a live per-runtime smoke (registers ``session_workflow``,
returns the required keys, ``supportsMcp`` ⇒ a declared MCP tool is callable,
``ownsSandbox`` ⇒ ``.solve.modelPatch`` is emitted) — runs against a cluster and
is what justifies flipping ``capabilitiesVerified`` + enabling
``AGENT_RUNTIME_REJECT_LOSSY_SWAP``. It is intentionally NOT in this CI suite.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import runtime_registry as rr  # noqa: E402
from core.conformance import (  # noqa: E402
    assert_descriptor_consistency,
    check_descriptor_consistency,
    descriptor_violations,
    return_shape_violations,
)

# Code-derived expectation table (the "seed values verified from code" in the
# roadmap §Phase 5). A descriptor that drifts from its real wiring fails here
# before it can mis-dispatch. Only the load-bearing dispatch capabilities are
# pinned; provider LISTS are checked by count via the soft invariants.
EXPECTED: dict[str, dict[str, object]] = {
    "dapr-agent-py": {
        "family": "durable-session",
        "durabilityGranularity": "per-activity",
        "multiProvider": True,
        "ownsSandbox": False,
        "requiresWarmPool": False,
        "requiresBrowserSidecars": False,
        "supportsMcp": True,
        "capabilitiesVerified": True,
    },
    "dapr-agent-py-testing": {
        "family": "durable-session",
        "durabilityGranularity": "per-activity",
        "multiProvider": True,
        "ownsSandbox": False,
        "requiresWarmPool": False,
        "requiresBrowserSidecars": False,
        "supportsMcp": True,
        "capabilitiesVerified": True,
    },
    "browser-use-agent": {
        "family": "browser",
        "durabilityGranularity": "per-activity",
        "ownsSandbox": False,
        "requiresWarmPool": True,
        "requiresBrowserSidecars": True,
        "supportsMcp": True,
        "capabilitiesVerified": False,
    },
    "adk-agent-py": {
        "family": "durable-session",
        "durabilityGranularity": "per-turn",
        "multiProvider": False,
        "ownsSandbox": True,
        "requiresWarmPool": False,
        "requiresBrowserSidecars": False,
        "supportsMcp": True,
        "capabilitiesVerified": False,
    },
    "claude-agent-py": {
        "family": "durable-session",
        "durabilityGranularity": "per-turn",
        "multiProvider": False,
        "ownsSandbox": True,
        "requiresWarmPool": False,
        "requiresBrowserSidecars": False,
        "supportsMcp": True,
        "capabilitiesVerified": False,
    },
    "claude-code-cli": {
        # interactive-cli: the real Claude Code TUI in a herdr pane; the
        # workflow wraps the session LIFECYCLE (per-session durability) and
        # durable/run dispatch is rejected for this family.
        "family": "interactive-cli",
        "durabilityGranularity": "per-session",
        "multiProvider": False,
        "ownsSandbox": True,
        "requiresWarmPool": False,
        "requiresBrowserSidecars": False,
        "supportsMcp": True,
        "capabilitiesVerified": False,
    },
}

ALL_RUNTIME_IDS = sorted(EXPECTED)


def test_boot_guard_passes_on_current_registry():
    # The exact check the orchestrator runs at startup — the registry must boot.
    n = assert_descriptor_consistency()
    assert n == len(ALL_RUNTIME_IDS)
    assert check_descriptor_consistency() == []


def test_registry_has_exactly_the_expected_runtimes():
    assert sorted(rr.registry.ids()) == ALL_RUNTIME_IDS


@pytest.mark.parametrize("runtime_id", ALL_RUNTIME_IDS)
def test_descriptor_matches_code_derived_expectation(runtime_id):
    d = rr.registry.by_id(runtime_id)
    assert d is not None, runtime_id
    expected = EXPECTED[runtime_id]
    assert d.family == expected["family"]
    assert bool(d.capabilities_verified) is expected["capabilitiesVerified"]
    for cap, want in expected.items():
        if cap in ("family", "capabilitiesVerified"):
            continue
        assert d.capabilities.get(cap) == want, f"{runtime_id}.{cap}"


@pytest.mark.parametrize("runtime_id", ALL_RUNTIME_IDS)
def test_no_runtime_has_hard_violations(runtime_id):
    # Hard invariants must hold for EVERY runtime (verified or not).
    from core.conformance import _hard_violations  # noqa: PLC0415

    assert _hard_violations(rr.registry.by_id(runtime_id)) == []


def test_verified_runtimes_are_fully_consistent():
    # capabilitiesVerified=true ⇒ passes hard AND soft checks (the honesty gate).
    for d in rr.registry.list_runtimes():
        if d.capabilities_verified:
            assert descriptor_violations(d) == [], d.id


def test_soft_checks_are_gated_on_capabilitiesVerified():
    # browser-use declares multiProvider=true with a single provider — an
    # ALLOWED soft inconsistency precisely because it is unverified. The gate is
    # that flipping it to verified would surface the violation, blocking the flip.
    bu = rr.registry.by_id("browser-use-agent")
    assert bu is not None
    assert bu.capabilities.get("multiProvider") is True
    assert len(bu.capabilities.get("supportedProviders") or []) == 1
    assert descriptor_violations(bu) == []  # unverified → soft check skipped

    bu_verified = dataclasses.replace(bu, capabilities_verified=True)
    violations = descriptor_violations(bu_verified)
    assert any("multiProvider" in v for v in violations), violations


def test_owns_sandbox_and_warm_pool_are_mutually_exclusive():
    for d in rr.registry.list_runtimes():
        if d.capabilities.get("ownsSandbox"):
            assert not d.capabilities.get("requiresWarmPool"), d.id


def test_browser_sidecars_imply_browser_family_and_warm_pool():
    for d in rr.registry.list_runtimes():
        if d.capabilities.get("requiresBrowserSidecars"):
            assert d.family == "browser", d.id
            assert d.capabilities.get("requiresWarmPool") is True, d.id


# --- return-shape contract (bridge-side WARN net; the item-5 deferral) ---------


def test_return_shape_accepts_a_conforming_result():
    result = {
        "success": True,
        "output": "patch applied",
        "sessionId": "sess-1",
        "agentRuntime": "dapr-agent-py",
    }
    assert return_shape_violations(result) == []


def test_return_shape_accepts_content_instead_of_output():
    result = {
        "success": True,
        "content": "hello",
        "sessionId": "sess-1",
        "agentRuntime": "claude-agent-py",
    }
    assert return_shape_violations(result) == []


def test_return_shape_flags_missing_payload_and_keys():
    assert return_shape_violations({"sessionId": "s", "agentRuntime": "r", "success": True}) == [
        "missing an output payload (one of ['output', 'content'])"
    ]
    issues = return_shape_violations({"output": "x"})
    assert any("sessionId" in i for i in issues)
    assert any("agentRuntime" in i for i in issues)


def test_return_shape_flags_non_dict():
    assert return_shape_violations("not a dict") == [
        "result is str, expected a dict"
    ]
