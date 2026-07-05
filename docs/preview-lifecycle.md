# Preview lifecycle: sleep / TTL / capacity / eviction (A4) + the D1 contract

How Tier-2 vcluster previews age out: activity tracking (touch), sleeping idle previews,
TTL teardown, and capacity eviction — plus the `origin`/`prNumber`/`ttlHours` contract the
PR-preview automation (D1) builds against.

**Everything ships OFF.** The three lifecycle flags default to `0`, the GC CronJob ships
`suspend: true`, and with the flags at 0 a reap pass only honors *explicit per-preview*
`vcluster-preview-expires-at` markers (which nothing sets until a caller passes `ttlHours`).
Merging this is inert for the live fleet.

> **TTL/sleep stay OFF until E3 lands.** A preview's DB — run history, transcripts,
> artifacts — dies at teardown. Until E3 (archive-on-teardown) exports run summaries +
> code-version bundles to the host, an automatic reap silently destroys the not-promoted
> iteration history. The flags existing is the A4 deliverable; the lead turns them on
> after E3.

## Design principle

The reaper NEVER trusts in-vcluster inactivity detection (tailnet HTTPS is invisible to the
vcluster API; in-vcluster Dapr chatter reads false-busy). Activity is what the **BFF knows**:
explicit `touch` calls from the points where a preview is actively *used*. Reads (list,
detail, status polls) never count.

## Flags (SEA env; wired via the stacks render-script dev hook)

| Env | Default | Meaning |
|---|---|---|
| `VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES` | `0` (off) | Sleep an **activity-tracked** preview idle this long. Free pool members and previews with no `last-active` annotation (legacy/human, e.g. the standing `gan-*`) are never slept. |
| `VCLUSTER_PREVIEW_TTL_HOURS` | `0` (off) | Global teardown age (from ns creation). Applies to **every** preview once on — see the gan-* warning below. Explicit `expires-at` markers are honored regardless of this flag; the effective expiry is the sooner of the two. |
| `VCLUSTER_PREVIEW_TOTAL_MAX` | `0` (unlimited) | Hard cap on ALL previews (awake + slept). Overflow is evicted in the locked order below. |
| `VCLUSTER_PREVIEW_MAX` | `6` | Now **awake-only**: slept previews hold no compute and don't count. `counts.awake` from the SEA list excludes slept members, so the BFF's cold-provision 429 gate is awake-only automatically. |
| `VCLUSTER_PREVIEW_ACTIVE_MINUTES` | `30` | "Recently touched" horizon — a preview touched inside this window is never evicted. |
| `VCLUSTER_PREVIEW_LIFECYCLE_RECONCILE_SECONDS` | `60` | Reaper thread cadence (thread starts only when one of the three flags above is > 0). |

Dev enablement goes through `stacks/scripts/gitops/render-workflow-builder-release-overlays.sh`
(the same hook that dev-scopes `VCLUSTER_PREVIEW_POOL_SIZE`): render with
`VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES_DEV` / `VCLUSTER_PREVIEW_TTL_HOURS_DEV` /
`VCLUSTER_PREVIEW_TOTAL_MAX_DEV` set, commit the regenerated dev overlay. Never hand-edit
`packages/overlays/` or the generated `workflow-builder-system-overlays/`.

## The D1 contract (request fields → namespace markers → list fields)

Request fields (both `POST /internal/vcluster-preview` and `POST /internal/vcluster-preview/claim`,
mirrored on the BFF client `launchVclusterPreview` / `claimVclusterPreview` /
`provisionVclusterPreview` via `VclusterPreviewLifecycleParams`):

| Field | Values | Effect |
|---|---|---|
| `origin` | `"user"` \| `"pr"` | ns label `vcluster-preview-origin`. PR-origin previews are evictable; human ones never are. Absent = legacy/human. |
| `prNumber` | int | ns label `vcluster-preview-pr` (with `origin: "pr"`). |
| `ttlHours` | int | SEA computes now+ttlHours and stamps ns annotation `vcluster-preview-expires-at` (RFC3339). Honored by any reap pass, independent of the global TTL flag. |

