# Preview observe + archive (E2/E3) and per-service session UX (B5)

Wave 4/5 of the dev-env-v2 plan: the Dev hub observes every Tier-2 preview's
run history through a read proxy (E2), preserves run summaries + un-promoted
code bundles when a preview is torn down (E3), and renders multi-service dev
sessions as one environment with per-service cards + sidecar controls plus a
restore-all teardown sweep (B5). Everything is flag-gated and default-OFF.

## Flags

| Flag | Default | Where read | Effect |
|---|---|---|---|
| `PREVIEW_READ_PROXY_ENABLED` | off | host BFF (`application/config.ts`) | Enables `GET /api/dev-environments/previews/[name]/executions[/{executionId}]` + the per-preview "Recent runs" panel on the Dev hub |
| `PREVIEW_ARCHIVE_ON_TEARDOWN` | off | host BFF | `DELETE /api/dev-environments/vcluster/[name]` archives run summaries + un-promoted source bundles BEFORE issuing the SEA teardown |
| `PREVIEW_READ_PROXY_TIMEOUT_MS` | 4000 | host BFF (adapter) | Per-request proxy timeout |

Enable on dev via the render-script hook pattern (see
`stacks/scripts/gitops/render-workflow-builder-release-overlays.sh`, the
`wfb_preview_run_feed_patch` block that already injects
`PREVIEW_RUN_FEED_ENABLED` into the dev BFF env — extend it, regenerate the
overlay; never hand-edit the generated overlay).

B5 (grouped read model, per-service cards, sidecar status/run routes, teardown
restore-all) is NOT flagged — it is additive read-model/UI surface plus a
strictly-conservative restore sweep.

## E2 — read proxy

### Auth: the shared INTERNAL_API_TOKEN (deliberate choice)

`runner.sh` copies the host `workflow-builder-secrets` Secret — including
`INTERNAL_API_TOKEN` — verbatim into every preview vcluster at provision
(`copy secret` loop). Preview BFFs therefore accept the host's own internal
token on their existing `/api/internal/*` guards (`requireInternal` /
`validateInternalToken`), for previews that already exist today, with zero new
key machinery.

Alternatives considered:

- **Deterministic per-preview key (the smoke-key pattern)** — the seeded
  `wfb_smoke_<name>` keys are derived from the preview NAME ALONE (no secret;
  `runner.sh` seeds `sha256("wfb_smoke_<name>")` into the preview's
  `api_keys`). They authenticate as the ADMIN USER against the full v1 API —
  a broader credential than needed, no secret in the derivation, and no
  derivation helper exists in the codebase today. Rejected: strictly more
  work for a strictly worse credential.
- **New minted-per-preview read key** — requires provision-path changes in
  stacks + a new guard; brings no isolation benefit while the whole
  `workflow-builder-secrets` Secret is copied into the vcluster anyway.

The proxy sends `X-Internal-Token`. Reads hit only existing internal READ
routes (list/detail/artifacts/file-content); nothing is written to previews.

### Reachability: in-cluster synced Service first, tailnet fallback

vcluster syncs preview Services onto the host cluster, so the preview BFF is
reachable from the host BFF pod as

```
http://workflow-builder-x-workflow-builder-x-<backing>.vcluster-<backing>.svc.cluster.local:3000
```

(verified live on dev, e.g. `workflow-builder-x-workflow-builder-x-gan-claude`
in ns `vcluster-gan-claude`). `<backing>` is `pool ?? name` — a CLAIMED
warm-pool member keeps its pool-named namespace/services, the user alias is
display-only (identical rule to the E1 feed streams). When the composed
service name would exceed the 63-char DNS label limit (the syncer
hash-truncates unpredictably), the adapter falls back to the preview's tailnet
URL (`https://wfb-<name>.tail286401.ts.net`) — note host-pod tailnet egress is
not guaranteed; in-cluster is the designed path (preview names are short in
practice: prefix leaves 25 chars).

Preview names are ALWAYS resolved against SEA's `GET /internal/vcluster-previews`
list; caller input is never used to construct a URL directly (no SSRF surface).

### Routes and degradation

- `GET /api/dev-environments/previews/[name]/executions?limit=&status=` —
  session-gated, flag-gated (404 when off). Proxies the preview's
  `GET /api/internal/agent/workflows/executions`.
