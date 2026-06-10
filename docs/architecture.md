# Workflow Builder Architecture

Workflow Builder is a visual workflow system that uses Dapr Workflows for durable orchestration, OpenShell-backed sandboxes for agent execution, and Postgres-backed review artifacts for patches, file snapshots, browser captures, and child-run metadata.

## Current Runtime Model

The active runtime runs on the `ryzen` local Talos spoke for development and on
GitOps-managed Talos spoke clusters for shared environments. `dev` is a
Crossplane-owned Hetzner Talos spoke managed from the hub through stacks,
source-hydrator, GitOps Promoter, and hub ArgoCD. The May 2026 dev rebuild uses
3 control-plane nodes plus 6 benchmark worker nodes labeled
`stacks.io/swebench-pool=dev-benchmark`; workflow-builder's SWE-bench
concurrency gates use Kueue-backed OpenShell and agent-host admission on that
worker pool. Treat one active SWE-bench instance as a full-instance bundle:
validated inference image, OpenShell sandbox/worker resources, agent-host
session resources, Dapr workflow capacity, Kueue quota, live node request
headroom, active leases, and evaluator capacity all contribute to effective
throughput.

The runtime components are:

- `workflow-builder`: SvelteKit UI and BFF (Dapr app-id: `workflow-builder`, `workflow-builder` namespace)
- `workflow-orchestrator`: Python Dapr durable workflow owner (`workflow-builder` namespace)
- `function-router`: action router (Dapr service invoke target for non-agent slugs)
- agent runtimes (`dapr-agent-py` / `claude-agent-py` / `adk-agent-py`): the custom `AgentRuntime` CRD + Kopf `agent-runtime-controller` are RETIRED. Runtimes are now dispatched as per-session ephemeral pods via upstream kubernetes-sigs/agent-sandbox + Kueue (Kueue-admitted, self-reaped on session end), differing ONLY by container image. The runtime registry (`services/shared/runtime-registry.json`) resolves which runtime/image each `durable/run` dispatches. `browser-use-agent` uses a dedicated `SandboxWarmPool` carve-out (chromium boot latency); a legacy static `Deployment-dapr-agent-py` survives only for the `openshell-durable-agent` enum + the `agent-runtime-pool-coding` benchmark pool.
- `dapr-agent-py` (legacy static `Deployment`, replicas:4): survives only for the `openshell-durable-agent` enum + the `agent-runtime-pool-coding` benchmark pool. New `durable/run` steps dispatch a per-session ephemeral agent-sandbox pod (image resolved from the runtime registry), not a per-slug standing Deployment.
- `openshell-agent-runtime`: consolidated action handler for `workspace/* + browser/* + openshell/*` (per 2026-04-19 cutover). Also the OpenShell control-plane for per-session sandboxes — sandboxes live in the `openshell` namespace and are reached via mTLS from agent-runtime pods.
- `fn-activepieces`: default SaaS action backend
- `postgresql`: workflow definitions, executions, artifacts, approvals, child-run metadata, sessions, agents, agent_versions
- `redis` plus Dapr sidecars: workflow state, pub/sub, service invocation, actor durability
- `swebench-coordinator`: Dapr Workflow service that validates SWE-bench
  inference environments, admits instance child workflows through resource
  leases, writes dataset/prediction artifacts, and launches official evaluator
  Jobs.
- `swebench-evaluator`: short-lived Kubernetes Job that dispatches per-instance
  Tekton TaskRuns for official harness grading and posts results back to the
  workflow-builder internal benchmark API.

Per-agent runtime pods run in the **same namespace as the orchestrator**
(`workflow-builder`) — Dapr workflow sub-orchestration resolves the
child's workflow actor in the parent's namespace, so cross-namespace
placement is not supported at the workflow-SDK layer.

