"""Runtime capability conformance (DurableSessionRuntime — Phase 5 / roadmap item 6).

Capability honesty: a runtime descriptor MAY declare a capability ``true`` only
if its wiring is present and (in live mode) the behavior is exhibited. This
module is the *static* half of that enforcement — it runs with no cluster:

  1. ``assert_descriptor_consistency()`` — a boot guard (modeled on
     dapr-agent-py's ``assert_dapr_agents_version()``) called at orchestrator
     startup. It fails the pod fast if any descriptor violates the structural
     capability invariants below.
  2. The conformance test harness (``tests/runtime_conformance/``) runs the same
     invariants + a per-runtime code-derived expectation table in CI.

THE HARD/SOFT SPLIT — this is the capability-honesty gate:
  * HARD invariants are true structural contradictions that would mis-dispatch a
    runtime (e.g. browser sidecars without the browser family). They are checked
    for EVERY runtime and they MUST hold on the current registry.
  * SOFT invariants are full-consistency checks (e.g. ``multiProvider`` ⇔ more
    than one provider). They are enforced ONLY for runtimes whose
    ``capabilitiesVerified`` flag is ``true``. An UNVERIFIED runtime is allowed
    to carry a soft inconsistency — that is precisely why it is not yet verified.
    A runtime can therefore only be flipped to ``capabilitiesVerified: true``
    once it passes the soft checks too, which is the honesty gate the live
    conformance smoke (the dynamic half, not in this module) sits behind.

The static invariants do NOT prove live behavior (an MCP tool actually being
callable, ``ownsSandbox`` ⇒ ``.solve.modelPatch`` actually emitted) — that is the
live smoke's job and is why ``capabilitiesVerified`` is a separate flag the
harness flips, not something derivable from the descriptor alone.
"""

from __future__ import annotations

from typing import Any, Mapping

from core.runtime_registry import RuntimeDescriptor, RuntimeRegistry
from core.runtime_registry import registry as _default_registry

_KNOWN_DURABILITY_GRANULARITIES = {"per-activity", "per-turn", "per-session"}

# Core return-shape contract every durable/run child result must satisfy
# (plan §Return schema). sessionId/agentRuntime/success are stamped by the
# bridge, so the load-bearing requirement is an output payload.
_REQUIRED_RETURN_KEYS = ("sessionId", "agentRuntime", "success")
_REQUIRED_RETURN_PAYLOAD_KEYS = ("output", "content")


def _cap(d: RuntimeDescriptor, name: str) -> bool:
    return bool(d.capabilities.get(name))


def _hard_violations(d: RuntimeDescriptor) -> list[str]:
    """Structural contradictions — checked for every runtime; must hold today."""
    out: list[str] = []
    providers = d.capabilities.get("supportedProviders") or []

    # Every runtime must declare at least one provider (dispatch needs one).
    if not providers:
        out.append(f"{d.id}: supportedProviders is empty (every runtime needs >=1)")

    # Browser sidecars imply the browser family + a warm pool (Chromium boot).
    if _cap(d, "requiresBrowserSidecars") and d.family != "browser":
        out.append(
            f"{d.id}: requiresBrowserSidecars=true but family={d.family!r} (expected 'browser')"
        )
    if _cap(d, "requiresBrowserSidecars") and not _cap(d, "requiresWarmPool"):
        out.append(f"{d.id}: requiresBrowserSidecars=true but requiresWarmPool=false")

    # ownsSandbox and requiresWarmPool are mutually exclusive sandbox-ownership
    # models — a runtime either manages its own pod-local sandbox or draws from
    # the shared warm pool, never both.
    if _cap(d, "ownsSandbox") and _cap(d, "requiresWarmPool"):
        out.append(
            f"{d.id}: ownsSandbox=true AND requiresWarmPool=true (mutually exclusive sandbox models)"
        )

    # durabilityGranularity must be one of the known values.
    gran = d.capabilities.get("durabilityGranularity")
    if gran is not None and gran not in _KNOWN_DURABILITY_GRANULARITIES:
        out.append(f"{d.id}: unknown durabilityGranularity={gran!r}")

    return out


def _soft_violations(d: RuntimeDescriptor) -> list[str]:
    """Full-consistency checks — enforced ONLY for capabilitiesVerified runtimes."""
    out: list[str] = []
    providers = d.capabilities.get("supportedProviders") or []

    # multiProvider must match the provider count exactly.
    if _cap(d, "multiProvider") and len(providers) <= 1:
        out.append(
            f"{d.id}: multiProvider=true but supportedProviders={list(providers)} (needs >1)"
        )
    if not _cap(d, "multiProvider") and len(providers) > 1:
        out.append(
            f"{d.id}: multiProvider=false but supportedProviders has {len(providers)} (needs <=1)"
        )

    # A verified runtime must declare its durability granularity (it's a load-
    # bearing dispatch/retry property, not optional once proven).
    if not d.capabilities.get("durabilityGranularity"):
        out.append(f"{d.id}: capabilitiesVerified=true but no durabilityGranularity declared")

    return out


def descriptor_violations(d: RuntimeDescriptor) -> list[str]:
    """All conformance violations for one descriptor (hard always; soft iff verified)."""
    out = _hard_violations(d)
    if d.capabilities_verified:
        out.extend(_soft_violations(d))
    return out


def check_descriptor_consistency(
    registry: RuntimeRegistry | None = None,
) -> list[str]:
    """Return every conformance violation across the registry (empty == clean)."""
    reg = registry or _default_registry
    out: list[str] = []
    for d in reg.list_runtimes():
        out.extend(descriptor_violations(d))
    return out


def assert_descriptor_consistency(registry: RuntimeRegistry | None = None) -> int:
    """Boot guard: raise if the registry violates capability conformance.

    Returns the number of runtimes checked on success (for a startup log line).
    """
    violations = check_descriptor_consistency(registry)
    if violations:
        raise RuntimeError(
            "Runtime registry capability conformance failed (capability honesty):\n  - "
            + "\n  - ".join(violations)
            + "\nFix the canonical services/shared/runtime-registry.json and re-run "
            "`node scripts/sync-runtime-registry.mjs`."
        )
    reg = registry or _default_registry
    return len(reg.list_runtimes())


def return_shape_violations(
    result: Mapping[str, Any] | Any,
    descriptor: RuntimeDescriptor | None = None,
) -> list[str]:
    """Validate a durable/run child result against the core return contract.

    Used bridge-side (sw_workflow) as a WARN-first net so a non-conforming
    runtime surfaces in logs instead of silently mis-mapping (the item-5
    deferral). ``descriptor`` is accepted for future capability-specific checks
    (e.g. ownsSandbox ⇒ modelPatch) but the generic contract is runtime-agnostic.
    """
    out: list[str] = []
    if not isinstance(result, Mapping):
        return [f"result is {type(result).__name__}, expected a dict"]
    for key in _REQUIRED_RETURN_KEYS:
        if key not in result:
            out.append(f"missing required key {key!r}")
    if not any(key in result for key in _REQUIRED_RETURN_PAYLOAD_KEYS):
        out.append(
            f"missing an output payload (one of {list(_REQUIRED_RETURN_PAYLOAD_KEYS)})"
        )
    return out


__all__ = [
    "assert_descriptor_consistency",
    "check_descriptor_consistency",
    "descriptor_violations",
    "return_shape_violations",
]
