# Agent Node + Workflow Sandbox Architecture — Reflection & Standardization Proposal

> Written after building **"Impressive SvelteKit Game (Goal Loop)"** (`sveltekit-game-goal-showcase`) and validating it across all four agent runtimes. This doc captures what we learned, assesses whether the runtime-agnostic **agent node** abstraction holds up, and proposes a standardization of the two sandbox architectures behind a low-config UX.

## Context

The goal workflow has a CLI agent build a polished, playable SvelteKit game under a `goalSpec` objective, then captures a walkthrough and serves a 3b1b-style live preview. We ran it on `codex-cli`, `claude-code-cli`, `agy-cli`, and `dapr-agent-py` (deepseek). The exercise stress-tested two things that had never been pushed this hard together: **goal-mode termination across runtimes**, and **multi-step sandbox reuse** (build → verify → validate → preview on one workspace).

**Headline result:** the *plumbing* is runtime-agnostic and now solid — every runtime dispatches, builds, completes its goal, and terminates correctly. The remaining failures are **downstream model behavior**, not the abstraction. `claude-code-cli` is a full green run end-to-end.

---

## Part 1 — What works / what doesn't, per runtime

| Runtime | Family | Goal model | Outcome | Failure cause |
|---|---|---|---|---|
| **claude-code-cli** | interactive-cli | native `/goal` | ✅ **full success** | — built a complete Tetris with **prerendered** `data-test` hooks; terminate → outputSync → verify → validate → preview all green |
| **codex-cli** | interactive-cli | native `/goal` | ✗ at `browser/validate` | **Model**: builds a *client-only* SPA (empty prerender shell) and self-judges the goal complete without satisfying the "prerender the hooks" criterion → `[data-test="game-root"]` never in static HTML, doesn't render headlessly even at 45 s |
| **agy-cli** | interactive-cli | custom BFF loop | ✗ (hung) | **Model**: called `update_goal(complete)` at iteration 1, then kept working and went silent without idling → idle-gated terminate never fired (now caught by the tick backstop) |
| **dapr-agent-py** (deepseek) | durable-session | custom BFF loop | ✗ `error` | **Model**: mis-read a harmless `EnvHttpProxyAgent` warning as a proxy hang, killed `npm install` on a 45 s timer, never completed (weak model; stronger dapr models e.g. gpt-5.5 worked in prior goal runs) |

**Key takeaway:** all four runtimes are *interchangeable at the dispatch + build + terminate layer*. The differentiator is **how faithfully each model follows a multi-criterion goal** (prerender, completion audit, patience with slow tooling). claude was the only model that honored the full completion contract.

---

## Part 2 — Plumbing bugs found & fixed (the real infra work)