Stamping paths: a **claim** stamps everything SEA-side inside the same atomic
(resourceVersion-guarded) label flip that claims the member — no separate patch to race.
A **cold provision** passes `ORIGIN`/`PR_NUMBER`/`EXPIRES_AT` as Job env and the runner
stamps them at bringup (the ns doesn't exist when SEA accepts the request). The runner also
stamps `vcluster-preview-last-active` at the end of every bringup (the activity clock starts
when the preview becomes usable).

Namespace marker reference (host ns `vcluster-<real>`):

| Marker | Kind | Meaning |
|---|---|---|
| `vcluster-preview-state` | label | `slept` = scaled down; anything else/absent = hot. |
| `vcluster-preview-origin` | label | `user` \| `pr`; absent = legacy/human. |
| `vcluster-preview-pr` | label | GitHub PR number. |
| `vcluster-preview-protected` | label | `true` = the reaper/eviction/sleep NEVER touch it (operator tool). |
| `vcluster-preview-last-active` | annotation | RFC3339; absent = not activity-tracked (never slept). |
| `vcluster-preview-expires-at` | annotation | RFC3339 explicit expiry. |
| `vcluster-preview-slept-at` | annotation | RFC3339, informational. |

List endpoint (`GET /internal/vcluster-previews`) now surfaces per preview: `state`
(`hot`|`slept`), `origin`, `prNumber`, `expiresAt`, `lastActive`; counts gain `slept`,
`total`, `totalMax` (and `awake` becomes hot-only). `GET /internal/vcluster-preview/{name}`
surfaces the same fields; a slept preview reports `phase: "slept"` (its pods are
deliberately gone — probing would misread "provisioning").

## List classification (#29): pool members never masquerade as user previews

Incident (2026-07-05): a mid-bake pool member showed in the Dev-hub previews panel as an
ordinary preview named `pool-1251` and a user's one-click delete removed it (plus a claimed
PR preview in the same session — the delete had no confirm). Two fixes:

**SEA-side (the durable one).** `_compute_vcluster_previews` classifies every member by its
*effective pool state* (`_member_effective_pool_state`):

1. The `vcluster-preview-pool` label when present. Contract: the runner stamps `baking` at
   up-Job START (before the ~5 min bringup) and flips it to `free` at completion; claims
   CAS it to `claimed`; the recycler/reaper to `recycling`.
2. FALLBACK heuristic for bakes started by runner images that predate the `baking` stamp:
   a member whose id matches the pool-manager's generated shape (`pool-` + exactly 4 hex
   chars, from `secrets.token_hex(2)`) with NO pool label and NO alias label is treated as
   `baking`. Clearly commented in `app.py` for removal once no live member predates the
   runner change. Trade-off: a user COLD preview literally named e.g. `pool-ab12` is
   mis-hidden from the list (still works, still deletable by name) until then.