- `GET /api/dev-environments/previews/[name]/executions/[executionId]` —
  proxies `GET /api/internal/workflow-data/executions/[executionId]`.

Unknown preview → 404. Known-but-failing preview → HTTP 200 with
`result: { ok: false, reason: "unreachable" | "unauthorized" | "not-found" | "bad-response" }`
— the UI renders "preview unreachable", never a 500. Timeouts are short
(default 4s).

### Dev-hub UI

`vcluster-preview-panel.svelte` grows a per-preview expandable **Recent runs**
panel (`preview-runs-panel.svelte`): proxy hydrate + 30s poll + live re-fetch
when the E1 feed sees an event for that preview (bridged via
`$lib/stores/preview-run-events.svelte.ts` — one SSE connection total, owned
by the feed panel). Each run row deep-links into the preview's own UI:
`<preview-url>/workspaces/default/workflows/runs/<executionId>` (observe
centrally, interact locally).

### Hexagonal shape

- Port: `PreviewReadProxyPort` (+ `PreviewReadResult`, `PreviewExecutionSummary`,
  `PreviewArtifactSummary`) in `application/ports/observability.ts`.
- Adapter: `application/adapters/preview-read-proxy.ts` (`HttpPreviewReadProxy`,
  `previewApiBaseUrl`).
- Services: `application/preview-read-proxy.ts`, wired in `application/index.ts`
  (`previewReadProxy`, `previewArchive` getters).

## E3 — archive on teardown

`DELETE /api/dev-environments/vcluster/[name]` (the ONLY BFF caller of
`teardownVclusterPreview`) now runs, when `PREVIEW_ARCHIVE_ON_TEARDOWN` is on
and BEFORE the SEA teardown (the preview DB dies with the vcluster):

1. **Run summaries** — up to 200 executions via the E2 proxy.
2. **Un-promoted source bundles** — per execution,
   `GET /api/internal/workflow-data/executions/[id]/artifacts?kind=source-bundle`
   (a NEW internal GET added in this change — previews on older app images
   fail this leg uniformly and the archive degrades to summary-only, noted in
   the summary JSON); bundles whose `metadata.promotion` marker exists are
   skipped (already durable as a PR); blob bytes via the preview's existing
   `GET /api/internal/files/[id]/content`; capped 20 bundles / 25 MiB each /
   ~45s soft deadline.
3. **Storage** — host Files API (`workflow_artifacts` rows FK onto HOST
   `workflow_executions`, which a preview's executions don't exist in, so the
   `files` table is the durable home):
   - `scopeId: "preview-archive:<name>"`, `purpose: "output"`, owned by the
     user who tore the preview down;
   - `preview-<name>/run-summary-<ts>.json` — schema `wfb.preview-archive/v1`:
     `{ preview{name,pool,url}, archivedAt, executionsTotal, executions[],
     bundles[], bundleErrors, artifactListingDegraded, notes[] }`;
   - `preview-<name>/bundle-<artifactId>.tar.gz` per copied bundle.
   `createFile` dedups on (userId, scopeId, name, sha1) → re-archiving is
   idempotent.

**Failures never block teardown**: any archive error (unknown preview,
unreachable, thrown) resolves to `archive: { archived: false, reason }` in the
DELETE response and the teardown proceeds. The runner.sh down-Job is untouched.

Query archives later: `GET /api/v1/files?scopeId=preview-archive:<name>`
(session) or `GET /api/internal/files/[id]/content` (internal token).

## B5 — per-service session UX + restore-all

### Grouped read model (additive)

- `DevEnvironmentGroupReadModel` in `ports/workflows.ts`;
  `listDevEnvironmentGroups` on the repository/facade; pure transform in
  `application/dev-environment-grouping.ts`.
- `GET /api/dev-environments` returns `{ environments, groups }` (flat list
  unchanged for back-compat). The Dev-hub grid renders one card per EXECUTION
  with per-service ready chips.
- `GET /api/dev-environments/[executionId]` returns `{ environment, services }`.

### Per-service cards (detail page)

`dev-service-card.svelte` per service: ready dot, dapr app-id, browse link,
sidecar `/__status` (last sync time/bytes), and run buttons for the registry's
allowlisted commands. BFF proxy routes (session-gated):

