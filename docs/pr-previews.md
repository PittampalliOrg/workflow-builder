# Label-gated PR previews (dev-env-v2 D1/D2)

A pull request carrying the **`preview`** label gets a live Tier-2 vcluster
preview at `https://wfb-pr-<n>.tail286401.ts.net`, serving the **PR head's
code** with **no image build**: the preview is claimed from the A3 warm pool
(seconds) or cold-provisioned (~5 min), dev-mode pods are adopted for the
services the PR touches, and the PR head is seeded into them via the
sidecar/plugin `/__sync` (gzip tar + `x-sync-token`). Pushing to the PR
re-seeds; closing the PR (or removing the label) tears the preview down.

Everything is **default-off** behind flags; unlabeled PRs cost nothing.

## Architecture

```
GitHub PR webhook (pull_request events)
  │  label `preview` gates the lane (CEL filter)
  ▼
hub Tekton EventListener `github-outer-loop`            [stacks: outer-loop-builds]
  ├─ trigger workflow-builder-pr-preview-up   (opened/synchronize/reopened/labeled)
  ├─ trigger workflow-builder-pr-preview-down (closed / `preview` unlabeled)
  ▼
TaskRun `pr-preview-dispatch` (ns tekton-pipelines)
  ├─ 1. pending commit status  (context `pr-preview`, github-clone-credentials)
  ├─ 2. POST https://workflow-builder-dev.tail286401.ts.net/api/internal/pr-previews
  │      via --connect-to through the Tailscale egress Service
  │      `workflow-builder-dev-bff-egress` (hub pods can't resolve spoke MagicDNS);
  │      auth = X-Internal-Token (perpiece-build-secrets/internal-api-token).
  │      Then polls GET /api/internal/pr-previews/<n> until ready|error|capacity_full.
  └─ 3. final commit status + ONE sticky PR comment (marker `<!-- pr-preview -->`)
  ▼
dev BFF ApplicationPrPreviewService                      [wfb: application/pr-previews.ts]
  ├─ map changed paths → services (dev-preview registry repoSubdir, longest
  │    prefix wins; empty/unknown → workflow-builder only)
  ├─ ensure the Tier-2 preview `pr-<n>`: claim-first from the A3 pool
  │    (origin=pr, prNumber, ttlHours pass-through), cold fallback with
  │    capacity admission → SEA reap once → retry once → `capacity_full`
  ├─ adopt dev-mode pods INSIDE the preview: POST the PREVIEW BFF's own
  │    /api/internal/workflows/executions/pr-<n>/dev-preview
  │    {services[], mode: preview-native, adopt: true, origin: <preview URL>, syncToken}
  ├─ seed the PR head: ONE helper pod (the Promote `withGithubToken` pattern)
  │    clones `pull/<n>/head` (depth 1, fork-safe), stages each service's
  │    repoSubdir filtered by syncPaths (+extraSync), gzip-tar-POSTs to each
  │    pod's http://<podIp>:<syncPort>/__sync with `x-sync-token`
  └─ D2 (flagged): dispatch the Playwright-critic workflow against the preview
       URL; verdict posted as a second sticky comment (`<!-- pr-preview-verify -->`)
```

Teardown: the Tekton `down` trigger → `POST {action:"down"}` → SEA
teardown-by-alias. The SEA PR-origin lifecycle (namespace labels
`vcluster-preview-origin`/`vcluster-preview-pr`, annotation
`vcluster-preview-expires-at`, TTL/GC + oldest-first PR eviction — humans
never) is owned by the SEA side (a4-lifecycle) and backstops missed webhooks.

## Flags & env (all default off / unset)

| Flag | Where | Effect |
|---|---|---|
| `PR_PREVIEWS_ENABLED` | dev BFF | Enables `POST/GET /api/internal/pr-previews*` (off → 404, so the Tekton lane no-ops harmlessly). |
| `PR_PREVIEW_VERIFY_ENABLED` | dev BFF | D2: dispatch the verify workflow when a preview reaches ready. |
| `PR_PREVIEW_VERIFY_WORKFLOW` | dev BFF | Name of the seeded critic workflow to dispatch (see “Verify” below). Unset → verify records `skipped`. |
| `PROMOTE_AUTO_PREVIEW_LABEL` | dev BFF | D2: Promote adds the `preview` label to the PRs it opens (one extra curl in the helper-pod shell). |
| `PR_PREVIEW_REPO` | dev BFF | Repo override (default `PittampalliOrg/workflow-builder`). |
| `PR_PREVIEW_TTL_HOURS` | — | Not read directly; the service passes `ttlHours` (default 24) on claim/provision. |

