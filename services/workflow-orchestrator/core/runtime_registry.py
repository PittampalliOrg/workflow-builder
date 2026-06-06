"""Declarative durable-agent runtime registry (DurableSessionRuntime, Phase 1).

Source of truth for runtime identity on the live ``durable/run`` dispatch path,
replacing the inline ``_NATIVE_DURABLE_AGENT_TARGETS`` dict + the precedence ladder
formerly hand-coded in ``workflows/sw_workflow.py``. Descriptors are loaded from
the adjacent ``runtime_registry.json``; app-ids are resolved at load time from
``core.config`` so the existing Dapr-Configuration/env override flow is unchanged.

(The legacy HTTP run-lane resolver ``activities/call_agent_service._durable_agent_app_id``
is NOT consolidated here — it is dead code on the unused ``call_durable_agent_run``
path and is removed wholesale in Phase 6, not migrated. The BFF-side enumerations
are consolidated in Phase 2.)

The resolution precedence (``resolve``) reproduces the old
``_resolve_native_agent_runtime`` EXACTLY — behavior-preserving by construction:

    1. ``agentAppId`` (flattened_args, then agentConfig) → synthetic per-agent
       descriptor (a dapr-agent-py runtime pod addressed by app-id).
    2. else the legacy ``agentRuntime`` | ``runtime`` enum (flattened_args, then
       agentConfig), defaulting to ``dapr-agent-py`` → a registered descriptor.
    3. else ``agentSlug`` (flattened_args ``agentSlug``, then agentConfig ``slug``)
       → on-the-fly ``agent-runtime-<slug>`` descriptor.
    4. else raise (same message + sorted-id list as before).

The two-name dispatch (verified): the literal workflow dispatched is
``dispatchWorkflowName`` (``session_workflow``); the bridge-eligibility sentinel
is ``bridge_gate_token`` (``config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME`` ==
``agent_workflow``). ``to_target_dict`` keeps the legacy ``workflow_name`` key
(== bridge_gate_token) so existing call-sites are untouched, and adds
``dispatch_workflow_name`` + ``bridge_gate_token`` so the dispatch site can stop
hard-coding the literal.

Capability flags are advisory in Phase 1 (nothing consumes them yet); the Phase 3
swap-safety gate reads them and the Phase 5 conformance harness verifies them
(``capabilities_verified``). Phase 2 promotes this file to
``services/shared/runtime-registry.json`` and adds a TS reader for the BFF.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from core.config import config

_REGISTRY_PATH = Path(__file__).with_name("runtime_registry.json")


def _str_or_empty(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _first_nonempty(*values: Any) -> str:
    for value in values:
        picked = _str_or_empty(value)
        if picked:
            return picked
    return ""


@dataclass(frozen=True)
class RuntimeDescriptor:
    """One durable-agent runtime's identity + declared capabilities."""

    id: str
    app_id: str
    instance_prefix: str
    dispatch_workflow_name: str
    family: str = "durable-session"
    main_container_name: str | None = None
    image_env_key: str | None = None
    agent_metadata_framework: str = "Dapr Agents"
    benchmark_eligible: bool = False
    capabilities_verified: bool = False
    capabilities: Mapping[str, Any] = field(default_factory=dict)

    @property
    def bridge_gate_token(self) -> str:
        # Resolved from config (override-safe) — matches what the old
        # _NATIVE_DURABLE_AGENT_TARGETS stored in each target's workflow_name.
        return config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME

    def to_target_dict(self) -> dict[str, Any]:
        """Legacy-compatible ``target`` dict consumed by sw_workflow dispatch.

        ``workflow_name`` retains its historical value (the bridge gate token,
        ``agent_workflow``); ``dispatch_workflow_name`` + ``bridge_gate_token``
        are additive so the dispatch site can de-hard-code the ``session_workflow``
        literal and the gate comparison.
        """
        return {
            "workflow_name": self.bridge_gate_token,
            "app_id": self.app_id,
            "instance_prefix": self.instance_prefix,
            "dispatch_workflow_name": self.dispatch_workflow_name,
            "bridge_gate_token": self.bridge_gate_token,
        }


