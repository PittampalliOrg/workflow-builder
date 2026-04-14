# MCP Agent Workflows

This document describes the current working path for running `dapr-agent-py` with MCP servers from Workflow Builder.

## Current Method

The validated path is:

1. Configure an OAuth-backed app connection in Settings.
2. Create or enable a matching `mcp_connection` row for the project.
3. Save a SW 1.0 workflow with a `durable/run` action.
4. Put the MCP server config in `durable/run.with.agentConfig.mcpServers`.
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

The important binding is `mcp_connection.connection_external_id -> app_connection.external_id`. The piece MCP server uses that external id to resolve and refresh credentials through Workflow Builder's internal decrypt endpoint.

## Runtime Paths

### Explicit MCP Config

This is the currently validated production path. The workflow spec carries the MCP config in the `durable/run` node:

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

The orchestrator code also has a dynamic resolver for native durable agent calls. When present in the deployed image, it:

1. reads enabled `mcp_connection` rows for the workflow project,
2. skips `hosted_workflow` entries that need bearer-token transport auth,
3. builds `streamable_http` MCP server configs,
4. appends those configs to `agentConfig.mcpServers`,
5. records warnings in `agentConfig.mcpConnectionWarnings`.

Use the explicit config path for smoke tests unless you have verified the deployed `workflow-orchestrator` image includes the resolver and shows the resolver logs.

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
