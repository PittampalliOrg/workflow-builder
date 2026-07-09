export const meta = {
  name: 'ap-catalog-phase2-research',
  description: 'Research the metadata-source feasibility + integration points for AP catalog Phase 2 (200+ available, code-free)',
  phases: [
    { title: 'Research', detail: '3 parallel: metadata source, sync+schema+reconciler, UI surfaces' },
    { title: 'Synthesize', detail: 'design + provenance decision + implementation plan' },
  ],
}
const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STK = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const R = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    findings: { type: 'string' },
    anchors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string' }, what: { type: 'string' } }, required: ['ref','what'] } },
    approach: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['area','findings','anchors','approach','risks'],
}
const ctx = `Repo workflow-builder ${WB}; stacks ${STK}. Phase 2 of docs/activepieces-catalog-expansion.md: make ALL 200+ Activepieces pieces AVAILABLE as picker options (metadata-only, code-free) while only the admin-ENABLED + BUNDLED subset is provisioned/runnable. Phase 1 (the enablement gate) already shipped: a platform_disabled_piece blocklist + the reconciler catalog-branch gate. INVARIANT: enabled-and-runnable is a subset of bundled (services/piece-mcp-server: package.json + piece-registry.ts); available-only pieces have NO bundled code so must NEVER be provisioned. Today piece_metadata is populated ONLY from the bundled ~47 by sync-metadata.ts; all 4 pickers read piece_metadata. Read files + npm/registry; do NOT edit. File:line anchors.`

phase('Research')
const [source, syncReconciler, ui] = await parallel([
  () => agent(`${ctx}\n\nRESEARCH the METADATA SOURCE for 200+ code-free pieces (the key decision):\n1. How many @activepieces/piece-* packages exist on npm (the 200+)? How to enumerate them + their latest versions (npm search/registry API, an @activepieces meta-package, or the AP monorepo packages list)?\n2. FEASIBILITY of a per-piece ISOLATED snapshot generator: for each piece, in its OWN temp dir, npm install @activepieces/piece-NAME, import the Piece object, run the equivalent of metadata-catalog.ts buildPieceCatalogRow, collect the row. Per-piece isolation should AVOID the cross-piece dep conflicts that bundling-all-into-one-image causes. Confirm buildPieceCatalogRow (${WB}/services/piece-mcp-server/src/metadata-catalog.ts) only needs the imported Piece (no DB/runtime). What does a piece package export + how is metadata read?\n3. ALTERNATIVE: an AP cloud catalog API (e.g. cloud.activepieces.com/api/v1/pieces) returning full metadata for all pieces — does it exist + what shape? Pros/cons vs the CI snapshot (the doc prefers the snapshot for the GitOps/offline posture).\n4. Recommend the provenance + sketch the generator (a script under services/piece-mcp-server or a CI job). Report the piece-list source + the per-piece extraction approach + whether isolated install sidesteps conflicts.`, { label: 'source', phase: 'Research', schema: R }),

  () => agent(`${ctx}\n\nRESEARCH the sync-metadata + schema + reconciler integration for AVAILABLE-ONLY rows:\n1. ${WB}/services/piece-mcp-server/src/sync-metadata.ts — exactly how it upserts piece_metadata from the bundled set (buildPieceCatalogRows). Does it DELETE rows not in the bundle (which would clobber available-only rows)? How to make it (a) seed available-only rows from services/shared/piece-catalog-snapshot.json and (b) NOT delete available-only rows on a bundle-sync.\n2. piece_metadata columns (id,name,display_name,logo_url,catalog_digest,catalog_schema_version,catalog_source_image,package_type,version) — which field marks a row as available-only vs bundled? Recommend: a new boolean column (available_only) OR reuse catalog_source_image (bundled=image ref, available-only=snapshot). The reconciler MUST exclude available-only from provisioning.\n3. The reconciler catalog branch (${STK}/packages/components/workloads/activepieces-mcps/manifests/ConfigMap-activepieces-mcp-reconciler-script.yaml ~L352) selects 'name from piece_metadata where catalog_schema_version=1 and catalog_digest is not null'. If available-only rows have a catalog_digest, they'd be wrongly provisioned (pod boot fails: getPiece exits, no bundled code). How to exclude them — set their catalog_digest NULL, OR add 'and available_only is not true' to the query? Recommend the cleanest.\n4. Report the sync change + the schema flag + the reconciler exclusion (+ a migration if a new column).`, { label: 'sync-reconciler', phase: 'Research', schema: R }),

  () => agent(`${ctx}\n\nRESEARCH the 4 PICKER surfaces + the UI threading for available-vs-enabled:\n1. ${WB}/src/lib/server/action-catalog/piece-metadata-source.ts — it reads piece_metadata and HARDCODES registered/ready/insertable=true. How to set insertable/registered=false for available-not-enabled rows so the canvas greys them?\n2. ${WB}/src/lib/server/mcp-availability.ts (getMcpAvailability) — the registered/configured model + the SERVER_NOT_REGISTERED authStatus. How to add available-not-enabled pieces to wantedPieces marked registered=false so integrations render amber 'Available — request enablement'.\n3. ${WB}/src/routes/api/pieces/+server.ts + /api/mcp-connections/catalog/+server.ts — how they list pieces; left-join the platform_disabled_piece (enabled) + the available_only flag to expose 'enabled'/'available' for the planned All|Connected|Available|Enabled filter pills.\n4. The connections/integrations UI (src/routes/workspaces/[slug]/connections) + the agent Tools/Integrations picker — where the filter pills + the greyed 'Available — request enablement' state render. Report the exact files + the minimal threading (Phase 2 is metadata-listing UX; keep it scoped).`, { label: 'ui', phase: 'Research', schema: R }),
])

phase('Synthesize')
const PLAN = {
  type: 'object', additionalProperties: false,
  properties: {
    provenanceDecision: { type: 'string' },
    snapshotGenerator: { type: 'string' },
    syncSchemaReconciler: { type: 'string' },
    uiThreading: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    risksAndDecisions: { type: 'array', items: { type: 'string' } },
  },
  required: ['provenanceDecision','snapshotGenerator','syncSchemaReconciler','uiThreading','steps','risksAndDecisions'],
}
const plan = await agent(`${ctx}\n\nSynthesize the Phase 2 implementation plan: the metadata PROVENANCE decision (CI snapshot vs AP cloud API; recommend + why), the snapshot generator sketch, the sync-metadata + schema flag + reconciler exclusion, and the UI threading — in dependency order, file-anchored. Flag the key risks/decisions (esp. snapshot feasibility/dep-conflicts, the available-only flag choice, and how to bound UI scope).\n\nSOURCE:\n${JSON.stringify(source)}\n\nSYNC-RECONCILER:\n${JSON.stringify(syncReconciler)}\n\nUI:\n${JSON.stringify(ui)}`, { label: 'synth', phase: 'Synthesize', schema: PLAN })
return { source, syncReconciler, ui, plan }
