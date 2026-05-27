# Agent Runtime Model

The runtime model is split:

- Dapr owns durable `session_workflow` / `agent_workflow` execution and
  parent-to-child routing.
- OpenShell owns isolated workspace sandboxes.
- The `AgentRuntime` CRD (`agents.x-k8s.io/v1alpha1`) materializes only the
  Dapr application hosts we still need.

By default a published agent still gets a dedicated `agent-runtime-<slug>` app
id. When `AGENT_RUNTIME_SHARED_POOLS_ENABLED=true` (or an agent explicitly sets
`runtimeIsolation: "shared"` with `runtimePool.appId`), eligible non-browser
agents route to a runtime-class pool such as `agent-runtime-pool-coding`.
Agent-specific instructions, tools, MCP servers, skills, hooks/plugins,
workspace binding, cwd, and model metadata remain per-session in childInput.

Runtime pods share the `workflow-builder` namespace with the orchestrator so
Dapr workflow sub-orchestration can resolve placement (Dapr workflow does not
support cross-namespace child-workflow routing).

## Lifecycle

```
  Publish or version-bump an agent in the UI
               │
               ▼
  registry-sync.ts → resolveAgentRuntimeRoute(...)
               │
               ├─ dedicated: upsertAgentRuntime(agent slug, bootstrap MCP, sidecars)
               │
               └─ shared:    upsertAgentRuntime(pool slug, no per-agent bootstrap MCP)
               │
               ▼
  AgentRuntime CR in workflow-builder ns
               │
               ▼
  agent-runtime-controller (Kopf)
     · on_create → build Deployment (replicas=minReplicas)
     · on_spec_update → replace Deployment spec
     · on_wake (annotation) → scale to 1, or maxReplicas for shared pools
     · idle_reaper timer → scale to minReplicas after idleTtlSeconds since lastActiveAt

                ▼
  Pod: agent-runtime-<slug-or-pool>-<hash>
     init:  seed-openshell-config
     ctrs:  dapr-agent-py (main) · daprd (sidecar)
            [+ chromium · playwright-mcp if browserSidecar.enabled]
```

## Runtime Classes And Pools

Runtime routing is centralized in
`src/lib/server/agents/runtime-routing.ts`:

- default class for `dapr-agent-py` is `coding`;
- `browser-use-agent` maps to `browser` and stays dedicated;
- `dapr-agent-py-testing` stays dedicated unless the agent explicitly asks for
  shared isolation;
- Playwright MCP sidecar agents stay dedicated because `localhost:3100/mcp`
  must be pod-local;
- non-browser agents can share a pool when the global feature gate is enabled.

Pool app ids can be supplied with `AGENT_RUNTIME_POOL_APP_IDS_JSON`, for
example:

```json
{
  "coding": { "appId": "agent-runtime-pool-coding", "minReplicas": 1, "maxReplicas": 4 },
  "office": "agent-runtime-pool-office"
}
```

If the feature gate is enabled and a class is not listed, the router derives
`agent-runtime-pool-<class>` and uses `AGENT_RUNTIME_POOL_MIN_REPLICAS` /
`AGENT_RUNTIME_POOL_MAX_REPLICAS` for capacity metadata.

On the May 2026 dev Talos spoke, normal coding agents can still use a larger
shared coding pool:

```json
{
  "coding": { "appId": "agent-runtime-pool-coding", "maxReplicas": 9, "slotsPerReplica": 8 }
}
```

That gives the shared coding pool 72 runtime slots for the legacy shared-pool
path. Kueue-backed SWE-bench runs do not use this value as the physical
sandbox concurrency ceiling; their launch capacity is driven by the
full-instance Kueue bundle (`host-worker-composite`), live node request
headroom, selected exact-ready instances, Dapr workflow capacity, and any
explicit model caps.

Capacity-sensitive benchmark runs also read
`AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON`,
`AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR`, and any explicit
`runtimePool.maxActiveSessions` to decide how many agent child workflows can be
active at once. See `docs/swebench-concurrency.md` for the full precedence
chain across UI defaults, BFF admission, Dapr workflow limits, sandbox
headroom, and evaluator parallelism.

## Pod shape

`_build_deployment` in `services/agent-runtime-controller/src/main.py`
produces a pod template with:

