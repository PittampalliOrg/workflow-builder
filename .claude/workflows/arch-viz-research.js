export const meta = {
  name: 'arch-viz-research',
  description: 'Map the system, research OSS architecture-visualization tools, verify, and synthesize a recommendation',
  phases: [
    { title: 'Understand', detail: 'parallel readers over workflow-builder + stacks' },
    { title: 'Research', detail: '6 web researchers over OSS tool categories' },
    { title: 'Shortlist', detail: 'merge + dedup + pick candidates to verify' },
    { title: 'Verify', detail: 'adversarial fact-check per shortlisted tool' },
    { title: 'Synthesize', detail: 'draft recommendation + completeness critic' },
  ],
}

const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const SYSTEM_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Dense 2-4 paragraph summary of findings' },
    facts: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, detail: { type: 'string' } }, required: ['topic', 'detail'] } },
    reusable_assets: { type: 'array', items: { type: 'string' }, description: 'Existing components/data/pipelines that an architecture-visualization system could reuse, with file paths' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'What is missing today for building an auto-updating architecture map' },
  },
  required: ['summary', 'facts', 'reusable_assets', 'gaps'],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    category_summary: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          license: { type: 'string' },
          is_oss: { type: 'boolean' },
          maintenance: { type: 'string', description: 'Activity status as of 2026: last release, commit cadence, community health' },
          what_it_does: { type: 'string' },
          auto_update: { type: 'string', description: 'How it stays current automatically (live telemetry, CI regeneration, k8s watch, discovery, etc.)' },
          requirements: { type: 'string', description: 'Hard dependencies / prerequisites (e.g. requires Istio, requires Cilium, needs privileged eBPF, specific languages)' },
          fit: { type: 'string', description: 'Fit assessment for THIS specific system (constraints given in prompt)' },
          effort: { type: 'string', description: 'Rough adoption effort: trivial/days/weeks/months' },
          relevance: { type: 'number', description: '0-10 relevance to the user goal' },
        },
        required: ['name', 'url', 'license', 'is_oss', 'maintenance', 'what_it_does', 'auto_update', 'requirements', 'fit', 'relevance'],
      },
    },
  },
  required: ['category_summary', 'candidates'],
}

const SHORTLIST_SCHEMA = {
  type: 'object',
  properties: {
    shortlist: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          why: { type: 'string' },
          verify_questions: { type: 'array', items: { type: 'string' }, description: '2-4 specific factual claims to adversarially verify' },
        },
        required: ['name', 'category', 'why', 'verify_questions'],
      },
    },
    rejected_notable: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, why: { type: 'string' } }, required: ['name', 'why'] } },
  },
  required: ['shortlist', 'rejected_notable'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    confirmed_facts: { type: 'array', items: { type: 'string' } },
    corrections: { type: 'array', items: { type: 'string' }, description: 'Claims from research that turned out wrong or outdated' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Hard blockers for adoption in this system' },
    verdict: { type: 'string', description: 'strong-fit | conditional-fit | poor-fit, with one sentence why' },
  },
  required: ['name', 'confirmed_facts', 'corrections', 'blockers', 'verdict'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    missing: { type: 'array', items: { type: 'string' } },
    errors: { type: 'array', items: { type: 'string' } },
    improvements: { type: 'array', items: { type: 'string' } },
    overall: { type: 'string' },
  },
  required: ['missing', 'errors', 'improvements', 'overall'],
}

