# Interchangeable Agents + Per-Phase Agent Selection

**Status:** Design / feasibility analysis (2026-06-19). Investigated against `main` after PR #224.

> **Goal (user intent).** Standardize our actions/nodes/workflow patterns so the **cli-agents** (`claude-code-cli`, `codex-cli`, `agy-cli`) and **`dapr-agent-py`** are **interchangeable** — parameterized in the workflow definition + UI — and so the **plan / generator / critic** pattern can **mix and match**: select *any* agent independently for each of the three phases.

This doc records the current system, where it's already runtime-agnostic vs. coupled, the one real blocker (shared workspace), the options to remove it, and a phased plan. It is the SSOT for this workstream.

---

## TL;DR verdict

| Capability | Feasible today? | What it needs |
|---|---|---|
| **Swap a whole workflow's agent runtime via a parameter** (all phases same family) | ✅ **Yes, now** | Collapse the cloned per-runtime fixtures into ONE parameterized workflow. No backend change. |
| **Per-phase mix-and-match WITHIN one runtime family** (e.g. plan / generate / critic = three different `claude-code-cli` agents, or three different `dapr-agent-py` agents) | ✅ **Yes, now** | Three trigger inputs + three node `agentRef`s + three UI pickers. No backend change. |
| **Per-phase mix-and-match ACROSS workspace backends** (e.g. plan = `dapr-agent-py`, generate = `codex-cli`) — when phases must **share files** | ⛔ **Not supported — REJECTED at dispatch** | The two families use *physically different* file storage (see §4): cli-agents write a pod-local JuiceFS mount; dapr-agent-py writes a **remote OpenShell sandbox**. A shared `/sandbox/work` cannot span them. The resolver now fails fast (`WorkspaceBackendMismatchError`) instead of silently losing files. |

**Decided strategy (2026-06-19):** rather than bridge the two storage backends (rejected — see §4), we **constrain per-phase mix-and-match to a single workspace-backend family** and make the boundary explicit + enforced:
- Each runtime declares a `capabilities.workspaceBackend` in the registry SSOT (`juicefs-shared` for interactive-cli; `openshell-shared` for dapr-agent-py / browser-use; `pod-local` for claude-agent-py / adk-agent-py).
- `resolveSpecAgentRefs` rejects any workflow whose nodes share a `workspaceRef` but resolve to different backends.

**Bottom line:** the dispatch layer is *already* fully runtime-agnostic per node (verified). Within one backend family, per-phase mix-and-match works today (Phase 1, shipped). Cross-backend mixing is deliberately **not** supported — it's a storage-layer impossibility without a unified-workspace rebuild, so we guard it rather than fake it.

---

## 1. Current system

### 1.1 Dispatch is already per-node runtime-agnostic

Each `durable/run` node carries its own `agentRef`. The BFF resolver and the orchestrator resolve and dispatch **per node**, with no workflow-global runtime assumption:

- `src/lib/server/agents/resolver.ts` `resolveSpecAgentRefs()` walks every `durable/run` task and resolves **each** node's `agentRef` independently (per-node cache by `refKey`), then `resolveAgentRuntimeRoute()` computes that node's `appId` / `runtimeClass` / `isolation` and stamps `agentRuntime` / `agentAppId` into the node's `with`/`with.body`.
- `services/workflow-orchestrator/workflows/sw_workflow.py` `_resolve_native_agent_runtime(...)` runs **per task** at dispatch; `ctx.call_child_workflow(app_id=<node-specific app-id>)` targets that node's resolved runtime. No code assumes one runtime for the whole workflow. No namespace / placement / colocation constraint forces children to share a runtime.

**Implication:** two nodes in one workflow with different agent slugs already dispatch to different runtimes today.

### 1.2 Agent selection UI (today)