See `docs/agent-runtime-comparison.md` and `docs/durable-session-runtime-contract.md`
for the agent runtime model: per-session ephemeral agent-sandbox pods (image-only
diff, Kueue-admitted, self-reaped), pod shape, Dapr Component scoping, and dispatch
paths (direct session vs workflow bridge). The custom `AgentRuntime` CRD + Kopf
`agent-runtime-controller` (and its wake/idle TTL) are RETIRED. For stop/terminate/
purge of workflows + durable agent runs, see `docs/workflow-lifecycle-termination.md`
(the lifecycle SSOT).

See `docs/swebench-concurrency.md` for the SWE-bench capacity model. The
headline rule is that requested concurrency is only an input; actual throughput
is the minimum of selected exact-ready instances, full-instance Kueue headroom,
Dapr/runtime slots, live schedulability, optional model caps, and evaluator
parallelism. Legacy shared-runtime and Dapr sidecar slot caps still matter for
non-Kueue rollback paths.

See `docs/swebench-mlflow-comparison.md` for the SWE-bench comparison and
MLflow tracking model. The supported comparison shape is one benchmark parent
run per agent/configuration over the same instance set, grouped by a campaign
tag and projected into one MLflow experiment with parent, instance-child, and
eval-child runs.

SWE-bench instance starts are gated on `workflow-orchestrator` `GET /readyz`.
That endpoint verifies Dapr outbound health, Dapr metadata, connected Dapr
workflow workers, and taskhub access. If `workflowConnectedWorkers` is zero, the
BFF returns `workflow_runtime_unavailable` and the coordinator requeues the
instance instead of creating a stuck execution row. MLflow tracking is
best-effort background work on this path; MLflow timeouts must not block Dapr
workflow dispatch.

Model selection for `durable/run` is data-driven. `dapr-agent-py` reads
`agentConfig.modelSpec` from the workflow call, maps that value to a Dapr LLM
component, and patches the underlying Dapr chat client when a provider needs a
direct SDK/API adapter. The default live model can remain Anthropic while a
single workflow or execution opts into OpenAI by setting:

```json
{
  "agentConfig": {
    "runtime": "dapr-agent-py",
    "modelSpec": "openai/gpt-5.4"
  }
}
```

For OpenAI GPT-5.4, the mapping is:

```text
openai/gpt-5.4 -> llm-openai-gpt5 -> OpenAI Responses API model gpt-5.4
```

`dapr-agent-py` uses `OPENAI_API_KEY` for OpenAI model calls. Reasoning effort
is controlled by `OPENAI_REASONING_EFFORT`; tool-heavy workbook runs have been
validated with `low`.

## Design Principles

### One durable parent workflow

`workflow-orchestrator` is the orchestration owner for long-running workflows. It owns:

- parent workflow state
- approval gates and timeouts
- child-run scheduling
- final execution phase and status

Agent runtimes do not own orchestration. They execute child work and return normalized results to the parent workflow.

The orchestrator also owns a runtime watchdog for the parent Dapr worker. It
polls Dapr metadata for `workflowConnectedWorkers`; if no workflow worker stays
connected past the restart threshold, the pod deletes itself through the
Kubernetes API so both the Python app container and the `daprd` sidecar are
replaced. This is deliberate: process exit alone can leave a stale sidecar in
the same pod.

### Data-driven definitions

Workflow Builder stores workflows as data:

- `nodes` and `edges` for the editor
- canonical `spec` for execution and publishing

The system still uses a generic dynamic workflow interpreter for draft workflows. That lets the UI create and save new workflows without rebuilding the orchestrator.

### Published workflows are frozen revisions

Published workflows are not just “saved” workflows.

Publishing:

- freezes the current workflow definition into `spec.metadata.publishedRuntime.revisions[*].definition`
- assigns a stable workflow name such as `wf_<workflowId>`
- assigns an immutable version such as `pub_<...>`
- makes the workflow eligible for versioned registration at orchestrator startup

At startup, `workflow-orchestrator` loads published revisions from Postgres and registers them with Dapr via `register_versioned_workflow`.

