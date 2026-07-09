export const meta = {
  name: 'perpiece-poll-build-completion',
  description: 'Replace the fragile cross-cluster Tekton register callback with spoke-side GHCR polling of building piece_images rows',
  phases: [
    { title: 'Implement', detail: 'BFF poll fn+endpoint + stacks CronJob + pipeline register-removal, in parallel' },
    { title: 'Review', detail: 'adversarial review of correctness, completeness, and the contract' },
  ],
}

const DESIGN = `
DURABLE FIX: the per-piece build pipeline runs on the HUB; the registration (flip
the spoke's piece_images row to ready) was a cross-cluster HTTP callback from the
hub Tekton register task to the spoke BFF — which FAILS because hub Tekton pods
can't resolve spoke Tailscale MagicDNS (curl: could not resolve host
workflow-builder-dev.tail286401.ts.net).

Replace it with SPOKE-SIDE POLLING: each spoke periodically asks its OWN BFF to
reconcile its 'building' piece_images rows against GHCR (in-cluster, no MagicDNS,
no egress, no TLS). The BFF already has the building blocks in
src/lib/server/pieces/piece-images.ts: ghcrImageExists(pieceName, version) ->
{exists, digest}; recordImageResult(pieceName, version, {status, image, digest,
errorMessage}) -> {enabledAt}|null (UPSERTs the row, preserves enabledAt);
markPieceRunnable(pieceName) (clears blocklist; the ready+enabled row is the
provision signal the reconciler keys on); pieceImageRef(pieceName, version) ->
the ghcr.io/.../ap-piece-<name>:<version> ref.

The internal-token endpoint contract is: POST /api/internal/pieces/reconcile-building
(requireInternal from $lib/server/internal-auth), no body, returns JSON counts.
`

phase('Implement')

const BFF_WORKTREE = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/perpiece-poll'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filesChanged', 'summary', 'openQuestions'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'absolute paths created/modified' },
    summary: { type: 'string', description: 'what was implemented + key decisions' },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'anything ambiguous or risky for the reviewer' },
  },
}

const [bffImpl, stacksImpl] = await parallel([
  () => agent(`Implement the BFF side of the spoke-polls-GHCR fix. Edit files ONLY under the git worktree ${BFF_WORKTREE} (it is checked out on branch feat/perpiece-poll-completion off main; do NOT touch any other worktree).

${DESIGN}

TASKS:
1. In ${BFF_WORKTREE}/src/lib/server/pieces/piece-images.ts add an exported async function:
     reconcileBuildingImages(opts?: { buildTimeoutMs?: number }): Promise<{ checked: number; readied: number; failed: number }>
   - Default buildTimeoutMs from env PIECE_BUILD_TIMEOUT_MS (parse int) else 30*60*1000 (thirty minutes).
   - Select all piece_images rows where status = 'building' (need pieceName, version, updatedAt, enabledAt). Use the existing drizzle 'db' + the pieceImages table already imported in the file; if db is null return zeroed counts.
   - For each building row:
       const { exists, digest } = await ghcrImageExists(pieceName, version)
       if exists: await recordImageResult(pieceName, version, { status: 'ready', image: pieceImageRef(pieceName, version), digest }); inspect the recordImageResult RETURN value — if its enabledAt is not null, await markPieceRunnable(pieceName). Increment readied.
       else: compute the row's AGE in milliseconds as (the current epoch-millis time) minus updatedAt.getTime() — in the TypeScript use the standard JS epoch-now millisecond call for "current epoch-millis time". If age > buildTimeoutMs: await recordImageResult(pieceName, version, { status: 'failed', errorMessage: 'build did not produce a GHCR image within the timeout' }); increment failed.
       else: leave it 'building' (still in progress — a no-op this cycle).
   - 'checked' counts how many building rows were examined. Wrap each row in try/catch so one bad row does not abort the whole sweep (console.warn it and continue). Return the counts.
   - Reuse the EXISTING helpers in this file (ghcrImageExists, recordImageResult, markPieceRunnable, pieceImageRef) — do NOT reimplement them. Match the file's existing import style, comment density, and tabs-for-indentation.

2. Create ${BFF_WORKTREE}/src/routes/api/internal/pieces/reconcile-building/+server.ts:
   - export const POST: RequestHandler — call requireInternal(request) (from '$lib/server/internal-auth'), then const result = await reconcileBuildingImages(); return json(result). Model the structure on the sibling ${BFF_WORKTREE}/src/routes/api/internal/pieces/[pieceName]/image-registration/+server.ts (same auth + json import patterns).

DO NOT git commit or push. Read the existing piece-images.ts + image-registration/+server.ts FIRST to match conventions exactly. Verify your TypeScript is self-consistent (correct imports, drizzle eq/and usage). Report via the schema.`, { label: 'impl:bff', phase: 'Implement', schema: IMPL_SCHEMA }),

  () => agent(`Implement the GitOps side of the spoke-polls-GHCR fix in the stacks repo at ${STACKS} (on branch main; edit the working tree, do NOT commit/push).

${DESIGN}

TASKS:
1. CREATE a CronJob that drives the poll on each spoke. Find the existing 'goal-loop-tick' CronJob in the stacks repo (grep for goal-loop-tick or 'goal-loop/tick') and MODEL the new one on it EXACTLY (same namespace=workflow-builder, same internal-token sourcing from the workflow-builder-secrets secret key INTERNAL_API_TOKEN, same in-cluster BFF URL pattern, same image/curl approach, same ArgoCD annotations). New CronJob name: 'perpiece-build-poll'. Schedule: '*/2 * * * *'. It does: POST http://<in-cluster-bff>/api/internal/pieces/reconcile-building with header 'X-Internal-Token: <token>' (no body). Use the SAME in-cluster BFF host:port the goal-loop-tick CronJob uses. Place the file in the SAME directory/app as the goal-loop-tick CronJob (it must deploy to BOTH dev and ryzen) and ADD it to that directory's kustomization.yaml resources list.

2. In ${STACKS}/packages/components/hub-tekton/manifests/outer-loop-builds/Pipeline-perpiece-image-build.yaml: REMOVE the 'register' task and the 'register-failure' finally task (polling replaces the cross-cluster callback). The pipeline becomes validate-piece-pkg -> build-and-push -> smoke-test, with the finally block removed entirely. Leave the 'callback_url' pipeline PARAM in place (unused now, but removing it would require touching the TriggerTemplate/TriggerBinding/EventListener + the BFF body — out of scope; an unused param is harmless). Do NOT delete Task-perpiece-register.yaml or the perpiece-build-secrets ExternalSecret (webhook-secret is still used by the EL; leave them).

3. Run 'kubectl kustomize' on BOTH the outer-loop-builds dir AND the dir where you added the CronJob; fix until both render clean (exit 0).

DO NOT git commit or push. Report via the schema, and in openQuestions note the exact in-cluster BFF URL + token mechanism you used and which kustomization dir you touched.`, { label: 'impl:stacks', phase: 'Implement', schema: IMPL_SCHEMA }),
])

