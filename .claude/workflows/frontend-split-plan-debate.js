export const meta = {
  name: 'frontend-split-plan-debate',
  description: 'Adversarial plan agents: for vs against physically splitting the browser frontend',
  phases: [
    { title: 'Design', detail: '2 adversarial Plan agents' },
  ],
}

phase('Design')

const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const EVIDENCE = `
CONTEXT (verified by prior exploration; you may re-verify specifics in the repos at ${WB} and ${STACKS}):

HEX REFACTOR STATE: The SvelteKit app completed a ports/adapters refactor. 0/411 route server files import db/drizzle; 341/411 go through src/lib/server/application (125 port interfaces in ports.ts, composition root getApplicationAdapters() in application/index.ts, all 53 Drizzle-importing files under application/adapters/). Python orchestrator runs strict WORKFLOW_DATA_API_MODE=http over Dapr (no Postgres fallback, proven by tests + live preview). Gaps: several multi-thousand-line quarantine adapters (benchmark-service.ts 6.9k lines, evaluation-service.ts 3.7k), and NO global import-boundary guard (no dependency-cruiser, no eslint no-restricted-imports — only 34 hand-written per-file boundary tests).

UI<->BFF COUPLING: @sveltejs/adapter-node, SSR on, custom server-prod.js (CMD) wrapping build/handler.js + a ws upgrade layer proxying 4 terminal WS paths (/api/v1/sessions/<id>/shell, /cli-terminal/<tid>, /api/sandboxes/<name>/terminal/<sid>, /api/openshell/...) to sandbox pods :8002 / openshell-agent-runtime; WS auth = HTTP preflight to http://127.0.0.1:PORT (SHELL_RESOLVER_ORIGIN). 28 server loads (+page/+layout.server.ts) ALL import $lib/server directly, zero fetch('/api'). 5 *.remote.ts SvelteKit remote functions (same-origin RPC). 1 form action. 133 files fetch relative '/api/...'; NO configurable API base. Cookies wb_access_token/wb_refresh_token httpOnly SameSite=Lax; CORS handler returns ACAO:* with NO credentials header and allow-headers omits X-Workspace; X-Workspace is injected by a window.fetch monkeypatch in +layout.svelte for same-origin URLs; 10 SSE endpoints consumed via EventSource (cannot set custom headers); OAuth callbacks land on the app origin (getAppUrl); SvelteKit csrf.checkOrigin default ON.

DEPLOYMENT: One image (workflow-builder, GHCR) serves SSR pages + static assets + /api/v1/* + /api/internal/* in one node process. Deployment replicas:2, RollingUpdate maxUnavailable 0, Dapr sidecar (app-id workflow-builder, app-port 3000, enable-workflow=true + placement), tls-terminator nginx sidecar :8443 for the tailnet LB, db-migrate init container from the SAME image. Exposure: tailnet LoadBalancer (browser, https), nginx Ingress localtest.me (browser), Tailscale Funnel Ingress path-scoped to /api/internal/workflows/triggers/github (GitHub webhooks). NON-BROWSER consumers all hit ClusterIP workflow-builder:3000 or Dapr app-id workflow-builder: workflow-orchestrator (Dapr invoke for 10+ workflow-data routes; direct svc DNS for sessions/ensure-for-workflow, workspace/seed, environments, artifacts), function-router + piece-mcp-server (/api/internal/connections/<id>/decrypt), agent pods x4 runtimes (/api/internal/sessions/<id>/events/ingest, outputs, goals), Argo Events hub relay via tailnet egress (/api/internal/gitops/events/ingest), workflow-mcp-server (goals + workflow execute), CronJobs (reap-idle, resource-sample, pieces/reconcile-building), GitHub via Funnel. BFF outbound: Postgres direct, orchestrator/function-router/sandbox-execution-api via svc DNS, sandbox pods by pod-IP:8002, Dapr building blocks (pubsub, state, secrets, config, workflow API + placement), tailnet egress services. Release pin: ONE image key in release-pins/workflow-builder-images.yaml rendered into a kustomize Component; skaffold inner/outer loop; Tier-2 vcluster previews template a single __IMAGE__ param; PREVIEW_DEV_MODE adopt replaces the prod Deployment with a dev pod.

USER MOTIVATIONS for considering the split (in priority order given): (1) deploy independence — ship UI changes without redeploying the API surface that orchestrator/agents depend on; (2) architecture purity — UI as a truly external client of stable BFF APIs; (3) future clients/teams — other frontends consuming the same stable API. The user does NOT currently cite scaling/availability pressure. Single developer today. The system runs on ryzen/dev clusters with GitOps (ArgoCD + release pins), skaffold dev loops, and Tier-2 vcluster previews that all assume one image.
`

