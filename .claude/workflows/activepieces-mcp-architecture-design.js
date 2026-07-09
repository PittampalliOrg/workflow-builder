export const meta = {
  name: 'activepieces-mcp-architecture-design',
  description: 'Judge-panel design: 3 perspectives on AP-as-Dapr-activities + AP-as-MCP architecture',
  phases: [
    { title: 'Design', detail: '3 parallel Plan agents: execution architecture, maintainability, UX' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['recommendation', 'alternatives', 'phased_roadmap', 'risks'],
  properties: {
    recommendation: { type: 'string', description: 'The recommended design, in detail: components, contracts, data flow, concrete file-level changes (existing files to reuse/modify, new files), and why it beats alternatives' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'pros', 'cons', 'verdict'],
        properties: {
          name: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          verdict: { type: 'string', description: 'why rejected or deferred' },
        },
      },
    },
    phased_roadmap: { type: 'array', items: { type: 'string' }, description: 'Ordered implementation phases with scope per phase' },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Decisions that genuinely need the user (max 4, only if load-bearing)' },
  },
}

phase('Design')

const CONTEXT = `
You are designing architecture for the workflow-builder system (SvelteKit BFF + Python Dapr workflow-orchestrator on Kubernetes, GitOps via stacks repo/ArgoCD). Two goals:
(1) Activepieces (AP) piece ACTIONS usable as deterministic Dapr workflow ACTIVITIES (SW 1.0 interpreter, durable, retryable).
(2) AP pieces exposed as MCP SERVERS for durable agents (dapr-agent-py, claude-agent-py) and external MCP clients.
Cross-cutting: seamless architectural fit, great UI/UX, and maintainability as AP pieces update upstream (npm @activepieces/piece-*) outside our control.

READ THIS FIRST — full exploration findings (5 agents: workflow-builder repo, stacks infra, upstream AP repo, Dapr+MCP research, CNCF ecosystem) are in JSON at:
/tmp/claude-1000/-home-vpittamp-repos-PittampalliOrg-workflow-builder-main/270a7c16-5083-4e09-8b81-f4b6abc9861e/tasks/wepreioi7.output
Read it (it is ~640 lines of JSON; read in 2 pages). Then read any repo files you need.

Repos: workflow-builder=/home/vpittamp/repos/PittampalliOrg/workflow-builder/main, stacks=/home/vpittamp/repos/PittampalliOrg/stacks/main, upstream AP=/home/vpittamp/repos/PittampalliOrg/activepieces/main

ESTABLISHED FACTS (verified):
- fn-activepieces (45 pinned piece npm pkgs, /execute + /options + /catalog/functions, registers ap_<piece>_<action> Dapr activities) is the function-registry _default route BUT has NO workload manifest in stacks — it is NOT deployed anywhere. AP piece actions are dead as workflow actions today.
- piece-mcp-server (parameterized by PIECE_NAME env) IS live: a stacks CronJob reconciler (every 2 min) creates per-piece Knative Services (minScale=0, pinned pieces minScale=1, TTL cleanup, catalog ConfigMap) from enabled mcp_connection rows + PINNED_PIECES. Creds resolved server-side via X-Connection-External-Id → BFF /api/internal/connections/<id>/decrypt. Extensions registry adds custom actions without forking npm pkgs.
- piece_metadata table has catalogDigest + catalogSourceImage drift detection; sync-metadata Job upserts at deploy. Piece versions pinned in package.json, manual bumps only.
- Orchestrator resolve_mcp_config.py merges project-enabled mcp_connection rows into agentConfig.mcpServers (mcpConnectionMode=project). mcp-gateway gates EXTERNAL MCP clients to hosted workflows.
- Upstream AP: MIT except ee/. Engine has NO standalone execute-one-action op (always flow context). Upstream MCP maps FLOWS→tools, not piece actions→tools. AgentPieceTool fills props via LLM (non-deterministic). So our piece-action→tool/activity mapping stays our own code (it already exists in piece-mcp-server/piece-to-mcp.ts and fn-activepieces/executor.ts).
- System invariants: BFF owns credential decryption (AES-256-CBC app_connection); function-router is credential broker for activities; orchestrator never holds plaintext secrets; all non-agent actions go orchestrator → Dapr service invoke → function-router → fn-*; Knative scale-to-zero precedent (fn-system); Dapr 1.17, JetStream pubsub, Postgres state stores; KEDA + Kueue + agent-sandbox already deployed.
- User preferences (strong, from prior feedback): prefer upstream CNCF primitives over custom controllers; check what we already deploy before adding new infra; FULL CUTOVER over backwards-compat shims; permanent end-to-end fixes.
- CNCF options researched: ToolHive (MCPServer CRD + VirtualMCPServer aggregation, Stacklok), kagent/kmcp (CNCF sandbox, MCPServer CRD), kgateway v2.1 + agentgateway (MCP multiplexing/federation, OAuth, CNCF sandbox), agentregistry (OCI tool catalogs, CNCF sandbox 2026), Envoy AI Gateway. Diagrid mcp-access-control quickstart: FastMCP + Dapr sidecar + OAuth2 middleware + ACLs (portable self-hosted).

DELIVERABLE for the overall task: an architecture-evaluation doc in docs/ (current state + options + pros/cons + recommendation + phased roadmap), then implementation. Your plan feeds that.`