// ---------- Shared context blocks ----------
const SYSTEM_CONTEXT = `
THE USER'S SYSTEM (established facts — trust these):
- Kubernetes fleet: hub-and-spoke. Talos Linux clusters on Hetzner (hub, dev) + a local "ryzen" Talos-in-Docker cluster. GitOps via ArgoCD + argocd-agent (hub authors, spokes sync), kustomize packages in a "stacks" repo, source-hydrator + GitOps Promoter.
- CNI: Cilium on the Talos clusters (kubeProxyReplacement: true). Hubble is NOT currently enabled (no hubble section in values). NO Istio / no service mesh.
- Service-to-service communication: Dapr 1.17 (sidecar per service) — service invocation, pub/sub, workflows, actors. Dapr sentry mTLS. Also Knative scale-to-zero services, plain HTTP, and Postgres.
- Observability already deployed: OpenTelemetry Collector (otlp receiver + Dapr prometheus scrape) exporting traces to ClickHouse (via addon overlays) and logs to Loki; Grafana + Loki deployed; Tempo on hub only; MLflow for traces too; an existing custom ClickHouse trace viewer in their app.
- The application: "workflow-builder" — a SvelteKit BFF (UI + API) + ~10 Python/Node microservices in a monorepo (services/): workflow-orchestrator (Python Dapr workflow interpreter), function-router, fn-system, per-piece Knative services, mcp-gateway, workflow-mcp-server, several AI agent runtimes (dapr-agent-py, claude-agent-py, adk-agent-py, browser-use-agent, cli-agent-py), crawl4ai-adapter. Plus per-session ephemeral sandbox pods.
- The UI already uses Svelte Flow (@xyflow/svelte) heavily — a visual workflow canvas, a fork-lineage tree, a GitOps pipeline visualization, a run console. The team is expert at building graph UIs in SvelteKit.
- They run a platform of durable AI agents that can execute codebase-analysis jobs as workflows on a schedule (relevant for LLM-generated docs/diagrams that auto-update).
- Languages: TypeScript (SvelteKit BFF, some services), Python (most services). Two repos: workflow-builder (app monorepo) + stacks (GitOps/kustomize).

THE USER'S GOAL: a system inside their Kubernetes setup that visualizes architecture, dependencies, and relationships of their applications/microservices — INCLUDING the code and constructs within the code (routes, DB tables, workflows, pub/sub topics, Dapr components, etc.). It must give a human an easy-to-understand map of how the system works, how services connect, which parts of the code are involved — and it must UPDATE AUTOMATICALLY as services/code change. Strong preference for self-hosted open source.`

const RESEARCH_INSTRUCTIONS = `
You are a research agent. First use ToolSearch with query "select:WebSearch,WebFetch" to load web tools, then research thoroughly (many searches, fetch official docs/GitHub repos, check recent release/commit activity — today is July 2026, so verify projects are alive NOW, not as of old blog posts). Evaluate honestly against the system constraints above. Include projects that turn out to be dead or non-OSS if notable — mark them accordingly (is_oss=false or maintenance="abandoned") so we don't rediscover them. Be precise about licenses (note relicensing events). Your final output is ONLY the structured data.`

// ---------- Phase 1 + 2 run concurrently (independent) ----------
log('Launching 4 system readers + 6 web researchers concurrently')