States `baking` / `free` / `recycling` are HIDDEN from the user list but still counted
(counts gain a `baking` key; `total`/`awake` capacity math unchanged). A `claimed` member
shows under its alias with `pool` (backing member id) and `poolState: "claimed"`.
`GET /internal/vcluster-previews?includePool=true` is the admin/debug escape hatch: every
member under its raw id with its `poolState`; unclaimed pool members carry
`tailnetHost`/`url: null` (the per-claim `wfb-<alias>` LB doesn't exist yet). The
`includePool` variant bypasses the burst cache in both directions so it can never be
served — or poison — the user list.

**UI-side.** The previews panel teardown now requires a `confirm()` whose message spells
out name + backing pool member + origin (`teardownConfirmMessage` in
`src/lib/components/dev/vcluster-preview-teardown-confirm.ts`; PR-origin previews warn
that PR close is the normal teardown path).

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /internal/vcluster-preview/{name}/touch` | Activity ping: stamps `last-active`. On a **slept** preview it also flips the state to hot and starts a resume-Job (`{"resuming": true}` — poll the GET until `ready`). |
| `POST /internal/vcluster-preview/{name}/sleep` | Explicit sleep (the reaper's mechanism, callable directly). 409 on protected/free members. |
| `POST /internal/vcluster-preview/reap` | Run ONE reaper pass synchronously; returns stats (`reapedExpired`, `evicted`, `sleptNow`, `total`, `awake`, `slept`). Optional body `{"needRoom": n}` additionally evicts `n` members via the locked order — the D1 consumer's make-room lever when capacity is full. |

BFF client: `touchVclusterPreview(name)` in `src/lib/server/workflows/vcluster-preview.ts`.
Called from: `launchVclusterPreview` after a successful claim (covers idempotent re-claims,
which don't restamp SEA-side), and `provisionDevPreview` when `mode: "preview-native"`
(alias derived from the `https://wfb-<name>.…` origin). There is no `/__sync` BFF proxy
route — `/__sync` is served by the dev pod sidecar directly, so no touch point exists there.

## Sleep mechanism (vcluster 0.34.1 OSS finding)

Researched against the v0.34.1 binary + source (`pkg/cli/pause_helm.go`,
`pkg/lifecycle/lifecycle.go`, `config/config.go`):

- **`vcluster pause` / `vcluster resume` (aliases `sleep`/`wakeup`) ARE fully OSS** with the
  default helm driver — pure client-go against the host cluster, no platform login.
  Mechanics: annotate the control-plane StatefulSet `loft.sh/paused=true` +
  `loft.sh/paused-replicas=<n>`, scale it to 0, delete host pods labeled
  `vcluster.loft.sh/managed-by=<name>`. PVCs/Services/Secrets untouched.
- **The `sleepMode:`/`sleep:` vcluster.yaml CONFIG is enterprise-gated** (`IsProFeatureEnabled`
  errors without a platform login; the OSS syncer contains no sleep controller). Config-based
  auto-sleep is not available to us — which is fine: the plan distrusts in-vcluster inactivity
  detection anyway; the reaper decides, the pause mechanics are just the mechanism.
- Our `runner.sh ACTION=sleep|resume` reimplements exactly the CLI's pause/resume with
  kubectl (no binary download in the sleep-Job; byte-auditable), **including the
  `loft.sh/paused*` annotations for CLI interop** — `vcluster list` shows Paused,
  `vcluster resume`/`vcluster connect` against a slept preview behave correctly
  (note: `vcluster connect` auto-resumes a paused vcluster).
- Gotchas: (1) **naked virtual pods don't survive** a sleep/resume (the restarted syncer
  deletes virtual pods whose host pods vanished; controller-backed workloads recreate) —
  active agent-session pods die, which is acceptable because sleep only targets idle
  previews; (2) storage keeps costing while slept (only compute is freed); (3) the tailnet
  LB proxies live in the host `tailscale` ns and stay up — the hostname survives sleep,
  requests just fail until resume (~60–120s: CP boot + syncer pod recreation + BFF rollout).

Free pool members are **exempt from sleep**: a slept free member would blow the <90s claim
budget on a surprise cold resume, and the whole point of the pool is claim-readiness. The
claim path also skips slept free members defensively (manual force-sleep only).

## Eviction order (the pure selector `_select_preview_evictions`)

When a reap pass needs room (TOTAL_MAX overflow, or an explicit `needRoom`):

1. **free-slept** — slept free pool members (manual force-sleep only), oldest first
2. **free-hot surplus** — free hot pool members BEYOND the `POOL_SIZE` target, oldest first
3. **TTL-expired** — expired non-free members (explicit marker, or creation+TTL when the
   global flag is on), soonest-expired first
4. **PR-origin** — non-expired `origin=pr` previews, oldest-created first

NEVER evicted: protected members, terminating/recycling members, **recently-active** members
(touched within `VCLUSTER_PREVIEW_ACTIVE_MINUTES`), and **human previews** (origin absent or
`user`) that are not expired. The selector is a pure function
(`services/sandbox-execution-api/src/app.py`) with exhaustive unit tests
(`tests/test_vcluster_lifecycle.py`).

