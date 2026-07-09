export const meta = {
  name: 'hex-arch-review-explore',
  description: 'Explore hexagonal architecture work + UI/BFF coupling + deployment topology',
  phases: [
    { title: 'Explore', detail: '3 parallel Explore agents over workflow-builder + stacks' },
  ],
}

phase('Explore')

const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const [hexReport, couplingReport, deployReport] = await parallel([
  () => agent(`You are exploring the repo at ${WB} (a SvelteKit UI+BFF for a Dapr workflow system). Search breadth: very thorough.

GOAL: Produce a factual review of the hexagonal (ports & adapters) architecture refactor that was recently done in this repo. Recent commits include: "docs: add hexagonal architecture diagram", "docs: record strict preview hex evidence", "refactor: move evaluation service behind adapter", "refactor: move benchmark service behind adapter".

Investigate:
1. Read ${WB}/docs/hexagonal-architecture.md in full — summarize its layer model, rules, and any stated invariants/roadmap.
2. Inspect ${WB}/src/lib/server/application/ — list the files, approximate sizes. Characterize ports.ts (how many port interfaces, what categories: repositories, stores, schedulers, runtime ports, telemetry, session ports, artifact stores, etc.). Characterize index.ts (composition root getApplicationAdapters()) — what concrete adapters it wires. Characterize workflow-data.ts (ApplicationWorkflowDataService) and any other application services (evaluation, benchmark, etc.). List the adapters/ directory contents (postgres.ts, dapr?, others).
3. Run git log --oneline -40 in ${WB} and identify the arc of hex-refactor commits.
4. Quantify remaining leaks: grep the routes tree (src/routes) for direct imports of '$lib/server/db' or drizzle schema/table imports — count how many route files still bypass the application layer vs go through application services. Sample a few of each kind. Also check src/lib/server outside application/ — which legacy modules still do direct DB access (e.g. lifecycle, goals, sessions/spawn, gitops)?
5. The "strict mode" orchestrator boundary: find the internal workflow-data routes (src/routes/api/internal/workflow-data/**) and how the Python orchestrator (services/workflow-orchestrator) calls them instead of Postgres. Is strict mode flag-gated? What flag? Is the orchestrator fully off direct Postgres or partially?
6. Any drift guards/tests protecting the boundary (lint rules, dependency-cruiser, tests)?

RETURN: a dense factual report with file:line references, port/adapter inventories, leak counts (numbers), and an honest completeness assessment (what % of routes/services are behind the boundary, what remains).`, { label: 'explore:hex-architecture', phase: 'Explore', agentType: 'Explore' }),

  () => agent(`You are exploring the repo at ${WB} (a SvelteKit 5 UI+BFF, single deployment "workflow-builder"). Search breadth: very thorough.

GOAL: Inventory every runtime coupling between the browser frontend (Svelte pages/components) and the server side of the SAME SvelteKit process, to inform whether the frontend could be physically split into a separate deployment.

Investigate:
1. ${WB}/svelte.config.js + vite.config.ts: which adapter (adapter-node?), SSR settings, CSRF config, any origin config.
2. ${WB}/src/hooks.server.ts: what it does per request (auth/session resolution, workspace scoping via X-Workspace header or URL slug, anything else like handleFetch).
3. Server load functions: count +page.server.ts / +layout.server.ts files under src/routes. Do they import server application services / db directly, or do they fetch('/api/...')? Sample several important ones (workflows list, session detail, workspaces layout guard). Also count +page.ts universal loads.
4. Form actions: grep for "export const actions" — how many pages rely on SvelteKit form actions?
5. Streaming/real-time: find SSE endpoints (e.g. /api/v1/sessions/[id]/events/stream, /api/v1/gitops/events/stream) and any WebSocket usage — especially the interactive CLI web terminal (how does terminal traffic reach the sandbox pod? Is there a WS proxy in the BFF, e.g. via a custom server, or does the browser connect elsewhere?). Look for xterm, websocket, ws imports in src/.
6. Client fetch patterns: do components fetch relative '/api/...' URLs (same-origin assumption)? Any absolute URL/env-based API base?
7. Cookies/auth: how are sessions stored (cookie name, Secure/SameSite flags), OAuth callback routes, JWT api keys. What would break cross-origin?
8. Anything else that assumes one process: locals typing, direct imports of $lib/server from .svelte files (shouldn't exist), depends()/invalidate patterns, streamed promises from load.

RETURN: a dense factual report with file:line references and counts: N server loads (of which M call services directly), N form actions, list of SSE/WS endpoints, auth/cookie details, and a concrete list of "things that break or need rework if the UI is served from a different origin/deployment".`, { label: 'explore:ui-bff-coupling', phase: 'Explore', agentType: 'Explore' }),

  () => agent(`You are exploring TWO repos: ${WB} (app monorepo: SvelteKit BFF + python services) and ${STACKS} (GitOps repo with k8s manifests). Search breadth: very thorough.

GOAL: Map the deployment topology of the "workflow-builder" SvelteKit UI+BFF service and inventory all NON-BROWSER consumers that call into it, to inform whether the browser frontend could be split into a separate deployment.

Investigate:
1. In ${STACKS}: find the workflow-builder workload manifests (likely workloads/workflow-builder/ or similar). Report: Deployment spec (containers, Dapr annotations/app-id, ports, resources, replicas), Services, Ingress/Tailscale LoadBalancers (how is the UI exposed — tailnet LB? funnel?), ConfigMaps/env (DATABASE_URL source, INTERNAL_API_TOKEN, etc.), release-pins mechanism for its image.
2. In ${WB}: the Dockerfile for the SvelteKit app (root Dockerfile?) — build output (adapter-node build/index.js?), what serves static assets.
3. Inventory non-browser inbound consumers of the BFF HTTP surface, with evidence:
   - workflow-orchestrator (services/workflow-orchestrator): grep for calls to /api/internal/... (ensure-for-workflow, workflow-data routes, artifacts POST, gitops ingest?) and how they're made (Dapr service invoke to which app-id?).
   - function-router / piece-runtime: /api/internal/connections/<id>/decrypt.
   - sandbox/agent pods (cli-agent-py, dapr-agent-py): session event ingest endpoints (/api/events/ingest or /api/v1/... mirror), hooks relay, files upload.
   - Argo Events → /api/internal/gitops/events/ingest.
   - GitHub webhooks via Tailscale Funnel → /api/internal/workflows/triggers/github.
   - workflow-mcp-server goal tools → BFF goal APIs?
   List each consumer → endpoint(s) → transport (Dapr invoke vs direct Service DNS vs tailnet/funnel).
4. Outbound: what the BFF itself calls (orchestrator via Dapr, Postgres direct, sandbox pod IPs :8002, ClickHouse, etc.) — enough to characterize its sidecar/network needs.
5. Preview/dev implications: how PREVIEW (Tier-2 vcluster) and skaffold dev loops deploy workflow-builder — would a split UI mean two images/two release-pins? Check skaffold.yaml module for workflow-builder and the preview runner references if visible in ${STACKS}.

RETURN: a dense factual report with file:line references: the deployment shape, full consumer→endpoint table, exposure paths (tailnet/funnel/ingress), and notes on what a physical UI/BFF split would mean for images, pins, previews, and Dapr.`, { label: 'explore:deploy-topology', phase: 'Explore', agentType: 'Explore' }),
])

return { hexReport, couplingReport, deployReport }