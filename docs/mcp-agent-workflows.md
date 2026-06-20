# MCP Agent Workflows

This document describes the current working path for running `dapr-agent-py` with MCP servers from Workflow Builder.

## Current Method

The validated path is:

1. Configure an OAuth-backed app connection in Settings.
2. Create or enable a matching `mcp_connection` row for the project.
3. Save a SW 1.0 workflow with a `durable/run` action.
4. Set `durable/run.with.agentConfig.mcpConnectionMode` to `project`, or put explicit MCP server configs in `durable/run.with.agentConfig.mcpServers`.
5. Use `x-workflow-builder.input` metadata so the UI renders a prompt textarea instead of requiring raw JSON.

This path works with the Activepieces MCP services deployed in the `workflow-builder` namespace. For example, the Microsoft OneDrive service endpoint is:

```text
http://ap-microsoft-onedrive-service:3100/mcp
```

## Data Model

The relevant tables are:

- `app_connection`: user-owned credentials, encrypted at rest, with a stable `external_id`.
- `mcp_connection`: project-level MCP binding. It records the source type, piece name, MCP server URL, status, and `connection_external_id`.
- `workflow_connection_ref`: workflow-node index of connection usage, used for integrity checks and usage tracking.
- `workflows.spec`: canonical SW 1.0 execution document. This is where explicit `agentConfig.mcpServers` entries live today.

The important binding is `mcp_connection.connection_external_id -> app_connection.external_id`. The piece-runtime (image `piece-mcp-server`, per-piece `ap-<piece>-service`) uses that external id to resolve and refresh credentials through Workflow Builder's internal decrypt endpoint. The same per-piece service is **converged** — it serves deterministic workflow activities at `/execute`, canvas dropdowns at `/options`, and the MCP tools at `/mcp` from one image (see `docs/activepieces-integration-architecture.md` §2.1). For MCP purposes it behaves exactly as before; the `/mcp` endpoint is unchanged.

## Runtime Paths

### Explicit MCP Config

This is the most deterministic smoke-test path. The workflow spec carries the MCP config in the `durable/run` node:

```json
{
  "server_name": "piece_microsoft_onedrive",
  "displayName": "Microsoft OneDrive",
  "sourceType": "nimble_piece",
  "pieceName": "microsoft-onedrive",
  "connectionExternalId": "conn_example",
  "transport": "streamable_http",
  "url": "http://ap-microsoft-onedrive-service:3100/mcp"
}
```

`dapr-agent-py` receives that list in `agentConfig.mcpServers`, connects the MCP client, loads the tools, and makes them available in the agent loop.

### Project-Level Resolver

The preferred project-level path is `agentConfig.mcpConnectionMode: "project"`. The orchestrator resolver for native durable agent calls:

1. reads enabled `mcp_connection` rows for the workflow project,
2. skips `hosted_workflow` entries that need bearer-token transport auth,
3. builds `streamable_http` MCP server configs,
4. appends those configs to `agentConfig.mcpServers`,
5. records warnings in `agentConfig.mcpConnectionWarnings`.

Use the explicit config path for smoke tests when you need to pin a single server. Use project mode for normal workflows that should inherit enabled Settings MCP connections.

## Agent Tools & Integrations UI (shipped 2026-06-10)

The per-agent MCP configuration UI was rebuilt. The old single `agent-mcp-picker.svelte` (with the explicit/project/auto mode `<select>`) is **deleted** and replaced by a component tree under `src/lib/components/agents/tools-integrations/`:

- `AgentToolsIntegrations.svelte` — the "Tools & Integrations" card on the agent detail page (`/workspaces/[slug]/agents/[id]`).
- `AttachedServerCard.svelte` — per-attached-server card.
- `ToolGroupList.svelte` — grouped per-tool `Allow | Disable` toggles within a server.
- `EffectiveToolSurfaceBar.svelte` — shows the effective tool surface (project ceiling ∩ per-agent narrowing).
- `AttachServerSheet.svelte` — attach an enabled workspace MCP server to the agent.
- `SystemServersNote.svelte` — note about auto-wired system servers (e.g. the goal MCP server).

### Per-agent tool curation (no schema change)

Per-agent tool selection is persisted as `agent_versions.config.mcpServers[].allowedTools` — a string array on each attached server entry. There is **no DB schema change**; it rides the existing versioned `config` JSON. Agent config is persisted and versioned through the normal publish-with-changelog flow.

**INVARIANT** for `allowedTools`:

- **absent** ⇒ all tools on that server are enabled (default).
- **`[]`** (empty array) ⇒ all tools on that server are disabled.
- a non-empty array ⇒ exactly those tool names are enabled.

### Two-level model: project ceiling ∩ per-agent narrowing

Tool visibility is the intersection of two levels:

1. **Project ceiling** — `mcp_connection.metadata.toolSelection`, set on the Integrations piece detail page (`/workspaces/[slug]/connections/[pieceName]`). This is the maximum tool set any agent in the project may use for that piece.
2. **Per-agent narrowing** — `config.mcpServers[].allowedTools` on the agent version.

The effective surface = project ceiling ∩ per-agent `allowedTools`. `EffectiveToolSurfaceBar` renders this so the curator sees the net result.

### Attach-list + "Include all workspace MCP servers" toggle