| Container | Role |
|---|---|
| `seed-openshell-config` (init) | Writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + `gateways/<name>/metadata.json` + mTLS certs from the `openshell-client-tls` + `openshell-server-client-ca` secrets. Required by every OpenShell-backed tool (`write_file`, `bash_run`, `execute_command`, ...). |
| `dapr-agent-py` | Main container. Runs the SDK's `session_workflow` + `agent_workflow` + any plugins/hooks. Reads `DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON` from the CR spec. Shares an emptyDir at `/root/.config` with the init container. |
| `daprd` | Injected by the `openshell-sandbox-dapr-webhook`. Gets its X.509 SVID from Dapr sentry; requires the `openshell-sandbox-dapr` Configuration in the pod's namespace. |
| `chromium` *(optional)* | Runs TigerVNC + Chromium with CDP on `localhost:9222`. Only when the agent has a Playwright MCP preset. |
| `playwright-mcp` *(optional)* | Listens on `localhost:3100/mcp`, drives `chromium` over CDP. Backed by a per-agent ClusterIP Service `agent-runtime-<slug>-mcp:3100`. |

Secrets (all in `workflow-builder` ns):
- `dapr-agent-py-secrets` — LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), Google Cloud config, DB URL, and `INTERNAL_API_TOKEN` for session-event mirroring.
- `workflow-checkpoint-gitea` — workflow-checkpoint Git credentials.
- `openshell-client-tls` + `openshell-server-client-ca` — mTLS for the OpenShell gateway (mounted into the init container only).

## Dapr Components in `workflow-builder`

Dapr rejects any pod that sees more than one `actorStateStore=true`
Component. The namespace now has one workflow/actor store and keeps the
agent session store non-actor so transient Kueue app ids do not require
Component scope mutation:

| Component | `actorStateStore` | Scopes (allowlist) |
|---|---|---|
| `workflowstatestore` | true | unscoped in namespace |
| `dapr-agent-py-statestore` | false | unscoped in namespace |
| `agent-workflow` | false | legacy slugs only; no active consumer |

**Adding a new agent or pool**: create or update its `AgentRuntime` CR. The
runtime app id should not be added to Dapr Component scopes; unscoped
Components are already visible inside the namespace. This avoids stale
`agent-session-*` / `agent-runtime-*` scope buildup and lets Kueue-admitted
per-execution workflow hosts use the shared workflow store without a custom
scope controller.

Non-actor components (`agent-registry`, `agent-memory`, `runtime-config`,
`pubsub`, `llm-*`, `kubernetes-secrets`) are also unscoped within the
namespace; being in `workflow-builder` ns is the security boundary.

## Admission webhook

The `openshell-sandbox-dapr-webhook` MutatingWebhookConfiguration
(`packages/base/manifests/openshell/`) has two entries:

1. Sandbox CRD mutator (matches the `sandboxes.agents.x-k8s.io`
   resource in `openshell` ns only).
2. **Agent-runtime Deployment mutator** — matches Deployments with
   `agents.x-k8s.io/role=agent-runtime` label, `namespaceSelector`
   matches BOTH `openshell` and `workflow-builder`. Injects the Dapr
   sidecar annotations (`dapr.io/enabled`, `dapr.io/app-id=<deployment-name>`,
   `dapr.io/enable-workflow=true`, `dapr.io/config=openshell-sandbox-dapr`)
   before the pod is created.

The `Configuration/openshell-sandbox-dapr` referenced in the injected
annotation must exist in the pod's own namespace (daprd resolves
Configuration by short name against its own ns). It lives in both
`openshell` and `workflow-builder` via duplicated manifests.

## Dispatch

Both the direct-session path and the workflow-bridge path rewrite
Playwright MCP entries through `rewriteMcpForBrowserSidecar`
(`src/lib/server/agents/mcp-sidecar.ts`) before handing the
`agentConfig` to `dapr-agent-py`, so stdio presets become
`{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`
and resolve to the pod's own playwright-mcp sidecar.

### Direct (UI-initiated) sessions

```
UI /sessions/new            src/lib/server/sessions/spawn.ts
  ↓                            ↓
POST /api/v1/sessions      wakeAgentRuntime(runtimeRoute.slug, 30_000)
  ↓                            ↓
session row (DB)           Dapr invoke:
  ↓                            /v1.0/invoke/<agentAppId-or-pool>/method/internal/sessions/spawn
attachRuntime(...)             ↓
                            dapr-agent-py → session_workflow
```

### Workflow-driven sessions (via SW 1.0 `durable/run`)

