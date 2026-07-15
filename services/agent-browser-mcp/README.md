# agent-browser-mcp

Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) CLI exposed as a
**streamable-HTTP MCP server**, so the platform's non-CLI agents (`dapr-agent-py`, e.g. a
GLM 5.2 browser agent) can drive a real Chrome browser through their `config.mcpServers`.

## Why a service (not in the agent image)

agent-browser is a Rust CLI that controls Chrome for Testing over CDP and speaks MCP over
**stdio** (`agent-browser mcp`). Our dapr-agent-py agents attach MCP tools over HTTP
(`transport: streamable_http`), and Chrome + its libraries are heavy. Running agent-browser
as its own service keeps Chrome isolated in one image and leaves the agent image untouched —
any agent can gain browser tools just by pointing `mcpServers` at this endpoint.

```
dapr-agent-py agent  --(streamable_http MCP)-->  agent-browser-mcp :8000/mcp
                                                   └─ supergateway (stdio↔HTTP bridge)
                                                        └─ agent-browser mcp  (stdio JSON-RPC)
                                                             └─ Chrome for Testing (CDP, headless)
```

## Endpoint & tools

- MCP endpoint: `http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp`
- Tool profile: `core` (override with `AGENT_BROWSER_TOOLS`, e.g. `core,network`)
- 29 tools in `core`, including `agent_browser_open`, `agent_browser_snapshot` (accessibility
  tree with stable `@eN` refs), `agent_browser_click`, `agent_browser_fill`,
  `agent_browser_screenshot`, `agent_browser_get_text/url/title`, `agent_browser_eval`,
  `agent_browser_close`, tab management.
- `--stateful`: the open page and its `@refs` persist across calls within an MCP session, so
  `open → snapshot → click → screenshot` works as one flow.

## Attaching it to an agent

```jsonc
// agent config.mcpServers
[{ "name": "agent-browser",
   "transport": "streamable_http",
   "url": "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp" }]
```

The agent then calls `agent_browser_open`, `agent_browser_snapshot`, etc. directly.

## Env

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port for the MCP endpoint |
| `AGENT_BROWSER_TOOLS` | `core` | agent-browser MCP tool profile(s) |
| `AGENT_BROWSER_ENCRYPTION_KEY` | _(unset)_ | optional; encrypts saved auth state |

## Related: the agent-browser skill

For **CLI** agents (claude-code/codex/agy) the native integration is the Bash-based
agent-browser *skill* (`agent-browser skills get core`), not this MCP service. This service is
specifically for MCP-consuming (non-CLI) agents.