Enable on dev via the render-script hook pattern (see stacks
`packages/scripts/render-workflow-builder-release-overlays.sh`, precedent:
`wfb_preview_run_feed_patch` for `PREVIEW_RUN_FEED_ENABLED`) — dev-gated,
regenerate the overlay, never hand-edit the rendered env branch.

## LEAD ACTIONS (live changes — not performed by this build)

1. **GitHub webhook settings change (required):** the existing
   `PittampalliOrg/workflow-builder` webhook pointing at
   `https://tekton-hub.tail286401.ts.net` delivers only `push` today. In the
   repo settings → Webhooks, add **“Pull requests”** to its events (same
   secret; the interceptor already validates HMAC). Note: the
   `ensure-stacks-github-webhooks` Tekton step only manages the **stacks**
   repo's ArgoCD/Promoter hooks and never strips extra events, so this manual
   change is durable.
2. **Create the `preview` label** in the workflow-builder repo (plain label, no
   automation attached).
3. **Enable `PR_PREVIEWS_ENABLED` on the dev BFF** (render-script hook, above)
   — only after the BFF image containing this feature has rolled to dev.
4. Optional: seed a critic workflow + set `PR_PREVIEW_VERIFY_WORKFLOW` and
   `PR_PREVIEW_VERIFY_ENABLED`; set `PROMOTE_AUTO_PREVIEW_LABEL` to close the
   Promote loop.

## Durable pipeline records (#39)

Run state lives in the `pr_previews` table (one row per PR), NOT in BFF memory.
Why this is load-bearing, learned live on 2026-07-05:

- The dev BFF runs 2 replicas and the hub dispatch Task's status polls are
  conntrack-pinned to ONE backend — with in-memory records the poll usually hit
  the non-owner replica and the commit status pended forever.
- A Deployment rollout mid-run (any dev-overlay env regen re-rolls the BFF)
  killed the pipeline silently; nothing resumed it.

Mechanics (generation-fenced — `owner_gen` column):

- `up` upserts the record BEFORE dispatching and BUMPS the generation: the
  latest push wins, everywhere. Any older pipeline (same or other replica)
  aborts at its next write — every stage patch is a CAS on `owner_gen`.
- A 30s heartbeat (also fenced) keeps `updated_at` fresh while a pipeline runs.
- `status()` reads the row from any replica. A NON-TERMINAL row
  (provisioning/seeding) whose heartbeat is older than 120s is treated as
  orphaned: `claimStale` (guarded single-row `UPDATE … RETURNING`, bumps the
  generation) makes exactly one replica the new owner — a merely-STALLED
  previous owner is fenced out, not just a dead one. The resume reuses the
  interrupted run's recorded services and head; verify is not resumed.
- An ownership probe runs right before the seed POST, so a deposed pipeline
  cannot overwrite pods a newer run just seeded.
- `down` deletes the row, which fences out every surviving pipeline. The
  narrow window where an early-stage pipeline re-claims a preview after
  teardown leaves a zombie that the SEA TTL/GC backstop reaps (PR previews
  carry `ttlHours`).
- A record-less ready preview still reports `ready` (terminal) straight from
  the cluster.
- Stages log as `[pr-preview] pr=<n> stage=… ` — `kubectl logs deploy/workflow-builder
  -c workflow-builder | grep pr-preview` is the debugging entrypoint.

Trade-off: a status poll that lands between owner-death and the next poll can
report `ready` from the cluster-fallback while a re-seed is still pending —
accepted; the seed converges via resume or the next synchronize push.

## Capacity semantics

- **Claim-first**: pool claims consume an already-awake member — never
  capacity-gated (A3 invariant).
- **Cold fallback**: admission mirrors the user route (awake ≥ max → full). On
  full: `POST /internal/vcluster-preview/reap` once (SEA evicts the oldest
  PR-origin preview; **human previews are never evicted**), then retry once.
  Still full → state `capacity_full`; the Task posts a failing `pr-preview`
  commit status (“capacity full”) + sticky comment. Re-label (or push) to retry.
- PR previews share `VCLUSTER_PREVIEW_MAX` with everyone else; TTL default 24 h.

## Idempotency / re-seed

