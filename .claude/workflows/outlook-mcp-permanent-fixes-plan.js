export const meta = {
  name: 'outlook-mcp-permanent-fixes-plan',
  description: 'Map integration points for cold-start warm-up, in-place reconnect, and connection cleanup',
  phases: [
    { title: 'Map', detail: '4 parallel readers across BFF, cli-agent-py, UI, data' },
    { title: 'Synthesize', detail: 'actionable implementation plan' },
  ],
}
const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const MAP = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path','role'] } },
    anchors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string' }, what: { type: 'string' } }, required: ['ref','what'] } },
    approach: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['area','files','anchors','approach','risks'],
}
const ctx = `Repo workflow-builder at ${WB}. cli-agent-py source is at ${WB}/services/cli-agent-py. Context: Claude Code CLI (claude-code-cli runtime) connects MCP servers ONCE at startup. Scale-to-zero Activepieces piece MCP servers (Knative \`ap-<piece>-service\`, URL like http://ap-microsoft-outlook-service.workflow-builder.svc.cluster.local/mcp, transport streamable_http, sourceType nimble_piece) can be COLD/scaling-from-zero when the CLI connects → connection fails → CLI surfaces it as 'not authenticated' and offers a dead-end browser 'Authenticate' flow (can't open a browser in a headless pod). Read files, do NOT edit. Exact file:line anchors.`

phase('Map')
const [cliMcp, bffWarm, reconnect, cleanup] = await parallel([
  () => agent(`${ctx}\n\nMAP the CLI HOST (services/cli-agent-py): (1) where the agent's MCP servers are RECEIVED (env var like DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON / a JSON config) and MATERIALIZED into the Claude Code CLI config (\`claude mcp add\` calls, a project .mcp.json, or ~/.claude.json) — the adapter (cli_adapters/claude_code.py?) + the capability_compiler emit_claude_code_cli_servers. (2) WHERE Claude Code is LAUNCHED (the herdr pane spawn / subprocess) — the exact point BEFORE which I should warm + health-check-retry each AP MCP server URL so the CLI connects to a warm server. (3) Is there any existing retry/health-check/warm-up? (4) How to DETECT an AP piece MCP server entry (URL substring 'ap-' + '-service', or sourceType nimble_piece, or server_name 'piece_*'). Report the exact function + insertion point for a 'warm AP MCP servers (GET the URL, retry until 2xx/ready, bounded timeout) before launching the CLI' step.`, { label: 'cli-host', phase: 'Map', schema: MAP }),

  () => agent(`${ctx}\n\nMAP the BFF spawn path for a belt-and-suspenders fire-and-forget warm-up: src/lib/server/sessions/spawn.ts — after resolveAgentConfigMcpForProject, the resolved mcpServers carry the AP server URL. Could the BFF fire a fire-and-forget GET to each AP MCP server (to trigger Knative scale-from-zero) at spawn time? Find the resolved server shape (url/serverUrl, sourceType nimble_piece), where mcpServers is available in spawn.ts, and whether there's an existing in-cluster fetch helper. ALSO: how does the CLI host RECEIVE the MCP config from the BFF (which env var / payload field is set in spawn.ts for the cli-agent-py pod)? Report the warm-up insertion point + the BFF→pod MCP config handoff.`, { label: 'bff-warm', phase: 'Map', schema: MAP }),

  () => agent(`${ctx}\n\nMAP the IN-PLACE RECONNECT: (1) src/routes/api/app-connections/oauth2/complete/+server.ts — does it UPDATE the existing connection row identified by connectionId (overwrite value/token, reset status to ACTIVE) IN PLACE, or only finalize a freshly-created row? Confirm a reconnect that reuses an existing connectionId would refresh the token without changing external_id. (2) src/lib/connections/oauth-popup.ts startOAuthConnect — it POSTs /api/app-connections to CREATE a new row then uses pending.connectionId. Design an \`existingConnectionId\` option: skip the create, set pending.connectionId = existing id. (3) src/routes/workspaces/[slug]/connections/[pieceName]/+page.svelte — the Connections card (lists appConnections). Where to add a per-connection 'Reconnect' button that calls startOAuthConnect({existingConnectionId}). (4) Does oauth2/start need the connectionId? (it only builds the auth URL). Report the exact minimal changes.`, { label: 'reconnect', phase: 'Map', schema: MAP }),

  () => agent(`${ctx}\n\nMAP CONNECTION CLEANUP/DELETE: (1) the DELETE endpoint for an app_connection (src/routes/api/app-connections/[connectionId]/+server.ts ?) — method, what it cascades, guards. (2) ALL places a connection external_id can be REFERENCED so I only delete UNREFERENCED duplicates: mcp_connection.connection_external_id, agents/agent_versions config.mcpServers (mcpConnectionExternalId/connectionExternalId), workflow_connection_ref, workflows nodes. Give the exact tables/columns + a query to find which of a set of outlook connection external_ids are referenced. (3) confirm conn_LTXk7T1-2FLElDvTZYprh is referenced (by mcp_connection) and must be KEPT. Report the safe-delete decision query + the delete mechanism.`, { label: 'cleanup', phase: 'Map', schema: MAP }),
])

phase('Synthesize')
const PLAN = {
  type: 'object', additionalProperties: false,
  properties: {
    coldStart: { type: 'string' },
    reconnect: { type: 'string' },
    cleanup: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    holes: { type: 'array', items: { type: 'string' } },
  },
  required: ['coldStart','reconnect','cleanup','steps','holes'],
}
const plan = await agent(`${ctx}\n\nSynthesize an actionable, file-anchored implementation plan for: (A) cold-start warm-up (primary: in cli-agent-py before CLI launch; optional: BFF spawn fire-and-forget), (B) in-place reconnect (oauth-popup + UI + verify complete updates in place), (C) connection cleanup (safe-delete query + mechanism). Flag holes (esp. whether oauth2/complete truly updates in place, and the cli-host warm-up timing/insertion point).\n\nCLI-HOST:\n${JSON.stringify(cliMcp)}\n\nBFF-WARM:\n${JSON.stringify(bffWarm)}\n\nRECONNECT:\n${JSON.stringify(reconnect)}\n\nCLEANUP:\n${JSON.stringify(cleanup)}`, { label: 'synthesis', phase: 'Synthesize', schema: PLAN })
return { cliMcp, bffWarm, reconnect, cleanup, plan }
