# Code-Version Persistence for Long-Running Code Workflows

**Status:** SHIPPED. **Last updated:** 2026-06-29.

> **Implementation note (2026-06-29):** The recommended **Pattern B2 (git bundles in the Files
> API)** is SHIPPED (#290) for runs whose code lands in `/sandbox/work`, AND extended with a
> **dev-pod-as-source `tar-overlay`** path for the in-preview GAN loop (code that lives only behind
> the dev pod's `/__export`). Both feed ONE durable-version → manual **Promote → PR** pipeline. See
> §6.1 for the as-built summary; the design discussion below (§§1–6) is retained for context.

> What durable substrate should hold the code our agentic workflows produce, so we can
> **preview the impact** of a change, keep **many versions across many runs/iterations**,
> and **apply** the good ones — *without* opening a pull request for every version?

This doc compares how the leading agentic coding platforms solve this, evaluates our current
system honestly against that bar, and recommends a path that reuses what we already have.

---

## 1. The problem

We run long-running workflows (e.g. the GAN-harness dashboard loop) that produce code over
many turns and many refine iterations, often across many runs of the same workflow. We want to:

1. **Persist** the produced code durably (survives the per-run sandbox being reaped).
2. **Preview** the impact before committing to it — both the *diff* and the *rendered* result.
3. **Apply** a chosen version to a real repo (PR) — **only the ones we accept**.
4. Handle **many versions** without a branch/PR per iteration (no PR sprawl, no manual patch-apply).

For greenfield outputs (no upstream repo) the persisted version *is* the deliverable; for existing
repos, "apply" means a PR to that repo.

---

## 2. Current system (grounded in live data)

We already have most of the **primitives**; the gap is durability + a cross-run UX.

| Capability | Status | Mechanism (verified) |
|---|---|---|
| **Diff preview** | ✅ durable | `workflow_artifacts` kind `diff`: per-node `git diff` (baseline..working), inline ≤256 KB else gzip→`files`; rendered via diff2html in the run **Changes** tab. Survives workspace reaping. *(Prior GLM dashboard run `oMLOMHbJ…`: 9 diff artifacts across negotiate/generate/evaluate_ui.)* |
| **Rendered preview** | ✅ (while workspace alive) | Playwright critic **screenshot** + **`.webm`** walkthrough (browser-artifacts) + the live-preview proxy (`cli-live-preview` / openshell sandbox-preview). |
| **Git-native version primitive** | ⚠️ built, **remote OFF** | `workflow_code_checkpoints`: a git commit per agent edit — `beforeSha`/`afterSha`/`changedFiles`, **plus fields for a durable push** (`remoteUrl`/`remoteRef`/`remoteStatus`/`remotePushedAt`). Diff + **restore** APIs exist. `should_checkpoint_tool` fires per tool-use; the remote is Gitea-backed (`WORKFLOW_CHECKPOINT_GIT_*` / `GITEA_*` + `GITEA-TOKEN`, gated by `WORKFLOW_CHECKPOINT_GIT_REMOTE_ENABLED`). |
| **Durable, re-accessible *code*** | ❌ | On the last completed run, **115/115 checkpoints had `remoteStatus=skipped`** — commits were created locally (`afterSha` set) but never pushed. They lived only in the JuiceFS `/sandbox/work` workspace, which is later GC'd (`sandbox-gc`). So the *actual code* of a past version is gone; only the diff *blobs* survive. |
| **Apply** | ⚠️ during-run only | The `pr` node (`workspace/command`, currently `skipped:true` in the fixtures) computes repo/base/title and can push a branch / open a PR — but only while the workspace is alive. No "pick version N from run M later and apply." |

**Storage facts that shape the design:**
- `/sandbox/work` is **per-execution + reaped** — the wrong durability domain for an archive.
- On dev, **JuiceFS data already lives in MinIO** (metadata in Postgres). JuiceFS shines at
  *shared, live, large/sequential* I/O and is catastrophic for small-file churn (npm install ~11 min) —
  see `docs/juicefs-sandbox-storage.md`.
- The **Files API** is already a content-addressed blob store (**SHA-1 dedup, 25 MB cap**), used for
  artifacts + session outputs.

**Net:** we can *view* any past diff forever, but we cannot *retrieve or apply the actual code* of a
specific run/iteration after the fact. It's "screenshots of versions," not "a shelf of versions you can
check out and ship."

---

## 3. How the industry does it

Five research clusters (cloud-VM agents, local-git agents, greenfield builders, plus the Claude Code
harness source). Four dominant patterns emerge.

### Pattern A — "Git is the database" (durable from step one)
Every iteration is a real commit on a real branch; **one branch + one PR per task**; iterate via new
commits on the *same* branch; rollback = plain git. No cheap internal checkpoint layer; sprawl is
controlled *socially* (same-branch iteration), not mechanically.
- **Jules** (temp VM → branch+PR), **GitHub Copilot coding agent** (`copilot/*` branch, incremental
  commits to a draft PR; can only push to branches it created), **Sweep** (branch+PR per issue),
  **Aider** (auto-commit per AI edit straight into local git; `/undo` = `git reset HEAD^`),
  **Factory (Action mode)**, **Codegen** (repo layer).
- Trade-offs: simplest, GitHub-native, audit-friendly, nothing proprietary to lose; but **no instant
  whole-environment rewind**, history is only as clean as commit discipline, and every attempt touches git.

### Pattern B — "Cheap internal checkpoints during iteration → durable PR only on acceptance" *(the one we want)*
Two sub-flavors by *what* gets snapshotted:

- **B1 — VM/container image snapshots.** Snapshot the whole machine cheaply (copy-on-write, block-level),
  iterate/fork/rollback against snapshots, emit a git PR only as the *publish* step.
  - **Devin** — the canonical implementation: `blockdiff` (FIEMAP + `cp --reflink` CoW; ~200 ms to snapshot
    a 20 GB disk) on Firecracker-lineage microVMs → "practical to snapshot frequently." Forkable
    save-states; rollback of files *and* runtime state; git PR only on publish. ([blockdiff](https://cognition.com/blog/blockdiff))
  - **Cursor cloud agents** — agent loop in **Temporal** (durable execution) decoupled from the VM;
    **hibernate/resume + checkpoint/restore/fork VM images**; `commitAfterEachStep:false` → one clean
    commit on completion; PRs ship with screenshots/videos. ([cloud-agent-lessons](https://cursor.com/blog/cloud-agent-lessons))
  - **Codegen** — persistent sandboxes + filesystem/image snapshots across runs (substrate undisclosed).
  - **OpenAI Codex (cloud)** — *partial*: ephemeral container per task + 12 h cache (speed, not rollback);
    git is the version store; **best-of-N** (`--attempts N`) runs N containers, only the chosen one → PR. ([codex cloud](https://developers.openai.com/codex/cloud))
  - Trade-offs: near-instant rollback of code **and** runtime (deps/processes/DB); forkable bases cut cold-start.
    Costs: heavy custom infra (custom snapshot format, hypervisor, durable orchestration); proprietary,
    non-portable snapshot graph.

- **B2 — File/content snapshots in a side store (not git).** Snapshot just the working-tree files (or full
  app state) per prompt, separate from git; git/GitHub is reserved for accepted work.
  - **Claude Code / Agent SDK** — per-prompt **file-backup store** in `~/.claude/file-history/<session>/<hash>@vN`
    (lazy copy-on-write per changed file, ≤100 snapshots, 30-day retention); `/rewind` restores code and/or
    conversation. Explicitly *"checkpoints as local undo, Git as permanent history."* **Gap: only Write/Edit/
    NotebookEdit are tracked — Bash edits (`rm`/`mv`/`sed -i`) are not.** ([checkpointing](https://code.claude.com/docs/en/checkpointing))
    *Separately*, for transferring a workspace to the Cloud Code Runtime it uses **git bundles**
    (`utils/teleport/gitBundle.ts`): `git stash create` → `update-ref refs/seed/stash` → **`git bundle create --all`**,
    with a **size-tiered fallback** (`--all` → `HEAD` → squashed-root via `commit-tree`, 100 MB cap) → **upload
    the `.bundle` to the Files API** → store the file-id for remote seeding → clean up the seed refs. One-way
    transfer, not continuous sync.
  - **Replit** — the most engineered B2: **content-addressed CoW manifests (16 MiB chunks in GCS) + a git
    commit per checkpoint + Neon DB branches** → whole-environment checkpoint incl. conversation and DB.
  - **Cursor local editor agent** — local non-git checkpoint before each AI change.
  - Trade-offs: cheaper than VM snapshots; fast undo; can include things git won't (conversation, DB).
    Costs: a proprietary store to build + GC; **frequent gaps** (Claude Code Bash, Bolt DB, destructive
    restore in Zed); two systems (snapshot store + git) to reconcile.

### Pattern C — "In-browser/sandbox runtime + live preview, internal versions, export on ship"
Greenfield builders run the *app itself* for instant live preview, snapshot a version per message
internally, and treat GitHub as an export/sync target.
- **v0 (Vercel)** — per-message version history → **one branch per chat** (`v0/main-…`) with auto-commit
  per code-changing message → "never pushes to main", opens a PR; previews in Vercel Sandbox. ([v0 versions](https://v0.app/docs/versions))
- **Bolt.new** — in-browser **WebContainers** (ephemeral in-memory FS) + internal checkpoint timeline +
  **two-way GitHub sync**; *rollback restores code but NOT DB state*.
- **Lovable** — snapshot **after every AI interaction**, non-destructive restore (like a revert commit),
  two-way GitHub sync on the default branch. ([Lovable versioning](https://lovable.dev/blog/versioning-with-lovable-two-point-zero))
- Distinguishing trait: preview is a **running app**, not a diff. Trade-off: divergence risk between the
  internal store and git; DB state often excluded from rollback.

### Pattern D — "Git worktrees for isolation" (a building block, not a full strategy)
Isolated checkouts for parallel agents without separate clones: **Zed** (worktree git-state saved/restored
with thread history), **Devin Review**, **Cursor/Codex** (worktree-per-task). Pairs with A or B.

### Cross-industry takeaways
- Two philosophies dominate: **git-as-truth (A)** vs **snapshot-as-truth-with-git-as-publish (B)**. The
  async cloud leaders split — Jules/Copilot are pure A; Devin/Cursor are pure B1; Codex straddles.
- The **"cheap checkpoint → durable PR on acceptance" pattern is real and converging**, implemented at the
  **VM-image** layer (Devin, Cursor, Codegen), the **file/content side-store** layer (Claude Code, Replit,
  v0/Bolt/Lovable), or **not at all** (Jules, Copilot, Sweep, Aider).
- **Honest finding:** *no* platform documents a **hosted git server (Gitea/GitLab), git bundles, or a bare
  repo** as its durable version store. Where snapshots aren't used, the store is plain **git/GitHub**.
  Git **bundles** appear once — Claude Code's **one-way workspace teleport** — exactly the "pack the working
  tree into a blob, store it in a file store, rehydrate elsewhere" shape we need.

---

## 4. Where we fit, and the gap

We're a hybrid already: our **diff artifacts** play the B2 *cheap-preview* role (but they store *diffs*, not
restorable file-snapshots); our **`workflow_code_checkpoints`** is the git-native primitive (Pattern A/B
seam) but with the durable remote **switched off**; our **`pr` node** is the apply step (Pattern A publish).
Our **rendered preview** (screenshot/`.webm`/live proxy) matches Pattern C's instinct.

**The gap is narrow and specific:**
1. The produced **code** isn't persisted durably (commits die with the reaped workspace; only diff blobs live).
2. No **cross-run version browser** to compare iterations across runs and pick one.
3. No **apply-on-accept** that turns a *chosen past version* into a PR on demand.

We do **not** need Devin-class VM snapshots — those buy runtime+DB rollback we don't require, at a large
infra cost. We need a durable place for the **source**, plus the promote UX.

---

## 5. Options for the durable store (the one real decision)

We removed Gitea previously for size/resource reasons. Re-evaluated against our constraints (preview is
already durable via diff artifacts; the store only needs to hold *code for checkout/apply*):

| | **Gitea** (reintroduce) | **Git bundles** in Files-API/MinIO | **Bare repo on a PVC** (`file://`) |
|---|---|---|---|
| Standing compute | ❌ pod + DB load 24/7 (the reason it was removed) | ✅ none — just blobs | ✅ none (no daemon) |
| Durability | ✅ repo PVC | ✅ content-addressed object store | ✅ PVC |
| Web browse/compare/blame | ✅ native | ❌ needs rehydration *(but preview = diff artifacts → not needed)* | ❌ |
| Native PR + webhooks | ✅ (our PR trigger speaks it) | ❌ rehydrate → push GitHub → PR (have `pr`-node logic) | ❌ |
| Dedup across runs | ✅ packfile dedup over all refs | ⚠️ per-bundle; mitigate w/ source-only or `base..tip` thin bundles + Files-API SHA dedup | ✅ packfile dedup |
| Concurrency (many parallel runs) | ✅ server arbitrates | ✅ write-once blob per version → no contention | ⚠️ concurrent pushes race without a server |
| Apply a past version later | ✅ `git fetch <ref>` | ✅ fetch bundle → `git clone` → push/PR | ✅ `git fetch` |
| Ops surface | upgrades, backups, DB, stateful svc | ~zero (GC = delete blobs) | low (PVC + locking care) |

**Gitea resource cost (if reintroduced):** single Go binary — idle ~**150–250 Mi** RAM, ~**400–512 Mi** under
clone/push; ~**100m** CPU idle, bursty; ~**150 MB** image; a Gitea schema on the existing Postgres (or SQLite
on its PVC); a repo PVC ~**10–20 Gi** (source-only + dedup, grows slowly, GC-able). Modest in raw numbers, but
it's a **standing stateful service** with an upgrade/backup surface — the real cost, and the original reason
it was dropped.

**Can JuiceFS make bundles faster?** No meaningful win:
- A bundle is one large **sequential** file — JuiceFS's strength (the npm-install pain was *small-file*
  metadata churn, the opposite), so it wouldn't *hurt*.
- But it won't *help*: a bundle is a single object PUT/GET that MinIO does directly; on dev **JuiceFS data
  already lives in MinIO**, so "bundle on JuiceFS" = "bundle in MinIO + an extra metadata round-trip."
- The JuiceFS path you'd reach for (`/sandbox/work`) is the **reaped per-run workspace** — wrong durability
  domain. The apply-latency cost is the local `git clone`/unpack on scratch, which JuiceFS doesn't touch.
- → Store bundles in the **Files API / MinIO**, not JuiceFS. JuiceFS's value is *shared live workspaces*,
  not immutable archives.

---

## 6. Recommendation

**Adopt Pattern B2 with git bundles in the Files API** — the same shape Claude Code uses for teleport, and the
best fit for our reaped-workspace + no-standing-compute constraints. Reuse existing primitives; don't
reintroduce Gitea.

1. **Persist (bundle on accept-worthy checkpoints).** At session/iteration end, in the agent's local scratch
   repo, capture the source as a bundle — mirror Claude Code's technique:
   `git stash create` (capture WIP) → `git bundle create` of the **source tree** (exclude
   `node_modules`/`.svelte-kit`/`build`; for size, prefer a squashed single-commit tree or `base..tip` thin
   bundle). Source-only bundles are **KB–MB**, well under the Files-API 25 MB cap, and SHA-1-dedup across
   identical iterations. Upload via the **Files API**; record the `file_id` on `workflow_code_checkpoints`
   (use the existing `remote*` columns or add a `bundleRef`/`bundleFileId`). This flips checkpoints from
   local-only → durably re-accessible **with no PR and no server.**
2. **Preview (already have it).** Diff = existing `diff` artifacts (Changes tab). Rendered = screenshot/`.webm`
   /live-preview proxy. Nothing new needed.
3. **Browse versions (new, thin UI).** A cross-run **Versions** surface over `workflow_code_checkpoints`
   (keyed by `repoPath`/`workflowExecutionId`/`afterSha`/`bundleRef`/`changedFiles`): list iterations across
   many runs of the same target, each linking its diff + rendered preview.
4. **Apply on accept (new action).** A **"Promote → PR"** button that, for a chosen version: downloads the
   bundle → `git clone` to scratch → pushes a branch to the real GitHub repo → opens a PR (the existing
   `pr`-node logic / a BFF action). **PR only for the chosen version** — no PR-per-iteration. For greenfield
   targets, the bundle itself is the deliverable (offer download / "create repo from this version").
5. **GC.** Bundles are immutable blobs → retention by age/count per workflow; deleting a blob is the whole GC.

**Phasing:**
- **P1 — durability:** add bundle-on-checkpoint + Files-API upload + `bundleRef` on the checkpoint row.
  (Highest leverage: versions become re-accessible.)
- **P2 — promote:** the "rehydrate bundle → branch → PR" BFF action + a button on the run page.
- **P3 — versions hub:** the cross-run Versions browser (fold into the Observe-hub direction,
  `docs/monitoring-ui-unification.md`).
- **P4 — (optional) richer restore:** "fork from version N into a new run" (rehydrate the bundle as the
  starting workspace) — our analogue of Devin/Cursor forkable save-states, achieved with bundles instead of
  VM images.

**Deliberately rejected:** reintroducing Gitea (standing stateful service we removed; its web-UI/PR
advantages are redundant given diff artifacts + the GitHub `pr` path); VM/image snapshots (Devin/Cursor B1 —
buys runtime+DB rollback we don't need at high infra cost); bundles on JuiceFS (no speed win; wrong
durability domain).

---

## 6.1 As-built (SHIPPED)

Two capture paths feed **one** durable-version → manual Promote → PR pipeline. The discriminator is the
`source-bundle` artifact's `inlinePayload.tier`; promotion routes on it.

**A. `/sandbox/work` runs → git bundle (#290).**
- `cli-agent-py/src/workspace_diff_sync.py::_BUNDLE_SCRIPT` + `sync_source_bundle_activity` (dapr mirror
  `sync_source_bundle_openshell`) builds a cloneable git bundle of the agent's tree at session end —
  tiered `full → thin → squashed`, excludes `node_modules`/build, ≤20 MB.
- `src/lib/server/workflows/source-bundle.ts::persistSourceBundle` → Files API blob (SHA-1 dedup, 25 MB
  cap) + a `workflow_artifacts` row `kind:"source-bundle"`.

**B. Dev-pod-as-source (in-preview GAN) → `tar-overlay`.** The produced code lives only on the dev pod
behind `GET /__export` (the agent edits in a reaped per-pod scratch repo and `/__sync`-pushes); the
`/sandbox/work` bundle producer is empty/wrong for these runs. So:
- `src/lib/server/workflows/dev-preview.ts::captureDevPreviewSource(executionId,{nodeId,iteration})`
  resolves the persisted dev-preview pod (`podIP`/`syncPort` from the `workflow_workspace_sessions`
  row), fetches `http://<podIP>:<syncPort>/__export?paths=<syncPaths>` (tar.gz, `x-sync-token`), skips
  empty/>25 MB, and calls `persistSourceBundle` with `contentType:"application/gzip"`,
  `tier:"tar-overlay"`, and `inlinePayload {repoUrl, repoSubdir, syncPaths, base, iteration}` (self-
  contained — promote never needs the registry).
- **Per-iteration capture:** the `preview-dev-gan` fixture calls a `snapshot` node
  (`dev/preview-snapshot` → internal `POST …/dev-preview/snapshot {nodeId,iteration:${.idx}}`) right
  after `generate` inside the refine loop, so **every iteration's design is a distinct, promotable
  version** (the deterministic artifact id includes `iteration`). A best-effort capture in
  `teardownDevPreview` is the fallback when no snapshot node runs.

**Promote (manual, on-demand — zero standing compute).**
`POST /api/workflows/executions/[id]/versions/[artifactId]/promote {mode:"pr"|"branch"}` provisions a
`withGithubToken` helper pod and, keyed on `tier`:
- `full|squashed` → `git clone` the bundle; `thin` → clone target + `git fetch` the bundle;
- `tar-overlay` → `git clone --depth 1 -b <base>` the base repo, `rm -rf` each `syncPath` under
  `repoSubdir`, `tar -xzf` the export over it, commit.
Then push a `wfb-promote-<ts>` branch and open a PR. **A PR is created only for the version you pick** —
no PR per iteration. In a Tier-2 preview vcluster (schema-only DB, no app-connection rows) the helper
falls back to the **pod-level PAT** (`GITHUB_TOKEN` from `workflow-builder-secrets`); the in-pod
`[ -n "$GH" ]` guard returns `ERR=no_github_token` gracefully if neither is present.

**UI.** `GET /api/workflows/[workflowId]/versions` (cross-run) and `GET …/executions/[id]/versions`
(per-run). The Dev-hub detail page (`/workspaces/[slug]/dev/[executionId]`) shows a **Code versions**
panel (`code-versions-panel.svelte`): one row per version (iteration · tier · size · time) with a
per-row **Promote → PR** button that renders the returned PR link.

---

## 7. Verification

- **A (`/sandbox/work`):** run a code workflow → each accepted checkpoint has a `source-bundle`
  artifact; after reap, download the bundle and `git clone` it to recover the exact source.
- **B (`tar-overlay`):** run `preview-dev-gan` (`workflow-builder`, `mode:preview-native`,
  `adopt:false`) → `GET …/executions/[id]/versions` shows **one `tar-overlay` version per iteration**,
  non-zero `sizeBytes`, payload carrying `repoUrl/repoSubdir/syncPaths/base/iteration`.
- **Promote:** from a chosen iteration click **Promote → PR** → a PR opens against
  `PittampalliOrg/workflow-builder@main` with the overlaid `src` diff (run inside a Tier-2 preview to
  exercise the pod-PAT path); non-chosen iterations get no PR. Re-promoting a different iteration yields
  a distinct branch/PR; re-capturing UPSERTs (deterministic per-iteration id, no dup).
- **Dedup/GC:** identical iterations share one Files-API blob; age/count retention deletes old blobs.

---

## 8. Related docs
- `docs/juicefs-sandbox-storage.md` — why JuiceFS is for shared live workspaces, not small-file/archive I/O.
- `docs/workflow-artifacts.md` — the `diff`/typed-artifact pipeline that already powers preview.
- `docs/monitoring-ui-unification.md` — the Observe hub the Versions browser should fold into.
- `docs/browser-session-live-view-and-recording.md` — the screenshot/`.webm` rendered-preview layer.
