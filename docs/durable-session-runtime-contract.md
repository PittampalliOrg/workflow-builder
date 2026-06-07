# DurableSessionRuntime Contract (v1)

> Status: **IMPLEMENTED** — the declarative runtime registry SSOT
> (`services/shared/runtime-registry.json`) + capability descriptors + the
> swap-safety gate are live. This is the versioned contract every swappable
> durable-agent runtime satisfies, plus the single source of truth for runtime
> identity. Companion doc:
> [`agent-runtime-comparison.md`](./agent-runtime-comparison.md) (why the two
> runtimes diverge). For stop/terminate/purge of durable agent runs, see
> [`workflow-lifecycle-termination.md`](./workflow-lifecycle-termination.md)
> (the lifecycle SSOT).

## Why

`durable/run` can target several agent runtimes (`dapr-agent-py`,
`claude-agent-py`, `adk-agent-py`, `browser-use-agent`, per-agent
`agent-runtime-<slug>` pods). Historically the orchestrator selected one through
a hand-coded precedence ladder + an inline `_NATIVE_DURABLE_AGENT_TARGETS` dict in
`workflows/sw_workflow.py`, and the BFF repeated the runtime list across ~8
scattered enumerations. There was **no interface** — adding or swapping a runtime
meant editing every site, and a runtime swap could silently drop features (MCP
tools, hooks, multi-provider) because nothing declared what a runtime can do.

The contract draws the abstraction line at the seams that **already carry every
runtime today** and adds an explicit capability declaration so the platform knows
when a swap is lossy.

## The contract

A runtime is registry-eligible iff it satisfies all of:

### 1. Dispatch
- Registers a Dapr workflow named exactly **`dispatchWorkflowName`** (canonical
  `session_workflow`).
- The orchestrator gates the workflow↔session bridge on **`bridgeGateToken`**
  (canonical `agent_workflow`, == `config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME`).

> **Two-name dispatch (load-bearing).** `session_workflow` is the *dispatched*
> workflow; `agent_workflow` is the *bridge-eligibility sentinel* — they are
> different strings with different roles (`sw_workflow.py` dispatches the former,
> gates on the latter). The registry carries both as distinct fields; conflating
> them flips every runtime into the unreachable non-bridge branch and deadlocks
> `CreateWorkflowInstance`.

### 2. Input (`childInput`, produced by the BFF `ensure-for-workflow` bridge)
MUST accept and honor: `sessionId`, `agentConfig.{modelSpec, maxTurns,
permissionMode}`, `instructionBundle.rendered.system`, `autoTerminateAfterEndTurn`
(hard-coded `true` for `durable/run`). Runtime-OPTIONAL (honor iff the matching
capability is `true`): `agentConfig.{mcpServers, hooks, plugins, contextStrategy}`.
A runtime that does not honor an optional field MUST declare the corresponding
capability `false` so the (future) swap-safety gate warns instead of silently
dropping it.

### 3. Return
MUST return a `dict` with at least `{ success: bool, output|content: str,
sessionId: str, agentRuntime: str }`. Optional, read by specific consumers:
`{ status, modelPatch, runtimeSandboxName, workspaceRef, sandboxName, messages,
daprInstanceId, agentWorkflowId, childWorkflowName, usage }`.

### 4. Events
Emit, via HTTP POST to the BFF `/api/internal/sessions/{id}/events/ingest`, the
minimum CMA vocabulary unconditionally (`session.status_*` + `agent.message` /
`agent.tool_use` / `agent.tool_result`); emit the optional incremental tier
(`message_delta`, `agent.llm_usage`, `agent.context_usage`, `hook.decision`) only
when `capabilities.incrementalEvents` is `true`.

## The registry

Canonical (Phase 1): **`services/workflow-orchestrator/core/runtime_registry.json`**,
read by `core/runtime_registry.py`. App-ids are **not** frozen in the JSON — each
descriptor names an `appIdConfigKey` resolved at load from `core.config` (Dapr
Configuration / env), so the existing override flow is unchanged; only the static
`capabilities` blob is new.

> **Phase 2** promotes this file to `services/shared/runtime-registry.json` (the
> single source of truth read by **both** the Python orchestrator reader and a new
> TS BFF reader) and collapses the BFF's scattered enumerations (image if-chain,
> the three container allowlists, `BENCHMARK_AGENT_RUNTIMES`, the framework blob).
> It lives in the orchestrator build context for Phase 1 because that build
> context is `services/workflow-orchestrator` (`COPY . .`) and cannot reach
> `services/shared/` without the cross-context plumbing Phase 2 adds.

