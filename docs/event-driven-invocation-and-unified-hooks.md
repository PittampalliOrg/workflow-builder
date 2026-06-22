# Event-driven agent invocation + unified cross-runtime hooks

> Status: **DESIGN / FEASIBILITY** — no code yet. This doc assesses two
> Dapr-Agents framework features against our architecture and recommends a
> concrete, additive, runtime-agnostic path. Companion docs:
> [`agent-runtime-comparison.md`](./agent-runtime-comparison.md) (why the runtimes
> diverge), [`durable-session-runtime-contract.md`](./durable-session-runtime-contract.md)
> (the registry SSOT + capability descriptors + swap-safety),
> [`hooks-and-plugins.md`](./hooks-and-plugins.md) (the dapr-agent-py hooks surface),
> [`interactive-cli-sessions.md`](./interactive-cli-sessions.md) (the CLI family SSOT),
> [`workflow-lifecycle-termination.md`](./workflow-lifecycle-termination.md)
> (why per-session dispatch must stay placement-routed).

## Why

Two requests:

1. **Event-driven invocation** — add Dapr Agents'
   [extensions](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-extensions/)
   so an agent can be *triggered by an event* (a message/webhook/queue), not only
   by a synchronous dispatch, across both `dapr-agent-py` and the CLI wrapper
   `cli-agent-py`.
2. **Unified hooks** — connect the CLIs' native hooks to
   [Dapr Agents hooks](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-hooks/)
   so hooks are *standardized* across `dapr-agent-py` and the CLI agents.

Both are desirable, but the framework features don't map 1:1 onto our system. This
doc records what exists, what fits, and the recommended additive approach (chosen
with the user): an **additive pub/sub trigger that creates a `session_workflow` run
via the existing dispatch primitive**, and a **portable `agentConfig.hooks` contract
honored by all four runtimes** — explicitly *not* a dispatch migration and *not*
adopting the dapr_agents 4-slot `Hooks` API.

## Current state

### Two invocation models (neither uses pub/sub today)

| Runtime | Framework | Workflow registered | Dispatched by |
|---|---|---|---|
| `dapr-agent-py` (`services/dapr-agent-py/src/main.py`) | subclasses `dapr_agents.DurableAgent` (`OpenShellDurableAgent`), pinned `dapr-agents` (see version note) | `agent_workflow` (per-turn) + `session_workflow` (multi-turn) | orchestrator `ctx.call_child_workflow(...)` (Dapr workflow API) |
| `cli-agent-py` (`services/cli-agent-py/src/main.py`, `src/taskhub.py`) | **none** — standalone FastAPI + daprd, workflow only | `session_workflow` | BFF → `POST /internal/sessions/spawn` → `taskhub.start_instance` (TaskHub gRPC) |

`dapr-agent-py` already constructs the framework's HTTP host
(`AgentRunner().serve(agent, app=app, port=8002)`) and decorates `agent_workflow`
with `@message_router(message_model=TriggerAction)` — **the pub/sub plumbing is
wired but never invoked**; every real dispatch goes through the workflow API.
`cli-agent-py` has no `dapr_agents` objects at all — only `dapr.ext.workflow`.

**Dispatch must stay placement-routed.** Per-session agent pods are per-session
Kueue `Sandbox`s addressed by Dapr *placement*, not DNS/service-invoke. A prior
attempt to replace `call_child_workflow` with fire-and-forget/poll dispatch was
reverted (see `workflow-lifecycle-termination.md`, "Rejected" note). Any
event-driven path must *create a `session_workflow` run*, not bypass it.

### Three hook worlds

1. **`dapr-agent-py` custom hooks** (`services/dapr-agent-py/src/hooks/*`): a
   Claude-Code-style surface — 10 emitted events (PreToolUse, PostToolUse,
   PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop,
   Notification, PreCompact, PostCompact), `command` (subprocess) + `callback`
   (managed-only) types, a settings cascade, and a **per-run overlay**:
   `agentConfig.hooks` + `agentConfig.plugins` are applied via
   `src/plugins/runtime.py::apply_per_run`. PreToolUse/PostToolUse fire **inside
   the `run_tool` activity** (a per-activity durable boundary) and PreToolUse can
   **block** (`prevent_continuation`). Gated by `DAPR_AGENT_PY_HOOKS_ENABLED` /
   `DAPR_AGENT_PY_PLUGINS_ENABLED`. It imports `Hooks as NativeHooks` /
   `LLMHookContext` / `Proceed` from `dapr_agents` but **does not use them**.
