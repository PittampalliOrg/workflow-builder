# Callable Agents (`CallAgent` tool)

Agents published in the CMA console can delegate work to other agents by
listing peer slugs under `agentConfig.callableAgents`. At runtime those
peers are exposed to the agent's LLM as a single `CallAgent(name, prompt)`
tool. The peer's final message flows back to the caller as a
`tool_result` in the same turn — no polling, no second LLM round-trip.

## Wire path (Approach B)

```
parent agent_workflow
  ├─ LLM emits CallAgent(name=<slug>, prompt=<task>)
  ├─ CallAgentWorkflowTool._schedule_peer_session(ctx, …)
  │    └─ returns ctx.call_child_workflow(
  │          workflow="call_peer_session_workflow",
  │          instance_id="ca-<uuid16>-<slug20>"        # deterministic; ≤40 chars
  │       )
  ▼
call_peer_session_workflow(ctx, message)
  ├─ yield ctx.call_activity(create_peer_session_row)
  │    → POST /api/internal/sessions/spawn-peer?skipSpawn=true
  │    → creates the `sessions` row + returns resolved
  │      {agentConfig, environmentConfig, vaultIds, callableAgents, registryTeam}
  ├─ yield ctx.call_child_workflow(
  │     workflow="session_workflow",
  │     instance_id="<sessionId>:swf"                  # ≠ wrapper instance_id
  │  ) with autoTerminateAfterEndTurn=true + the prompt as an initial user.message
  └─ return {content, sessionId, success, turn, peerSlug}   # this dict becomes
                                                             # the CallAgent tool_result
```

Every boundary is a Dapr durable primitive — parent pod restarts replay
the yields; the dispatcher re-attaches to the same wrapper + child
workflow instances by `instance_id` instead of double-spawning.

## SDK extension point

`CallAgentWorkflowTool` subclasses `dapr_agents.tool.workflow.tool_context.WorkflowContextInjectedTool`
(available in `dapr-agents>=1.0.1`; the service is currently pinned to the GA
`dapr-agents==1.0.3` and boot-guards that exact version via
`assert_dapr_agents_version()`). The base `DurableAgent.agent_workflow`
dispatch loop detects it via
`isinstance(tool_obj, WorkflowContextInjectedTool)` and routes the tool
call through `ctx.call_child_workflow(...)` inline — the parent yields on
the Task, the child's return value becomes the tool's `tool_result`
content (via `serialize_tool_result`).

Ordinary (non-workflow) tools still dispatch as activities via
`ctx.call_activity(self.run_tool, ...)`.

## Configuration

**Agent authoring** (CMA console — Capabilities tab):

```jsonc
{
  "callableAgents": ["playwright-browser-agent", "code-reviewer"]
}
```

Each slug must point to an agent in the same `project_id` that is
`registry_status = "registered"`. Archived peers are filtered out by
`resolveCallableAgents`.

**Runtime flag** (Deployment env):