That gives the system two execution modes:

- draft: run through `dynamic_workflow`
- published: run through the registered workflow name and revision version

### One sandbox substrate

All active sandbox-backed agent work now runs on OpenShell.

Supported agent actions:

- `durable/run`

Supported workspace/browser actions:

- `workspace/profile`
- `workspace/clone`
- `workspace/command`
- `workspace/cleanup`
- `browser/*`

Those all route to OpenShell-backed runtimes.

Specialized work uses OpenShell sandbox templates rather than package
installation at runtime. The `dapr-agent-xlsx` template resolves to the
`openshell-sandbox-xlsx` image and is expected to include spreadsheet
dependencies such as `xlsxwriter`, `openpyxl`, and `pandas` in the image. Agent
prompts for XLSX workflows should verify package availability, but should not
run `pip`, `apt`, `npm`, or other package managers during the workflow.

### Durable review artifacts

For successful coding runs, the review surface is persisted independently of the live sandbox:

- workflow execution rows
- workflow execution logs
- workflow agent runs
- workflow agent events
- plan artifacts
- file-change summaries
- patches
- file snapshots
- browser artifacts

The UI should prefer persisted artifacts over live workspace state.

## High-Level Architecture

```text
browser
  -> workflow-builder (SvelteKit BFF)
  -> workflow-orchestrator (Dapr workflow interpreter)
     -> durable/run  => ctx.call_child_workflow -> dapr-agent-py  (native; no function-router hop)
     -> everything else => Dapr service invoke -> function-router
        -> system/*      -> fn-system
        -> workspace/*   -> openshell-agent-runtime
        -> browser/*     -> openshell-agent-runtime
        -> openshell/*   -> openshell-agent-runtime
        -> code/*        -> code-runtime
        -> web/*         -> crawl4ai-adapter
        -> _default      -> fn-activepieces

openshell-agent-runtime / dapr-agent-py
  -> OpenShell sandboxes or dedicated coding workers
  -> PostgreSQL-backed review surfaces
```

Dispatch is owned by `services/workflow-orchestrator/workflows/sw_workflow.py`:
`_AGENT_ACTION_TYPES = {"durable/run"}` gates the native child-workflow branch,
`_REMOVED_AGENT_ACTION_TYPES` rejects legacy slugs (`claude/run`,
`openshell/run`, `openshell/session-start`, `openshell-langgraph/run`,
`openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`,
`durable/plan`). Everything else funnels
through `activities/execute_action.py` which calls function-router via
`activities/dapr_invoke.py` (`DaprClient().invoke_method`).

## Core Request Paths

### Visual workflow execution

1. The browser starts a run through `workflow-builder`.
2. The BFF calls `workflow-orchestrator`.
3. `workflow-orchestrator` resolves the execution target:
   - draft -> `dynamic_workflow`
   - published -> registered workflow name/version
4. Action nodes dispatch by slug:
   - `durable/run` → resolver stamps `agentAppId`; orchestrator calls `ctx.call_child_workflow(..., app_id=<agent runtime app id>)`
   - everything else → `activities/execute_action.py` → Dapr service invoke → `function-router`
5. The parent workflow persists status and review data as the run progresses.

### Standard durable agent coding run

1. A workflow node uses `durable/run`.
2. The BFF resolver inlines the published agent config and stamps `agentAppId`. With pooling enabled this can be a shared pool such as `agent-runtime-pool-coding`; otherwise it is usually `agent-runtime-<slug>`.
3. `workflow-orchestrator`'s `_run_native_durable_agent_child_workflow` helper builds the child input (prompt, workspaceRef, cwd, agentConfig, instructionBundle, maxTurns, metadata) and calls `ctx.call_child_workflow("session_workflow", input=..., instance_id="{parent}__durable__{task}__run__0", app_id=<agentAppId>)`.
4. `dapr-agent-py` receives the per-session child input directly — no function-router hop, no HTTP polling.
5. `WorkflowRetryPolicy(max_attempts=8, initial_backoff_seconds=4, ...)` on the callee side absorbs pod restarts, sidecar churn, and transient failures across the orchestrator→agent boundary.
6. `dapr-agent-py` resolves the model component from `agentConfig.modelSpec`, metadata, or top-level `model`.
7. `dapr-agent-py` runs the agent loop, binding to the OpenShell workspace created or resolved earlier in the workflow.
8. Built-in workspace tools run against that OpenShell workspace.
9. MCP tools are added from per-session `agentConfig.mcpServers` or, when the deployed orchestrator image includes the resolver, from enabled project `mcp_connection` rows.
10. Review artifacts are persisted to Postgres.

