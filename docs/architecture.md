# Workflow Builder Architecture

Workflow Builder is a visual workflow system that uses Dapr Workflows for durable orchestration, OpenShell-backed sandboxes for agent execution, and Postgres-backed review artifacts for patches, file snapshots, browser captures, and child-run metadata.

## Current Runtime Model

The active runtime on `kind-ryzen` and the GitOps-managed cluster is:

- `workflow-builder`: SvelteKit UI and BFF (Dapr app-id: `workflow-builder`, `workflow-builder` namespace)
- `workflow-orchestrator`: Python Dapr durable workflow owner (`workflow-builder` namespace)
- `function-router`: action router (Dapr service invoke target for non-agent slugs)
- `agent-runtime-controller`: Kopf operator in `workflow-builder` namespace; reconciles `AgentRuntime` CRs → one `Deployment/agent-runtime-<slug>` per published agent
- `agent-runtime-<slug>`: dynamic per-agent pods (app-id `agent-runtime-<slug>`), one per published agent, scale 0↔1 on demand via wake/idle TTL. Contain `dapr-agent-py` main container + `seed-openshell-config` init + `daprd` sidecar + optional `chromium` + `playwright-mcp` browser sidecars.
- `dapr-agent-py` (legacy shared pod): kept for backwards compat; new workflows address agents by `agentRef` → `agent-runtime-<slug>` instead.
- `openshell-agent-runtime`: OpenShell control-plane for per-session sandboxes (sandboxes live in `openshell` namespace and are reached via mTLS from agent-runtime pods)
- `fn-activepieces`: default SaaS action backend
- `postgresql`: workflow definitions, executions, artifacts, approvals, child-run metadata, sessions, agents, agent_versions
- `redis` plus Dapr sidecars: workflow state, pub/sub, service invocation, actor durability

Per-agent runtime pods run in the **same namespace as the orchestrator**
(`workflow-builder`) — Dapr workflow sub-orchestration resolves the
child's workflow actor in the parent's namespace, so cross-namespace
placement is not supported at the workflow-SDK layer.

See `docs/per-agent-runtime.md` for the full per-agent model:
controller lifecycle, pod shape, Dapr Component scoping, wake/idle TTL,
dispatch paths (direct session vs workflow bridge), and troubleshooting
cheatsheet.

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
        -> workspace/*   -> workspace-runtime
        -> browser/*     -> openshell-agent-runtime
        -> openshell/*   -> openshell-agent-runtime
        -> code/*        -> code-runtime
        -> dapr-swe/*    -> dapr-swe
        -> _default      -> fn-activepieces

openshell-agent-runtime / dapr-agent-py / dapr-swe
  -> OpenShell sandboxes or dedicated coding workers
  -> PostgreSQL-backed review surfaces
```

Dispatch is owned by `services/workflow-orchestrator/workflows/sw_workflow.py`:
`_AGENT_ACTION_TYPES = {"durable/run"}` gates the native child-workflow branch,
`_REMOVED_AGENT_ACTION_TYPES` rejects legacy slugs (`dapr-agent-py/run`,
`claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph*`,
`dapr-swe/run`, `durable/plan`, `mastra/*`, `agent/*`). Everything else funnels
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
   - `durable/run` → `ctx.call_child_workflow(..., app_id="dapr-agent-py")`
   - everything else → `activities/execute_action.py` → Dapr service invoke → `function-router`
5. The parent workflow persists status and review data as the run progresses.

### Standard durable agent coding run

1. A workflow node uses `durable/run`.
2. `workflow-orchestrator`'s `_run_native_durable_agent_child_workflow` helper builds the child input (prompt, workspaceRef, cwd, agentConfig, maxTurns, metadata) and calls `ctx.call_child_workflow("agent_workflow", input=..., instance_id="{parent}__durable__{task}__run__0", app_id=DAPR_AGENT_PY_APP_ID)`.
3. `dapr-agent-py`'s `@workflow_entry def agent_workflow(self, ctx, message)` receives the input directly — no function-router hop, no HTTP polling.
4. `WorkflowRetryPolicy(max_attempts=8, initial_backoff_seconds=4, ...)` on the callee side absorbs pod restarts, sidecar churn, and transient failures across the orchestrator→agent boundary.
5. `dapr-agent-py` resolves the model component from `agentConfig.modelSpec`, metadata, or top-level `model`.
6. `dapr-agent-py` runs the agent loop, binding to the OpenShell workspace created or resolved earlier in the workflow.
7. Built-in workspace tools run against that OpenShell workspace.
8. MCP tools are added from `agentConfig.mcpServers` or, when the deployed orchestrator image includes the resolver, from enabled project `mcp_connection` rows.
9. Review artifacts are persisted to Postgres.

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
  `openshell/*`, `code/*`, `dapr-swe/*`, `_default` → `fn-activepieces`.
  The registry is ConfigMap-driven (`/config/functions.json`) with a hardcoded
  `BUILTIN_FALLBACK_REGISTRY` override for cross-cutting routes (including the
  `_default` AP fallback) so misconfigured ConfigMaps can't break AP piece
  dispatch.
- **Credential broker**: AES-256-CBC decrypt from `app_connection` via the
  workflow-builder WB API, mapped to env-var names per integration, with
  `credential_access_logs` audit rows. It is the **only** service with access
  to plaintext credentials; workflow-orchestrator never handles them.
- **Knative response normalization**: flattens inconsistent Knative
  `{success, data, error}` shapes across runtimes.

Non-responsibilities (deliberately removed):

- `durable/run` dispatch is owned by workflow-orchestrator via
  `ctx.call_child_workflow(..., app_id="dapr-agent-py")`. No HTTP polling, no
  workflow-status shim, no transient-retry loop in function-router. Retry
  resilience lives on the callee (`WorkflowRetryPolicy` in
  `dapr-agent-py/src/main.py`).
- `dapr-agent-py/*` and `dapr-agent-py-testing/*` slugs are removed from the
  registry. The orchestrator rejects them via `_REMOVED_AGENT_ACTION_TYPES`
  before any dispatch happens.

### dapr-agent-py

Provides:

- native Dapr child workflow execution for `durable/run`
- the agent loop for OpenShell-backed coding runs
- per-run model selection from `agentConfig.modelSpec`, workflow metadata, or top-level `model`
- direct OpenAI Responses API adapter for `openai/gpt-5.4` and `openai/o3`
- runtime MCP client setup from `agentConfig.mcpServers`
- MCP tool dispatch alongside built-in workspace tools

### openshell-agent-runtime

Provides:

- OpenShell-backed workspace profile, clone, command, and cleanup
- browser materialization and validation
- sandbox template mapping, including `dapr-agent-xlsx` for Excel workbook workflows

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
4. Did the OpenShell runtime or LangGraph runtime produce normalized child-run output?
5. Did the run persist durable review artifacts?
6. Is the UI reading those persisted artifacts instead of a fallback?

## Deployment Truth

On `ryzen`, app code and cluster manifests are separate concerns:

- app repos produce images
- `stacks/main` declares the live image tags and manifests ArgoCD should run

Changing only this repo does not change the real cluster until the corresponding `stacks/main` updates are applied.
