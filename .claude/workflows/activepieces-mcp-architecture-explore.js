export const meta = {
  name: 'activepieces-mcp-architecture-explore',
  description: 'Fan-out exploration: AP integration in workflow-builder, stacks infra, upstream AP repo, Dapr MCP patterns, CNCF ecosystem',
  phases: [
    { title: 'Explore', detail: '5 parallel read-only explorers (3 repos + 2 web research)' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['summary', 'key_files', 'facts', 'gaps'],
  properties: {
    summary: { type: 'string', description: '2-4 paragraph synthesis of what was found' },
    key_files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: {
          path: { type: 'string' },
          why: { type: 'string', description: 'one line: why this file matters for the AP-as-Dapr-activities + AP-as-MCP design' },
        },
      },
    },
    facts: { type: 'array', items: { type: 'string' }, description: 'Concrete, verifiable facts (with file:line or URL where possible)' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'Missing pieces, dead code, drift, or unintegrated parts discovered' },
    design_hints: { type: 'array', items: { type: 'string' }, description: 'Hints/constraints this area imposes on the target architecture' },
  },
}

phase('Explore')

const SHARED_CONTEXT = `
CONTEXT: We are designing the best architecture for two goals in the workflow-builder system:
(1) Activepieces (AP) piece ACTIONS usable as deterministic Dapr workflow ACTIVITIES (called from the workflow-orchestrator SW 1.0 interpreter, durable/retryable, no LLM in the loop).
(2) AP pieces exposed as MCP SERVERS so durable AI agents (dapr-agent-py, claude-agent-py via Claude Agent SDK) and external MCP clients can use piece actions as tools.
Cross-cutting concerns: seamless fit into the existing Dapr-on-Kubernetes architecture, great UI/UX in the SvelteKit canvas + agent config, and MAINTAINABILITY as AP pieces update upstream outside our control (piece versioning, metadata sync, npm packages).
You are READ-ONLY. Return raw structured findings (your final output is consumed by an orchestrator, not a human). Cite file paths with line numbers where it matters.`