const readerDefs = [
  {
    key: 'stacks-topology',
    prompt: `Analyze the GitOps repo at ${STACKS} to map the Kubernetes fleet topology for an architecture-visualization project.
${SYSTEM_CONTEXT}
Investigate (use Glob/Grep/Read; be thorough but read selectively):
1. Cluster inventory + how clusters are defined/registered (hub, dev, ryzen; argocd-agent). Where the ArgoCD Applications live, roughly how many apps/workloads exist, and the app-of-apps structure.
2. The full workloads inventory: list the deployed workloads/namespaces (packages/, workloads/ dirs) — names + one-line purpose where inferable.
3. Observability stack details: the OTEL collector config pipelines (receivers/processors/exporters per cluster overlay), where traces/metrics/logs land (ClickHouse tables? Loki? Tempo on hub?), Grafana dashboards present, whether anything today produces a service dependency graph. Check specifically: packages/components/observability/ and packages/components/addons/observability-clickhouse-*.
4. Dapr installation config: version, components (pubsub, statestores), tracing config (sampling rate, otel endpoint), placement/scheduler.
5. Any existing visualization/catalog tooling deployed (Headlamp? Kubeview? Backstage? none?).
6. How a new workload would be added (the pattern) — matters for deploying a new visualization service.
Return the structured output.`,
  },
  {
    key: 'services-commgraph',
    prompt: `Analyze the app monorepo at ${WB} to extract the SERVICE-LEVEL communication graph and the machine-readable sources of truth that encode it.
${SYSTEM_CONTEXT}
Investigate:
1. Enumerate every service under ${WB}/services/ (+ the SvelteKit BFF at repo root): language, framework, purpose.
2. Map the communication edges: who calls whom, via what mechanism (Dapr service invoke app-ids, Dapr pub/sub topics, ctx.call_child_workflow, plain HTTP, Knative URLs, Postgres, Redis, ClickHouse). Grep for invoke_method/DaprClient/publish_event/app_id/fetch calls to internal routes. Produce an explicit edge list: source → target (mechanism, evidence file:line).
3. Machine-readable SSOTs that encode topology: services/shared/runtime-registry.json (read it fully), function-registry ConfigMap references, trigger registry, dev-preview-registry (src/lib/server/workflows/dev-preview-registry.ts), nav-config. What do they contain, and what fraction of the real topology do they cover?
4. Database: how many tables in src/lib/server/db/schema.ts, and which services touch the DB directly vs via the BFF.
5. What code constructs exist that a human would want on an architecture map: SvelteKit route count (src/routes/), API route groups, Dapr workflow names, activity names, MCP servers/tools, pub/sub topics, node types.
Return the structured output with the edge list embedded in facts (topic='edge').`,
  },
  {
    key: 'ui-assets',
    prompt: `Analyze ${WB} (SvelteKit BFF) to inventory REUSABLE UI + data assets for building an architecture-map product surface inside this app.
${SYSTEM_CONTEXT}
Investigate:
1. Svelte Flow usage: which components build graph UIs today (src/lib/components/workflow/ canvas, base-sw-node, animated-edge; fork lineage tree; gitops pipeline-model.ts + activity-overlay.ts; run-console). What layout engines (dagre? elkjs?) are used, how nodes/edges are modeled.
2. The ClickHouse trace access layer: src/lib/server/otel/clickhouse.ts + the traces pages (workspaces traces list/detail, investigation-studio waterfall) — what span data is queryable (service names, span kinds, durations), could service-to-service edges be derived from existing ClickHouse span data with a SQL query? What are the table schemas?
3. The deployment inventory + GitOps activity stream: src/lib/server/gitops/ (inventory, pipeline-model, activity-events) — what per-service deployment metadata already exists (images, tags, health, sync state).
4. Existing admin/observe surfaces and navigation (nav-config.ts) — where an "Architecture" hub would slot in.
5. Auth/scoping patterns for a new page + API route (workspace scoping, internal-token routes) and the pattern for a reconciler CronJob (e.g. activepieces-mcps reconciler) that could periodically regenerate a graph.
Return the structured output; reusable_assets should be concrete (component/file paths + what they give us).`,
  },
  {
    key: 'code-constructs',
    prompt: `Analyze the codebase at ${WB} (and skim ${STACKS}) to assess what CODE-LEVEL constructs an architecture map should surface, and how statically extractable they are.
${SYSTEM_CONTEXT}
Investigate:
1. Repo shape: line counts by language (use e.g. find + wc or tokei if available), how many TS files under src/, Python files under services/, the dependency manifests (package.json workspaces? per-service pyproject/requirements?).
2. For the BFF: how SvelteKit routes map to server modules (src/routes/**/+server.ts, +page.server.ts), the src/lib/server/ module structure, imports between modules — could dependency-cruiser or madge produce a meaningful module graph? Any circular-dep or layering conventions?
3. For Python services: internal structure of workflow-orchestrator (workflows/, activities/, core/) — the registry of Dapr workflow names + activity names; how agent runtimes register session_workflow. Are these enumerable via static analysis (decorators like @workflow/@activity, runtime.register)?
4. Cross-cutting constructs worth mapping: Drizzle schema tables + which server modules import each table; Dapr component names referenced in code; pub/sub topic strings; environment variables that bind services together; internal API routes (/api/internal/*) and which services call them.
5. Existing codegen/sync scripts (scripts/sync-runtime-registry.mjs etc.) as the established pattern for generated artifacts with drift guards.
6. Docs: the docs/ directory — how architecture knowledge is captured today (30+ markdown docs, CLAUDE.md) and staleness risk.
Return the structured output.`,
  },
]