2. **CLI native hooks** (`cli-agent-py/src/hooks_api.py` +
   `src/cli_adapters/{claude_code,codex,antigravity}.py`): each CLI emits its own
   hooks — claude via static `docker/managed-settings.json` HTTP hooks →
   `POST /internal/hooks/claude`; codex/agy via a per-session command-relay
   (`base.py::write_hook_relay_script`) → `POST /internal/hooks/cli/{adapter}`.
   `HookProcessor` maps them to `session_events` and raises workflow lifecycle
   events. **The CLIs ignore `agentConfig.hooks`** — only their native config is
   honored.
3. **dapr_agents native `Hooks`** (the doc URL #2): 4 typed slots
   (`before_tool_call`, `before_llm_call`, `after_llm_call`, `after_tool_call`)
   returning a `HookDecision` (`Proceed`/`Deny`/`Skip`/`Mutate`/`RequireApproval`).
   Importable but unused in our build.

So there are two *execution* surfaces (dapr-agent-py custom hooks; per-CLI native
hooks) and the unused framework `Hooks`. The portable knob `agentConfig.hooks`
runs on exactly one of the four runtimes today.

## Feature assessment vs our architecture

### dapr_agents "extensions" (activation hook) — NOT directly usable

The extensions API is `agent.add_activation(cb)` + an `ActivationContext` fired
once at hosting start; the callback opens an event source and schedules runs with
`runner.run(..., wait=False)`. Two blockers:

- **Not in our pinned version.** A live probe of the running `dapr-agent-py`
  showed `dapr_agents.__version__ == 1.0.3` with `add_activation` / `ActivationContext`
  / top-level `TriggerAction` **absent** (`Hooks`, `AgentRunner`, `DurableAgent`
  present). The pyproject pin reads `1.0.4`, so there is also a
  **legacy-Deployment vs sandbox-image version drift** to reconcile separately;
  either way the activation-hook seam the docs describe is newer than what we run,
  and the version guard (`src/dependency_guard.py`, fail-fast) makes a bump heavy
  (replay/durability tests + drain).
- **cli-agent-py has no `DurableAgent`/`AgentRunner`** to attach an activation to.
- **`runner.run()` is the wrong dispatch.** It schedules an in-process agent run;
  our agents must run as per-session placement-routed `session_workflow` instances.

→ Use the **plain, additive pub/sub-subscription seam** (below) for both services
instead of the framework extensions API. Same outcome (event triggers a run),
no version bump, uniform across runtimes.

### dapr_agents native 4-slot `Hooks` — NOT the standardization vehicle

Adopting `Hooks(before_tool_call=..., ...)` in dapr-agent-py would replace its
per-activity custom subsystem — but that subsystem *is* the prerequisite for
PreToolUse permission gating + the `hook.decision` event stream, and it's
intrinsically coupled to the per-activity durable boundary
(`agent-runtime-comparison.md` §5–7). And it does nothing for the CLIs, which run
their own loop and can only be intercepted through their *native* hook protocols.

→ Standardize on the **portable `agentConfig.hooks` contract** we already have,
and make the CLI family honor it — don't swap execution engines.

## Recommended approach

### A. Event-driven invocation = additive pub/sub trigger

A Dapr **pub/sub component** + an **"agent trigger" topic**. Both services
subscribe; a trigger message **creates a `session_workflow` run via the existing
primitive**. Nothing about today's dispatch, placement, lifecycle, the
`ANTHROPIC_API_KEY` exclusion, or `cliAuth` resolution changes.

- **cli-agent-py**: add a Dapr subscription (a `GET /dapr/subscribe` registration +
  a `POST` handler, or a declarative `Subscription` CR) whose handler validates the
  message and calls the existing `taskhub.start_instance(instance_id, payload)`.
- **dapr-agent-py**: a parallel subscription handler that calls the same workflow-
  create path it uses today (`CreateInstance` / the spawn route). Do **not** route
  through `@message_router`/`runner.run` (wrong dispatch + version gap).
- **Publisher**: the BFF for internal triggers (e.g. a scheduled or fan-out
  invocation), and/or external webhooks → pub/sub for integrations. The trigger
  payload mirrors the `durable/run` / spawn body (agentAppId/agentSlug,
  workspaceRef, agentConfig, prompt).

**Pros**: minimal blast radius; reuses the proven dispatch; works for all
interactive-cli + dapr-agent-py; decouples producers from the agent; no dapr-agents
bump. **Cons/cautions**: needs a **deterministic instance id + idempotency/dedup**
(at-least-once pub/sub can redeliver — reuse the existing deterministic
`child_instance_id` discipline and the `_idempotent_schedule` guard); a poison
message must not wedge the subscription (dead-letter / bounded retry); the pub/sub
component must be scoped to these apps without violating the Component-visibility
invariant (no new `actorStateStore=true` component).

### B. Unified hooks = portable `agentConfig.hooks` on all four runtimes

`dapr-agent-py` already executes `agentConfig.hooks`. Extend the CLI family to honor
the same contract:

1. **Translate** each `agentConfig.hooks` entry into the target CLI's native hook
   config at seed time (in the adapters): claude → `managed-settings.json` /
   settings overlay; codex → `config.toml`; agy → `hooks.json` — each pointed at
   the existing relay (`write_hook_relay_script`).
2. **Execute** the portable hook's `command`/`callback` inside the relay /
   `HookProcessor` when the matching native hook fires, surfacing decisions
   (block/allow/ask) **where the CLI's native protocol allows** — claude PreToolUse
   can block via exit-2; codex/agy are largely Stop-only → advisory.

Publish a **capability matrix** so the limits are explicit, e.g.:

| Event | dapr-agent-py | claude-code-cli | codex-cli | agy-cli |
|---|---|---|---|---|
| PreToolUse (can block) | ✅ block/allow/ask | ✅ block (exit-2) | ⚠️ advisory | ⚠️ advisory |
| PostToolUse | ✅ | ✅ | ⚠️ via transcript | ⚠️ via transcript |
| UserPromptSubmit | ✅ | ✅ | ✅ | ⚠️ |
| Stop / SessionEnd | ✅ | ✅ | ✅ | ✅ |
| Notification / Compact | ✅ | ✅ | ⚠️ | ⚠️ |

(Fill in precisely against each adapter's declared flags during implementation.)

**Pros**: one authoring surface (`agentConfig.hooks`) across the fleet; keeps each
CLI's native hooks and the per-activity dapr-agent-py engine intact; honest about
where blocking is/ isn't possible. **Cons**: per-CLI translation is fiddly and the
blocking-granularity asymmetry is real (must be declared, not hidden).

## Capability-descriptor impact

Declare the new properties in the registry SSOT
(`services/shared/runtime-registry.json`, regenerated by
`scripts/sync-runtime-registry.mjs`) so swap-safety
(`src/lib/server/agents/swap-safety.ts`) reasons about them:

- `eventDrivenInvocation: boolean` — does the runtime accept a pub/sub trigger.
- `portableHooks: boolean` + per-runtime **hook-blocking granularity** (e.g.
  `full` | `advisory`) so a swap from a blocking runtime to an advisory one WARNs.

## Phased roadmap (when we build)

- **P1 — pub/sub trigger for cli-agent-py.** Smallest surface, no framework risk:
  subscription handler → `taskhub.start_instance` + idempotency. Validate end-to-end
  with a published trigger creating one CLI session run.
- **P2 — pub/sub trigger for dapr-agent-py.** Same pattern via its workflow-create
  path. (Reconcile the 1.0.3↔1.0.4 drift first; do **not** depend on `add_activation`.)
- **P3 — portable `agentConfig.hooks` for the CLIs.** Adapter translation + relay
  execution + the capability matrix; start with claude (full block), then
  codex/agy (advisory).
- **P4 — registry descriptors + swap-safety + UI.** `eventDrivenInvocation` /
  `portableHooks` / blocking-granularity; surface in the agent config UI.

## Open questions / validation

- **dapr-agents version**: probe shows the legacy Deployment on **1.0.3**; pin says
  1.0.4. Reconcile, and record whether any target version exposes
  `add_activation`/`ActivationContext` (it isn't required by this design, but the
  drift should be fixed regardless).
- **Pub/sub component**: reuse the existing Redis pub/sub vs a dedicated one;
  scope to these app-ids without adding an actor state store.
- **Idempotency**: deterministic trigger→instance-id mapping + dedup window;
  dead-letter for poison messages.
- **External publishers**: in scope now, or BFF-internal triggers first?

## Out of scope (explicit)

- Migrating dispatch from the workflow API to pub/sub message routing (placement /
  lifecycle risk — rejected).
- Replacing dapr-agent-py's custom hooks with the dapr_agents 4-slot `Hooks` API.
- Any dapr-agents version bump as part of this change.