const [exec, maint, ux] = await parallel([
  () => agent(`${CONTEXT}

YOUR LENS: EXECUTION ARCHITECTURE (deterministic activities + MCP serving). Design the target runtime architecture. Answer specifically:

1. Should we converge on ONE execution surface per piece (the existing per-piece Knative piece-mcp-server gains a deterministic /execute or Dapr-invokable endpoint, used by BOTH the orchestrator for activities AND agents via MCP), OR revive the fn-activepieces monolith for activities alongside per-piece MCP services, OR a third shape? Weigh: cold-start latency for workflow activities (Knative scale-from-0 vs monolith always-on), image count/build cost, metadata/version skew between two services importing the same npm pkgs, credential-broker flow differences (function-router broker vs piece-mcp-server self-resolve), Dapr service-invoke addressing of Knative services, blast radius of a piece bump.
2. How exactly does the orchestrator invoke a piece action durably? Today: SW 1.0 step slug (e.g. "github/create-issue") → dapr_invoke activity → function-router → _default. Keep function-router in the path (credential broker + audit) or have the orchestrator hit the piece service directly with a connection ref the piece service resolves itself (like MCP path does)? Address idempotency for non-idempotent piece actions (execution_id-derived idempotency keys), retry classification (which AP errors are retryable), the AP pause/webhook contract (executor.ts pause detection → SW 1.0 approval-gate/timer mapping), and the 16 MiB payload ceiling.
3. MCP serving shape: keep per-piece Knative services + CronJob reconciler, or move to ToolHive/kmcp MCPServer CRDs, or put kgateway/agentgateway in front as a single multiplexed MCP endpoint (one URL, tool namespacing per piece, per-tool authz)? Consider: the reconciler is custom-but-thin (CronJob, not Kopf), user prefers upstream CNCF primitives, but also prefers reusing what is already deployed; agents currently get per-piece URLs in agentConfig.mcpServers; external clients go through mcp-gateway. Evaluate whether ONE aggregated MCP endpoint (VirtualMCPServer or agentgateway) materially improves agent UX (tool discovery across all enabled pieces) vs per-piece servers.
4. Dapr-native security: should piece MCP services get Dapr sidecars (service-invoke + mTLS + ACLs, per the Diagrid pattern) instead of raw HTTP? What breaks (Knative + Dapr sidecar interplay, streamable-http sessions)?
Give concrete component diagrams (text), exact request flows, and file-level change lists.`,
    { label: 'plan:execution-arch', phase: 'Design', schema: PLAN_SCHEMA, agentType: 'Plan' }),

  () => agent(`${CONTEXT}

YOUR LENS: MAINTAINABILITY + UPSTREAM TRACKING. AP publishes piece updates to npm continuously, outside our control. Design the full lifecycle that keeps our system current WITHOUT silent breakage. Answer specifically:

1. Piece version pipeline: automated bump PRs (Renovate/dependabot on the piece package.json group), CI gates (metadata extraction diff → catalogDigest comparison → schema-breaking-change classifier: removed/renamed action, changed required prop, changed auth shape), canary smoke (piece-mcp-server boots, lists tools, runs a read-only action where possible), then normal GitOps promotion. What exists already (catalogDigest, catalogSourceImage, sync-metadata Job) and what is missing?
2. Version pinning semantics for DETERMINISTIC workflows: should workflow specs stamp pieceVersion at authoring time (resolve at save, validate at execution, fail-fast on mismatch)? How do running durable instances survive a piece bump mid-flight? Do we need side-by-side piece versions (we currently cannot — single image), and is that worth it or is fail-forward + replay acceptable (user prefers full-cutover simplicity)?
3. Metadata SSOT: piece_metadata table vs catalog ConfigMap vs npm at build time — define the single source of truth and the sync flow, including the extensions registry (custom actions layered on vendored pieces — how do extension schemas survive upstream bumps?). Compare with how WE already handle this for agent runtimes (services/shared/runtime-registry.json + sync script + drift-guard CI) — should pieces get the same SSOT-registry treatment?
4. Tool/schema stability for MCP consumers: agents cache tools at session start; external clients may pin tool names. Define tool-naming stability rules (stable action name, not display name), schema-version surfacing, deprecation flow (AP deprecates a piece → warn in UI → block new use → grace period).
5. Evaluate OCI-artifact catalogs (agentregistry / MCP registry patterns) and ToolHive registry as future governance — adopt now, later, or never, given a single-team self-hosted system?
Give a concrete pipeline design (what runs where: GitHub Actions/Tekton, what gates merge) with file-level changes.`,
    { label: 'plan:maintainability', phase: 'Design', schema: PLAN_SCHEMA, agentType: 'Plan' }),

  () => agent(`${CONTEXT}

YOUR LENS: UI/UX. Design the user experience that makes AP pieces feel native in workflow-builder. First READ the existing UI code to ground yourself: src/lib/components/workflow/ (canvas, side-panel, action picker), src/routes/api/pieces, src/routes/api/mcp-connections, settings/connections pages, agent config UI (agentConfig.mcpServers editing), and the workflow-builder skill docs if helpful. Then design:

1. A unified "Integrations" surface: one place where a user sees the piece catalog (logos, categories, search — data already in piece_metadata), creates a connection (existing OAuth2 popup flow), and toggles per-piece capabilities: "available as workflow actions" and "exposed as MCP server" (today: mcp_connection row → reconciler picks it up). What exists vs what is new? How do project-scoping (project_id) and the CMA workspace model apply?
2. Canvas action-picker UX for piece actions: search/browse pieces+actions, prop forms generated from piece metadata (incl. dynamic dropdowns via the /options proxy — currently needs fn-activepieces alive), inline connection selection (workflow_connection_ref), validation badges (piece version pinned, connection missing, piece deprecated). Identify exact existing components to extend vs new ones.
3. Agent MCP config UX: today explicit JSON in durable/run.with.agentConfig.mcpServers or mcpConnectionMode=project. Design the picker (enabled piece MCP servers as checkboxes, tool-count preview via list_tools, connection binding per server) for both the agent-editor UI and the durable/run node side-panel. Should project-mode become the default with per-node opt-out?
4. Health/status UX: piece service status (Knative ready/scale-to-zero), metadata sync age, version drift badges ("piece X updated upstream"), MCP smoke status; where do these live (Integrations page detail view? admin?).
5. Execution UX: run-detail rendering of piece action steps (logos, inputs/outputs, credential audit link), MCP tool calls in session transcript (already CMA-shaped events — what is missing for piece tools?).
Keep it consistent with existing shadcn-svelte + CMA-parity patterns. Give per-surface wireframe sketches (text) and the exact routes/components/files to add or extend.`,
    { label: 'plan:ux', phase: 'Design', schema: PLAN_SCHEMA, agentType: 'Plan' }),
])

return { execution: exec, maintainability: maint, ux: ux }