See `docs/mcp-agent-workflows.md` for the current UI-runnable MCP configuration method.

### Legacy workflow compatibility

1. Older saved workflows may still contain deprecated agent action types.
2. `workflow-orchestrator` rejects deprecated embedded-agent actions at runtime.
3. New workflow definitions must use `durable/run`.

### Browser validation

1. Browser validation runs through `browser/*`.
2. Orchestrator Dapr-invokes `function-router`, which routes to `openshell-agent-runtime`.
3. The runtime materializes the persisted execute result into a browser workspace.
4. The preview server and browser capture run against that materialized state.
5. The resulting artifact is stored durably and exposed back to the UI.

## Component Responsibilities

### workflow-builder

Provides:

- Svelte Flow editor (@xyflow/svelte)
- workflow save and publish UX
- run launch, approval, and review UI
- SCM-aware execute prompts with bounded repository selectors and generated unique names for new repositories
- BFF routes for orchestrator and execution data

### workflow-orchestrator

Provides:

- the generic Dapr workflow interpreter
- published workflow registration
- parent timeout and approval ownership
- child-run scheduling
- normalized execution state in Postgres

Key areas:

- `services/workflow-orchestrator/workflows/dynamic_workflow.py`
- `services/workflow-orchestrator/app.py`
- `services/workflow-orchestrator/activities/call_agent_service.py`
- `services/workflow-orchestrator/activities/track_agent_run.py`

### function-router

A narrow sync service — credential broker + Knative response normalizer + slug-
to-service dispatcher. Invoked by workflow-orchestrator via Dapr service invoke
(`activities/dapr_invoke.py` → `DaprClient().invoke_method("function-router",
"execute", ...)`), not raw HTTP.

Provides:

- **Slug routing** by `actionType` prefix: `system/*`, `workspace/*`, `browser/*`,
  `openshell/*`, `code/*`, `web/*`, `_default` → `fn-activepieces`.
  `workspace/*`, `browser/*`, and `openshell/*` all resolve to `openshell-agent-runtime`
  after the 2026-04-19 consolidation (legacy `workspace-runtime` TS service
  decommissioned). The registry is ConfigMap-driven (`/config/functions.json`),
  **authoritative over** the hardcoded `BUILTIN_FALLBACK_REGISTRY` which only
  fills in slugs the ConfigMap omits (merge order corrected 2026-04-20 in
  `services/function-router/src/core/registry.ts`).
- **Credential broker**: AES-256-CBC decrypt from `app_connection` via the
  workflow-builder WB API, mapped to env-var names per integration, with
  `credential_access_logs` audit rows. It is the **only** service with access
  to plaintext credentials; workflow-orchestrator never handles them.
- **Knative response normalization**: flattens inconsistent Knative
  `{success, data, error}` shapes across runtimes.

Non-responsibilities (deliberately removed):

- `durable/run` dispatch is owned by workflow-orchestrator via
  `ctx.call_child_workflow(..., app_id=<agent runtime app id>)`. No HTTP
  polling, no workflow-status shim, no transient-retry loop in function-router.
  Retry resilience lives on the callee (`WorkflowRetryPolicy` in
  `dapr-agent-py/src/main.py`). The app id may be a dedicated
  `agent-runtime-<slug>` runtime or a shared runtime-class pool.