- `src/lib/components/workflow/config/sw-agent-config.svelte` — an **AgentPicker** dropdown (fed by `/api/agents`) sets `agentRef = { id, version }` on the node. The **runtime is read-only** here: it's derived from the selected agent (`selectedRuntime = runtimes[selectedAgent.runtime]`) and shown as a badge (family / provider / evaluator-goal availability).
- Runtime is chosen **at agent creation** only (`/workspaces/[slug]/agents/new` template → `agents.runtime` column); there is no per-node runtime override and no post-creation runtime editor. This is by design — the node is runtime-agnostic because it points at an agent, and the agent owns the runtime.
- `src/lib/components/workflow/execute-dialog.svelte` renders the **trigger input schema** generically (text / select / textarea / multiselect from `startNode.taskConfig.input.schema.document`). It can already render agent-picker dropdowns if the schema declares such fields with options.

### 1.3 The generator/critic pattern (today)

- Lives **only as JSON fixtures** in `scripts/fixtures/generator-critic/` — there is no visual authoring surface for the loop itself.
- Shipped as **four near-identical clones** differing only by the default agent slug:
  - `retroforge-showcase.json` → `dapr-agent-py`
  - `retroforge-cli-showcase.json` → `claude-code-cli`
  - `retroforge-codex-cli-showcase.json` → `codex-cli`
  - `retroforge-agy-cli-showcase.json` → `agy-cli`
- Each clone exposes **one** input, `agentSlug`, wired into **all three** phase nodes (`plan`, `generate`, `evaluate`) via `agentRef.slug = "${ .trigger.agentSlug // \"…\" }"`. So today every phase uses the *same* agent/runtime.
- The phases share files through a **per-execution JuiceFS mount at `/sandbox/work`** (`workspaceRef = ${ .runtime.executionId }`): the planner writes `SPEC.md`, the generator builds the app, the deterministic gate + critic read it.

### 1.4 What's runtime-agnostic vs. runtime-coupled in `agentConfig`

From `services/shared/runtime-registry.json` (capability SSOT), `src/lib/server/agents/swap-safety.ts`, and the runtime consumers:

| `agentConfig` field | Portable across runtimes? | Honored by | Swap class | Notes |
|---|---|---|---|---|
| `name` | ✅ | all (metadata) | — | |
| `instructions` (persona) | ✅ | all → system prompt | — | dapr: instruction bundle → system prompt; cli: `--append-system-prompt-file` |
| `body.prompt` (turn prompt) | ✅ | all → first user message | — | dapr: `initialEvents`; cli: `seedUserMessage` |
| `mcpServers` | ✅ (gated) | all w/ `supportsMcp` | **REJECT** if unsupported | all 5 support MCP today |
| `tools` / `allowedTools` | ✅ | all | — | universal allowlist |
| `skills` | ✅ (gated) | all w/ `supportsSkills` | WARN | materialized to disk both families |
| `maxTurns` / `maxIterations`, `timeoutMinutes` | ✅ | all | — | |
| `permissionMode` | ✅ (gated) | all w/ `supportsPermissionGating` | WARN | agy lacks gating → bypass |
| `hooks` | ✅ (gated) | all w/ `supportsHooks` | WARN | |
| `plugins` | ⚠️ | dapr / claude / agy (not codex) | WARN | |
| **`modelSpec`** | ❌ **runtime-specific** | **`dapr-agent-py` only** | **REJECT** to a cli-agent | cli-agents IGNORE it — they use the user's **subscription auth** + their native model (e.g. `normalize_codex_model`). Parameterizing "model" only makes sense for API-key runtimes. Default for dapr is `deepseek-v4-pro`. |
| `cliAdapter` | ❌ cli-only | cli-agents | — | dispatch-time only |
| `continueSession` | ❌ cli-only | `claude-code-cli` | — | `--continue` |
| `compiled*PresetSections` | dapr-only (BFF-added) | `dapr-agent-py` | — | |

**Key divergence #1 (model):** `modelSpec` is meaningful only for `dapr-agent-py` (and other API-key runtimes). cli-agents pick their model from the linked subscription credential. A portable template must treat "model" as **optional + runtime-conditional**.