const [forCase, againstCase] = await parallel([
  () => agent(`${EVIDENCE}

YOU ARE THE ADVOCATE **FOR** physically splitting the browser frontend of this system into a separate deployment. Steelman it. Your job:

1. Choose the best-fit split SHAPE for THIS codebase (consider at least: (a) static SPA / adapter-static + separate API service; (b) two SvelteKit node deployments from the same codebase — a UI/SSR shell that proxies or calls the BFF; (c) same-image "role split" — two Deployments of the SAME image, one serving browsers (UI + /api/v1), one serving machines (/api/internal + Dapr app-id workflow-builder), gated by env/role, Service+Ingress retargeted; (d) any better shape you can devise). Pick ONE and justify against the alternatives.
2. Show concretely how your shape serves the user's 3 motivations (deploy independence, purity, future clients) BETTER than the status quo.
3. Produce a realistic phased migration plan for your chosen shape: files/manifests to change (be specific: svelte.config.js, server-prod.js, hooks.server.ts corsHandle, stacks Deployment/Service/Ingress/pin files, skaffold, preview templates), auth/cookie/CORS handling, WS/SSE handling, migration ownership (db-migrate init), Dapr app-id/subscription implications (both deployments same app-id = round-robin invoke + duplicate pubsub — handle it), rollback story.
4. Be honest about cost: estimate effort bands (S/M/L/XL per phase) and enumerate the risks you CANNOT engineer away.

Read files in the repos as needed to ground your plan. RETURN: chosen shape + rationale, motivation-by-motivation benefit case, phased plan with concrete file/manifest touchpoints, effort/risk table.`, { label: 'plan:for-split', phase: 'Design', agentType: 'Plan' }),

  () => agent(`${EVIDENCE}

YOU ARE THE ADVOCATE **AGAINST** physically splitting the browser frontend of this system into a separate deployment (or at least against doing it NOW). Steelman the opposition. Your job:

1. For EACH of the user's 3 motivations (deploy independence, architecture purity, future clients/teams), show whether a physical frontend split actually delivers it — and name the CHEAPER, more direct instrument that delivers the same outcome (e.g. global import-boundary guard via dependency-cruiser/eslint no-restricted-imports for purity; API contract versioning/OpenAPI + contract tests for future clients; what exactly for deploy independence — analyze whether UI-deploy churn even harms machine consumers today given replicas:2 + maxUnavailable:0 + Dapr retries + graceful-shutdown 60s; consider whether the REAL blast-radius risk is something else, like active WS terminal sessions being killed on rollout).
2. Quantify the true cost of the split honestly (SSR loads, remote functions, WS proxies, SSE, cookies/CORS/OAuth, 133 fetch call sites, two images/pins, skaffold + Tier-2 vcluster preview machinery, db-migrate ownership, schema-drift risk of two image versions sharing one DB) — and identify which costs are one-time vs permanent tax (every preview, every dev loop, every deploy forever).
3. Define the CONDITIONS under which the split WOULD become worth it (team growth? a real second client? UI deploy frequency X? measured availability incident?) so the assessment can record revisit triggers.
4. Recommend the concrete alternative program: prioritized, small: e.g. (a) dependency-cruiser/eslint boundary guard, (b) freeze+version the /api/v1 contract consumed by future clients, (c) same-image role-split as a cheap middle path IF deploy independence pressure materializes — evaluate whether that middle path is even needed now.

Read files in the repos as needed to ground claims (e.g. check PodDisruptionBudget existence, graceful shutdown, whether UI-only changes are actually frequent in git history — sample git log). RETURN: motivation-by-motivation rebuttal with cheaper instruments, cost table (one-time vs permanent), revisit-trigger list, prioritized alternative program.`, { label: 'plan:against-split', phase: 'Design', agentType: 'Plan' }),
])

return { forCase, againstCase }