### Descriptor shape

| Field | Meaning |
|---|---|
| `id` | runtime name (e.g. `claude-agent-py`) |
| `appIdConfigKey` | `core.config` attribute resolving the Dapr app-id (override-safe) |
| `instancePrefix` | child-instance-id prefix (`durable`, `durable-claude`, …) |
| `family` | `durable-session` \| `browser` (browser ⇒ Arc 2 warm-pool, not the ephemeral Sandbox lane) |
| `mainContainerName` | pod container name (feeds the BFF container allowlists in Phase 2) |
| `imageEnvKey` | BFF env var carrying the per-session Sandbox image (Phase 2) |
| `agentMetadataFramework` | replaces the hard-coded `'Dapr Agents'` registry blob (Phase 2) |
| `benchmarkEligible` | appears in the SWE-bench runtime picker |
| `capabilitiesVerified` | `true` once the Phase 5 conformance harness proves the flags |
| `capabilities` | the guarantee/feature descriptor (below) |

### Capability descriptor

`durabilityGranularity` (`per-activity` \| `per-turn`), `retryMaxAttempts`,
`durableTurnTimer`, `supportsMcp`, `supportsBuiltinOpenShellTools`,
`supportsHooks`, `hookTiming` (`live` \| `batch`), `supportsPermissionGating`,
`supportsPlugins`, `supportsCompaction`, `incrementalEvents`, `ownsSandbox`,
`requiresWarmPool`, `requiresBrowserSidecars`, `multiProvider`,
`supportedProviders`.

> Capabilities are **advisory in Phase 1** — nothing consumes them yet. The
> **Phase 3** swap-safety gate reads them to WARN/REJECT lossy swaps; the
> **Phase 5** conformance harness flips `capabilitiesVerified` once each declared
> flag is proven. The durability difference (`per-activity` vs `per-turn`) is a
> first-class declared property, never erased: a swap that downgrades it is a
> warned event, not a silent change.

### Resolution precedence (`resolve`)

Reproduces the historical `_resolve_native_agent_runtime` ladder **exactly**
(asserted by `tests/test_runtime_registry.py`'s behavior-equivalence matrix):

1. `agentAppId` (flattened args, then `agentConfig`) → synthetic per-agent
   descriptor (a `dapr-agent-py` pod addressed by app-id).
2. else `agentRuntime` \| `runtime` enum (flattened, then `agentConfig`),
   defaulting to `dapr-agent-py` → a registered descriptor.
3. else `agentSlug` (flattened) \| `agentConfig.slug` → on-the-fly
   `agent-runtime-<slug>` descriptor.
4. else raise (same message + sorted id list).

## Current runtimes

| id | family | durability | MCP | providers | verified |
|---|---|---|---|---|---|
| `dapr-agent-py` | durable-session | per-activity (8 retries) | ✅ | 9 (multi) | ✅ |
| `dapr-agent-py-testing` | durable-session | per-activity | ✅ | 9 | ✅ |
| `claude-agent-py` | durable-session | per-turn (3 retries) | ✅ *(Phase 0)* | anthropic | ⏳ Phase 5 |
| `adk-agent-py` | durable-session | per-turn | ❌ | gemini | ⏳ |
| `browser-use-agent` | browser | per-activity | ✅ | anthropic | ⏳ |

## Roadmap

- **Phase 0 (done):** `claude-agent-py` honors `agentConfig.mcpServers` + emits
  `hook.decision` via the SDK (`mcp_config.py`, `claude_sdk_runner.py`).
- **Phase 1 (this doc):** registry + contract + two-name dispatch de-hard-coding.
- **Phase 2:** promote the registry to `services/shared/`; collapse the BFF
  enumerations + extract the shared event publisher.
- **Phase 3:** swap-safety gate (WARN/REJECT lossy swaps) + lifted model/provider
  resolver.
- **Phase 4:** SWE-bench de-branch (`isClaudeAgentRuntime` → `capabilities.ownsSandbox`).
- **Phase 5:** runtime conformance harness; flip `capabilitiesVerified`.
- **Phase 6:** delete audited dead lanes.
