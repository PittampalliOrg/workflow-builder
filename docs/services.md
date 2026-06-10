# Services Reference

This document describes the current `workflow-builder` runtime.

## Core Runtime

The current core runtime is:

- `workflow-builder` (SvelteKit UI + BFF; the separate `workflow-builder-svelte` repo is deprecated and not deployed)
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-py` (legacy shared agent runtime; new workflows address per-agent `agent-runtime-<slug>` runtimes via `agentRef`)
- agent runtimes via upstream kubernetes-sigs/agent-sandbox + Kueue (per-session ephemeral Sandbox pods differing only by container image; no `agent-runtime-controller`, resolved through `services/shared/runtime-registry.json`)
- `openshell-agent-runtime`
- `fn-system` (Knative; `system/*`)
- `code-runtime` (`code/*`), `crawl4ai-adapter` (`web/*`)
- `workflow-mcp-server` (port 3200; goal MCP tools + workflow tools)
- `swebench-coordinator`
- `swebench-evaluator`
- `fn-activepieces`
- `postgresql`

Supporting infrastructure:

- Dapr sidecars
- Redis and pub/sub components
- cluster ingress and secrets infrastructure

## workflow-builder

SvelteKit UI and BFF.

- Port: `3000`
- Responsibilities:
  - visual workflow builder
  - workflow save and publish UI
  - run launch and approval UI
  - run review UI for logs, traces, changes, patch, snapshots, and browser artifacts
  - API routes that proxy to orchestrator and internal review surfaces

## workflow-orchestrator

Python FastAPI service and Dapr workflow owner.

- Port: `8080`
- Dapr app-id: `workflow-orchestrator`
- Responsibilities:
  - execute draft workflows via `dynamic_workflow`
  - register and execute published workflow revisions
  - own parent workflow state, timers, and approvals
  - schedule child runs
  - normalize execution state into Postgres
- Important endpoints:
  - `GET /healthz`
  - `GET /readyz`
  - `POST /api/v2/workflows/execute-by-id`
  - `GET /api/v2/workflows/{instanceId}/status`
  - `POST /api/v2/workflows/{instanceId}/events`
  - `POST /api/v2/workflows/{instanceId}/terminate`
  - `POST /api/v2/workflows/{instanceId}/purge` (recursive-by-default; forwards `force` for purge-force, Dapr 1.17.9)
  - `GET /api/v2/runtime/introspect`

  These are the low-level Dapr lifecycle primitives. User-facing stops do **not**
  call them directly — they route through the BFF **Lifecycle Controller**
  (`src/lib/server/lifecycle/`) via `POST /api/v1/sessions/[id]/stop` /
  `POST /api/workflows/executions/[id]/stop`, which sequences terminate → confirm
  terminal → purge with explicit per-session app-id fan-out (the orchestrator's
  `terminate_durable_runs_by_parent_execution` activity was RETIRED). See
  `docs/workflow-lifecycle-termination.md` (the lifecycle SSOT).

`/readyz` is the start-path gate for benchmark instance dispatch. It requires
Dapr outbound health, metadata access, at least one connected Dapr workflow
worker, and taskhub readiness. The runtime watchdog self-deletes the pod when
the workflow worker remains disconnected so Kubernetes restarts both
`workflow-orchestrator` and its `daprd` sidecar.

## swebench-coordinator

Python Dapr Workflow service for official workflow-builder SWE-bench runs.

- Dapr app-id: `swebench-coordinator`
- Responsibilities:
  - validate selected inference environments before agent inference starts;
  - admit instance workflows through benchmark resource leases;
  - write SWE-bench-compatible `dataset.jsonl` and `predictions.jsonl`;
  - launch the official evaluator Job;
  - run post-hoc MLflow evaluation and link native traces when available.

Agent comparison campaigns create one independent `benchmark_runs` row per
agent/configuration over the same instance ids. The coordinator processes each
run independently; the compare UI and MLflow campaign tags group the results
afterward.

## swebench-evaluator

Short-lived Kubernetes Job for the official SWE-bench harness.

- Responsibilities:
  - run the harness over the coordinator-provided dataset and predictions;
  - record official `resolved`, `unresolved`, `empty_patch`, and error status;
  - post results back through the workflow-builder internal benchmark API.

MLflow metrics and scorer output enrich the result, but this evaluator's
harness callback remains the source of truth for SWE-bench resolution.

## function-router

TypeScript sync credential broker + Knative routing proxy.

- Port: `8080`
- Dapr app-id: `function-router`
- Invoked by: workflow-orchestrator via `DaprClient().invoke_method("function-router", "execute", ...)` (see `services/workflow-orchestrator/activities/dapr_invoke.py`). Raw HTTP is no longer used on this path.
- Key endpoint: `POST /execute`
- Responsibilities:
  - **Credential broker**: fetches decrypted connection values by HTTP-GETting the BFF internal decrypt endpoint (`/api/internal/connections/<externalId>/decrypt`, with the Activepieces `/api/v1/dapr/connections/decrypt` endpoint tried first when AP context is present), maps them to env-var names per integration, and writes `credential_access_logs` audit rows. function-router does **not** perform AES-256-CBC decryption itself — the BFF owns the cipher (`src/lib/server/security/encryption.ts`, `createDecipheriv('aes-256-cbc')`). function-router brokers and audits; the BFF holds the key.
  - **Slug-to-service routing**: ConfigMap-driven registry (`/config/functions.json`). The ConfigMap is **authoritative** over the hardcoded `BUILTIN_FALLBACK_REGISTRY`; builtin only fills slugs the ConfigMap omits (merge order corrected 2026-04-20 in `services/function-router/src/core/registry.ts`).
  - **Knative response normalization**: flattens inconsistent `{success, data, error}` shapes.

Current route contract (merged registry — ConfigMap + BUILTIN):

- `workspace/*` → `openshell-agent-runtime` (consolidated 2026-04-19; legacy `workspace-runtime` TS service decommissioned)
- `browser/*` → `openshell-agent-runtime`
- `openshell/*` → `openshell-agent-runtime`
- `code/*` → `code-runtime`
- `web/*` → `crawl4ai-adapter`
- `workflow-orchestrator/*` → `workflow-orchestrator`
- `_default` → `fn-activepieces` (set in both ConfigMap and BUILTIN for defense-in-depth)

Not routed here (by design):

- `durable/run` — dispatched by workflow-orchestrator via `ctx.call_child_workflow(app_id=<agent runtime app id>)`, where the app id is stamped by the BFF resolver and may be a dedicated `agent-runtime-<slug>` runtime or a shared class pool. Retry resilience is handled by `WorkflowRetryPolicy(max_attempts=8)` on the callee side in `dapr-agent-py`.
- `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan` — rejected at the orchestrator via `_REMOVED_AGENT_ACTION_TYPES` with a clear error; never reach function-router. (Older `mastra/*` and `agent/*` families were removed entirely and are no longer in the registry or the rejection set.)

The image can also receive a mounted registry override from the cluster. The merge is `{ ...loadedConfigMap, ...BUILTIN_FALLBACK_REGISTRY }` — BUILTIN keys win, so core cross-cutting routes stay stable. Check the live ConfigMap + `src/core/registry.ts` when runtime routing and expectations disagree.

## dapr-agent-py

Python Dapr agent runtime for `durable/run`, built **on the official GA
`dapr-agents` framework** (`dapr-agents==1.0.3`, boot-guarded via
`assert_dapr_agents_version()`). `OpenShellDurableAgent` subclasses the
framework's `DurableAgent` and reuses `DaprChatClient` / `AgentRunner` /
`MCPClient`. Per-provider LLM adapters monkeypatch `DaprChatClient.generate`
for direct provider HTTP calls (bypassing the alpha Dapr Conversation API).

- Dapr app-id: `dapr-agent-py`
- Responsibilities:
  - run the native durable agent child workflow
  - bind to the OpenShell workspace identified by `workspaceRef`
  - execute the agent loop with built-in workspace tools
  - select the LLM component per run from `agentConfig.modelSpec`, workflow metadata, or top-level `model`
  - call OpenAI through the Responses API for OpenAI model specs
  - connect MCP servers from `agentConfig.mcpServers`
  - dispatch MCP tools and close MCP client sessions at run completion
  - load hooks + plugins from the settings cascade + `DAPR_AGENT_PY_PLUGIN_PATHS` at boot (feature-flagged, off by default)
  - fire PreToolUse / PostToolUse / PostToolUseFailure inside the durable `run_tool` activity and SessionStart / UserPromptSubmit / Stop / SessionEnd in the workflow function
  - accept per-run `agentConfig.hooks` and `agentConfig.plugins` overlays from the trigger message (parallel to `mcpServers` and `skills`)

See `docs/hooks-and-plugins.md` for the full hook/plugin reference —
events fired, matcher syntax, settings cascade, plugin manifest shape,
per-run overlay, and Dapr durability semantics for hook execution.

Model selection:

- Default model selection still comes from `DAPR_LLM_COMPONENT_DEFAULT`.
- `agentConfig.modelSpec` has highest priority for workflow calls.
- `openai/gpt-5.4` and `gpt-5.4` resolve to `llm-openai-gpt5`.
- `llm-openai-gpt5` calls OpenAI Responses API model `gpt-5.4`.
- `openai/o3` and `o3` resolve to `llm-openai-o3`.
- OpenAI auth requires `OPENAI_API_KEY`; `dapr-agent-py` does not use model-provider OAuth for OpenAI calls.
- Anthropic auth requires `ANTHROPIC_API_KEY`; `dapr-agent-py` does not use Claude OAuth for Anthropic calls.
- Gemini model routing is disabled until an API-key-backed Gemini adapter is added.
- `OPENAI_REASONING_EFFORT` controls Responses API reasoning effort for GPT-5 and `o` models. Use `low` for tool-heavy workflows that need frequent short tool calls; use a higher value only when slower, deeper reasoning is worth the latency.

Operational evidence for model routing should come from both execution events
and pod logs:

```text
run_started.model = llm-openai-gpt5
llm_start.model = llm-openai-gpt5
[openai-responses] Calling gpt-5.4 ... auth=openai-api-key
```

## openshell-agent-runtime

Canonical OpenShell runtime for workspace and browser flows.

- Port: `8080`
- Dapr app-id: `openshell-agent-runtime`
- Responsibilities:
  - `workspace/profile`
  - `workspace/clone`
  - `workspace/command`
  - `workspace/cleanup`
  - `browser/*` (including `browser/validate` and `browser/start-preview`)
  - `openshell/*` helper routes

Important behavior:

- uses OpenShell sandboxes as the active sandbox substrate
- owns workspace profile, clone, command, cleanup, and browser materialization
- maps sandbox templates to images for specialized runtimes
- supports retained Claude session handoff
- runs browser validation against materialized workspace state
- stateless w.r.t. `workflow_workspace_sessions` — the orchestrator's
  `persist_workspace_session` activity upserts that row after
  `workspace/profile` completes with `keepAfterRun=true`

The XLSX workflow path depends on the `dapr-agent-xlsx` sandbox template. That
template must resolve to the custom `openshell-sandbox-xlsx` image, not the base
OpenShell sandbox image. The image should already contain spreadsheet tooling
such as `xlsxwriter`, `openpyxl`, and `pandas`; workflows should verify those
packages but should not install them at runtime.

Validated XLSX flow:

1. `workspace/profile` creates an OpenShell workspace using `sandboxTemplate: "dapr-agent-xlsx"`.
2. `durable/run` runs `dapr-agent-py` in that workspace and loads the `xlsx` skill.
3. The child agent writes `/sandbox/validation-output/workbook-output.xlsx` and `/sandbox/validation-output/xlsx-local-result.json`.
4. Deterministic parent steps validate workbook metadata and zip structure.
5. The workbook is uploaded to OneDrive, downloaded back, and verified through Microsoft Excel workbook, worksheet, and range reads.

## workflow-mcp-server

Deployed MCP server (stacks `Deployment-workflow-mcp-server.yaml` + `Service-workflow-mcp-server.yaml`; previously manifest-only).

- Port: `3200`
- Responsibilities:
  - goal MCP tools `create_goal` / `update_goal` / `get_goal` — the goal-loop completion contract, session-scoped via the `X-Wfb-Session-Id` header (see `docs/goal-loop.md`)
  - workflow MCP tools
- `DATABASE_URL` + `INTERNAL_API_TOKEN` via `envFrom workflow-builder-secrets`

## fn-activepieces

Default SaaS action backend.

- Port: `8080`
- Responsibilities:
  - execute plugin-backed SaaS actions
  - satisfy `_default` routing from `function-router`

## PostgreSQL

Primary persistence layer.

- Responsibilities:
  - workflow definitions
  - workflow executions and logs
  - workflow agent runs and events
  - published workflow revisions
  - plan artifacts
  - browser artifacts
  - workspace session metadata

## Shared Runtime Contract

Across OpenShell-backed workflow actions, the stable contract is:

1. create or resolve a workspace profile
2. clone or reconnect the repo
3. run planning or coding work in the chosen agent runtime
4. persist review artifacts
5. expose those artifacts back to the UI

That contract should stay stable even if the reasoning backend changes.