const researchDefs = [
  {
    key: 'ebpf-servicemaps',
    prompt: `Research open-source eBPF / network-level Kubernetes SERVICE MAP tools (auto-discovered, zero-instrumentation topology from live traffic).
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
Cover at least: Coroot (+license change history), Pixie (px.dev, CNCF), Otterize network-mapper, Caretta (groundcover), Microsoft Retina, Grafana Beyla and its donation to OpenTelemetry (OBI / opentelemetry-ebpf-instrumentation), Cilium Hubble + Hubble UI (NOTE: they already run Cilium — assess what enabling Hubble buys: flow logs, service map UI, L7 visibility, resource cost), Kubeshark, and anything newer (2025-2026) in this space.
Key fit questions: works on Talos Linux (immutable, no shell on host)? Handles Dapr sidecar architecture (does a sidecar-mediated call show as app→app or app→sidecar→sidecar→app — how noisy is the map)? Resource footprint? Can the topology be EXPORTED (API/metrics) so a custom UI can consume it, vs locked in the tool's own UI?`,
  },
  {
    key: 'trace-servicegraphs',
    prompt: `Research deriving SERVICE DEPENDENCY GRAPHS from distributed traces/metrics the user ALREADY collects (Dapr + OTEL traces to ClickHouse; Grafana/Loki; Tempo on hub).
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
Cover at least: OpenTelemetry Collector servicegraph connector + spanmetrics connector (maturity, config, how edges are emitted as metrics, known limitations e.g. in-memory store, multi-collector issues), Grafana Tempo service graphs + Grafana Node Graph panel, Jaeger (v2) dependency/System-Architecture view and its Spark/streaming jobs status, SigNoz (ClickHouse-native APM with service map — license: SSPL portions? maintenance; could it REUSE their existing ClickHouse or does it need its own schema), Uptrace (license changes), HyperDX / ClickStack (ClickHouse official observability stack — service map support?), qryn/Gigapipe, and writing a CUSTOM ClickHouse SQL over OTEL spans (parent-child span join on trace_id to emit service edges) — how do others do this, is there prior art / example queries.
Key fit questions: Dapr trace semantics (Dapr emits its own spans for service invocation + pub/sub — do standard servicegraph connectors handle the Dapr sidecar span topology correctly?), effort to light up vs value.`,
  },
  {
    key: 'catalogs-c4',
    prompt: `Research open-source SOFTWARE CATALOGS and ARCHITECTURE-AS-CODE / C4-model tooling for a living, human-friendly system map.
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
Cover at least: Backstage (software catalog, catalog graph plugin, entity relations, Kubernetes plugin, TechDocs; REAL adoption cost — the 'Backstage tax', maintenance burden for a solo/small team; also lighter Backstage distros like Roadie=hosted, RHDH), Structurizr (DSL, structurizr-lite, onprem, CI regeneration patterns), LikeC4 (very relevant: architecture-as-code with beautiful interactive diagrams, vite-based, embeddable as React component? maintenance/community 2026), IcePanel/Multiplayer/Port/Cortex/OpsLevel (mark non-OSS ones), EventCatalog (event-driven architecture documentation — pub/sub topics, AsyncAPI; license: is it still OSS? it moved to a dual license?), C4-PlantUML + Mermaid C4, ILOgraph, and any 2025-2026 newcomers.
Key fit questions: can catalog/model data be GENERATED from existing SSOTs (their runtime-registry.json, k8s manifests, package.json workspaces) rather than hand-maintained YAML? Which tools render an interactive drill-down (context→container→component) vs static pictures? Embeddability into an existing SvelteKit app (iframe/web-component/lib)?`,
  },
  {
    key: 'k8s-topology',
    prompt: `Research open-source KUBERNETES RESOURCE TOPOLOGY visualization — live cluster object graphs and manifest-derived diagrams.
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
Cover at least: Headlamp (CNCF; its Map/graph view + plugin system — could it be extended with custom relationships like Dapr app-id edges?), KubeDiagrams (generates architecture diagrams from manifests/Helm/kustomize — active 2025-2026?), KubeView, kubectl-graph (exports k8s object graph to Neo4j/ArangoDB), Cyclops, Skooner, kube-ops-view, ArgoCD's built-in application resource tree + ApplicationSet views (what it already gives them for free), Weave Scope (dead — note as archetype), Otterize intents UI overlap, Steve (Rancher), k9s (TUI, note only), and 2025-2026 newcomers (e.g. anything from the Backstage/Headlamp ecosystems, KRO ResourceGraphDefinition? kubectl-tree/lineage). 
Key fit questions: which of these expose their graph as DATA (API/JSON) a custom SvelteKit UI could consume? Which understand CRDs (they have Sandbox CRs, Dapr Components, ArgoCD Applications, Knative Services)? Auto-update = watch-based vs poll?`,
  },
  {
    key: 'code-graphs',
    prompt: `Research open-source CODE-LEVEL dependency graph and code-knowledge-graph tooling (module/import graphs, symbol graphs, code-property graphs, code visualization).
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
Cover at least: 
- JS/TS: dependency-cruiser (rules + graph output formats, mermaid/dot/json), madge, ts-morph/custom, Nx graph (monorepo — note theirs is pnpm not Nx), skott.
- Python: pydeps, import-linter, tach (Gauge/tach — rust-based module boundary tool), grimp.
- Symbol/precise level: SCIP ecosystem (scip-typescript, scip-python; Sourcegraph's OSS status as of 2026 — the 2024 relicensing), Glean (Meta, OSS — TS/Python indexers?), Kythe (status), GitHub stack-graphs (archived?), tree-sitter as a build-your-own base, LSP-based extraction.
- Code property graphs: Joern (security CPG, Scala), CodeQL (license restrictions!).
- Visualization: CodeCharta (code city), Emerge, Sourcetrail (dead? maintained forks as of 2026 — e.g. petermost fork / OpenSourcetrail?), Gephi as generic renderer, CodeSee (shut down?).
- Code knowledge graphs for AI: FalkorDB code-graph / GraphRAG-SDK, potpie, blarify, aider repo-map concept, anything new 2025-2026 (code-graph-rag projects).
Key fit questions: multi-language (TS + Python) in one graph? Output as consumable JSON for a custom UI? CI-regenerable (auto-update)? Which give the ARCHITECTURE-level view (module/service boundaries) vs overwhelming symbol dumps?`,
  },
  {
    key: 'llm-livingdocs',
    prompt: `Research LLM/agentic AUTO-GENERATED architecture documentation and "living docs" systems — tools that read a repo and produce/refresh architecture explanations + diagrams automatically.
${SYSTEM_CONTEXT}
${RESEARCH_INSTRUCTIONS}
NOTE: this user runs their OWN durable-AI-agent platform on this very cluster (Claude/codex CLI agents executable as scheduled workflows with repo access) — so patterns and pipelines matter as much as finished products. Cover at least: DeepWiki (Cognition/Devin, hosted) and deepwiki-open (AsyncFuncAI — license, quality, self-host requirements, diagram generation), CodeBoarding (static-analysis + LLM architecture diagrams — status 2026), Swark (VS Code, LLM→mermaid), RepoAgent, Komment.ai (OSS?), mutable.ai (dead?), Sourcebot (OSS code search w/ AI, relevance?), plus the PATTERN literature: docs-as-code CI regeneration, Structurizr DSL emitted by LLM, mermaid-in-PR bots, "architecture drift detection" (LLM compares docs vs code on PR), git-hook triggered doc refresh. Also: does anyone maintain an OSS pipeline that builds a CODE KNOWLEDGE GRAPH + LLM summaries per module (hierarchical summarization à la DeepWiki) that could run as a scheduled job?
Key fit questions: quality/hallucination control (grounding in static analysis vs pure LLM), cost per refresh on a ~large monorepo, incremental updates (only changed modules), output formats embeddable in their SvelteKit app.`,
  },
]