`up` is idempotent per PR: an existing `pr-<n>` preview is **re-seeded, never
re-provisioned** (`synchronize` = re-seed only). The per-preview sync token is
deterministic (`sha256(alias + INTERNAL_API_TOKEN)`), so re-seeds keep working
against pods provisioned by an earlier `up`. Dev-pod adoption is idempotent
server-side (SEA keys sandboxes on `(executionId=pr-<n>, service)`).

## Verify (D2) — current state

There is **no reusable URL-taking Playwright-critic workflow in the repo
today** (the generator-critic fixtures under `scripts/fixtures/generator-critic/`
are full coding pipelines). The dispatch is therefore **configured, not
hardcoded**: `WorkflowDispatchPrPreviewVerifyRunner` starts the workflow named
by `PR_PREVIEW_VERIFY_WORKFLOW` with trigger data
`{previewUrl, prNumber, headSha, source: "pr-preview-verify"}`, waits (bounded)
for the run, and posts `output.verdict` (or the raw output) as the
`<!-- pr-preview-verify -->` sticky comment. Gap to close: seed a critic
workflow that navigates `previewUrl` with the Playwright MCP agent and emits a
`verdict` output.

## Known assumptions / caveats

- **SEA contract (a4-lifecycle sibling, in flight):** `origin`/`prNumber`/`ttlHours`
  on claim + provision, PR-origin namespace labels/TTL annotation, and
  `POST /internal/vcluster-preview/reap`. This side tolerates an older SEA:
  a 422 on the extra fields retries once without them; a missing reap endpoint
  reads as “nothing reaped”.
- The preview BFF image must include this feature branch for the dev-pod call
  (`origin` passthrough on the internal dev-preview route) — previews pin the
  release image, so **live validation is gated on the image roll**.
- Seeding POSTs to pod IPs from the hub… no — from a helper pod on the DEV
  cluster; vcluster pods are host pods, so pod-IP reachability is flat. If a
  CNI policy ever blocks it, seed through the preview BFF instead.
- PR-preview status is in-memory on the dev BFF: after a BFF restart the GET
  reports `unknown` for an existing-ready preview (a fresh `up` re-establishes
  it). Acceptable for v1; a table is the upgrade path if it bites.
- Fork PRs work (seed fetches `pull/<n>/head` on the base repo), but the label
  gate means a maintainer must opt each fork PR in — that is the security
  boundary for running fork code in a preview.

## Live-validation checklist (after the lead actions)

1. Open a PR touching `src/…` only; add the `preview` label.
   - Commit status `pr-preview` goes **pending** → **success** with
     `https://wfb-pr-<n>.tail286401.ts.net` as target URL; sticky comment shows
     state `ready`, services `workflow-builder`.
2. Assert the URL serves the PR code: include a marker string in the PR (e.g.
   a visible footer change) and `curl` the preview URL for it.
3. Push a new commit (`synchronize`): status flips pending → success again;
   the marker updates; SEA shows no second provision (same `pr-<n>` ns).
4. PR touching `services/workflow-orchestrator/**`: sticky comment lists
   `workflow-orchestrator` (+ bff only if bff paths changed); orchestrator
   adopt pod serves the edit.
5. Capacity: with the cluster at `VCLUSTER_PREVIEW_MAX`, label another PR —
   oldest PR-origin preview is evicted (never a human's); if nothing is
   evictable the status reads “capacity full”.
6. Remove the label (or close the PR): teardown runs; sticky comment says torn
   down; `pr-<n>` namespace gone.
7. D2: enable `PROMOTE_AUTO_PREVIEW_LABEL`, run a Promote → the opened PR
   carries `preview` and auto-provisions. Enable verify flags → second sticky
   comment with the critic verdict.

## Files

- **wfb**: `src/lib/server/application/pr-previews.ts` (+ tests),
  `application/ports/pr-previews.ts`, `application/adapters/pr-previews.ts`
  (+ tests), routes `src/routes/api/internal/pr-previews/…`,
  `workflows/vcluster-preview.ts` (lifecycle fields + reap),
  `application/adapters/workflow-code-version-promotion.ts` (preview label),
  `application/config.ts` (flags).
- **stacks** (`packages/components/hub-tekton/manifests/outer-loop-builds/`):
  `EventListener-github-outer-loop.yaml` (2 pull_request triggers),
  `TriggerBinding-workflow-builder-pr-preview.yaml`,
  `TriggerTemplate-pr-preview-dispatch.yaml`, `Task-pr-preview-dispatch.yaml`,
  `Service-workflow-builder-dev-bff-egress.yaml`, `kustomization.yaml`.
