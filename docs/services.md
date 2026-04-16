# Services Reference

This document describes the current `workflow-builder` runtime.

## Core Runtime

The current core runtime is:

- `workflow-builder`
- `workflow-builder-svelte`
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-py`
- `openshell-agent-runtime`
- `dapr-swe`
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
  - `POST /api/v2/workflows/execute-by-id`
  - `GET /api/v2/workflows/{instanceId}/status`
  - `POST /api/v2/workflows/{instanceId}/events`
  - `POST /api/v2/workflows/{instanceId}/terminate`
  - `GET /api/v2/runtime/introspect`

## function-router

TypeScript sync credential broker + Knative routing proxy.

- Port: `8080`
- Dapr app-id: `function-router`
- Invoked by: workflow-orchestrator via `DaprClient().invoke_method("function-router", "execute", ...)` (see `services/workflow-orchestrator/activities/dapr_invoke.py`). Raw HTTP is no longer used on this path.
- Key endpoint: `POST /execute`
- Responsibilities:
  - **Credential broker**: the only service with Dapr secret store + WB decrypt API access. AES-256-CBC decrypts AP connection values, maps to env-var names per integration, writes `credential_access_logs` audit rows.
  - **Slug-to-service routing**: ConfigMap-driven registry (`/config/functions.json`) with hardcoded `BUILTIN_FALLBACK_REGISTRY` override.
  - **Knative response normalization**: flattens inconsistent `{success, data, error}` shapes.

Current route contract (merged registry — ConfigMap + BUILTIN):

- `workspace/*` → `workspace-runtime`
- `browser/*` → `openshell-agent-runtime`
- `openshell/*` → `openshell-agent-runtime`
- `code/*` → `code-runtime`
- `dapr-swe/*` → `dapr-swe`
- `workflow-orchestrator/*` → `workflow-orchestrator`
- `_default` → `fn-activepieces` (set in both ConfigMap and BUILTIN for defense-in-depth)

Not routed here (by design):

- `durable/run` — dispatched by workflow-orchestrator via `ctx.call_child_workflow(app_id="dapr-agent-py")`. Retry resilience is handled by `WorkflowRetryPolicy(max_attempts=8)` on the callee side in `dapr-agent-py`.
- `dapr-agent-py/*`, `dapr-agent-py-testing/*`, `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph*/run`, `dapr-swe/run`, `durable/plan`, `mastra/*`, `agent/*` — rejected at the orchestrator via `_REMOVED_AGENT_ACTION_TYPES` with a clear error; never reach function-router.

The image can also receive a mounted registry override from the cluster. The merge is `{ ...loadedConfigMap, ...BUILTIN_FALLBACK_REGISTRY }` — BUILTIN keys win, so core cross-cutting routes stay stable. Check the live ConfigMap + `src/core/registry.ts` when runtime routing and expectations disagree.

## dapr-agent-py

Native Python Dapr agent runtime for `durable/run`.

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
- OpenAI auth uses connected OpenAI OAuth headers when present, then falls back to `OPENAI_API_KEY`.
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
  - `browser/*`

Important behavior:

- uses OpenShell sandboxes as the active sandbox substrate
- owns workspace profile, clone, command, cleanup, and browser materialization
- maps sandbox templates to images for specialized runtimes
- supports retained Claude session handoff
- runs browser validation against materialized workspace state

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

## dapr-swe

Separate distributed coding runtime.

- Responsibilities:
  - planner/developer/reviewer style issue workflows
  - execution paths under the `dapr-swe/*` action family

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