phase('Review')

const ctx = `
BFF implementation summary:
${JSON.stringify(bffImpl, null, 2)}

STACKS implementation summary:
${JSON.stringify(stacksImpl, null, 2)}

The BFF changes are in the git worktree ${BFF_WORKTREE} (git diff against origin/main).
The stacks changes are in ${STACKS} (git diff against HEAD). Read the ACTUAL diffs, not just the summaries.
`

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blocking', 'nonBlocking'],
  properties: {
    verdict: { enum: ['correct', 'needs-fixes'], type: 'string' },
    blocking: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'issue', 'fix'], properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } }, description: 'must-fix issues' },
    nonBlocking: { type: 'array', items: { type: 'string' }, description: 'nits / suggestions' },
  },
}

const LENSES = [
  { key: 'correctness', prompt: `Review for CORRECTNESS + races. Read the ACTUAL git diffs. Check: (1) reconcileBuildingImages flips ready ONLY when the GHCR image exists, preserves enabled_at, and calls markPieceRunnable only when enabled_at is set. (2) The timeout path: building->failed fires only after the timeout, using updatedAt (not createdAt). (3) Race: a build still in progress (image not yet pushed) must be a NO-OP (left building), not failed. (4) Idempotency: it only selects status='building' (confirm). (5) drizzle query correctness (eq/and, the building filter, timestamp handling). (6) Does the CronJob curl method/header/URL EXACTLY match the endpoint contract (POST, X-Internal-Token, /api/internal/pieces/reconcile-building)?` },
  { key: 'completeness', prompt: `Review for COMPLETENESS — does this FULLY replace the cross-cluster callback? Read the ACTUAL git diffs. Check: (1) 'register' task AND 'register-failure' finally fully removed from Pipeline-perpiece-image-build.yaml with NO dangling references (no finally referencing a removed task, no runAfter pointing at 'register'). (2) The pipeline still succeeds on build+smoke. (3) The new CronJob deploys to BOTH dev and ryzen (in an app/overlay that syncs to both). (4) End-to-end: poll flips ready+enabled -> reconciler (relaxed AO_FILTER) provisions ap-<piece>-service. (5) Build-FAILURE handling: a build that never pushes an image eventually times out to failed.` },
  { key: 'contract-security', prompt: `Review the CONTRACT + security. Read the ACTUAL git diffs. Check: (1) requireInternal is called BEFORE any work in the new endpoint. (2) The CronJob sources the internal token from the same secret/key the BFF validates (INTERNAL_API_TOKEN). (3) kustomize renders clean for BOTH touched dirs (RUN it yourself). (4) The endpoint returns sane JSON; the sweep is resilient to one bad row; no unhandled rejections. (5) No secret values hardcoded. (6) Does the leftover unused 'callback_url' param or Task-perpiece-register.yaml cause any kustomize/Tekton validation error?` },
]

const reviews = await parallel(LENSES.map((l) => () =>
  agent(`${l.prompt}\n\n${ctx}`, { label: `review:${l.key}`, phase: 'Review', schema: REVIEW_SCHEMA })
    .then((r) => ({ lens: l.key, ...r }))
))

const allBlocking = reviews.filter(Boolean).flatMap((r) => (r.blocking || []).map((b) => ({ lens: r.lens, ...b })))
return {
  bffImpl,
  stacksImpl,
  reviews: reviews.filter(Boolean),
  blockingCount: allBlocking.length,
  blocking: allBlocking,
}
