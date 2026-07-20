# Framework Multi-Agent Primitives vs. our Agent Teams

Research question (raised by the pydantic-teammate stall, 2026-07-20): do
pydantic-ai or dapr-agents ship multi-agent primitives that are **more
reliable** than our script-led Agent Teams structure — and should we adopt
any of them?

## What each framework actually offers

### dapr-agents (the framework `dapr-agent-py` builds on)

Coordination is **infrastructure-level**: each agent runs as a standing Dapr
service subscribed to its own pub/sub topic (+ a shared broadcast topic); an
orchestrator service (LLM-selected, Random, or RoundRobin) publishes
CloudEvents to an agent's topic, which **automatically schedules a durable
workflow instance** on that agent. An agent registry in the state store
enables discovery. Reliability properties: at-least-once delivery, schema
validation at ingress, durable-workflow recovery — an agent *receives work
without any LLM cooperation*, because message arrival (not a tool call)
triggers execution.

### pydantic-ai

Four patterns, in increasing structure:
1. **Agent delegation (agent-as-tool)** — a parent agent's tool runs another
   agent *in-process*; failure propagates synchronously, usage rolls up via
   `ctx.usage`. The most reliable coordination possible (a function call),
   scoped to one process.
2. **Programmatic hand-off** — application code decides which agent runs
   next, passing message history. This is precisely what our dynamic-script
   engine is at platform scale (the script is the application code), made
   durable.
3. **Graph-based control flow** (pydantic-graph state machines) — the role
   our SW 1.0 / dynamic-script layer already plays.
4. **A2A** — a cross-process agent protocol assuming standing endpoints.

The Diagrid python-ai Dapr integration (our port's reference) is
single-agent; it adds no multi-agent primitives.

## The comparison that matters

| Dimension | dapr-agents orchestration | pydantic-ai delegation/hand-off | our Agent Teams |
|---|---|---|---|
| Work delivery | pub/sub → auto-scheduled workflow (**no LLM cooperation needed**) | in-process function call (**cannot silently hang**) | task rows + event-lane nudge; teammate must *choose* to call `claim/update_task` via MCP |
| Coordination transport | Dapr pub/sub (at-least-once) | process memory | **MCP over HTTP inside the runtime** ← the weak lane |
| Durability | Dapr workflow per agent | none (process scope) unless wrapped | Dapr workflow per session + DB task/knowledge state |
| Deployment fit for us | ✗ standing topic-subscribed services — the model we retired; per-session Kueue sandboxes are placement-routed, not subscribable | ✓ inside one activity only (coarse durability) | ✓ built for per-session sandboxes, cross-runtime |
| Determinism of control | LLM-orchestrator (or trivial RR) | application code | **script-led (deterministic lead)** — stronger than both |
| Cross-runtime workers, human-visible tasks/knowledge, budget rollup | ✗ | ✗ | ✓ |

**Verdict: neither framework's multi-agent stack should replace Teams.**
Both assume either standing services (dapr-agents, A2A) or single-process
scope (delegation); neither offers persistent cross-runtime workers,
task/knowledge visibility, or budget rollup. Our script-led lead is *more*
deterministic than an LLM orchestrator. What the frameworks are better at is
exactly where Teams failed in the stall incident: **the coordination
transport**. Teams' only LLM- and network-dependent link is the `wfb_team`
MCP tool lane inside the runtime — the frameworks coordinate via
infrastructure (pub/sub) or function calls instead.

## Recommendations (adopt the mechanics, keep the structure)

- **R1 — fix the immediate bug**: the pydantic MCP toolset stall under
  multi-activity reuse (diagnosis in flight; teammates are the first
  pydantic sessions that actually wire an MCP server since the goal-MCP
  removal).
- **R2 — native team toolset for API-capable runtimes** (highest value):
  expose `claim_task`/`update_task`/`send_message`/knowledge as a
  **harness-native toolset** in pydantic-ai-agent-py (and optionally
  dapr-agent-py) that calls the BFF team HTTP API directly — pydantic-ai's
  "tool = in-process function call" reliability model, deleting the MCP hop
  for coordination. MCP stays for the CLI family (their native transport).
- **R3 — dapr-native delivery for assignment signals**: task-assignment
  nudges already ride the session external-event lane; keep hardening
  toward "message arrival triggers the turn" (the dapr-agents property)
  rather than transcript-level nudging — consistent with the platform's
  standing dapr-native-adoption rule.
- **R4 (optional, later)** — in-activity delegation: allow a pydantic agent
  to run a bounded sub-agent inside one `execute_tool` activity for tight
  sub-judgments (coarse durability, acceptable for small scopes).

Related: `docs/pydantic-ai-default-runtime-evaluation.md`,
`docs/event-driven-invocation-and-unified-hooks.md` (pub/sub trigger
recommendation), the dynamic-script team primitives spec.