**Key divergence #2 (workspace):** see §4 — the real blocker.

---

## 2. The two goals, decomposed

### Goal A — Interchangeable runtimes (parameterized)

"Pick the runtime for this workflow via a parameter instead of maintaining four cloned fixtures."

- **Already works at dispatch.** The only reason we have four fixtures is the hard-coded default slug. Collapsing them into **one** parameterized workflow (single `agentSlug` input, or three — see Goal B) removes the clone sprawl.
- The only field that doesn't travel cleanly is `modelSpec` → make it conditional (used by dapr/API-key runtimes; ignored, not errored, by cli-agents — already the runtime behavior).

### Goal B — Per-phase mix-and-match (plan / generator / critic)

"Select any agent for each of the three phases independently."

- **Within one runtime family:** works **today** with authoring changes only. Replace the single `agentSlug` input with **`planAgent` / `generatorAgent` / `criticAgent`**, point each phase node at its own input, and the backend dispatches each to its own (same-family) agent.
- **Across families:** the dispatch works, but the **shared `/sandbox/work` filesystem does not span families** (§4). For the *file-sharing* generator/critic loop this is a blocker. For patterns that hand off via context/artifacts instead of a shared FS, it works.

---

## 3. Where to standardize (the surfaces)

1. **Workflow authoring — collapse the clones into ONE parameterized template.**
   - Single `generator-critic` workflow with three optional agent inputs (`planAgent`, `generatorAgent`, `criticAgent`), each defaulting to a shared evaluator/critic agent. Phase nodes reference `${ .trigger.planAgent }` etc.
   - Keep the persona in `agentConfig.instructions` + `body.prompt` (both portable). Drop `modelSpec` from the portable template; let dapr nodes carry it only when targeting an API-key agent.
   - Retire `retroforge-{cli,codex-cli,agy-cli}-showcase.json` in favor of the parameterized one (full-cutover preference per repo conventions).

2. **A portable `agentConfig` contract (the "agnostic subset").**
   - Define the runtime-agnostic field set (name, instructions, body.prompt, mcpServers, tools, skills, maxTurns, timeoutMinutes, permissionMode, hooks) as the template surface.
   - Make `modelSpec` conditional/optional; surface the swap-safety verdict (`allow|warn|reject`) at author/run time so a cross-runtime selection that would drop MCP or mismatch a provider is caught early (the gate already exists in `swap-safety.ts`; wire its verdict into the per-phase picker).

3. **UI — per-phase agent pickers.**
   - The `execute-dialog.svelte` renderer is already schema-driven: declare `planAgent`/`generatorAgent`/`criticAgent` as `select` fields populated with the workspace's agents (name + runtime badge), and they render as dropdowns. Form values flow to `${ .trigger.* }`.
   - Optionally add a small **generator/critic authoring** affordance (a node-group preset) so the loop isn't fixtures-only — out of scope for the first cut.

4. **Workspace unification (only needed for cross-family mixing).** See §4.

---

## 4. Workspace backends — why cross-backend mixing is impossible, not just unwired

The generator/critic loop relies on a **per-execution shared filesystem** so the phases hand off `SPEC.md` and the built artifact. The decisive finding (verified in source, 2026-06-19): **the two runtime families do their file I/O in physically different places.**

- **interactive-cli family** (`claude-code-cli` / `codex-cli` / `agy-cli`) — tools run *in the cli pod*; files live on a **pod-local per-execution JuiceFS** mount at `/sandbox/work` (`sharedWorkspaceStore*` in the stacks `sandbox-execution-api` classes; keyed by `sharedWorkspaceKey` = executionId). `workspaceBackend: juicefs-shared`.
- **`dapr-agent-py`** — its tools do **not touch the pod filesystem at all**. Every tool (`file_write`, shell, …) runs via `SandboxSession.exec()` against a **remote OpenShell sandbox** (`openshell_runtime.py:119-170`, `SandboxClient.from_active_cluster()` + `sandboxName`). Files live in that remote sandbox (keyed by `sandboxName` = executionId-derived). `workspaceBackend: openshell-shared`. (browser-use shares this backend.)
- **`claude-agent-py` / `adk-agent-py`** — own pod filesystem, not shared across pods. `workspaceBackend: pod-local`.