class RuntimeRegistry:
    def __init__(self, data: Mapping[str, Any]):
        self.dispatch_workflow_name: str = data["dispatchWorkflowName"]
        self.default_runtime_id: str = data.get("defaultRuntimeId", "dapr-agent-py")
        self._by_id: dict[str, RuntimeDescriptor] = {}
        for entry in data["runtimes"]:
            app_id = getattr(config, entry["appIdConfigKey"])
            descriptor = RuntimeDescriptor(
                id=entry["id"],
                app_id=app_id,
                instance_prefix=entry["instancePrefix"],
                dispatch_workflow_name=self.dispatch_workflow_name,
                family=entry.get("family", "durable-session"),
                main_container_name=entry.get("mainContainerName"),
                image_env_key=entry.get("imageEnvKey"),
                agent_metadata_framework=entry.get("agentMetadataFramework", "Dapr Agents"),
                benchmark_eligible=bool(entry.get("benchmarkEligible", False)),
                capabilities_verified=bool(entry.get("capabilitiesVerified", False)),
                capabilities=dict(entry.get("capabilities", {})),
            )
            self._by_id[descriptor.id] = descriptor

    # ---- lookups -------------------------------------------------------
    def by_id(self, runtime_id: str) -> RuntimeDescriptor | None:
        return self._by_id.get(runtime_id)

    def has(self, runtime_id: str) -> bool:
        return runtime_id in self._by_id

    def ids(self) -> list[str]:
        return list(self._by_id)

    def list_runtimes(self) -> list[RuntimeDescriptor]:
        return list(self._by_id.values())

    def list_benchmark_runtimes(self) -> list[RuntimeDescriptor]:
        return [d for d in self._by_id.values() if d.benchmark_eligible]

    # ---- synthetic (per-agent / per-slug) descriptors ------------------
    def _synthetic(self, app_id: str) -> RuntimeDescriptor:
        """A per-agent runtime pod addressed directly by app-id.

        These are dapr-agent-py runtime pods (agent-runtime-<slug> /
        agent-runtime-pool-<class>), so they inherit the default runtime's
        capabilities but are not individually conformance-verified.
        """
        default = self._by_id.get(self.default_runtime_id)
        return RuntimeDescriptor(
            id=app_id,
            app_id=app_id,
            instance_prefix="durable",
            dispatch_workflow_name=self.dispatch_workflow_name,
            family="durable-session",
            main_container_name=default.main_container_name if default else None,
            image_env_key=default.image_env_key if default else None,
            agent_metadata_framework=(
                default.agent_metadata_framework if default else "Dapr Agents"
            ),
            benchmark_eligible=False,
            capabilities_verified=False,
            capabilities=dict(default.capabilities) if default else {},
        )

    # ---- resolution (precedence-preserving) ----------------------------
    def resolve(
        self,
        flattened_args: Mapping[str, Any],
        agent_config: Mapping[str, Any] | None,
    ) -> tuple[str, RuntimeDescriptor]:
        ac: Mapping[str, Any] = agent_config if isinstance(agent_config, dict) else {}

        agent_app_id = _first_nonempty(
            flattened_args.get("agentAppId"),
            ac.get("agentAppId"),
        )
        if agent_app_id:
            return agent_app_id, self._synthetic(agent_app_id)

        runtime = (
            _first_nonempty(
                flattened_args.get("agentRuntime"),
                flattened_args.get("runtime"),
                ac.get("runtime"),
                ac.get("agentRuntime"),
            )
            or self.default_runtime_id
        )
        if runtime in self._by_id:
            return runtime, self._by_id[runtime]

        agent_slug = _first_nonempty(
            flattened_args.get("agentSlug"),
            ac.get("slug"),
        )
        if agent_slug:
            derived = f"agent-runtime-{agent_slug}"
            return derived, self._synthetic(derived)

        allowed = ", ".join(sorted(self._by_id))
        raise RuntimeError(
            f"Unsupported durable/run agentRuntime '{runtime}' and no agentAppId/agentSlug in body. "
            f"Allowed legacy runtimes: {allowed}"
        )


def _load_registry() -> RuntimeRegistry:
    with _REGISTRY_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return RuntimeRegistry(data)


# Singleton, loaded once at import (config is already loaded by core.config).
registry = _load_registry()


def resolve(
    flattened_args: Mapping[str, Any],
    agent_config: Mapping[str, Any] | None,
) -> tuple[str, RuntimeDescriptor]:
    """Module-level convenience mirroring the old _resolve_native_agent_runtime."""
    return registry.resolve(flattened_args, agent_config)
