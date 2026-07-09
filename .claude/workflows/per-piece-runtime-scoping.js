export const meta = {
  name: 'per-piece-runtime-scoping',
  description: 'Map the implementation surface for per-piece runtime images + produce a concrete build plan',
  phases: [
    { title: 'Map', detail: 'parallel deep-reads of the 6 surfaces that change' },
    { title: 'Plan', detail: 'synthesize into an ordered implementation plan' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const SURFACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['surface', 'keyFiles', 'findings', 'changesNeeded', 'risks'],
  properties: {
    surface: { type: 'string' },
    keyFiles: { type: 'array', items: { type: 'string' }, description: 'file:line anchors' },
    findings: { type: 'string', description: 'how it works today, concretely' },
    changesNeeded: { type: 'array', items: { type: 'string' }, description: 'specific edits for per-piece mode' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const surfaces = [
  {
    key: 'runtime-coupling',
    prompt: `In ${REPO}/services/piece-mcp-server, map EXACTLY how the static piece bundle is loaded at module-init and how a single piece is resolved at request time. Read src/piece-registry.ts (the static PIECES imports + getPiece), src/index.ts (server bootstrap — does it import the whole registry at startup? what does it do with PIECE_NAME?), and every module that imports PIECES or getPiece (executor.ts, piece-to-mcp.ts, options.ts/routes, metadata-catalog.ts). The goal: for a per-piece image that has ONLY ONE @activepieces/piece-<name> installed, the runtime must load that one piece dynamically (import("@activepieces/piece-"+PIECE_NAME)) and NOT statically import all 48. Identify what currently forces loading all 48 at init (the OOM driver), and the minimal change to support a "single-piece" mode (env-gated) where getPiece dynamically imports the one installed package. Give file:line anchors.`,
  },
  {
    key: 'request-flow',
    prompt: `In ${REPO}/services/piece-mcp-server, trace the 3 request surfaces — POST /execute (deterministic activities), POST /mcp (StreamableHTTP MCP tools), POST /options (canvas dropdowns), GET /health — from src/index.ts through to where they call getPiece / use the piece object. For each, note what piece data they need (actions, auth, run()) and whether they assume the full PIECES map or just the one PIECE_NAME piece. The per-piece image serves exactly ONE piece (PIECE_NAME); confirm each surface works with a single dynamically-loaded piece, and flag any place that iterates ALL pieces (which would break in single-piece mode). file:line anchors.`,
  },
  {
    key: 'build-image',
    prompt: `In ${REPO}/services/piece-mcp-server, read Dockerfile + build.mjs + package.json. Today it bundles src + npm-installs all 48 @activepieces/piece-* into one image. Design the per-piece image structure: (a) a base "piece-runtime-base" image = the server (dist/) + runtime deps but NO @activepieces/piece-* packages; (b) a per-piece image = FROM base; npm install @activepieces/piece-<name>@<ver>. Identify what's needed: how to split package.json so the base has NO piece deps, what the per-piece Dockerfile looks like, and how the snapshot generator's isolated-install (src/gen-catalog-snapshot.ts) is the same install op. Note the image-size/layer-sharing implications. file:line anchors.`,
  },
  {
    key: 'reconciler',
    prompt: `In ${STACKS}/packages/components/workloads/activepieces-mcps/manifests/, read ConfigMap-activepieces-mcp-reconciler-script.yaml (the reconcile.sh + kubectl_apply_kservice function) and CronJob-activepieces-mcp-reconciler.yaml. Today every ap-<piece>-service KService is templated with ONE shared PIECE_MCP_IMAGE env. For per-piece images, each ap-<piece>-service must use a PER-PIECE image (ghcr.io/.../ap-piece-<name>:<ver>). Identify exactly where in kubectl_apply_kservice the image is set, and how to source a per-piece image ref (e.g. from a new piece_images DB table the reconciler queries per piece, falling back to the bundle image for not-yet-migrated pieces). With per-piece images, the per-pod memory can drop back to ~256Mi (one piece). file:line anchors.`,
  },
  {
    key: 'image-pipeline',
    prompt: `Map how container images are built + published + pinned in this org so a per-piece build pipeline can reuse it. Read ${REPO}/CLAUDE.md + any skaffold/hooks (skaffold/hooks/commit-pin.sh) + how the hub Tekton outer-loop builds images (the github-outer-loop / outer-loop-build pattern referenced in CLAUDE.md and the gitops notes). Note: piece-mcp-server is NOT auto-built today (built locally). Design how a per-piece image (ap-piece-<name>:<ver>) gets built ON ENABLE: which pipeline builds it, where the image ref is recorded, and how an admin "enable" action triggers it. Keep it concrete + reuse existing infra. file:line anchors.`,
  },
  {
    key: 'registry-enable',
    prompt: `In ${REPO}, map the DB + BFF surface for an "enable a piece" action and a piece→image registry. Read src/lib/server/db/schema.ts (piece_metadata, platform_disabled_piece — the Phase 1 blocklist), src/routes/(admin)/admin/pieces/* (the admin gate), and the available_only column (Phase 2). Design: a piece_images table {pieceName, version, image, digest, builtAt, status} recording per-piece images; an "Enable" admin action that (1) marks the piece enabled, (2) triggers a per-piece image build, (3) on build success the reconciler provisions ap-<piece>-service from that image. Note how this supersedes the bundle (a piece with a piece_images row uses its own image; others fall back to the bundle during migration). file:line anchors.`,
  },
]

phase('Map')
const maps = await parallel(
  surfaces.map((s) => () =>
    agent(s.prompt, { label: `map:${s.key}`, phase: 'Map', schema: SURFACE_SCHEMA, agentType: 'Explore' })
  )
)
const mapped = maps.filter(Boolean)

phase('Plan')
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pocSteps', 'fullSteps', 'filesToChange', 'openDecisions', 'recommendation'],
  properties: {
    pocSteps: { type: 'array', items: { type: 'string' }, description: 'ordered steps to prove ap-piece-ntfy runs ntfy in ~256Mi with no OOM' },
    fullSteps: { type: 'array', items: { type: 'string' }, description: 'ordered steps for the full per-piece path incl build-on-enable' },
    filesToChange: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'change'], properties: { file: { type: 'string' }, change: { type: 'string' } } } },
    openDecisions: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
}
const plan = await agent(
  `You are the architect for migrating workflow-builder's Activepieces piece runtime from a single 48-piece bundle image to PER-PIECE images (each ap-<piece>-service runs its own ghcr.io/.../ap-piece-<name> image with ONE piece, ~256Mi, no OOM, no dep conflicts; built only on enable). Context doc: ${REPO}/docs/per-piece-runtime-images.md. Here are deep-reads of the 6 implementation surfaces:\n\n${mapped
    .map((m) => `### ${m.surface}\nkeyFiles: ${(m.keyFiles || []).join(', ')}\nfindings: ${m.findings}\nchangesNeeded:\n- ${(m.changesNeeded || []).join('\n- ')}\nrisks: ${(m.risks || []).join('; ')}`)
    .join('\n\n')}\n\nProduce a concrete ordered implementation plan. The POC must come first: build ap-piece-ntfy (base + ntfy only), a single-piece runtime mode (dynamic import of the one installed piece), run it, and confirm it serves ntfy's send_notification tool in ~256Mi with no OOM — proving the model before the full pipeline. Then the full path: piece_images registry, reconciler per-piece image ref (with bundle fallback during migration), build-on-enable, admin Enable wiring. List exact files to change. Be specific and ordered.`,
  { label: 'plan:synthesize', phase: 'Plan', schema: PLAN_SCHEMA }
)

return { surfacesMapped: mapped.length, plan }