const readers = readerDefs.map((d) => () =>
  agent(d.prompt, { label: `read:${d.key}`, phase: 'Understand', schema: SYSTEM_SCHEMA }))
const researchers = researchDefs.map((d) => () =>
  agent(d.prompt, { label: `research:${d.key}`, phase: 'Research', schema: RESEARCH_SCHEMA }))

// Barrier justified: shortlisting needs ALL research; synthesis needs ALL reading.
const all = await parallel([...readers, ...researchers])
const readings = all.slice(0, readerDefs.length)
const research = all.slice(readerDefs.length)

const readingByKey = {}
readerDefs.forEach((d, i) => { if (readings[i]) readingByKey[d.key] = readings[i] })
const researchByKey = {}
researchDefs.forEach((d, i) => { if (research[i]) researchByKey[d.key] = research[i] })

const allCandidates = []
researchDefs.forEach((d, i) => {
  const r = research[i]
  if (r && r.candidates) r.candidates.forEach((c) => allCandidates.push({ category: d.key, ...c }))
})
log(`Research complete: ${allCandidates.length} candidates across ${Object.keys(researchByKey).length} categories`)

// ---------- Phase 3: Shortlist ----------
phase('Shortlist')
const shortlistResult = await agent(
  `You are selecting which open-source tools to adversarially verify before recommending an architecture-visualization solution.
${SYSTEM_CONTEXT}

FULL CANDIDATE LIST (from 6 research agents):
${JSON.stringify(allCandidates, null, 1)}

Pick the 10-14 candidates that could plausibly be PART of the recommended solution (it will likely be a layered/composite solution: runtime service map + k8s topology + catalog/model layer + code-level graph + LLM living-docs). Prefer: OSS-licensed, alive in 2026, exportable data (consumable by a custom SvelteKit UI), low ops burden, fit with Talos+Cilium+Dapr+ClickHouse+SvelteKit constraints. Include at least one candidate per layer where a viable one exists. For each, write 2-4 verify_questions targeting the claims that would change the recommendation if wrong (license status, maintenance, hard requirements, integration feasibility). Also list notable rejects with one-line reasons.`,
  { label: 'shortlist', phase: 'Shortlist', schema: SHORTLIST_SCHEMA },
)