So **W1 (mount the JuiceFS into the dapr pod) achieves nothing** — dapr's tools never read the dapr pod's filesystem. The backends are different storage systems; a shared `/sandbox/work` path name does not make them the same bytes. Within a family it works (all-cli share the JuiceFS; all-dapr/openshell share the OpenShell sandbox), which is why Phase 1 and the all-dapr RetroForge demo both work.

### Decision: constrain + guard, don't bridge

We do **not** pursue bridging the backends (W1/W2 are a storage rebuild for marginal benefit). Instead:

1. **`capabilities.workspaceBackend`** is now a first-class field in the runtime registry SSOT (`services/shared/runtime-registry.json` → synced to the orchestrator + BFF copies): `juicefs-shared` (cli family), `openshell-shared` (dapr-agent-py, browser-use), `pod-local` (claude-agent-py, adk-agent-py).
2. **`resolveSpecAgentRefs` enforces it** (`src/lib/server/agents/resolver.ts` `assertConsistentWorkspaceBackends`): any group of `durable/run` nodes sharing a `workspaceRef` must resolve to a single `workspaceBackend`, else it throws `WorkspaceBackendMismatchError` at dispatch with a clear message. This turns the old silent failure (files vanish) into a fast, explanatory rejection.

**Net rule:** per-phase mix-and-match is supported **within one workspace-backend family** (any cli ↔ any cli; any openshell ↔ any openshell) and **rejected across families** when they share a workspace.

For genuinely heterogeneous pipelines, the future-if-needed path is **W3 — context/artifact handoff** (each phase reads inputs from jq context / `workflow_artifacts` and writes outputs back; no shared FS). Not built; recorded for when a real need appears.

---

## 5. Phased plan

- **Phase 1 — Parameterized generator/critic + per-phase inputs (within-family).** ✅ Shipped (PR #225). One `generator-critic` workflow with `planAgent`/`generatorAgent`/`criticAgent` inputs; dev-verified with a claude+codex mix.
- **Phase 2 — UI per-phase pickers + swap-safety verdict.** Render the three agent selectors in `execute-dialog`; show the `swap-safety` `allow|warn|reject` badge per selection; surface the `workspaceBackend` of each selection so the user can't unknowingly compose a cross-backend (now-rejected) mix. Make `modelSpec` conditional (API-key runtimes only).
- **Phase 3 — Same-backend constraint, explicit + enforced.** ✅ Done (this revision): `workspaceBackend` in the registry SSOT + the resolver guard. (Replaces the original "extend the mount" scope, which the §4 finding invalidated.)
- **Phase 4 (optional) — generator/critic authoring affordance.** A canvas preset so the loop isn't fixtures-only. (W3 artifact-handoff would live here if cross-backend pipelines are ever needed.)

---

## 6. Constraints / invariants to preserve

- `ANTHROPIC_API_KEY` must never reach cli pods (subscription billing) — unchanged.
- cli-agents authenticate via the user's linked CLI credential; `modelSpec` is a no-op for them — the template must not *require* a model.
- Swap-safety is the authority on cross-runtime drops: MCP-loss + provider-mismatch are REJECT; hooks/plugins/permission/skills/durability are WARN. Surface it; don't bypass it.
- Per-node dispatch + the lifecycle event-subscription fix (PR #224) are the foundation — keep completion Stop-driven and per-node.

---

**Related:** `docs/agent-runtime-comparison.md`, `docs/durable-session-runtime-contract.md`, `docs/agent-node-and-workflow-sandbox-architecture.md` (the `sandbox.scope` knob + goal-lifecycle adapter), `docs/generator-critic-multi-agent.md`, `docs/interactive-cli-sessions.md`.