```
durable/run in spec
   ↓
orchestrator sw_workflow.py:
   yield call_activity(spawn_session_for_workflow, bridge_payload)
   ↓
spawn_session.py → HTTP POST /api/internal/sessions/ensure-for-workflow
   ↓
BFF handler:
   · rewriteMcpForBrowserSidecar on agentConfig.mcpServers
   · find/create sessions row (deterministic id)
   · findOrCreateEphemeralAgent if agentConfig is inline
   · wakeAgentRuntime(runtimeRoute.slug, 20_000)   ← wait for phase=Active, but don't block response
   · return {sessionId, agentId, agentVersion, childInput, reused}
   ↓
orchestrator:
   yield ctx.call_child_workflow("session_workflow",
                                  input=childInput,
                                  instance_id=<deterministic>,
                                  app_id=<agentAppId or pool app id>)
   ↓
session_workflow on selected runtime app id (autoTerminateAfterEndTurn=true)
   one turn → agent_workflow → status_idle{end_turn} → status_terminated
   ↓
parent resumes, durable/run returns
```

## Scaling + idle TTL

- Dedicated runtimes default to `replicas: 0` at CR creation. Shared pools may
  set `lifecycle.minReplicas` to keep warm capacity.
- **Wake signal**: annotation `agents.x-k8s.io/wake=<unix-timestamp>`
  on the CR. The controller's `on_wake` handler scales dedicated runtimes to
  1 and shared pools to `lifecycle.maxReplicas` (default 1), then stamps
  `lastActiveAt = now`.
- **Idle reaper**: a Kopf timer checks each CR every
  `IDLE_CHECK_INTERVAL` (60 s) and scales back to `minReplicas` if
  `now - lastActiveAt > idleTtlSeconds`. Default 1800 s; overridable
  per agent via environment config's `agentRuntimeIdleTtlSeconds`.
- **`lastActiveAt`** is bumped by the BFF on every dispatch
  (`wakeAgentRuntime` stamps the annotation atomically with the wake
  timestamp).

## Safety nets on the agent side (landed 2026-04-21)

Three defensive layers in `services/dapr-agent-py/` prevent a `durable/run`
child from hanging or blowing through context. Each is env-tunable and idempotent
under Dapr workflow replay.

### Empty-response circuit breaker — `src/main.py::call_llm`

Per-instance counter (`_empty_llm_response_count_by_instance`) increments on:
- Any raised exception from `super().call_llm()` (LLM API error, adapter
  failure, 400 from malformed conversation history, etc.)
- Any successful response where `content.strip()` is empty **and** `tool_calls`
  is empty — the pattern documented in Anthropic SDK
  [#1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204)
  (Claude Opus 4.7 + adaptive thinking + tools emits `stop_reason=end_turn`
  with only a thinking block + empty text + no tool_use).

Resets on any response with real content or tool_calls. Once the streak hits
`DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3), raises a distinctive
`AgentError` that propagates through `agent_workflow`'s inner `for turn` loop
and out to `session_workflow`'s `try/except`, which publishes `session.error` +
`session.status_terminated` and returns.

Note: the counter is process-local. Dapr's activity-level retry (`max_attempts=8`
from the `WorkflowRetryPolicy` at `main.py:2721`) can still re-invoke `call_llm`
up to 8 times per base-class iteration — each retry is subject to the same
3-strike cap, so total amplification is bounded at ~24 calls per stuck
iteration before the agent gives up.

### Session-turn timer — `src/main.py::session_workflow`

Before yielding the child agent_workflow, `session_workflow` creates a Dapr
durable timer and races them via `wf.when_any`:

```python
child_task = ctx.call_child_workflow(self.agent_workflow_name, ...)
timer_task = ctx.create_timer(timedelta(seconds=SESSION_TURN_TIMEOUT_SECONDS))
winner = yield wf_when_any([child_task, timer_task])
if winner is timer_task:
    raise AgentError(f"Session turn {turn_counter} exceeded {...}s timeout")
turn_result = child_task.get_result()
```

If the timer wins (default 600s, env `DAPR_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS`),
the session terminates with a timeout error. Catches stuck states the circuit
breaker doesn't see (MCP hang, `ctx.call_child_workflow` placement stall, tool
loop inside a successful activity).

Trade-off: Dapr workflow timers fire at their own pace after pod replay, but
they are *durable* — once created they persist across pod restarts.

### Image tool_result compaction — `src/anthropic_adapter.py::_compact_image_tool_results`

Before every `generate()` call, `patched_generate` walks the merged message
list, finds user-role `tool_result` blocks that embed `{"type": "image"}`
content, and keeps only the most recent
`DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) intact. Older image blocks
are replaced in place with a short text placeholder
(`"[compacted: N screenshot(s) dropped from context to fit prompt budget]"`)
while preserving the `tool_use_id` link — so Anthropic still sees a
structurally valid assistant↔tool_result pairing, just without the pixel
payload.