Hard safety rules, enforced in code: only namespaces labeled `app=vcluster-preview` are ever
considered (the runner refuses `ACTION=sleep` on anything else too); members with an
in-flight down/sleep/resume Job are skipped for the tick; pool members are flipped to
`recycling` BEFORE their down-Job (the proven recycler order, so claims can't grab a dying
member).

### Protecting the standing gan-* previews

`gan-*` have no `last-active` annotation (never slept) and no origin label (never evicted,
never TTL'd while the global flag is 0). **BUT: enabling the global `VCLUSTER_PREVIEW_TTL_HOURS`
WILL eventually reap them** (they are months old). Before enabling global TTL, the lead
must protect them:

```sh
kubectl label ns vcluster-<gan-name> vcluster-preview-protected=true   # per gan preview
```

`vcluster-preview-protected=true` exempts a preview from sleep, TTL, and eviction entirely.

## GC CronJob backstop

`stacks/packages/components/workloads/workflow-builder-preview-vcluster/lifecycle/CronJob-preview-lifecycle-reap.yaml`
— every 30 min, curls `POST /internal/vcluster-preview/reap` with the shared
`INTERNAL_API_TOKEN`. Ships `suspend: true`. It exists because the SEA reaper is an
in-process thread in a `replicas: 1` Deployment — the CronJob is the belt-and-suspenders
against thread death, and the manual lever:

```sh
kubectl -n workflow-builder patch cronjob preview-lifecycle-reap --type=merge -p '{"spec":{"suspend":false}}'
kubectl -n workflow-builder create job --from=cronjob/preview-lifecycle-reap reap-now
```

## SEA memory posture under pool churn (#32)

Evidence: SEA OOMKilled at 512Mi (2026-07-05 ~04:0xZ, twice) and at 1Gi (06:15Z — the
container came up 06:06Z and hit the limit in ~9 min of extreme churn: ~10
bakes/recycles/claims per hour + reap passes + heavy list polling). Restarts clean;
steady-state RSS afterwards ~360Mi.

What the investigation found (2026-07-05, reading + local repro):

- **No unbounded Python structure.** Module state is the bounded burst cache only; pod
  lists are label-filtered; OTEL uses a bounded `BatchSpanProcessor` queue.
  `tests/test_memory_regression.py` now locks this in: 400 churn cycles
  (list+probe / includePool list / pool reconcile / reaper pass) must retain <1 MiB.
- **Per-call kubernetes clients were pure churn** — every `_load_k8s_*` call built a
  fresh `ApiClient` (own urllib3 `PoolManager`, CA-bundle load, new TLS handshakes) per
  request handler AND per 60s background tick. Fixed: one process-cached `ApiClient`
  (`_k8s_shared_api_client`, token-rotation-safe via `refresh_api_key_hook`,
  `connection_pool_maxsize` floored at 16 for the 8-way probe fan-out). Honest
  measurement (`scripts/memleak_probe.py`, read-only lists against dev): single-threaded,
  fresh-vs-cached both plateau (~2.3 MiB warmup) — so this alone was NOT the leak; it is
  a defensible churn-removal, not the smoking gun.
- **The amplifier was the un-single-flighted list compute.** Under churn the burst cache
  is invalidated on every claim/bake/recycle, and every concurrent poller (UI 8s poll,
  BFF replicas, D1 dispatch status polls — each on its own anyio worker thread, pool of
  40) then ran the FULL `_compute_vcluster_previews` simultaneously: N namespace lists +
  N×8 fresh probe threads + N complete deserialized pod-list snapshots alive at once.
  Synchronized allocation bursts like that set peak RSS, and glibc returns freed pages to
  arena free lists — not the OS — so each burst ratchets RSS toward the limit. That
  matches the observed shape exactly (fast climb under churn, clean restart, no leak at
  rest). Fixed: the list endpoint single-flights its compute (one computes, concurrent
  callers briefly block and read the refreshed cache; `?includePool=true` and the
  cache-off `TTL=0` debug config keep the old behavior).

Re-run the evidence probe (read-only; needs a reachable context):

```sh
cd services/sandbox-execution-api
uv run python scripts/memleak_probe.py --mode fresh  --iterations 300 --context admin@dev
uv run python scripts/memleak_probe.py --mode cached --iterations 300 --context admin@dev
```

Post-roll watch: `kubectl -n workflow-builder top pod -l app=sandbox-execution-api`
during a churn window — expect the sub-1Gi sawtooth to flatten. Do NOT raise the limit
further as a fix (1Gi already applied in stacks #3531).

## Live-validation checklist (lead actions — nothing here ran during the build)

Prereqs: dev SEA image rolled to a build containing this change; the
`dev-workflow-builder-preview-vcluster` app synced (new runner.sh ConfigMap + CronJob).
All flags still 0 — every step below uses explicit levers.

1. **Protect gan-***: label all standing human previews `vcluster-preview-protected=true`.
2. **Inertness**: `POST /internal/vcluster-preview/reap` → expect all-zero stats besides
   `total/awake/slept`; no Jobs created; gan-* untouched.
3. **Touch**: `POST /internal/vcluster-preview/<existing>/touch` → `last-active` annotation
   appears; list shows `lastActive`; state stays `hot`; the touched preview still serves.
4. **Explicit sleep**: `POST /internal/vcluster-preview/<idle-test-preview>/sleep` → ns label
   `vcluster-preview-state=slept`; `vcpreview-sleep-*` Job completes <60s; CP StatefulSet
   0/0 with `loft.sh/paused=true`; host pods gone; PVCs present; `vcluster list` shows
   Paused; the wfb-<name> URL now fails (LB up, backend gone); list shows `state: slept`,
   `phase: slept`, and `counts.awake` dropped by 1 while `counts.total` held.
5. **Touch-resume**: touch the slept preview → `{"resuming": true}`; `vcpreview-resume-*`
   Job; BFF Ready again; URL serves; state hot. Record resume latency (expect 60–120s).
6. **Claim-of-slept**: sleep a CLAIMED pool member, then re-claim the same alias via the BFF
   launch → response `status: "resuming"`, member wakes, no duplicate claim-Job.
7. **D1 fields**: provision a throwaway with `{"origin":"pr","prNumber":9999,"ttlHours":1}`
   → ns labels/annotation stamped (cold path = runner; claim path = CAS flip); list surfaces
   `origin/prNumber/expiresAt`.
8. **Explicit-TTL reap**: after (7), set `vcluster-preview-expires-at` to the past (or wait
   the hour), run the reap Job → exactly that preview gets a down-Job (`reapedExpired: 1`);
   gan-* and everything else untouched.
9. **needRoom eviction**: with a PR-origin test preview standing, `POST reap {"needRoom": 1}`
   → it (and nothing human) is evicted.
10. **Sleep reaper (flagged)**: render dev with `VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES_DEV=30`,
    let a touched test preview idle >30 min → reaper sleeps it; free pool members stay hot;
    gan-* stay hot. Revert the render afterwards (leave 0 until E3).
11. **CronJob**: unsuspend, `create job --from=cronjob`, confirm HTTP 200 + stats in logs,
    re-suspend.

## B3b (in-cluster dev-image rebuild) — DROPPED, blocker documented

The stretch `POST /internal/dev-image-build` buildkit lane was dropped at the cred-plumbing
gate, per plan: GHCR **push** credentials exist only hub-side (the outer-loop Tekton
carve-out); dev carries pull-only `ghcr-pull-credentials`. A dev `wfb-dev-builds` ns would
need (a) a GHCR PAT with `write:packages` added to the hub→spoke shared-secrets replication
(`dev-shared-secrets` ESO-over-Tailscale path) + an ExternalSecret in the new ns, and (b) a
GitHub repo-read token for the clone — both hub secret-store changes that cannot be
validated build-only and that widen the push-credential blast radius to a spoke. A manual
dev-image rebuild lane already exists via the hub outer loop (stacks#3529); revisit B3b
after a deliberate decision on spoke-side push creds.
