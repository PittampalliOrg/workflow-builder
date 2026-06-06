
# Standardizing the Durable-Agent Runtimes: `DurableSessionRuntime` v1 Contract + One Declarative Runtime Registry

> Synthesis verdict: take **Minimal-Seam Formalization** as the backbone (highest avg, top feasibility, zero-risk consolidation that maps 1:1 onto the existing `_NATIVE_DURABLE_AGENT_TARGETS` dict), and graft the four genuinely-better ideas the other proposals contributed:
> 1. The **capability/guarantee descriptor + swap-safety gate** (Capability-Typed's correctness centerpiece) — turn silent feature drops into warned/rejected swaps.
> 2. **SDK-parity wiring as Phase 0** (SDK-Parity Convergence) — close the worst silent-drop FIRST, single-service, single-image, zero coupling.
> 3. The **shared event-publisher extraction + a boot-time/CI capability-honesty check** (Registry Unification + Capability-Typed conformance).
> 4. The **three judge-surfaced factual corrections** that every individual proposal got partly wrong (the two-name dispatch trap, the live claude-code-agent termination fan-out, the third allowlist site).
>
> The result is a single coherent plan, ordered low-risk/high-value first, every phase independently shippable through the per-service GitOps/Skaffold outer-loop.

---

## 0. Ground-truth corrections that shape the whole design (all verified this session)

These three facts were each only partly right in the source proposals; the synthesized plan is built on the verified reality:

- **`workflow_name` carries TWO distinct values and roles.** `config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME = "agent_workflow"` (`services/workflow-orchestrator/core/config.py:66`) is the **bridge-eligibility sentinel** — `session_bridge_eligible = target.get("workflow_name") == "agent_workflow"` (`sw_workflow.py:1779`). The **dispatched** workflow is the literal `"session_workflow"` (`sw_workflow.py:1922`). These are different strings serving different roles. The registry descriptor therefore carries **two fields**: `dispatchWorkflowName` (always `session_workflow`) and `bridgeGateToken` (always `agent_workflow`). A single `workflowName` field that fed both — as three of the four proposals wrote — would flip `session_bridge_eligible` FALSE for every runtime and drop them into the dead non-bridge `else` branch (`sw_workflow.py:1952-1965`), which attempts a direct `call_child_workflow` against an unwoken pod → `CreateWorkflowInstance` deadlock (findings Appendix). **Do not conflate them.**

- **The claude-code-agent lane is NOT freely deletable.** The HTTP-invoke run lane (`call_durable_agent_run` → `_durable_agent_app_id`, `call_agent_service.py:161-169,451`) is dead-by-disuse (no registered caller — verified: only its own span ref). BUT `terminate_durable_runs_by_parent_execution` (`call_agent_service.py:339-407`) is **live** — imported in `app.py:49`, called at `app.py:3488` and `app.py:3625` for parent-cancellation fan-out — and it references `CLAUDE_CODE_AGENT_APP_ID` (`:362`). So `CLAUDE_CODE_AGENT_APP_ID`/`CLAUDE_CODE_AGENT_CHILD_WORKFLOW_RUN_NAME` (`config.py:60,67`) cannot be deleted in a "no behavior change" phase; the dead `_durable_agent_app_id` HTTP run-lane CAN. We sequence this in Phase 5 with a real liveness audit, not Phase 1.

- **There are THREE container-allowlist sites, and `dedicatedRuntimeReason` is content-inspecting.** Allowlists: `src/lib/server/ws-kube-exec-proxy.ts:11`, `src/routes/api/v1/sessions/[id]/shell/resolve/+server.ts:7`, `src/routes/api/v1/sessions/[id]/runtime-flags/+server.ts:15` (the last carries an explicit "must stay in sync" comment). And `dedicatedRuntimeReason` (`runtime-routing.ts:205-221`) branches on `runtime === "browser-use-agent"` (`:211`) AND inspects `agentConfig.mcpServers` content via `isPlaywrightMcpEntry` (`:217`) — so the browser carve-out collapses to `capabilities.requiresWarmPool` only partly; the Playwright-content inspection must stay as a separate `requiresBrowserSidecars`-derivation that reads `mcpServers`.

---

## 1. Target architecture

End state has **one registry, two thin readers, one versioned contract, one shared publisher, one swap-safety gate, and one fewer dead lane.**

### 1.1 The `DurableSessionRuntime` v1 contract (versioned, documented)

A runtime is registry-eligible iff it satisfies:

- **Dispatch.** Registers a Dapr workflow named exactly `descriptor.dispatchWorkflowName` (canonical `"session_workflow"`), and the orchestrator gates the bridge on `descriptor.bridgeGateToken` (canonical `"agent_workflow"`). Both are descriptor fields, not literals (§0).
- **Input schema (`childInput`, produced by BFF `ensure-for-workflow`).** MUST accept `{ sessionId, agentConfig{ modelSpec, maxTurns, permissionMode, mcpServers?, hooks?, plugins?, contextStrategy? }, instructionBundle.rendered.system | renderedSystem, workspaceRef?, sandboxName?, runtimeSandboxName?, cwd?, maxIterations?, timeoutMinutes?, initialEvents | initialMessage, outputSync?, environmentConfig?, autoTerminateAfterEndTurn, _message_metadata, _otel }`. MANDATORY-to-honor: `sessionId`, `agentConfig.modelSpec`, `agentConfig.maxTurns`, `agentConfig.permissionMode`, `renderedSystem`, `autoTerminateAfterEndTurn` (hard-coded `true` for `durable/run` at `sw_workflow.py:1663` — kept mandatory-true in v1). RUNTIME-OPTIONAL: `mcpServers`, `hooks`, `plugins`, `contextStrategy` — a runtime that does not honor an optional field MUST declare the corresponding capability `false` (so the gate warns, instead of the runtime silently dropping it).
- **Return schema.** MUST return a `dict` (non-dict is wrapped `{content:str}` at `sw_workflow.py:1968` — kept as a defensive net, but the conformance check forbids it). REQUIRED keys: `{ success: bool, output | content: str, sessionId: str, agentRuntime: str }`. OPTIONAL: `{ status, modelPatch, runtimeSandboxName, workspaceRef, sandboxName, messages, daprInstanceId, agentWorkflowId, usage, childWorkflowName }`. SWE-bench consumers read `modelPatch`/`runtimeSandboxName` driven by `capabilities.ownsSandbox` (§2.3).
- **Lifecycle/events.** Honor `autoTerminateAfterEndTurn:true` (one turn → `session.status_idle{end_turn}` + `session.status_terminated`). Emit, via the shared publisher to `/api/internal/sessions/{id}/events/ingest`, the MINIMUM vocabulary (`session.status_*` + `agent.message`/`agent.tool_use`/`agent.tool_result`) unconditionally; emit the OPTIONAL incremental tier (`message_delta`, `agent.llm_usage`, `agent.context_usage`, `hook.decision`) only when `capabilities.incrementalEvents` is true.
- **Capability honesty.** A runtime MAY declare a capability `true` only if a check proves it. Enforced two ways: a per-runtime boot guard `assert_descriptor_consistency()` (modeled on the real `assert_dapr_agents_version()` in dapr-agent-py) that fails the pod if a declared capability's wiring is absent, and a CI capability-honesty probe (§4 Phase 5).

### 1.2 One runtime-descriptor registry (config-as-code, NOT a CRD, NOT a DB table)

**Where it lives — and why.** A single checked-in canonical source `services/shared/runtime-registry.json`, with two typed readers that import it. **Not a CRD** (the custom `AgentRuntime` CRD + Kopf controller were deliberately retired for upstream agent-sandbox + Kueue — findings §5.3/Appendix; re-introducing a control plane is the wrong direction). **Not a DB table** (a table adds a migration/seed/render lane + an orchestrator fetch + a DB↔ConfigMap eventual-consistency seam across two GitOps delivery lanes, for a fixed, code-coupled fleet of ~6 runtimes that change only when an engineer adds an image in the same PR — the table's render pipeline was the single biggest feasibility deduction against the two proposals that chose it). The runtime fleet is config-as-code; one git-blamable JSON is the most auditable, lowest-moving-parts home.

The orchestrator already loads identity from Dapr Configuration (`config._load_from_dapr`, `config.py:100-120`); the registry JSON is **vendored into each image** and the `appId`/image values stay env/Configuration-overridable exactly as today (`config.*_APP_ID` flow unchanged). The ONLY genuinely-new fact-type is the static `capabilities` blob.

**Descriptor shape:**

```jsonc
{
  "id": "claude-agent-py",
  "appId": "claude-agent-py",                      // from config.*_APP_ID (Dapr Config / env), unchanged
  "imageEnvKey": "AGENT_RUNTIME_CLAUDE_DEFAULT_IMAGE",
  "dispatchWorkflowName": "session_workflow",       // the call_child_workflow name (sw_workflow.py:1922)
  "bridgeGateToken": "agent_workflow",              // the session_bridge_eligible sentinel (sw_workflow.py:1779)
  "instancePrefix": "durable-claude",
  "mainContainerName": "claude-agent-py",           // feeds the 3 allowlists
  "family": "durable-session",                       // durable-session | browser
  "agentMetadataFramework": "Claude Agent SDK",      // replaces the hard-coded 'Dapr Agents'
  "benchmarkEligible": true,
  "capabilities": {
    "durabilityGranularity": "per-turn",             // per-activity | per-turn  (first-class, declared)
    "retryMaxAttempts": 3,
    "supportsMcp": false,                            // flipped true in Phase 0 once wired+verified
    "supportsBuiltinOpenShellTools": false,          // owns pod-local /sandbox
    "supportsHooks": false,                          // hookTiming: live | batch (see §2.4)
    "hookTiming": "batch",
    "supportsPermissionGating": false,
    "supportsPlugins": false,
    "supportsCompaction": false,                     // SDK autocompacts but un-observable; see decision D5
    "incrementalEvents": false,
    "ownsSandbox": true,
    "requiresWarmPool": false,
    "requiresBrowserSidecars": false,
    "multiProvider": false,
    "supportedProviders": ["anthropic"]
  }
}
```

Seed values (verified from code): **dapr-agent-py** → `{per-activity, retryMaxAttempts:8 (main.py:5897), supportsMcp:true (main.py:2524,4894), supportsBuiltinOpenShellTools:true, supportsHooks:true/hookTiming:live (main.py:3361-3457), supportsPermissionGating:true, supportsPlugins:true, supportsCompaction:true (main.py:2841-2870), incrementalEvents:true, ownsSandbox:false, requiresWarmPool:false, multiProvider:true, supportedProviders:[anthropic,openai,deepseek,nvidia,kimi,alibaba,together,gemini,foundry] (effective_agent_config.py:21-159)}`. **adk-agent-py** → seeded conservatively `{per-turn, ownsSandbox:true, supportsMcp:false, multiProvider:false}` until verified by conformance (its loop granularity is ADK-owned). **browser-use-agent** → `family:"browser", requiresWarmPool:true, requiresBrowserSidecars:true, supportsMcp:true`. **dapr-agent-py-testing** → mirrors dapr-agent-py with its own appId; it is a real registry row + a real stacks lane (`Deployment/Service/SA/Component` in both `workloads/dapr-agent-py/` and `workloads/openshell-agent-runtime/`).

**Two readers:**
- Python: `services/workflow-orchestrator/core/runtime_registry.py` — `resolve(flattened_args, agent_config) -> RuntimeDescriptor` (subsumes the `agentAppId > agentRuntime > agentSlug` ladder at `sw_workflow.py:1035-1093`, preserving the on-the-fly `agent-runtime-<slug>` derivation so un-republished specs keep working) + `by_id(id)`.
- TS: `src/lib/server/agents/runtime-registry.ts` — `import registry from '$shared/...'` (Vite JSON import, zod-validated at module load). Exposes `getRuntimeDescriptor(id)`, `listRuntimes()`, `listBenchmarkRuntimes()`, `shellableContainers()`, `defaultRuntimeId`.

**Drift guard.** Because there are two language readers of one JSON, add a CI parity check (mirroring the real `validate-ryzen-no-app-image-overrides` guard pattern) that (a) fails the build if any of the retired enumeration sites reintroduces a literal runtime-name string branch, and (b) confirms both readers parse the canonical JSON identically. This is **MVP-blocking** (the correctness lens flagged that the BFF independently hard-codes app-id literals like `runtime-target.ts:44`, so app-ids CAN silently diverge without it).

### 1.3 The swap-safety gate (the correctness centerpiece — grafted from Capability-Typed)

`assertSwapSafe(agentRequirements, targetDescriptor) -> { decision: "allow"|"warn"|"reject", drops: string[] }`. `agentRequirements` is derived from the agent's `agentConfig`: non-empty `mcpServers` ⇒ requires `supportsMcp`; `hooks`/`plugins` present ⇒ requires `supportsHooks`/`supportsPlugins`; `permissionMode !== "bypassPermissions"` ⇒ requires `supportsPermissionGating`; `modelSpec` provider ∉ `supportedProviders` ⇒ provider mismatch; an agent-declared `requiresDurability: "per-activity"` ⇒ requires that granularity.

**Policy table (ship WARN-default, escalate after audit):**
| Required vs declared | Decision |
|---|---|
| MCP required → `supportsMcp:false` | **REJECT** (silent tool loss is unacceptable — blocker #1) |
| provider ∉ `supportedProviders` | **REJECT** (silent coercion to a default model is unacceptable — blocker #4) |
| hooks/permission-gating/plugins loss | WARN + structured `runtime.swap_degraded` event |
| `per-activity` → `per-turn` durability downgrade | WARN + `runtime.swap_degraded` (blocker #2 — preserved, not erased) |
| `incrementalEvents` loss / `hookTiming: live → batch` | WARN |

Runs at **two** points: agent **publish** (`registry-sync.ts` — blocks saving an MCP agent pinned to a non-MCP runtime) AND **dispatch** resolution (`resolve_runtime` in the orchestrator + `spawn.ts` in the BFF). Rollout discipline: ship every decision as WARN first (logging every degraded swap), then escalate MCP/provider mismatches to REJECT only after auditing existing pins — so workflows currently running silently-degraded surface in logs before they hard-fail.

### 1.4 One shared event publisher (extracted + tiered)

Extract the dapr-agent-py `event_publisher.py` (the 408-LOC superset — adds trace stamping + `agent.llm_usage` + Notification hooks) into `services/shared/session_events/publisher.py`, consumed by both runtimes; delete claude-agent-py's 128-LOC near-verbatim copy. Identical `_CMA_EVENT_TYPE_MAP` + `_SESSION_SUPPRESSED_TYPES={run_started,run_complete,run_error}` + ingest URL live once. The module emits the minimum vocabulary unconditionally and gates the incremental tier on `capabilities.incrementalEvents`, so claude's batch-after-turn (`session_workflow.py:254`) is **contract-legal-and-labeled**, not a hidden gap.

---

## 2. The five seams

| Seam | Status | Resolution |
|---|---|---|
| **Dispatch** | ALREADY EXISTS — formalize | `_resolve_native_agent_runtime` + `_NATIVE_DURABLE_AGENT_TARGETS` (`sw_workflow.py:985-1093`) → `runtime_registry.resolve()`. Literal `session_workflow` (`:1922`) ← `descriptor.dispatchWorkflowName`; gate (`:1779`) ← `descriptor.bridgeGateToken` (§0 two-name fix). Dead non-bridge `else` (`:1952-1965`) deleted — every `durable-session` family runtime is bridge-eligible by contract; a future `family != durable-session` row must be handled before that path can ever be reached again (reserved by the `family` field). |
| **Session-event** | ALREADY SHARED — extract + tier | §1.4. One library; incremental tier gated by capability. |
| **Deployment** | ALREADY DATA-DRIVEN — point at registry | `agentImage` if-chain (`agent-workflow-host.ts:313-330`) → `descriptor.image` via `imageEnvKey`. Per-session Kueue Sandbox model (image-only diff) KEPT. Browser warm-pool (Arc 2) selected by `capabilities.requiresWarmPool` not `runtime==='browser-use-agent'`; the `isPlaywrightMcpEntry` content-inspection (`runtime-routing.ts:217`) stays and derives `requiresBrowserSidecars` from `mcpServers`. The 3 allowlists (§0) ← `listRuntimes().map(d => d.mainContainerName)` ∪ fixed sidecar names (`chromium`, `playwright-mcp`). |
| **Tool/MCP capability** | MUST BUILD (hardest) | §2.4. Capability declaration makes loss explicit (gate warns/rejects); SDK-native wiring (Phase 0) closes the gap where free. |
| **Config/model resolution** | PARTIALLY EXISTS — lift resolver | Extract `resolve_model(modelSpec) -> {provider, model}`; dapr-agent-py adapts to a Dapr Component name (`MODEL_COMPONENT_MAP`, `effective_agent_config.py:21-159`), claude to an SDK model string (`normalize_claude_model`). The gate cross-checks `resolve_model(spec).provider ∈ supportedProviders` → rejects OpenAI-on-claude instead of silently defaulting. Standardizes MANDATORY (`modelSpec`,`maxTurns`,`permissionMode`) vs runtime-optional (`mcpServers`,`hooks`,`plugins`,`contextStrategy`) `agentConfig` fields. |

### 2.4 Closing the worst silent-drop (tool/MCP — SDK-parity wiring)

VERIFIED present in the pinned `claude-agent-sdk>=0.2.93` at `services/claude-agent-py/.../claude_agent_sdk/types.py`: `ClaudeAgentOptions.mcp_servers` (`:1615`), `can_use_tool` (`:1748`), `hooks` (`:1760`), `include_hook_events` (`:1782`), `plugins` (`:1844`), and `HookEventMessage` (`:1228`). `build_claude_options` (`claude_sdk_runner.py:476-512`) wires NONE of them today.

In `build_claude_options`: read `agentConfig.mcpServers` (already browser-rewritten by `rewriteMcpForBrowserSidecar` in both spawn paths, so claude receives the same `{transport:'streamable_http', url}` shape dapr consumes — no new rewrite) → `mcp_servers`; wire `hooks` + `can_use_tool` (permission gating) + `plugins`; set `include_hook_events=True`. In the SDK stream loop forward `HookEventMessage` → the shared `publish_session_event`. This restores MCP + hook governance **without re-decomposing the single-activity loop** — its whole point. Flip `supportsMcp/supportsHooks/supportsPermissionGating` true ONLY after the conformance probe (§4 Phase 5) proves each. `durabilityGranularity` stays `per-turn` (intrinsic to the loop location — explicitly NOT closeable, stays declared). `hookTiming` is `batch` (single-activity ⇒ `hook.decision` fires at batch time, not mid-turn-live) — a labeled limit, not a hidden one (§3 weakness the correctness lens flagged: do NOT advertise live gating on a batch runtime).

---

## 3. Durability trade-off — preserved as a first-class declared property

`durabilityGranularity ∈ {per-activity, per-turn}` and `retryMaxAttempts` ride the descriptor and are **never erased**. dapr-agent-py declares `per-activity` / `8` (each `call_llm` `main.py:1844` + `run_tool` `main.py:1950` independently checkpointed/retried, `WorkflowRetryPolicy(max_attempts=8)` `main.py:5897`; partial tool results durably saved via `save_tool_results`). claude-agent-py declares `per-turn` / `3` (whole `query()` drained in one activity `claude_sdk_runner.py:596-613`, mid-turn crash re-runs from the prompt with no durable partial-tool record, `RetryPolicy max 3` `session_workflow.py:14-19`). The swap-safety gate treats a `per-activity → per-turn` downgrade as a WARN with a `runtime.swap_degraded` event listing the exact dropped guarantees — so an operator choosing claude for a long multi-tool turn does so with eyes open, instead of discovering coarser crash recovery after a mid-turn worker death. The contract deliberately does NOT try to make claude `per-activity` (that re-decomposition erases the SDK simplicity that is its reason to exist). Note: claude actually KEEPS the durable `when_any([activity,timer])` turn-timer (`session_workflow.py:240-249`) that dapr-agent-py REMOVED (commit `72154581`), so for the timeout-cutoff guarantee claude is stronger — captured by a `durableTurnTimer` capability for completeness. SWE-bench already runs its turn inline as a single activity by design (`docs/swebench-dapr-workflow-operations.md:191-201`), so standardizing claude there loses no durability.

---

## 4. Phased migration (each phase independently shippable through the per-service outer-loop)

### Phase 0 — SDK-parity wiring (highest leverage, single service, zero coupling)
- **Goal:** claude-agent-py stops silently dropping `mcpServers` + SDK hooks/permissions. The single change that converts blocker #1 from a silent loss to a working capability.
- **Changes:** §2.4 — wire `mcp_servers`/`hooks`/`can_use_tool`/`plugins`/`include_hook_events` into `build_claude_options`; forward `HookEventMessage` → shared publisher.
- **Files:** `services/claude-agent-py/src/claude_sdk_runner.py:22,476-512`, `services/claude-agent-py/src/session_workflow.py:254`, `services/claude-agent-py/src/event_publisher.py`.
- **Delivery:** claude-agent-py is `sandbox-only` (`src/lib/gitops/service-matrix.ts`) — build **only** `Dockerfile.sandbox` (the dual-image rule is a dapr-agent-py fact; do NOT over-apply it). Per-session Sandbox pulls the `*-sandbox` image via `AGENT_RUNTIME_CLAUDE_DEFAULT_IMAGE`.
- **Risk:** LOW-MED. SDK `can_use_tool`/`PreToolUse` semantics differ subtly from dapr's hand-ported hook protocol; treat `hook.decision` as best-effort parity, validate the CMA event map still classifies it. Do NOT flip descriptor capability flags until Phase 5 verifies.
- **Shippable alone:** yes.

### Phase 1 — Registry + contract doc (orchestrator-only, no behavior change)
- **Goal:** single source of truth for runtime identity; collapse the orchestrator enumeration; fix the two-name dispatch.
- **Changes:** add `services/shared/runtime-registry.json` + `services/workflow-orchestrator/core/runtime_registry.py`. Replace `_NATIVE_DURABLE_AGENT_TARGETS` (`sw_workflow.py:985-1018`) and the resolver ladder (`:1021-1093`) with `resolve()` (preserving the `agentAppId > agentRuntime > agentSlug`-derivation precedence so un-republished specs keep working). De-hard-code the dispatch literal (`:1922` ← `descriptor.dispatchWorkflowName`) and the bridge gate (`:1779` ← `descriptor.bridgeGateToken`). DELETE the dead non-bridge `else` branch (`:1952-1965`). Write `docs/durable-session-runtime-contract.md` (v1: two-name dispatch, input/return schema, capability vocabulary, event tiers).
- **Files:** above + `docs/durable-session-runtime-contract.md`.
- **Risk:** LOW — same app-ids dispatched. The one real hazard is the resolver-precedence regression; cover with the existing `tests/test_published_workflows.py` fixtures.
- **Shippable alone:** yes.

### Phase 2 — BFF descriptor reads + shared publisher (collapse the TS enumerations + de-dup the publisher)
- **Goal:** new runtime = one JSON row; delete scattered if-chains/allowlists; one event publisher.
- **Changes:** add `src/lib/server/agents/runtime-registry.ts`. Rewrite: `agentImage` if-chain (`agent-workflow-host.ts:313-330`) → `descriptor.image`; the **three** allowlists (`ws-kube-exec-proxy.ts:11`, `shell/resolve/+server.ts:7`, `runtime-flags/+server.ts:15`) → `mainContainerName` ∪ fixed sidecars; `BENCHMARK_AGENT_RUNTIMES` (`agent-runtimes.ts:1-5`) → `listBenchmarkRuntimes()`; `runtime-target.ts:44` literal `"dapr-agent-py"` → `registry.defaultRuntimeId`; `dedicatedRuntimeReason` browser branch (`runtime-routing.ts:211`) → `requiresWarmPool` (keep the `isPlaywrightMcpEntry` content-inspection at `:217` as `requiresBrowserSidecars` derivation); framework hard-code (`registry-sync.ts:177,185`) + `validateAgentMetadata` throw (`application-state.ts:208`) → `descriptor.agentMetadataFramework` / registry-membership check. Extract the shared publisher (§1.4); delete claude's copy; flip claude `incrementalEvents` only if Phase 0's per-message flush is in.
- **Files:** the above + `services/shared/session_events/publisher.py`, `services/dapr-agent-py/src/event_publisher.py`, `services/claude-agent-py/src/session_workflow.py`. **Cross-build-context note:** `services/shared/` is outside all four service build contexts today; add it to each Dockerfile's COPY (or a uv-package) — orchestrator does `COPY . .`, the agent services `COPY src/`. Verify the shared module lands in each image.
- **Risk:** MED — the cross-context plumbing + the 3-allowlist atomicity are the real work; behavior identical when seeded correctly. Add the MVP-blocking CI parity guard here.
- **Shippable alone:** yes.

### Phase 3 — Swap-safety gate (correctness centerpiece)
- **Goal:** lossy swaps WARN or REJECT instead of silently dropping features.
- **Changes:** add `src/lib/server/agents/swap-safety.ts` (`assertSwapSafe`, §1.3); wire at agent publish (`registry-sync.ts`) and BFF dispatch (`spawn.ts`); add the Python mirror in `resolve_runtime`. Lift `resolve_model(modelSpec) -> {provider, model}` (seam 5) and cross-check provider ∈ `supportedProviders`. Ship WARN-default; escalate MCP/provider to REJECT after the pin audit.
- **Files:** `src/lib/server/agents/swap-safety.ts`, `registry-sync.ts`, `src/lib/server/sessions/spawn.ts`, `sw_workflow.py` (resolve_runtime), `runtime-routing.ts`, `services/dapr-agent-py/src/effective_agent_config.py`.
- **Risk:** MED — REJECT could break agents already running silently-degraded; the WARN-first/audit rollout contains it.
- **Shippable alone:** yes.

### Phase 4 — SWE-bench de-branch (return-schema unification)
- **Goal:** delete `isClaudeAgentRuntime`; SWE-bench reads runtime-agnostically.
- **Changes:** standardize the return so `modelPatch`/`runtimeSandboxName` selection is driven by `capabilities.ownsSandbox` instead of the runtime literal (`service.ts:6440,6610-6620`). NOTE the verified structural reality: claude self-extracts (`.solve.modelPatch`, owns pod-local `/sandbox`) while dapr+adk use a separate downstream `extract_patch` step (`.extract_patch.modelPatch`) — the current branch already uses a `//` union fallback. Resolve the union explicitly: `ownsSandbox:true` ⇒ `.solve.*` with `.extract_patch.*` fallback; `ownsSandbox:false` ⇒ `.extract_patch.*`. **Add a bridge-side return-shape assertion BEFORE deleting the branch** (defensive ordering — a runtime that doesn't conform fails loudly, not silently mis-maps). Verify adk (`ownsSandbox:true`) genuinely emits `.solve.modelPatch` via conformance before routing it through that path.
- **Files:** `src/lib/server/benchmarks/service.ts:6440,6610-6620`, the bridge return assertion.
- **Risk:** MED — the adk routing flip is the one real behavior change; gate it on the Phase 5 probe.
- **Shippable alone:** yes.

### Phase 5 — Conformance + capability-honesty harness (the gatekeeper)
- **Goal:** a runtime cannot be registered/activated until it provably honors the contract; flip claude's capability flags only after proof.
- **Changes:** add `services/workflow-orchestrator/tests/runtime_conformance/` (orchestrator-driven smoke against a real per-session Sandbox) asserting: registers `dispatchWorkflowName` + reachable; returns required dict keys (rejects non-dict); honors `autoTerminateAfterEndTurn`; emits the minimum lifecycle sequence in order; and **capability honesty** — `supportsMcp` ⇒ a declared MCP server's tool is actually callable; `incrementalEvents` ⇒ a `message_delta` arrives before turn completion; `supportsPermissionGating` ⇒ a deny hook actually blocks. Add the per-runtime `assert_descriptor_consistency()` boot guard. Run as a required CI/canary gate (reuse the SWE-bench fixture lane) before a descriptor row is marked active. Flip claude `supportsMcp/supportsHooks/supportsPermissionGating` true here.
- **Files:** `services/workflow-orchestrator/tests/runtime_conformance/`, each runtime's boot guard, CI workflow.
- **Risk:** MED-HIGH effort (new smoke harness against stochastic Kueue pods), LOW correctness risk.
- **Shippable alone:** yes.

### Phase 6 — Dead-lane deletion + legacy Deployment retirement (after audits)
- **Goal:** remove the genuinely-dead lanes with verified blast radius.
- **Changes:** DELETE the dead HTTP run-lane `call_durable_agent_run` + `_durable_agent_app_id` (`call_agent_service.py:161-169,410-459`) — verified no registered caller. Retain `terminate_durable_runs_by_parent_execution` + `CLAUDE_CODE_AGENT_APP_ID` (`config.py:60,67`) UNLESS a live audit proves the claude-code-agent termination target itself is gone — it is LIVE today via `app.py:3488,3625`, so do NOT delete in this pass; record as a follow-up gated on retiring the claude-code-agent harness. In stacks, retire the legacy static `Deployment-dapr-agent-py.yaml` (+Service+SA) — note there are **two copies** (`workloads/dapr-agent-py/` and `workloads/openshell-agent-runtime/`) and a full `dapr-agent-py-testing` lane — ONLY after confirming the `openshell-durable-agent` enum + `agent-runtime-pool-coding` benchmark pool no longer need a standing pod (they may — verify first). KEEP the `Component-llm-*` + `*-statestore` Components (per-session pods still bind them).
- **Files:** `call_agent_service.py`, `stacks/.../workloads/dapr-agent-py/manifests/`, `stacks/.../workloads/openshell-agent-runtime/manifests/`.
- **Risk:** MED — stacks deletion gated on the standing-pool audit; this is why it is last.
- **Shippable alone:** yes (orchestrator dead-code removal and stacks retirement are separate sub-ships).

---

## 5. What to DELETE / simplify (net moving-parts reduction)

| Removed/collapsed | → becomes | Phase |
|---|---|---|
| `_NATIVE_DURABLE_AGENT_TARGETS` (6 rows, `sw_workflow.py:985-1018`) | registry rows | 1 |
| Dead non-bridge `else` branch (`sw_workflow.py:1952-1965`) — the deadlock path | deleted | 1 |
| `agentImage` if-chain (`agent-workflow-host.ts:313-330`) | `descriptor.image` | 2 |
| THREE allowlist copies (`ws-kube-exec-proxy.ts:11`, `shell/resolve/+server.ts:7`, `runtime-flags/+server.ts:15`) | `mainContainerName` ∪ sidecars | 2 |
| `BENCHMARK_AGENT_RUNTIMES` literal (`agent-runtimes.ts:1-5`) | `listBenchmarkRuntimes()` | 2 |
| `runtime-target.ts:44` `"dapr-agent-py"` literal | `registry.defaultRuntimeId` | 2 |
| `framework:'Dapr Agents'`/`DaprChatClient` blob (`registry-sync.ts:177,185`) + throw (`application-state.ts:208`) | `descriptor.agentMetadataFramework` | 2 |
| `runtime==='browser-use-agent'` routing branch (`runtime-routing.ts:211`) | `requiresWarmPool` (Playwright content-inspection kept as `requiresBrowserSidecars`) | 2 |
| claude-agent-py `event_publisher.py` (128-LOC dup) | shared `services/shared/session_events/publisher.py` | 2 |
| `isClaudeAgentRuntime` SWE-bench branch (`service.ts:6440,6610-6620`) | `capabilities.ownsSandbox` | 4 |
| Dead HTTP run-lane `call_durable_agent_run` + `_durable_agent_app_id` (`call_agent_service.py:161-169,410-459`) | deleted (audited) | 6 |
| Legacy static `Deployment-dapr-agent-py` ×2 + (conditionally) `dapr-agent-py-testing` lane | retired after standing-pool audit | 6 |

Net: ~8 scattered enumerations + 1 duplicated 128-LOC publisher + 1 dead run-lane + (conditionally) 1-2 static Deployments → 1 JSON + 2 thin readers + 1 shared publisher + 1 swap gate + 1 conformance harness. Honest accounting: this is a **net reduction in scattered string-branches**, but it ADDS a capability descriptor, a swap gate, a conformance harness, and a CI parity guard — fewer silent failure modes, slightly more declarative machinery. That trade is the correct one for a "never silently wrong" swappability goal.

---

## 6. How each consumer uses the unified contract after migration

- **Workflows (`durable/run`).** Unchanged dispatch shape: orchestrator `resolve_runtime()` → `descriptor`; `call_child_workflow(descriptor.dispatchWorkflowName, app_id=descriptor.appId)` through the session bridge (gated on `descriptor.bridgeGateToken`). The node's `agentConfig` (mcpServers/hooks/modelSpec) is checked by `assertSwapSafe` against the target descriptor at dispatch — a lossy pin warns (or rejects per policy) instead of silently degrading.
- **Interactive sessions.** `spawn.ts` reads the descriptor for image + container allowlist + warm-pool routing, runs `assertSwapSafe` at spawn, wakes the per-session Sandbox. Capability flags drive the runtime-flags endpoint (e.g. `incrementalEvents` controls whether the UI expects mid-turn deltas), so claude's batch stream renders as labeled-batch, not broken.
- **SWE-bench.** Reads `modelPatch`/`runtimeSandboxName` driven by `ownsSandbox` (Phase 4), not a runtime literal. `benchmarkEligible` descriptors populate the eval runtime picker. The seeded claude canary rides `agent-runtime-pool-coding` exactly as today; the single-activity SWE-bench turn loses no durability (it was always single-activity).
- **adk-agent-py.** A `durable-session` family registry row — dispatch + deployment + event seams unchanged; `ownsSandbox:true`. Its capability block is seeded conservatively and confirmed by Phase 5 conformance before its descriptor is marked active (especially before Phase 4 routes it through `.solve.*`).
- **browser-use-agent (Arc 2 carve-out).** `family:"browser", requiresWarmPool:true, requiresBrowserSidecars:true` — satisfies dispatch + event seams, routes to the SandboxWarmPool lane **by data** (`requiresWarmPool`) instead of the `runtime==='browser-use-agent'` literal, with the `isPlaywrightMcpEntry` content-inspection preserved. The one genuine structural non-fungibility, modeled as a capability, not special-cased.

---

## 7. Position on the END STATE: dapr-agent-py hand-port vs SDK-native

**Recommendation: KEEP dapr-agent-py — do NOT retire its hand-ported hooks/plugins/compaction/telemetry — but stop treating it as the universal default.** The convergence framing (make claude-agent-py the primary Anthropic runtime, reserve dapr-agent-py) is attractive but premature to hard-commit, because dapr-agent-py's hand-port is the ONLY implementation for the 9 non-Anthropic providers (which have no SDK) AND the only `per-activity` durability lane AND the only observable-compaction + `claude_code.*` per-tool OTEL surface. The SDK's autocompact is internal/opaque; the SDK's hooks are `batch`-timed in a single-activity loop. So the duplicated subsystems are NOT redundant in general — they are redundant only for an Anthropic agent that could run on the SDK runtime.

This plan **enables** convergence (Phase 0 + the capability gate let new Anthropic agents prefer claude-agent-py by data) without **forcing** it. The default-flip and any role-shrink of dapr-agent-py's ~31k LOC should follow a usage audit of non-Anthropic + per-activity runs — captured below as a genuine decision, not baked into the migration.