Prevents the 1M-token prompt overflow observed when a validator accumulates
>3 Playwright screenshots (each ~100–500KB base64 ≈ 50k tokens). Idempotent
and deterministic — safe to run on every replay tick.

## Troubleshooting cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `openshell/active_gateway: No such file` | Deployment was built before the controller image that adds `seed-openshell-config`. | Re-publish the agent (PUT `/api/agents/:id` with same name) to force `on_spec_update` → Deployment replace. |
| `no X509 SVID available / failed to get configuration openshell-sandbox-dapr` | Configuration missing in the pod's ns. | Ensure `workflow-builder/Configuration-openshell-sandbox-dapr.yaml` is applied. |
| `detected duplicate actor state store` | Pod sees two `actorStateStore=true` Components. | Partition scopes; only one should be visible to each app-id. |
| `Workflow actor … failed: CreateWorkflowInstance … the app may not be available` | Target pod scaled to 0 or in a different namespace from the caller. | Wake + confirm same-ns placement. |
| Tight loop of `Ignoring unexpected taskCompleted event with ID = N` | Downstream symptom of CreateWorkflowInstance failing → orchestrator's execute() can't apply the activity result. | Inspect daprd log on the parent for the real error. |
| Pod logs `[call-llm] circuit-breaker tripped after 3 empty/failed LLM responses` | Anthropic SDK #1204 thinking-only responses, or the conversation history got corrupted (e.g., `tool_use` without matching `tool_result`). | Check logs above the trip for the underlying 4xx; usually benign — circuit-breaker breaks the loop and session.error publishes. |
| Run sits at 75%+ for > 10 min with active LLM calls but no progress | Validator agent over-exploring. | Tighten the validator prompt (fewer tool calls); bump `maxTurns` down; confirm `SESSION_TURN_TIMEOUT_SECONDS` will catch it. |
| Anthropic HTTP 400 `prompt is too long: N > 1000000` | Too many base64-image tool_results in context. | Image compaction should fire automatically; lower `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` or reduce screenshot count in validator prompt. |
| Live-preview URL returns 404 "Retained sandbox not found" | `workflow_workspace_sessions` row missing or `status='cleaned'`. | Confirm `persist_workspace_session` activity ran (orchestrator log) and the workflow spec has `with.keepAfterRun: true` on the `workspace/profile` step. Manual fix: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`. |
| Trigger value like `${ .trigger.animationDescription }` shows up as literal in the agent prompt | SW 1.0 template engine only evaluates the value when the entire string is wrapped in `${...}`. | Re-write the prompt as a single jq concatenation: `"${ .trigger.X + \" — rest of prompt\" }"`. |

## See also

- `services/agent-runtime-controller/src/main.py` — the Kopf operator.
- `services/dapr-agent-py/src/main.py` — `OpenShellDurableAgent` (call_llm circuit breaker, session_workflow timer).
- `services/dapr-agent-py/src/anthropic_adapter.py` — `_compact_image_tool_results`, `patched_generate`.
- `services/workflow-orchestrator/activities/persist_workspace_session.py` — `workflow_workspace_sessions` UPSERT.
- `services/workflow-orchestrator/workflows/sw_workflow.py` — `_handle_call_task` (post-workspace/profile yield), `_should_cleanup_workspaces`.
- `src/lib/server/agents/mcp-sidecar.ts` — `rewriteMcpForBrowserSidecar` helper.
- `src/lib/server/kube/client.ts` — `wakeAgentRuntime`, `sleepAgentRuntime`, CR CRUD.
- `src/lib/server/sessions/spawn.ts` — direct-session dispatch.
- `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts` — workflow-bridge endpoint.
- `services/workflow-orchestrator/activities/spawn_session.py` — bridge activity.
- `src/lib/server/workflows/sandbox-preview.ts` — `getExecutionSandboxPreviewInfo` read path.