if (!shortlistResult) throw new Error('shortlist agent failed')
log(`Shortlisted ${shortlistResult.shortlist.length} tools for verification`)

// ---------- Phase 4: Verify (parallel per candidate) ----------
const verifications = await parallel(
  shortlistResult.shortlist.map((s) => () => {
    const cand = allCandidates.find((c) => c.name.toLowerCase() === s.name.toLowerCase()) || {}
    return agent(
      `Adversarially verify research claims about the open-source tool "${s.name}" (category: ${s.category}) as of July 2026. Use ToolSearch with query "select:WebSearch,WebFetch" first, then check PRIMARY sources (the project's GitHub repo — commits/releases/license file, official docs). Assume the research MAY be wrong or stale; your job is to catch that.
${SYSTEM_CONTEXT}

RESEARCH CLAIMS: ${JSON.stringify(cand, null, 1)}
WHY SHORTLISTED: ${s.why}
QUESTIONS TO VERIFY: ${JSON.stringify(s.verify_questions)}

Verify: (1) exact current license + any relicensing, (2) maintenance signals (last release date, recent commit activity, open-issue responsiveness), (3) each verify_question with evidence, (4) hard requirements vs this system (Talos Linux nodes, Cilium CNI, Dapr sidecars, no Istio, ClickHouse traces, SvelteKit UI). Return the structured verdict.`,
      { label: `verify:${s.name}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    )
  }),
)
const verified = verifications.filter(Boolean)
log(`Verified ${verified.length}/${shortlistResult.shortlist.length} shortlisted tools`)

// ---------- Phase 5: Synthesize ----------
phase('Synthesize')
const synthesisInput = {
  system_understanding: readingByKey,
  category_summaries: Object.fromEntries(Object.entries(researchByKey).map(([k, v]) => [k, v.category_summary])),
  shortlist: shortlistResult.shortlist.map((s) => ({ name: s.name, category: s.category, why: s.why })),
  rejected: shortlistResult.rejected_notable,
  verifications: verified,
}

const draft = await agent(
  `Write a comprehensive draft recommendation (markdown, no length limit — thoroughness wins) for building an auto-updating architecture/dependency/code-map visualization system for this user.
${SYSTEM_CONTEXT}

ALL EVIDENCE (system analysis by 4 repo readers + verified tool research):
${JSON.stringify(synthesisInput, null, 1)}

Requirements for the draft:
1. Start with a short "what your system already gives you" assessment (their SSOTs, ClickHouse traces, Svelte Flow expertise, GitOps inventory, agent platform).
2. Present a RECOMMENDED solution architecture — likely layered: (a) service/runtime dependency layer, (b) k8s/GitOps desired-state layer, (c) code-construct layer, (d) narrative/LLM living-docs layer — naming the specific chosen OSS tool or build-vs-buy call per layer WITH justification from the verified evidence, and how the layers join into ONE human-friendly map (one graph model / UI).
3. Be opinionated: a primary recommendation plus at most one alternative path (e.g. "adopt Backstage instead" or "buy into SigNoz") with honest trade-offs.
4. Auto-update story per layer: what triggers refresh (telemetry=continuous, CI on merge, reconciler CronJob, k8s watch).
5. A concrete phased build plan (P1..P4) with effort estimates, exploiting their existing components (name actual files/components from the repo-reader evidence).
6. Data model sketch: the unified graph schema (node kinds, edge kinds, sources).
7. Risks/gotchas section (e.g. Dapr sidecar noise in eBPF maps, servicegraph connector limitations, LLM doc drift, Talos constraints) — grounded in the verification results.
Return ONLY the markdown draft.`,
  { label: 'draft-recommendation', phase: 'Synthesize' },
)

if (!draft) throw new Error('draft agent failed')

const critique = await agent(
  `You are a completeness critic. The user asked: "build a system within my kubernetes setup that helps visualize the architecture, dependencies, relationships of my applications/microservices — including the code and constructs within the code; easy for a human to understand; updates automatically as services/code change. Review my system, research the best open-source projects, and recommend what the solution could look like and how to build it."
${SYSTEM_CONTEXT}

DRAFT RECOMMENDATION:
${draft}

VERIFICATION EVIDENCE: ${JSON.stringify(verified, null, 1)}

Critique the draft: (missing) what parts of the ask are unaddressed or thin — e.g. is the CODE-construct layer concrete enough? is the auto-update story complete for every layer? does it actually say how a HUMAN navigates the map? (errors) claims contradicting the verification evidence or the system facts; (improvements) highest-leverage sharpening. Be specific and ruthless.`,
  { label: 'completeness-critic', phase: 'Synthesize', schema: CRITIC_SCHEMA },
)

return {
  readings: readingByKey,
  research: researchByKey,
  shortlist: shortlistResult,
  verifications: verified,
  draft,
  critique,
}