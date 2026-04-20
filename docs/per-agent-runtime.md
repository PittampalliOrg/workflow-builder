# Per-Agent Runtime Model

Every published agent gets its own Kubernetes Pod. The `AgentRuntime`
CRD (`agents.x-k8s.io/v1alpha1`) is the source of truth; the
`agent-runtime-controller` Kopf operator reconciles one `Deployment`
per CR. Pods scale 0 ↔ 1 on demand and share the `workflow-builder`
namespace with the orchestrator so Dapr workflow sub-orchestration can
resolve placement (Dapr workflow does not support cross-namespace
child-workflow routing).

## Lifecycle

```
  Publish or version-bump an agent in the UI
               │
               ▼
  registry-sync.ts → upsertAgentRuntime(slug, config, ...)
               │
               ▼
  AgentRuntime CR in workflow-builder ns
               │
               ▼
  agent-runtime-controller (Kopf)
     · on_create → build Deployment (replicas=0)
     · on_spec_update → replace Deployment spec
     · on_wake (annotation) → scale to 1
     · idle_reaper timer → scale to 0 after idleTtlSeconds since lastActiveAt

                ▼
  Pod: agent-runtime-<slug>-<hash>
     init:  seed-openshell-config
     ctrs:  dapr-agent-py (main) · daprd (sidecar)
            [+ chromium · playwright-mcp if browserSidecar.enabled]
```

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

## Dapr Component scoping in `workflow-builder`

Dapr rejects any pod that sees more than one `actorStateStore=true`
Component. With three actor-capable stores in the namespace, scopes
partition access so each pod sees exactly one:

| Component | `actorStateStore` | Scopes (allowlist) |
|---|---|---|
| `workflowstatestore` | true | `workflow-orchestrator`, `workspace-runtime` |
| `dapr-agent-py-statestore` | true | `dapr-agent-py`, `dapr-agent-py-testing`, `workflow-builder`, every enumerated `agent-runtime-<slug>` |
| `agent-workflow` | true | legacy slugs only; no active consumer |

**Adding a new agent**: append the slug to the `scopes:` list in
`packages/components/active-development/manifests/dapr-agent-py/Component-dapr-agent-py-statestore.yaml`.
Follow-up work: have the controller patch this automatically on CR
create so the enumeration stays in sync.

Non-actor components (`agent-registry`, `agent-memory`,
`runtime-config`, `pubsub`, `llm-*`, `kubernetes-secrets`) are
un-scoped within the namespace — being in `workflow-builder` ns is
already the security boundary.

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
POST /api/v1/sessions      wakeAgentRuntime(slug, 30_000)
  ↓                            ↓
session row (DB)           Dapr invoke:
  ↓                            /v1.0/invoke/agent-runtime-<slug>/method/internal/sessions/spawn
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
   · wakeAgentRuntime(slug, 20_000)   ← wait for phase=Active, but don't block response
   · return {sessionId, agentId, agentVersion, childInput, reused}
   ↓
orchestrator:
   yield ctx.call_child_workflow("session_workflow",
                                  input=childInput,
                                  instance_id=<deterministic>,
                                  app_id="agent-runtime-<slug>")
   ↓
session_workflow on per-agent pod (autoTerminateAfterEndTurn=true)
   one turn → agent_workflow → status_idle{end_turn} → status_terminated
   ↓
parent resumes, durable/run returns
```

## Scaling + idle TTL

- `replicas: 0` at CR creation. Controller never scales proactively —
  pods only wake on demand.
- **Wake signal**: annotation `agents.x-k8s.io/wake=<unix-timestamp>`
  on the CR. The controller's `on_wake` handler scales the Deployment
  to 1 and stamps `lastActiveAt = now`.
- **Idle reaper**: a Kopf timer checks each CR every
  `IDLE_CHECK_INTERVAL` (60 s) and scales back to 0 if
  `now - lastActiveAt > idleTtlSeconds`. Default 1800 s; overridable
  per agent via environment config's `agentRuntimeIdleTtlSeconds`.
- **`lastActiveAt`** is bumped by the BFF on every dispatch
  (`wakeAgentRuntime` stamps the annotation atomically with the wake
  timestamp).

## Troubleshooting cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `openshell/active_gateway: No such file` | Deployment was built before the controller image that adds `seed-openshell-config`. | Re-publish the agent (PUT `/api/agents/:id` with same name) to force `on_spec_update` → Deployment replace. |
| `no X509 SVID available / failed to get configuration openshell-sandbox-dapr` | Configuration missing in the pod's ns. | Ensure `workflow-builder/Configuration-openshell-sandbox-dapr.yaml` is applied. |
| `detected duplicate actor state store` | Pod sees two `actorStateStore=true` Components. | Partition scopes; only one should be visible to each app-id. |
| `Workflow actor … failed: CreateWorkflowInstance … the app may not be available` | Target pod scaled to 0 or in a different namespace from the caller. | Wake + confirm same-ns placement. |
| Tight loop of `Ignoring unexpected taskCompleted event with ID = N` | Downstream symptom of CreateWorkflowInstance failing → orchestrator's execute() can't apply the activity result. | Inspect daprd log on the parent for the real error. |

## See also

- `services/agent-runtime-controller/src/main.py` — the Kopf operator.
- `src/lib/server/agents/mcp-sidecar.ts` — `rewriteMcpForBrowserSidecar` helper.
- `src/lib/server/kube/client.ts` — `wakeAgentRuntime`, `sleepAgentRuntime`, CR CRUD.
- `src/lib/server/sessions/spawn.ts` — direct-session dispatch.
- `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts` — workflow-bridge endpoint.
- `services/workflow-orchestrator/workflows/sw_workflow.py` — parent orchestrator `durable/run` handling.
- `services/workflow-orchestrator/activities/spawn_session.py` — bridge activity.
