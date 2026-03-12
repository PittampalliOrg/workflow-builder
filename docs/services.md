# Services Reference

Detailed descriptions of the backend services in the workflow-builder system.

## Runtime Classification

Current `kind-ryzen` core runtime:
- `workflow-orchestrator`
- `durable-agent`
- `function-router`
- `fn-system`
- `mcp-gateway`

Retained in source, but not part of the current core local runtime:
- `fn-activepieces`
- `workflow-mcp-server`
- `piece-mcp-server`
- `node-sandbox`

## workflow-orchestrator (Python)

The generic workflow engine. Interprets workflow definitions from the visual builder,
executing nodes in topological order via Dapr activities. Routes agent actions to
durable-agent. Also runs Activepieces flows via a linked-list step walker.

- **Port**: 8080
- **Dapr app-id**: `workflow-orchestrator`
- **Calls**: function-router (for sync action nodes including mastra/clone, mastra/plan), durable-agent (for async agent/*, durable/*, and mastra/execute actions), fn-activepieces (for AP piece actions)
- **Key endpoints**:
  - `POST /api/v2/workflows` - Start a WB workflow instance (expects pre-serialized nodes)
  - `POST /api/v2/workflows/execute-by-id` - Start workflow by DB ID (fetches + serializes nodes automatically)
  - `POST /api/v2/ap-workflows` - Start an AP flow instance
  - `GET /api/v2/workflows/{id}/status` - Get workflow status
  - `POST /api/v2/workflows/{id}/events` - Raise external event (approvals)
  - `POST /api/v2/workflows/{id}/terminate` - Terminate workflow
- **Routing split** (`workflows/dynamic_workflow.py:304`): `agent/*`, `durable/*`, and `mastra/execute` go through the async `process_agent_child_workflow` handler (fire-and-forget + external event completion). All other `mastra/*` actions (clone, plan) go through `execute_action` → function-router synchronously.
- **Agent routing** (`activities/call_agent_service.py`):
  - `agent/*`, `durable/*` → `call_durable_agent_run()` → durable-agent `/api/run`
  - `mastra/execute` → `call_durable_execute_plan()` → durable-agent `/api/execute-plan`
- **Output persistence** (`activities/persist_results_to_db.py`): At workflow completion (success or error), persists final output to `workflow_executions.output` in PostgreSQL. Belt-and-suspenders with the status polling endpoint.
- **Config** (`core/config.py`): `DURABLE_AGENT_APP_ID=durable-agent`, `FUNCTION_ROUTER_APP_ID=function-router`
- **AP workflow** (`workflows/ap_workflow.py`): Walks AP's linked-list flow format natively with step handlers for PIECE, CODE, ROUTER (condition branching), and LOOP_ON_ITEMS.

## durable-agent (TypeScript/Express)

Primary AI agent service using a Dapr Workflow-backed ReAct loop. Survives pod restarts,
has built-in retries, and uses deterministic replay for durability.

- **Port**: 8001
- **Dapr app-id**: `durable-agent`
- **Framework**: Express + @dapr/dapr ^3.4.0 + AI SDK 6 (@ai-sdk/openai)
- **Key endpoints**:
  - `POST /api/run` - Fire-and-forget agent run (schedules Dapr workflow)
  - `POST /api/plan` - Synchronous planning (generates structured plan)
  - `POST /api/execute-plan` - Fire-and-forget plan execution (schedules Dapr workflow)
  - `GET /api/tools` - List available workspace tools
  - `POST /api/tools/:toolId` - Execute a workspace tool directly
  - `GET /api/health` - Health check with agent status
  - `GET /api/dapr/subscribe` - Dapr subscription discovery
- **Workspace tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `mkdir`, `file_stat`, `execute_command`
- **ReAct loop** (`workflow/agent-workflow.ts`): Dapr workflow generator — LLM call → tool execution → LLM call → ... → final text answer. Accumulates all tool calls across turns in `AgentWorkflowResult.all_tool_calls`.
- **Per-request maxTurns**: Accepts `maxTurns` in request body, passed as `maxIterations` in workflow trigger. Default: 50 (configurable via `MAX_ITERATIONS` env var).
- **Sandbox**: K8s (KubernetesSandbox) with bubblewrap fallback for local dev
- **Completion**: Waits for Dapr workflow completion in background, extracts tool calls + file changes + git diff, publishes completion event via direct service invocation to orchestrator `/api/v2/workflows/{id}/events`
- **Dapr components**: `durable-statestore` (Redis, actorStateStore), `durable-pubsub` (NATS JetStream) — separate from orchestrator's components due to ArgoCD scoping
- **Build**: `docker build -f services/durable-agent/Dockerfile services/durable-agent/` (context is service dir, NOT project root)

## function-router (TypeScript)

Routes function execution to the appropriate service based on a registry.

- **Port**: 8080
- **Dapr app-id**: `function-router`
- **Key endpoint**: `POST /execute`
- **Registry** (`core/registry.ts`): Loaded from ConfigMap file, env var, or hardcoded defaults:
  - `system/*` → `fn-system` (http-request, database-query, condition)
  - `mastra/*` → `durable-agent`
  - `durable/*` → `durable-agent`
  - `_default` → `fn-activepieces` (all other slugs)
- **Routing**: Exact match → wildcard match → builtin fallback → `_default`
- **Credentials**: Pre-fetches from Dapr secret store (Azure Key Vault) or decrypts AP app connections via internal API
- **External events**: `POST /external-event` route for raising Dapr workflow events

## fn-system (TypeScript)

Built-in system actions executed as a Knative service.

- **Port**: 8080
- **Steps**: `http-request`, `database-query`, `condition`
- **Key endpoint**: `POST /execute`

## fn-activepieces (TypeScript)

Executes Activepieces piece actions. Ships with AP piece npm packages pre-installed.

This remains a logical routing target for AP piece actions, but it is not part of the
current core `kind-ryzen` runtime set.

- **Port**: 8080
- **Key endpoints**: `POST /execute`, `POST /options`, `GET /health`
- **Context**: Stubbed AP execution context (no-op store/files, real auth)

## workflow-mcp-server (TypeScript)

MCP server exposing workflow CRUD, node/edge manipulation, execution, and approval tools.
Includes embedded React Flow UI for MCP Apps integration.

This service still has manifests/build hooks in source, but it is not part of the current
core workflow execution path.

- **Port**: 3200
- **MCP endpoint**: `/mcp` (Streamable HTTP)
- **13+ tools**: `list_workflows`, `get_workflow`, `create_workflow`, `update_workflow`, `delete_workflow`, `duplicate_workflow`, `add_node`, `update_node`, `delete_node`, `connect_nodes`, `disconnect_nodes`, `list_available_actions`, `execute_workflow`
- **Execution**: `execute_workflow` calls orchestrator's `POST /api/v2/workflows/execute-by-id`
- **DB**: Raw `pg.Pool` (NOT Drizzle) — direct SQL against `workflows`, `functions`, `piece_metadata` tables
- **Build**: `pnpm run build:all` (UI via vite → dist/ui/, server via esbuild → dist/index.js)

## piece-mcp-server (TypeScript)

MCP server that exposes Activepieces piece actions as MCP tools with interactive UI.
Ships with 42 AP piece npm packages for broader coverage than fn-activepieces.

This service is retained because MCP provisioning code still references it, not because it
is part of the current core runtime.

- **Port**: Dynamic
- **MCP endpoint**: `/mcp`
- **Build**: `pnpm run build:all`

## mcp-gateway (TypeScript)

Public Streamable HTTP MCP endpoint for hosted MCP servers. Authenticates with Bearer tokens
and delegates execution to the workflow-builder Next.js app via internal endpoints.

- **Port**: 8080
- **Key endpoint**: `POST /api/v1/projects/:projectId/mcp-server/http`
- **Auth**: Bearer token validated against per-project MCP server config
- **Internal calls**: Uses `X-Internal-Token` to call workflow-builder `/api/internal/mcp/*` endpoints

## node-sandbox (Node.js)

Simple HTTP runtime sandbox. Drop-in replacement for python-runtime-sandbox.

This is an infrastructure helper image, not a long-running workflow-builder service in the
current local runtime.

- **Port**: 8888
- **Endpoints**: `GET /` (readiness), `GET /health`, `POST /execute` (shell command), `POST /upload` (file upload)
- **Runtime**: Node.js 22-slim, git/curl installed, runs as non-root