- `dapr-agent-py/*` and `dapr-agent-py-testing/*` slugs are removed from the
  registry. The orchestrator rejects them via `_REMOVED_AGENT_ACTION_TYPES`
  before any dispatch happens.

### dapr-agent-py

Built **on the official GA `dapr-agents` framework** (pinned `dapr-agents==1.0.3`
in `services/dapr-agent-py/pyproject.toml`, hard-guarded at boot by
`assert_dapr_agents_version()` in `src/dependency_guard.py`, called from
`src/main.py:192`). `class OpenShellDurableAgent(DurableAgent)`
(`src/main.py:1668`) subclasses the framework's `DurableAgent` and reuses
`DaprChatClient`, `AgentRunner`, `MCPClient`, and `WorkflowContextInjectedTool`
— it is not a from-scratch agent. The per-provider LLM adapters monkeypatch
`DaprChatClient.generate` to make **direct provider HTTP calls**, deliberately
bypassing the still-alpha Dapr Conversation API.

Provides:

- native Dapr child workflow execution for `durable/run`
- the agent loop for OpenShell-backed coding runs
- per-run model selection from `agentConfig.modelSpec`, workflow metadata, or top-level `model`
- direct OpenAI Responses API adapter for `openai/gpt-5.4` and `openai/o3`
- runtime MCP client setup from `agentConfig.mcpServers`
- MCP tool dispatch alongside built-in workspace tools
- the only retry policy on the durable path:
  `WorkflowRetryPolicy(max_attempts=8, initial_backoff_seconds=4,
  max_backoff_seconds=45, backoff_multiplier=1.5)` wrapping the agent's
  `call_llm` (`src/main.py:5897`). This lives on the **callee** side. The
  orchestrator's own internal activities have **no** `retry_policy`.

### openshell-agent-runtime

Single consolidated backend for `workspace/*`, `browser/*`, and `openshell/*`
action slugs (post 2026-04-19 function-router cutover; legacy `workspace-runtime`
TS service decommissioned).

Provides:

- OpenShell-backed workspace profile, clone, command, and cleanup
- browser materialization, validation, and live-preview proxy endpoints
- sandbox template mapping, including `dapr-agent-xlsx` for Excel workbook workflows

Because this service is stateless w.r.t. the `workflow_workspace_sessions`
table, the orchestrator yields a `persist_workspace_session` activity after
every `workspace/profile` action completes with `keepAfterRun=true` — that
activity UPSERTs the row so the BFF proxy at
`src/routes/api/workflows/executions/[executionId]/sandbox-preview/[previewId]/`
can resolve the retained sandbox.

It is a runtime backend, not the orchestration owner.

## Persisted Data Model

### PostgreSQL stores

- workflow definitions
- workflow executions
- workflow execution logs
- approval events
- workflow agent runs and events
- plan artifacts
- workspace sessions
- browser artifacts
- published workflow metadata and revision snapshots

### Dapr stores

Dapr durability is used for:

- workflow state and replay
- timers and external events
- child workflow delivery
- service invocation and pub/sub plumbing

Dapr state is not the review surface. The review surface is the persisted execution artifact set in Postgres.

## Operator Mental Model

When debugging the system, check in this order:

1. Is the parent workflow healthy in `workflow-orchestrator`?
2. Did `workflow-orchestrator` resolve the workflow as draft or published?
3. Did `function-router` route the action to the intended backend?
4. Did the OpenShell runtime (or the `durable/run` agent child workflow) produce normalized child-run output?
5. Did the run persist durable review artifacts?
6. Is the UI reading those persisted artifacts instead of a fallback?

## Deployment Truth

On `ryzen`, app code and cluster manifests are separate concerns:

- app repos produce images
- `stacks/main` declares the live image tags and manifests ArgoCD should run

Changing only this repo does not change the real cluster until the corresponding `stacks/main` updates are applied.