| Var                         | Values  | Behavior                                                                                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_CALL_AGENT_NATIVE=1` | on      | Native workflow-context path. Peer answer lands in the **same** LLM turn as a `tool_result`.                                          |
| unset / `0`                 | default | Legacy Approach A (`CallAgent` is a plain HTTP tool that POSTs to `/api/internal/sessions/spawn-peer` and returns a `child_session_id` — the LLM has to follow up with `ReadSessionEvents`). |

Approach B shipped for Ryzen prod on 2026-04-18. Approach A is kept as
a rollback target; both paths go through the same BFF endpoint and DB
rows, so the sessions list / parent-child lineage look identical either
way.

## Session semantics

- Child session id: `ca-<uuid16>-<slug20>` (deterministic, ≤40 chars —
  fits Dapr's 64-char `instance_id` cap with room for the `:swf` suffix).
- Child `sessions.parent_execution_id` = `<parentSessionId>:turn-<N>`.
- Child `sessions.id` = `sessions.dapr_instance_id` (wrapper instance).
  The inner `session_workflow` gets its own Dapr id `<sessionId>:swf`.
- Child runs with `autoTerminateAfterEndTurn=true` — one turn, emit
  `session.status_idle{end_turn}` + `session.status_terminated`, return.
- Full conversation visible in the UI sessions list exactly like a
  UI-initiated session. Parent run detail lists its children (same API
  as `durable/run`-spawned sessions: `/api/workflows/executions/[id]/sessions`).

## Expected parent event sequence

For a `CallAgent` call that returns cleanly:

1. `user.message`
2. `session.status_running` turn 1
3. `session.status_rescheduled`
4. `llm_start`
5. `agent.message` with `toolCalls=["CallAgent"]`
6. `llm_start` (turn 2 LLM, same run)
7. `agent.message` — final answer, `toolCalls=[]`
8. `session.status_idle{end_turn}`

No `ReadSessionEvents` tool call, no `session.error`, no extra turns.

## Durability matrix

| Step                                                                    | Primitive                                  | Replay-safe? |
| ----------------------------------------------------------------------- | ------------------------------------------ | ------------ |
| Parent `yield ctx.call_child_workflow(call_peer_session_workflow, …)`   | Dapr event-sourced; same `instance_id` re-attaches | ✅           |
| Wrapper `yield ctx.call_activity(create_peer_session_row)`              | Activity retried; idempotent by `sessionId` → existing row short-circuit | ✅           |
| Wrapper `yield ctx.call_child_workflow(session_workflow, instance_id=<sid>:swf)` | Child-workflow re-attach                    | ✅           |
| Child `session_workflow` end-to-end                                     | Unchanged from UI sessions                 | ✅           |
| `serialize_tool_result` + `ToolMessage` → LLM turn 2                    | In durable message log                     | ✅           |

Cross-app routing (to a peer whose `runtime` lives on a different Dapr
app id) uses `ctx.call_child_workflow(app_id=<peerAppId>, …)` — supported
natively by the SDK. For now every peer shares `dapr-agent-py`.

## Pitfalls observed during implementation (2026-04-18)

These are all documented in code comments, but noted here because they
were non-obvious:

1. **`WorkflowContextInjectedTool` only ships in `dapr-agents>=1.0.1`.**
   The 0.13.0 wheel has no `dapr_agents/tool/workflow/` submodule; pods
   crashloop on import when `AGENT_CALL_AGENT_NATIVE=1` is set. Pin is
   in `services/dapr-agent-py/pyproject.toml`.

2. **Namespaced workflow registration.** In 1.0.1 `DurableAgent.register_workflows()`
   registers the primary workflow as `dapr.agents.<AgentName>.workflow`
   via a `_named()` wrapper. Cross-workflow calls must use
   `self.agent_workflow_name` (the SDK property), never the bare string
   `"agent_workflow"` — that name is no longer in the registry.
   `session_workflow`'s turn dispatcher was fixed accordingly.

3. **Wrapper vs. child instance_id collision.** The deterministic
   `sessionId` is the wrapper's Dapr `instance_id` *and* was initially
   re-used for the inner `session_workflow`. Dapr keys workflow
   instances by id; two orchestrators sharing one id produces
   `Ignoring unexpected taskCompleted event with ID = 1` warnings and
   the child sticks in `rescheduling`. Fix: suffix the inner instance
   with `:swf`.

4. **Generator return-value capture.** `yield from super().agent_workflow(...)`
   drops the generator's `return final_message`. 1.0.1's SDK relies on
   that return to hand the per-turn assistant dict back to
   `session_workflow` — which in turn becomes the `CallAgent tool_result`
   content. Must bind the expression: `result = yield from super()…`
   then `return result`.

## Files

| File                                                                                | Role                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| `services/dapr-agent-py/src/tools/call_agent/workflow_tool.py`                      | `CallAgentWorkflowTool` (Approach B)           |
| `services/dapr-agent-py/src/tools/call_agent/tool.py`                               | Legacy HTTP tool (Approach A, feature-flagged) |
| `services/dapr-agent-py/src/tools/call_agent/prompt.py`                             | LLM-facing description                         |
| `services/dapr-agent-py/src/main.py` → `call_peer_session_workflow`                 | Wrapper workflow                               |
| `services/dapr-agent-py/src/main.py` → `create_peer_session_row`                    | Activity that POSTs to spawn-peer              |
| `src/routes/api/internal/sessions/spawn-peer/+server.ts`                            | BFF endpoint (serves both approaches)          |
| `src/lib/server/agents/registry.ts` → `resolveCallableAgents`                       | Peer allow-list resolver (per-project)         |