These were genuine, runtime-spanning defects exposed by goal-mode + sandbox-reuse, all now fixed (PRs #183–#189 + 2 stacks changes):

1. **Native-CLI cooperative terminate was a silent no-op.** The BFF raised the terminate with `eventName="session.lifecycle_events"` (the *channel*) while the cli-agent-py endpoint uses `eventName` *as* the event type — so it neither persisted the cancel-flag nor delivered a recognizable terminal event. Native CLI goal sessions hung after completing the goal. **Fix:** raise `eventName="session.terminate"` for both families (each endpoint re-routes to its own channel + persists the flag). *(Root cause of the multi-hour native-CLI hang.)*
2. **`outputSync` was gated on `status=="completed"`** → skipped when a session ended via *terminate* (the normal goal-complete path) → empty workspace → `verify_app` failed. **Fix:** run outputSync on `terminated` too.
3. **`outputSync`'s 64 MiB base64 ceiling can't carry `node_modules`.** Syncing a whole Node project blew the cap. **Fix:** redesign the workflow to a **static build** — `adapter-static` → outputSync only the small `build/` → serve statically (3b1b pattern).
4. **Goal marked complete on a session that never idles** (custom-loop `update_goal` is a direct DB write with no event) → idle-gated terminate never fires. **Fix:** tick-reaper backstop (`listCompletedUnterminatedWorkflowGoalSessions` → `finalizeCompletedWorkflowGoal`).
5. **Lost-idle probe false-positive** on long telemetry-only turns (the filtered "latest event" looked stale) → duplicate goal continuations mid-turn. **Fix:** raw-liveness guard (any recent event = alive).
6. **`browser/validate` selector timeout** on client-rendered SPAs. **Fix:** require the hooks be **prerendered** into static HTML, and raise the `waitForSelector` cap 15 s → 45 s.
7. **`autoTerminate` doesn't fire for native-CLI `/goal`** (the runtime emits no `turn.completed` the workflow keys on) — so the cooperative terminate, not autoTerminate, is the real end path for native CLI.

**Process lesson:** several of these were chained — each fix exposed the next — because the goal/termination/output contract was implemented with **inline per-runtime special-casing** rather than a declared contract. That is the thing worth abstracting (Part 3).

---

## Part 3 — Is the "agent node" abstraction interchangeable as intended?

**Yes at dispatch; leaky at lifecycle.**

- ✅ **Dispatch is genuinely runtime-agnostic.** One `durable/run` node with `agentRef.slug` (or `cliRuntime`) resolves any of the four runtimes via the runtime registry; the orchestrator (`ctx.call_child_workflow("session_workflow")`) and the workflow→session bridge don't care which runtime. We swapped `codex-cli` ↔ `claude-code-cli` ↔ `agy-cli` ↔ a dapr agent by changing one trigger field.
- ⚠️ **The goal/termination/output *contract* leaks across families.** The differences that caused Part 2's bugs:
  - **Completion signal:** native CLI emits `session.goal_completed` (transcript / `codex_update_goal`); custom-loop marks the goal complete via the goal-MCP `update_goal` (a *direct DB write*, no event).
  - **Termination:** native CLI ends via cooperative `session.terminate` (autoTerminate unreliable in `/goal`); custom-loop ends via the same raise but only after an *idle*; dapr consumes terminals on `user_events`, cli on `lifecycle_events`.
  - **Output delivery:** dapr builds *in* the shared workspace (no sync); CLI agents own a *separate* sandbox and must `outputSync` back.

**Recommendation — formalize a "goal lifecycle adapter" in the runtime registry.** We already declare capabilities (`durabilityGranularity`, `supportsMcp`, `ownsSandbox`, `cliAdapter`, …). Extend the descriptor with an explicit, declared **goal-lifecycle contract** so the BFF goal-loop + bridge stop special-casing runtimes inline:

```
goalLifecycle: {
  driver: "native-cli" | "bff-continuation",   // who loops
  completionSignal: "event" | "mcp-db-write",   // how we learn it's done
  terminate: { channel: "lifecycle_events" | "user_events", needsCancelFlag: bool },
  endTrigger: "cooperative-raise" | "auto-terminate",
  ownsSandbox: bool,                            // already present
}
```

The goal-loop would then pick channel/trigger/backstop from the descriptor instead of `if (isInteractiveCliSession) … else …`. Net effect: a *5th* runtime is added by writing a descriptor, not by patching `terminateWorkflowGoalSessionIfNeeded`, `onSessionEvent`, the tick reaper, and the bridge. The abstraction is sound; the contract just needs to be **data, not control flow**.

---

## Part 4 — The two sandbox architectures

We now have two real shapes, currently hand-wired differently per workflow:

### A. Shared retained sandbox (SvelteKit game, 3b1b)
`workspace/profile` provisions **one** sandbox (`keepAfterRun: true`); the agent build step + `verify` + `browser/validate` + `start-preview` all reference the same `sandboxName`/`workspaceRef`. CLI agents (which own their own runtime sandbox) bridge their output in via `outputSync`.

- ✅ Multi-step pipelines (build → verify → capture → **live preview**) on one workspace.
- ✅ The retained workspace backs the preview proxy after the run.
- ❌ Heavy hand-wiring: `workspace/profile` + `sandboxName`/`workspaceRef` threaded into every node + an `outputSync` block with explicit paths.
- ❌ The CLI-owns-its-own-sandbox asymmetry leaks (the `outputSync` 64 MiB / `node_modules` pain).

### B. Per-agent ephemeral sandbox (single agent action)
A `durable/run` node auto-provisions its own sandbox (#181) and is reaped on session end. No downstream reuse.

- ✅ Zero config — drop an agent node, it just runs.
- ✅ No `outputSync`/sharing to reason about.
- ❌ Output is trapped in the ephemeral sandbox — no verify/capture/preview chain, no artifact unless the agent emits one.

| | A. Shared retained | B. Per-agent ephemeral |
|---|---|---|
| Steps over one workspace | yes | no |
| Live preview after run | yes | no |
| Config burden | high (profile + refs + outputSync) | none |
| CLI-agent output bridging | manual `outputSync` | n/a |
| Best for | "build an app → verify → preview" pipelines | one-shot agent tasks |

---

## Part 5 — Proposed standardization: one "sandbox scope" choice

The two architectures differ only in **where the agent runs** and **whether the workspace outlives the node** — yet today that's expressed as completely different spec hand-wiring. Collapse it into a single declared **sandbox scope** the user picks once; the workflow compiler emits the plumbing.

**Node-level (or workflow-level) field:**

```
sandbox:
  scope: ephemeral | shared          # default ephemeral
  workspace: "<name>"                # required iff shared; auto-creates/binds the profile
  persist: false | true              # iff shared: keepAfterRun + enables preview
  output: none | artifact:<glob> | live   # how this node's work leaves the sandbox
```

**What the compiler does automatically (the abstraction):**
- `ephemeral` → today's auto-provision; reaped on end. No refs to thread.
- `shared` → first node tagged with a `workspace` name **synthesizes the `workspace/profile`** and every node with the same name inherits `sandboxName`/`workspaceRef`. The user never threads refs.
- **`output` hides the CLI-vs-dapr asymmetry.** The platform reads `ownsSandbox` from the runtime registry:
  - dapr (in-place) → no sync needed.
  - CLI (owns sandbox) → auto-insert `outputSync`. `output: artifact:build/**` syncs only the declared artifact (avoids the `node_modules`/64 MiB trap); `output: live` keeps the dir in the shared workspace.
- **Preview becomes a property, not a hand-built `browser/start-preview` node:** `persist: true` on a shared workspace + an `output` that's servable ⇒ the run page offers the live preview automatically.

**UX:** in the node panel, a single control —
> Run in: **( ) New sandbox** · **( ) Shared workspace [▼ name]**  ·  Keep for preview/downstream: ☐

— replaces the `workspace/profile` node + `sandboxName`/`workspaceRef` plumbing + the `outputSync` block + the manual `start-preview` node. Advanced users can still drop to the raw spec.

**Why this is the right shape:** it makes A and B the *same* primitive with one knob, removes the spec hand-wiring that made the game workflow fragile, and — crucially — pushes the CLI-owns-its-own-sandbox detail (the source of most of Part 2's pain) **below** the user's awareness, resolved from registry capabilities rather than authored per workflow. It pairs naturally with the Part 3 goal-lifecycle-contract change: both move per-runtime behavior from inline control flow into declared data.

---

## Appendix — shipped this session
PRs #183 (workflow + agent-node goal mode), #184 (static build + cleanup hardening), #185 (cooperative terminate restore + raw-liveness), #186 (npm patience prompt), #187 (terminate eventName root-cause), #188 (complete-goal tick backstop), #189 (prerender hooks); stacks: cli-agent-py `NODE_NO_WARNINGS`, openshell-agent-runtime `waitForSelector` 15→45 s. Validated end-to-end on `claude-code-cli`.