- `GET /api/dev-environments/[executionId]/services/[service]/sidecar-status`
- `POST /api/dev-environments/[executionId]/services/[service]/run` body `{cmd}`

The pod address comes from the persisted row's `syncUrl` (pod-IP:syncPort —
the exact mechanism `captureDevPreviewSource`'s `/__export` already uses, with
the same `WFB_DEV_SYNC_TOKEN` / `x-sync-token` auth). Command names are
validated BFF-side against the registry (`deps` + `testCommands`) before the
request leaves the host; the sidecar's `DEV_SYNC_COMMANDS_JSON` allowlist is
the second gate. Plugin-sync services (no sidecar) degrade to "no-sidecar".

### Teardown restore-all sweep (SEA-side, `services/sandbox-execution-api/src/app.py`)

The sweep lives next to `_adopt_restore_deployment` because that's where the
per-CR restore and all K8s clients live (the preview's own SEA runs inside
each vcluster, so the same code covers host Tier-1 rows and in-preview adopt).

- `_adopt_restore_orphans(apps, custom, namespace)`: restores every Deployment
  carrying `wfb-dev-preview/original-replicas` **at 0 replicas** that **no
  live Sandbox CR claims** (`wfb-dev-preview/adopt-deployment` annotation).
  Conservative: CR-list failure → restore NOTHING; replicas > 0 → untouched
  (a stale stash must not rewrite live scale); per-deployment failures are
  logged and skipped.
- Runs opportunistically at the end of `DELETE /internal/dev-preview/{name}`,
  and standalone via **`POST /internal/dev-preview/restore-orphans`** (internal
  token), which the BFF `teardownDevPreview` fires after its per-sandbox loop —
  including when NO session rows exist (the SEA-restart orphan case).
- Also fixed: the Dev-hub DELETE route passed the primary row's `sandboxName`
  into teardown, so a multi-service session only tore down ONE service's
  Sandbox (stranding sibling prods at 0). It now omits `sandboxName` → the
  loop covers every per-service row.

## Live-validation checklist (for the lead, dev cluster)

Preconditions: merged images rolled to dev; flags set on the dev BFF
(`PREVIEW_READ_PROXY_ENABLED=true`, `PREVIEW_ARCHIVE_ON_TEARDOWN=true` via the
render-script hook); do not disturb `gan-*`; A3 pool budget applies.

1. **Two-preview proxy render (E2)**: with two ready previews (one CLAIMED
   pool member among them if possible), open the Dev hub → vcluster panel →
   expand "Recent runs" on both. Expect: lists render (in-cluster path — check
   BFF logs show no tailnet fallback), the pool-claimed member lists via its
   pool-named service, rows deep-link into each preview's own run page.
   Trigger the seeded smoke (`preview-agent-smoke`) in one preview → with the
   E1 feed on, the runs panel re-fetches within ~2s of the feed event.
2. **Degradation**: expand runs on a preview mid-provision (or tear one down
   while its panel is open) → "preview unreachable (…)", HTTP 200, no 500s.
3. **Teardown-with-archive (E3)**: run the data-plane smoke in a scratch
   preview, Promote nothing, then DELETE it from the panel. Expect: DELETE
   response carries `archive: { archived: true, summaryFileId, … }`;
   `GET /api/v1/files?scopeId=preview-archive:<name>` lists the summary (+
   bundle files if the session produced code versions); teardown completes
   normally. Repeat with an unreachable preview name variant → `archived:false`,
   teardown still proceeds.
4. **Orphan restore sweep (B5)**: in a dev-mode preview with an adopted
   service, delete the dev-preview Sandbox CR out-of-band (simulating an SEA
   restart losing the CR) while the prod Deployment sits at 0 with the
   annotation; then tear down the session from the Dev hub. Expect: SEA log
   `adopt: orphan sweep restored [...]`, prod back at its stashed replicas,
   annotation cleared. Negative check: with a SECOND active adopt session
   running, its Deployment (claimed by a live CR) is untouched by the sweep.
5. **Multi-service UX (B5)**: launch a 2-service dev session → ONE card on the
   grid with two service chips; detail page shows two service cards; sidecar
   status renders for the sidecar-mode service; `contract` run button streams
   output; teardown restores BOTH prods (watch `kubectl get deploy -w`).