The visible explicit/project/auto mode `<select>` is gone. The UI is now an **attach-list** of servers plus an **"Include all workspace MCP servers"** toggle. `mcpConnectionMode` is derived, not user-typed:

- toggle **off** ⇒ `mcpConnectionMode: "explicit"` (only attached servers).
- toggle **on** ⇒ `mcpConnectionMode: "project"` (inherit all enabled project `mcp_connection` rows).
- the legacy `"auto"` value is still **read** for back-compat by both resolvers, but is no longer authored.

Runtime caveat: Antigravity (`agy-cli`) treats legacy `"auto"` like an explicit-only mode for implicit project fan-in. It still resolves explicitly attached project MCP references, and `"project"` still intentionally inherits every enabled workspace MCP server. This avoids presenting globally available MCP servers as configured AGY servers when an agent did not explicitly attach them.

### `?tools=` allowlist enforced on both resolvers

A `?tools=` URL allowlist (already the intersection of the project ceiling and the per-agent `allowedTools`) is enforced at the piece-mcp-server transport on **both** resolution paths:

- BFF — `src/lib/server/agents/mcp-resolution.ts`
- orchestrator — `services/workflow-orchestrator/activities/resolve_mcp_config.py`

Both compute the same effective tool set and append it to the per-piece `/mcp` URL, so the server only ever exposes the curated tools.

### Browser-safe helpers

Tool-selection math (intersection, the `allowedTools` invariant) lives in `src/lib/connections/piece-tools.ts` so `.svelte` components can import it — `$lib/server/*` modules cannot be imported into client components.

### Per-session override at launch (no mid-session attach)

The persisted+versioned agent config is the baseline. A per-session **ad-hoc override at launch** is available via the session config drawer: posting an `agentConfig` to `POST /api/v1/sessions` (or `/fork`) overrides for that one session **without mutating the agent**. There is **no mid-session attach** — the Perplexity-style `@`-mention to attach a server mid-session is a documented future stretch (`docs/activepieces-integration-architecture.md` §5.6), not shipped.

The `goal` MCP server is auto-wired into every MCP-capable session (opt-out `GOAL_MCP_AUTO_WIRE=false`); it is absent on the workflow-step (`durable/run`) path.

## SW 1.0 Smoke Workflow Shape

Use `workspace/profile` first, then `durable/run` with an explicit `workspaceRef`. The prompt should come from trigger input:

```json
{
  "document": {
    "dsl": "1.0",
    "namespace": "workflow-builder",
    "name": "mcp-dapr-agent-py-smoke",
    "version": "1.0.0",
    "do": [
      {
        "profile": {
          "call": "workspace/profile",
          "with": {
            "workspaceProfile": "default"
          },
          "output": {
            "as": "profile"
          }
        }
      },
      {
        "run_agent": {
          "call": "durable/run",
          "with": {
            "prompt": "${ .trigger.prompt }",
            "maxTurns": 8,
            "workspaceRef": "${ .profile.workspaceRef }",
            "cwd": "/workspace",
            "agentRuntime": "openshell-durable-agent",
            "agentConfig": {
              "mcpConnectionMode": "project",
              "mcpServers": [
                {
                  "server_name": "piece_microsoft_onedrive",
                  "displayName": "Microsoft OneDrive",
                  "sourceType": "nimble_piece",
                  "pieceName": "microsoft-onedrive",
                  "connectionExternalId": "conn_example",
                  "transport": "streamable_http",
                  "url": "http://ap-microsoft-onedrive-service:3100/mcp"
                }
              ]
            }
          },
          "output": {
            "as": "agent"
          }
        }
      }
    ],
    "x-workflow-builder": {
      "input": {
        "mode": "form",
        "fields": {
          "prompt": {
            "type": "textarea",
            "label": "Prompt",
            "defaultValue": "List the available MCP tools and run a small read-only smoke test."
          }
        }
      }
    }
  }
}
```

If the UI still renders the raw `Input (JSON)` field, use a JSON object:

```json
{"prompt":"List the available MCP tools and run a small read-only smoke test."}
```

The string alone is invalid for this field, and a JSON object will only affect the run if the workflow action references `${ .trigger.prompt }`.

## Dapr OAuth2 Middleware

Dapr's OAuth2 middleware is useful for remote MCP servers where the MCP client must obtain and attach an OAuth2 access token at transport time, or where a shared MCP server must validate incoming client tokens.

We are not using that Dapr middleware for current Activepieces piece MCP servers. In the current system:

- OAuth2 credentials are stored in `app_connection`.
- The Settings UI owns the OAuth flow.
- The piece MCP server is configured with a `connection_external_id`.
- The MCP server resolves credentials server-side through Workflow Builder's internal decrypt endpoint.
- `dapr-agent-py` connects to an in-cluster MCP endpoint without holding provider OAuth secrets.

Use Dapr OAuth2 middleware later for remote, multi-tenant, or externally hosted MCP servers that need client-side or server-side token enforcement at the MCP transport boundary.

## Validation Notes

Expected agent logs:

```text
[mcp] Registered 1 MCP server config(s)
[mcp] Connected 1 MCP server(s), loaded 5 tool(s)
```

The Microsoft OneDrive smoke test validated tool discovery plus read-oriented list/download behavior. Upload and custom API call currently show piece MCP argument/schema issues, so treat those as MCP server compatibility work rather than as a `dapr-agent-py` connection failure.