const results = await parallel([
  () => agent(`${SHARED_CONTEXT}

TASK: Explore the workflow-builder repo at /home/vpittamp/repos/PittampalliOrg/workflow-builder/main and map EVERYTHING related to the Activepieces integration and MCP piece exposure. Be very thorough:

1. services/fn-activepieces/ — how are AP pieces actually executed? Direct npm imports of @activepieces/piece-* packages? An embedded AP engine? How are actions invoked, how is auth/credentials injected, what's the request/response contract from function-router? How many pieces, how are they registered/installed (look for installed-pieces.ts, piece-registry.ts)?
2. services/piece-mcp-server/ — how does it expose a piece as an MCP server? Transport (stdio/streamable-http)? How is it deployed "on-demand" / dynamic port? How does it resolve credentials (mcp_connection.connection_external_id + app_connection)? What is its lifecycle?
3. services/mcp-gateway/ — what does it gate? How do external MCP clients reach pieces?
4. services/function-router/ — routing of AP slugs (default route), credential-broker flow (HTTP-GET BFF /api/internal/connections/<id>/decrypt), function-registry ConfigMap vs built-in fallback.
5. workflow-orchestrator side: how does the SW 1.0 interpreter dispatch a piece action (activities/dapr_invoke.py)? Retry/idempotency semantics for AP actions today.
6. BFF/UI side: src/lib/server/app-connections (OAuth2 PKCE, encryption), src/routes/api/pieces, piece_metadata table + how metadata gets seeded/synced, mcp_connection/mcp_server/mcp_run tables, how piece actions appear in the canvas action picker (side-panel, node config), how agents get mcpServers config (agentConfig.mcpServers UI), docs/activepieces-auth.md + docs/mcp-agent-workflows.md.
7. How piece UPDATES are handled today: is there any sync job pulling new piece versions/metadata? Pinned npm versions? What breaks when AP publishes new piece versions?

Also note anything that's dead code or half-integrated (e.g. fn-activepieces marked inactive in skaffold).`,
    { label: 'explore:workflow-builder-ap', phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SHARED_CONTEXT}

TASK: Explore the stacks GitOps repo at /home/vpittamp/repos/PittampalliOrg/stacks/main and map the Kubernetes infrastructure relevant to Activepieces + MCP in the workflow-builder system. Be thorough:

1. Find workloads/manifests for: fn-activepieces, piece-mcp-server (or per-piece MCP services), mcp-gateway, workflow-mcp-server, function-router, workflow-orchestrator. Note which are actually deployed vs deleted/omitted (we believe workflow-builder-system intentionally DELETES the fn-activepieces Application — confirm and find where).
2. The function-registry ConfigMap (slug → service routing) — where defined, what entries exist for AP slugs.
3. How "on-demand" piece MCP services are provisioned — is there an operator/controller/Job? Any dynamic Service/Deployment creation? Where does mcp-gateway route?
4. Dapr Components in workflow-builder namespace (state stores, pubsub), the openshell-sandbox-dapr webhook, anything that would affect hosting many small MCP server pods.
5. Secrets/ESO for AP credentials (AP_ENCRYPTION_KEY, INTERNAL_API_TOKEN), ingress for mcp-gateway (external MCP clients), Tailscale exposure if any.
6. Scaling/footprint patterns we already use that could host per-piece MCP servers: Knative (fn-system scale-to-zero), KEDA (deployed?), Kueue, agent-sandbox (kubernetes-sigs), SandboxWarmPool. Inventory what's installed cluster-wide (argocd apps, packages/) that could be reused.
7. Any existing per-spoke differences (hub/dev/ryzen) for these services.`,
    { label: 'explore:stacks-infra', phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SHARED_CONTEXT}

TASK: Explore the UPSTREAM Activepieces repo checked out at /home/vpittamp/repos/PittampalliOrg/activepieces/main. We want to understand how the AP project itself works, so we can integrate with it in a way that survives upstream updates. Be thorough:

1. Piece framework: packages/pieces/community/framework (createPiece/createAction/createTrigger, PieceAuth, Property types, ActionContext). What is the exact runtime contract of an action's run(ctx)? What does ctx contain (auth, propsValue, store, files, connections, server)?
2. Engine: packages/engine — how does the official AP engine execute pieces? Isolation model (workers, sandboxes, isolated-vm?), how pieces are loaded (npm install at runtime? file-based dev pieces?), input resolution, connection/auth injection.
3. AP's OWN MCP implementation: search for "mcp" across the repo (server-api modules, packages related to MCP). Activepieces upstream has an MCP feature (pieces as MCP tools). How do THEY map a piece action → MCP tool (tool naming, input schema generation from props, auth handling)? What transport/server do they use? This is critical — we may want to reuse their mapping code instead of writing our own.
4. Piece metadata + versioning: how piece metadata is generated (piece-metadata service?), how pieces are published to npm (@activepieces/piece-*), versioning semantics (piece version vs package version), the public pieces API (cloud.activepieces.com/api/v1/pieces), and how a self-hosted AP instance installs/updates pieces at runtime.
5. Triggers: how polling/webhook triggers work in the engine (relevant for future trigger support but secondary).
6. License boundaries: which parts are MIT (community) vs enterprise (ee/) — we must only depend on MIT parts.
7. Anything in upstream that resembles "run single action by name with given props+connection" as a standalone entrypoint (the engine's execute-action operation) — exact input/output types.`,
    { label: 'explore:activepieces-upstream', phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SHARED_CONTEXT}

TASK: Web research on Dapr + MCP integration patterns. Use WebFetch/WebSearch only (no repo writes).

1. Fetch and deeply analyze https://github.com/diagridio/catalyst-quickstarts/tree/main/mcp-access-control/python — list the files (use the GitHub API https://api.github.com/repos/diagridio/catalyst-quickstarts/contents/mcp-access-control/python if needed, and fetch raw files via raw.githubusercontent.com). Explain the full pattern: how the MCP server is built (FastMCP?), how Dapr is used (service invocation? state? conversation API?), how access control is enforced (scopes/middleware?), what the agent side looks like, and what of this is portable to self-hosted Dapr on Kubernetes (vs Catalyst-specific).
2. Research Dapr Agents (dapr/dapr-agents) MCP support: MCPClient, how tools from MCP servers are wired into DurableAgent, transports supported (stdio/sse/streamable-http).
3. Research the Dapr Conversation API (alpha2) tool-calling support — could a deterministic workflow activity call an MCP tool via Dapr primitives?
4. Any official "dapr-mcp" server or Dapr blog posts/docs on exposing tools via MCP, MCP middleware/auth patterns with Dapr (e.g. dapr.io blog, Diagrid blog posts on MCP, "Dapr MCP" search).
5. MCP spec status for auth (OAuth 2.1 resource server spec in streamable HTTP) — what a production MCP gateway needs.

Return concrete facts with URLs; for the quickstart include the actual code structure (file names + what each does + key code snippets as text).`,
    { label: 'research:diagrid-dapr-mcp', phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SHARED_CONTEXT}

TASK: Web research on CNCF / cloud-native ecosystem projects that could host or gateway MCP servers and tool catalogs on Kubernetes, to inform our architecture. Use WebSearch/WebFetch only.

1. ToolHive (stacklok) — MCP server operator for Kubernetes: MCPServer CRD, registry, transport proxying, secrets handling, current maturity, CNCF status.
2. kagent (CNCF sandbox) + kmcp — building/deploying MCP servers on k8s, ToolServer CRD, how kagent wires MCP tools to agents.
3. agentgateway (Linux Foundation / solo.io) + kgateway — MCP-aware data plane: MCP multiplexing/federation of multiple MCP servers behind one endpoint, authn/authz (OAuth), observability. Envoy AI Gateway MCP support too.
4. KEDA / Knative for scale-to-zero of many small MCP server pods (we already run Knative for fn-system and have Kueue).
5. Anything else genuinely relevant: e.g. Dapr's own roadmap on MCP, wasmCloud/Spin (wasm-hosted MCP tools), Crossplane-style catalog sync operators, OCI-artifact distribution of tool catalogs.
6. For each: maturity, CNCF/LF status, k8s-native fit, whether it would actually reduce our maintenance burden vs our existing in-house piece-mcp-server + mcp-gateway, and integration cost with Dapr sidecar mesh + mTLS.

Be skeptical: we already run Dapr, Knative, Kueue, KEDA(?), agent-sandbox, ArgoCD. Recommend only what composes with that. Return facts with URLs.`,
    { label: 'research:cncf-ecosystem', phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'Explore' }),
])

const [wfb, stacks, upstream, daprMcp, cncf] = results
return {
  workflow_builder: wfb,
  stacks: stacks,
  activepieces_upstream: upstream,
  dapr_mcp_research: daprMcp,
  cncf_ecosystem: cncf,
}