export const meta = {
  name: 'ap-catalog-expansion-research',
  description: 'Research how AP pieces are filtered/bundled/provisioned + design a 200+ available / admin-enabled-subset model',
  phases: [
    { title: 'Research', detail: '3 parallel readers: bundling+metadata source, catalog+UI+enablement, reconciler+resources' },
    { title: 'Synthesize', detail: 'available-vs-enabled tiering design + options + recommendation' },
  ],
}
const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STK = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const R = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    howItWorks: { type: 'string' },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path','role'] } },
    facts: { type: 'array', items: { type: 'string' }, description: 'concrete verified facts incl. counts' },
    forExpansion: { type: 'string', description: 'what would need to change to support 200+ available / admin-enabled subset' },
  },
  required: ['area','howItWorks','files','facts','forExpansion'],
}
const ctx = `Repo workflow-builder ${WB}; stacks ${STK}. GOAL of this research: understand exactly how Activepieces (AP) pieces are made AVAILABLE (discoverable in the catalog / UI piece picker) vs ENABLED (provisioned as a runnable ap-<piece>-service MCP server). Today ~45-47 pieces exist; AP's public catalog has 200+. We want to (a) make ALL 200+ available as OPTIONS, (b) enable only an admin-curated SUBSET as actual running MCP services. Read files + cluster (admin@dev kubectl); do NOT edit. Be file-anchored with exact counts.`

phase('Research')
const [bundling, catalogUi, reconciler] = await parallel([
  () => agent(`${ctx}\n\nRESEARCH the PIECE BUNDLING + METADATA SOURCE (the actual "~45 filter"):\n1. ${WB}/services/piece-mcp-server/package.json — list how many @activepieces piece packages are pinned (the real filter). How is the piece-runtime image built from them (Dockerfile)? Is the piece set baked at BUILD time?\n2. ${WB}/services/piece-mcp-server/ — the piece-registry.ts / how PIECE_NAME selects a piece at runtime; is piece CODE required to RUN a piece (execute/mcp), separate from METADATA (actions/auth/logo) needed to merely LIST it as an option?\n3. Can AP piece METADATA for ALL 200+ be obtained WITHOUT bundling each package's code — e.g. an AP registry/API, a metadata-only npm package, or @activepieces/pieces-* metadata exports? Grep for any metadata fetch/registry. What does ADDING a piece take today: npm dep + image rebuild + metadata re-sync (the docs say so) — confirm and detail.\n4. Verify the premise: how many pieces are in AP's catalog (200+?) and how many we bundle (~45). Report the gap + what bundling-all 200+ would cost (image size/build, dep conflicts — the curated 45 may be partly for dep sanity).`, { label: 'bundling', phase: 'Research', schema: R }),

  () => agent(`${ctx}\n\nRESEARCH the CATALOG, the UI PIECE PICKER, and the ENABLEMENT model:\n1. The piece_metadata table + ${WB}/services/piece-mcp-server/ sync-metadata.ts (or scripts) + the activepieces-mcp-catalog ConfigMap — what populates "available pieces"? Is the catalog sourced from the BUNDLED pieces only, or could it list more?\n2. The UI: how does the canvas piece catalog + the agent "Tools & Integrations" picker (src/routes + src/lib/components) LIST available pieces — from piece_metadata? Is there any notion of available-but-not-enabled, or a platform/admin allowlist today?\n3. The mcp_connection table + how a piece becomes "MCP-enabled" (mcp_connection.status ENABLED). Is enablement per-project or platform-wide? Is there ANY existing platform-admin gate on which pieces are usable?\n4. For the GOAL: what's the cleanest place to add a platform-admin ENABLEMENT allowlist (which of the 200+ available pieces are actually provisioned + attachable), and how the picker would show available-not-enabled vs enabled. Report the tables/files + the admin-gating insertion point.`, { label: 'catalog-ui', phase: 'Research', schema: R }),

  () => agent(`${ctx}\n\nRESEARCH the RECONCILER + RESOURCE/CONTROL-PLANE model at 200+ scale:\n1. ${STK}/packages/components/workloads/activepieces-mcps/manifests/ConfigMap-activepieces-mcp-reconciler-script.yaml — how does it DECIDE which pieces get an ap-<piece>-service (the reasons: catalog / mcp-enabled / pinned / workflow-referenced)? Where does its desired-piece LIST come from (the catalog ConfigMap? the DB? a hardcoded set?)? Confirm via admin@dev: 47 ksvc, 44 scale-to-zero (min=0), 3 pinned. Each pod requests ~50m CPU / 160Mi.\n2. If we provisioned 200+ Knative Services (scale-to-zero): what's the CONTROL-PLANE cost — Knative controller load (Service+Route+Config+Revision ×200+), the activator, the */2 reconciler iterating 200+, etcd object count? Is 200+ scale-to-zero ksvc reasonable on this cluster, or does it strain Knative? (idle pods = 0, but the OBJECTS + reconcile loop are not free.)\n3. How would the reconciler gate to an ENABLED subset (only provision admin-enabled pieces, keep the other ~155 as metadata-only options)? Where is its piece source + how to filter it by an enablement allowlist.\n4. Report the concrete resource/control-plane analysis + the reconciler change for "provision only enabled".`, { label: 'reconciler', phase: 'Research', schema: R }),
])

phase('Synthesize')
const PLAN = {
  type: 'object', additionalProperties: false,
  properties: {
    currentSystem: { type: 'string' },
    options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, how: { type: 'string' }, pros: { type: 'string' }, cons: { type: 'string' } }, required: ['name','how','pros','cons'] } },
    recommendation: { type: 'string' },
    resourceVerdict: { type: 'string', description: 'is 200+ available + admin-enabled-subset reasonable, and the cost knobs' },
    implementationSketch: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['currentSystem','options','recommendation','resourceVerdict','implementationSketch','openQuestions'],
}
const plan = await agent(`${ctx}\n\nSynthesize a design for "ALL 200+ AP pieces AVAILABLE as options, admin-enabled SUBSET provisioned/usable". Cover: current system (the bundling filter + catalog + reconciler), 2-3 design OPTIONS with explicit pros/cons (e.g. bundle-all-200+-image + allowlist-provision; metadata-catalog-for-200+ + bundle-only-enabled; dynamic-piece-install), a clear RECOMMENDATION, the RESOURCE/control-plane verdict (is it reasonable; the real cost knobs = bundled-image-size + control-plane-object-count + per-agent-tool-surface, NOT idle pods), and an implementation sketch. This will become a docs/ artifact.\n\nBUNDLING:\n${JSON.stringify(bundling)}\n\nCATALOG-UI:\n${JSON.stringify(catalogUi)}\n\nRECONCILER:\n${JSON.stringify(reconciler)}`, { label: 'synthesis', phase: 'Synthesize', schema: PLAN })
return { bundling, catalogUi, reconciler, plan }
