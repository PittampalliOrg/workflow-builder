# Agent Workspace, Build & GAN-Loop Best Practices (research synthesis)

**Status:** RESEARCH / DIRECTION. Synthesizes external best-practice research (Dec 2026) for the two
problems our long-running code-producing workflows hit: (1) a **durable, cross-pod-shared workspace**
that is *also* fast to build in, and (2) a reliable **generator ↔ evaluator (GAN) refinement loop**.
Maps the findings onto our actual architecture (`dapr-agent-py-juicefs` pool, `/sandbox/work` JuiceFS
mount, the GAN-harness fixtures) and gives concrete, phased recommendations.

Related SSOTs: `dapr-agent-py-sandbox-architecture.md` (3 workspace backends + juicefs convergence),
`juicefs-sandbox-storage.md` (JuiceFS tuning), `interchangeable-agents-and-per-phase-selection.md`
(per-phase agent mix), `gan-harness-workflow.md` (the GAN harness), `generator-critic-multi-agent.md`
+ `goal-loop-evaluator-design.md` (evaluator design), `sandbox-warm-pools.md` (cold-start),
`code-version-persistence.md` (durable produced code).

---

## 0. The problem, in our terms

A GAN-harness coding run dispatches several `durable/run` agent nodes (plan → negotiate →
generate → gate → evaluate → publish) that **share one workspace** so a later node (the deterministic
gate, the independent critic) sees what an earlier node (the generator) produced. We implement that
shared workspace as a **per-execution JuiceFS RWX CSI mount at `/sandbox/work`** (the `juicefs-shared`
backend). JuiceFS is a *network/object-backed* filesystem: great for cross-pod sharing + durability,
**bad for `node_modules`-style tiny-file build churn** (thousands of metadata round-trips).

Our first attempt to get fast builds — **W3 local-build mode** — set the agent's CWD to a local
`/sandbox/scratch/repo`, seeded it from work, and synced scratch→work at session end. This collided
with the fixture prompts (which tell the agent to edit `/sandbox/work/repo` directly) and the stale
scratch seed **clobbered the generator's edits every iteration** (see git history / the W3-disable
fix). W3 has since been disabled, which fixed correctness but reintroduced naive `npm install` on
JuiceFS. This doc establishes the *correct* pattern.

---

## 1. What the industry actually does (workspace + build)

Across production coding-agent platforms there is **no single standard**, but a dominant finding:

> **Almost nobody builds over a slow shared/network filesystem.** Cloud agents converge on
> **git-as-truth + an ephemeral fast-local-disk build env + a warm dependency snapshot**; the one
> system that explicitly *does* "build over a durable shared source" (OpenHands) does it with a
> **copy-on-write overlay** so build churn never hits the shared lower layer.

Four patterns, by platform:

| Pattern | Who | Shape | Tradeoff |
|---|---|---|---|
| **A. Git-as-truth + ephemeral local build + warm snapshot** | Codex, Copilot, Jules, Claude Code (cloud), Cursor | source = git; build on throwaway local-disk VM/container; cold dep-install decoupled via a cached FS/container snapshot (Codex 12h container, Jules Environment Snapshots, Cursor install-snapshot, Copilot `copilot-setup-steps.yml`); a maintenance/SessionStart hook reconciles drift | needs snapshot+setup script; uncommitted work lost when env reclaimed |
| **B. One CoW disk, snapshots make it durable** | Devin (`blockdiff`, XFS+reflink, ~200ms 20GB delta) | durable source and fast build are the *same* CoW disk | heaviest infra (custom hypervisor) |
| **C. CoW block store + local cache + async write-back** | Replit (`margarine`, 16MiB chunks→GCS; Neon DB branches) | build on fast local btrfs that caches a network block store; flush dirty blocks on commit | bespoke multi-tier storage |
| **D. CoW overlay over durable shared source** | OpenHands `:overlay` (`SANDBOX_VOLUME_OVERLAYS`) | shared source = RO lowerdir; all build writes → fast-local upperdir | upper-layer artifacts not durable unless synced; upperdir must be fast disk |
| **E. (non-pattern) bake deps into image layers** | SWE-bench, SWE-agent, OpenHands' own deps | deps `pip install -e .`/`npm ci` at *image build time*; hot path only checks out source + incremental install | image rebuild to change deps |

**Implication for us:** our `juicefs-shared` RWX mount is the cross-pod *sharing* tier (we need it for
the multi-agent GAN loop — git-as-truth alone can't share an *uncommitted* working tree across pods).
But we must stop building over it. The directly-applicable techniques are **D (overlay)** and the
`node_modules`-redirect + **E (bake base deps into the warm-pool image)**.

---

## 2. `node_modules`/builds on a network FS — concrete techniques

`node_modules` is tens of thousands of tiny files; cost is dominated by **per-file metadata
round-trips**, not bandwidth. Keep the high-churn artifacts (`node_modules`, package-manager
cache/store, build output) off the network FS and on **local NVMe/tmpfs**, while keeping source durable
on the network FS. Ranked:

1. **Redirect `node_modules` + cache/store to local disk via the package manager** (cleanest; the
   source dir stays a real directory). pnpm: `store-dir`/`modules-dir`/`virtual-store-dir` — but store
   and modules **must be on the same local FS** (cross-FS = pnpm silently *copies* instead of
   hard-linking) and absolute `modules-dir`/`virtual-store-dir` have open corruption bugs (pnpm #5800,
   #10243). npm: `npm install --cache /local/npm-cache`. Yarn Berry **PnP** (`nodeLinker: pnp`)
   eliminates `node_modules` entirely — best if the toolchain supports it.
2. **Bind-mount / K8s volume at `<workdir>/node_modules`** (RECOMMENDED for us). A bind mount is
   invisible to module resolution (real path = mount point) and **sidesteps every `preserve-symlinks`
   bug**. In K8s: an `emptyDir` (or `emptyDir{medium:Memory}` tmpfs, with `sizeLimit`) mounted at
   `<workdir>/node_modules` + `npm_config_cache`/pnpm store on another `emptyDir`.
3. **Symlink `node_modules` → local disk** (portable but pitfall-laden): `npm install` may clobber the
   symlink (create target first; use `--no-bin-links`); **symlink the `node_modules` *directory* only,
   never individual packages or the project root** (duplicate-instance/peer-dep failures). Resolution
   knobs diverge per tool — Node `--preserve-symlinks`, Webpack `resolve.symlinks:false`, TS
   `preserveSymlinks:true` (*inverse* of Webpack), and **Jest has no preserve-symlinks support** (a
   known pnpm+Jest sore spot).
4. **Copy-to-local, build, copy-artifacts-back** ("checkout-to-tmpfs"): treat the network FS as
   durable *storage*, not a *working* FS. This is what our gate + evaluator nodes already do
   (`tar -C /sandbox/work/repo … | tar -C /sandbox/scratch/repo`).
5. **overlayfs** (Pattern D): lower = JuiceFS, upper+work = local SSD. Note: **NFS is invalid as an
   overlay upperdir** (no d_type/xattrs) — only the *lower* may be the slow FS; upper must be local.
6. **Bake `node_modules`/pnpm store into the warm-pool image** → hot path is `pnpm i --offline` /
   incremental install (the SWE-bench/OpenHands approach; fits our per-image warm pool).

**Pitfall to avoid:** building directly on JuiceFS with no redirect (our current W3-disabled state) —
fine for tiny repos (is-number), slow/timeout-prone for large repos (the SvelteKit dashboard).

### JuiceFS-specific (if a build must touch it)
- `--writeback` is the single biggest install win (10k small entries: ~2 min → ~5–10 s), staged
  locally + async-uploaded; pair with `--upload-delay` so npm's churned temp files never upload.
  **Caveats:** staged data is lost on node death and invisible cross-node until uploaded — acceptable
  for ephemeral `node_modules`, **never** for the durable source.
- Raise `--entry-cache`/`--dir-entry-cache`/`--attr-cache` + enable `--negative-entry-cache` (module
  resolution does huge numbers of negative lookups).
- `--dir-stats` + `juicefs quota --inodes` per run to cap a runaway `node_modules`.
- **Metadata tier = Redis (or TiKV), NOT Postgres**; **data tier = object store (MinIO/S3), NOT
  data-in-Postgres** — the tiny-file create/link storm is the documented worst case (matches our own
  `juicefs-sandbox-storage.md` findings).

---

## 3. Upstream `kubernetes-sigs/agent-sandbox` (what we build on)

The upstream Sandbox CRD (`agents.x-k8s.io`, now `v1beta1` ~v0.5.0; we run older `v1alpha1`) gives each
sandbox: stable identity, persistent storage that survives restarts, lifecycle (create/scheduled-delete/
pause/resume). Relevant primitives:

- **Durable+fast workspace = `volumeClaimTemplates`** (StatefulSet semantics): the controller reattaches
  the *exact same PVC* on pod recreate/reschedule. Docs explicitly list **"caching dependencies across
  agent runs"** and **"build artifacts"** as the VCT use case — i.e. upstream wants build state on a
  **block PVC (ReadWriteOnce), fast**, not on network/FUSE.
- **Cross-pod sharing = RWX FUSE/GCS CSI** — and upstream gives *no* perf guidance for it, implicitly
  unsuited to build-heavy small files. **RWX is for sharing/handoff only, never the build root.**
- **Snapshots (gVisor)** = filesystem+memory checkpoint, but **same-instance only** (non-portable, can't
  seed a fresh warm pod) → suspend/resume cost control, *not* cross-agent handoff.
- **WarmPool + Claim**: per-session storage is attached **at claim time** (`SandboxClaim.volumeClaimTemplates`)
  so a generic warm pod becomes session-specific on claim. (Our warm-pool blocker is a *different* axis —
  static Dapr app-id breaks `call_child_workflow` placement — which upstream does not address.)
- **Self-reap = `shutdownPolicy: Delete` + `shutdownTime`/TTL** (we already do this).

**Takeaway:** the upstream-idiomatic answer is **block PVC for durable+fast build state, RWX only for
sharing.** Our GAN loop needs RWX (multi-pod), so we land on the hybrid: **RWX-shared source + local
(emptyDir/block) `node_modules`/build per pod** — §2.2.

---

## 4. OpenShell (NVIDIA) — not the workspace/build answer

OpenShell (`github.com/NVIDIA/OpenShell`, our `services/openshell-sandbox` base image) is a
**policy-governed security sandbox**: declarative YAML policy over filesystem/network/process/inference,
per-binary egress allowlists with SHA-256 trust-on-first-use, gateway + egress proxy. Its strength is
**security**, which browser-use genuinely needs. It documents **no** build-cache, dependency-management,
or workspace-tiering best practice, and our own `dapr-agent-py-sandbox-architecture.md` already concludes
the remote mTLS-RPC + ~4–8 KiB stdout-truncation model is the *slowest* surface for build work and
recommends moving non-browser workloads onto `juicefs-shared`. **Keep OpenShell for browser-use; do not
look to it for workspace/build patterns.** Worth retaining from it: the per-binary egress allowlist +
TOFU integrity model (stronger than coarse NetworkPolicy).

---

## 5. Generator ↔ evaluator (GAN) loop — best practices

Our contract-negotiation + execution-grounded + independent-critic design is **squarely on-pattern**
with the literature (Reflexion, Self-Refine, AlphaCodium, Agentless, Anthropic evaluator-optimizer,
LangChain RubricMiddleware, Dapr/Diagrid). Canonical principles + the upgrades we should adopt:

- **Independent evaluator** (separate context/model from the generator) with a **rubric / per-criterion
  atomic scoring**, not a holistic score. ✔ we do this.
- **Execution-grounded, two-tier authority** (STRONGLY recommended): tier 1 = **deterministic execution**
  (build + tests + lint) owns hard pass/fail; tier 2 = independent LLM-judge with a frozen rubric for the
  subjective dims execution can't measure (design quality), ideally with **voting** (multiple judges →
  harder to deceive all at once). "Run the code, don't judge the transcript" is the single strongest
  finding (Reflexion's unit-test reward → 91% HumanEval; Agentless reranks patches by *test results*).
- **Negotiate testable acceptance criteria up front and FREEZE them** — recognized pattern (AlphaCodium
  problem-reflection + test-reasoning + AI-test-gen pre-phase; RubricMiddleware rubric-at-invoke;
  Anthropic's "clear evaluation criteria" prerequisite). ✔ our `contract.json` negotiation is exactly
  this; the "model ignores prose count/schema" failure → correctly solved by a deterministic
  normalizer, not stricter prose.
- **Contract/tests are IMMUTABLE and evaluator-owned** — a documented reward-hacking mode is the
  generator weakening the tests/criteria. Instrument file access if the generator shares the workspace.
- **Bound the loop**: hard **iteration cap** (universal) + **objective K-consecutive-no-progress** stall
  detector keyed on a real metric (count of failing criteria) — don't let the generator/critic *declare*
  done.
- **Detect no-op iterations by diffing candidate vs prior** — reject/flag empty-or-trivial diffs as
  non-progress. **(This would have surfaced our W3 clobber instantly — every iteration's diff was
  empty.)**
- **Test anchors**: once a criterion passes, lock it; any later revision that breaks an anchored
  criterion fails the revision (stops oscillation / "fix B by regressing A").
- **Rich per-iteration feedback**: concrete failing cases (expected vs actual), per-criterion verdicts,
  and a **progress memory** (Reflexion episodic buffer; our `progress.json`) so iterations don't
  rediscover the same failures.

---

## 6. Recommendations for our platform (phased)

**R1 — Decouple build artifacts from the shared source (the W3 replacement).** Keep source-of-truth on
the `/sandbox/work` JuiceFS RWX mount (needed for GAN cross-pod sharing). Mount a **per-pod local
`emptyDir` at `/sandbox/work/repo/node_modules`** (bind-mount semantics — §2.2, avoids
`preserve-symlinks` bugs) and set `npm_config_cache`/pnpm store-dir to another local `emptyDir`. The
agent edits source on JuiceFS (durable, no clobber); installs/builds write to local disk (fast). Honor
the ns LimitRange (bump mem request with any tmpfs limit). *This is the clean, industry-aligned form of
the W1 idea, independent of the (now-disabled) W3 edit-in-scratch scheme.*

**R2 — Bake base deps into the warm-pool image** (Pattern E) so the hot path is an *incremental* install,
never a cold `npm install` over the network. Fits the existing per-image warm pool (`sandbox-warm-pools.md`).

**R3 — (optional, more elegant) overlayfs** (Pattern D / OpenHands `:overlay`): JuiceFS source = RO
lower, local SSD = upper+work. Single mount gives durable source + fast writes; requires host-side/CSI
mount privilege. Evaluate vs R1 (R1 is simpler and sufficient).

**R4 — JuiceFS hardening** (already partly tracked): Redis metadata + object-store data tier (off
Postgres), per-run `quota --inodes`, and — only if any build must touch JuiceFS — `--writeback` +
`--upload-delay` + raised metadata/negative-entry caches scoped to throwaway dirs.

**R5 — GAN-loop upgrades** to the harness: add **no-op-diff detection**, **test anchors**, an **objective
K-no-progress stall** signal, and make the **contract immutable/evaluator-owned**; keep the two-tier
(deterministic gate + LLM judge) authority. (See `goal-loop-evaluator-design.md` /
`generator-critic-multi-agent.md`.)

**R6 — Keep OpenShell for browser-use only**; continue converging non-browser runtimes onto
`juicefs-shared` (per `dapr-agent-py-sandbox-architecture.md`).

### What NOT to do
- Don't build (`npm install`) directly over JuiceFS for non-trivial repos (current W3-disabled state —
  fine for is-number, slow for the dashboard).
- Don't reintroduce the W3 edit-in-scratch + scratch→work sync (it clobbers; superseded by R1).
- Don't symlink individual packages or the project root (only the `node_modules` dir, and prefer
  bind-mount).
- Don't put JuiceFS metadata/data in Postgres for tiny-file workloads.
- Don't let the generator edit the contract/tests; don't judge transcript-only when execution is possible.

---

## 7. Sources

Workspace/build architecture: Devin `blockdiff` (cognition.com/blog/blockdiff), Cursor cloud agents,
Replit snapshot engine + Neon branches, Claude Code sandboxing/web/devcontainer, OpenAI Codex
environments (`codex-universal`), GitHub Copilot coding-agent env, Google Jules environment snapshots,
OpenHands runtime (`:overlay`), SWE-agent/SWE-ReX, SWE-bench harness, Sourcegraph Amp/Cody; OverlayFS
kernel docs; Firecracker snapshotting. node_modules/network-FS: JuiceFS cache/writeback/AI-perf docs,
pnpm symlink/store docs + issues #1515/#5800/#10243, K8s volumes (emptyDir/tmpfs), AWS CodeBuild local
caching, yarn #8689 (EFS), TS `preserveSymlinks`, Webpack `resolve.symlinks`, Jest #5356.
agent-sandbox: agent-sandbox.sigs.k8s.io (volumes/VCT/gcsfuse/snapshots/lifecycle/gvisor), Northflank
write-up. OpenShell: github.com/NVIDIA/OpenShell, langchain-ai/openshell-deepagent, Red Hat AI+OpenShell.
GAN loops: Reflexion (arXiv 2303.11366), Self-Refine (2303.17651), AlphaCodium (2401.08500), Agentless
(2407.01489), Anthropic "Building Effective Agents", LangChain RubricMiddleware, Dapr/Diagrid
evaluator-optimizer, LLM-as-judge survey (2411.15594).

---

## Follow-ups (filed)

These are tracked here because the repo has GitHub issues disabled.

### F1 — `code_checkpoint` should write to a SHADOW git ref (not HEAD)
**Why:** `code_checkpoint` (dapr-agent-py) auto-commits every Edit/Write into the
workspace **HEAD**, so `git diff` (HEAD vs working-tree) is always empty. That broke
the GAN contract's `git diff` verify commands + the no-op check, and code agents
**worked around it** (a glm-5.2 generator switched to `bash` sed/python to avoid the
auto-commit). **Interim fix shipped:** `DAPR_AGENT_PY_CODE_CHECKPOINT_ENABLED=false`
on the `dapr-agent-py-juicefs` pool (PR#300 + stacks). **Trade-off:** the run page's
**Code** tab (`workflow_code_checkpoints`) + per-checkpoint **restore-to-sandbox** no
longer appear for juicefs runs (the **Changes**/diff tab + `source-bundle` artifacts
cover viewing + durable retrieval, but not in-UI per-tool restore).
**Proposal:** rewrite `code_checkpoint` to snapshot into a shadow ref/dir (mirror the
diff-capture's `.wfb-diff-git` / `refs/wfb/baseline` pattern) so the agent's HEAD/
working-tree stay untouched (clean `git diff`) AND checkpoints + Code-tab restore keep
working — then `CODE_CHECKPOINT_ENABLED` can default back on.
Refs: `services/dapr-agent-py/src/code_checkpoint.py`; call-site gate
`_code_checkpoint_enabled` in `main.py`; shadow-ref pattern in
`services/dapr-agent-py/src/workspace_diff_sync.py`; tabs in
`src/routes/workspaces/[slug]/workflows/[workflowId]/runs/[executionId]/+page.svelte`
(`hasCodeTab`/`hasChangesTab`).

### F2 — R1 v2: fast builds without nesting a mount in the JuiceFS volume
R1 (emptyDir at `/sandbox/work/repo/node_modules`) was **reverted** — nesting an
emptyDir inside the RWX JuiceFS CSI mount broke the juicefs pods' view of the cloned
source (empty repo). Redo as non-nesting copy-to-local-build (generator builds in a
`/sandbox/scratch` copy like the gate/evaluator already do) — or accept the gate's
scratch build is the authoritative one and the generator's inline npm is slow. Measured:
local `npm ci` ≈ 18s vs ~11min on JuiceFS, so this matters for large repos.

### F3 — Apply the read_verdict GAN upgrades to `cli-showcase` + `dapr-showcase`
The no-op/anchor/immutability upgrades were applied only to the two dapr-family
fixtures (juicefs-pilot + glm-visual-dashboard). Apply the same patch format-preserving
to `gan-harness-cli-showcase` + `gan-harness-dapr-showcase` (they weren't indent-2; a
json reformat is a ~1400-line diff — patch the read_verdict command string in place).

### F4 — Contract-immutability: lock at `read_contract`, not first `read_verdict`
Today the `contract.lock.json` snapshot is taken on the first `read_verdict`. Move it to
`read_contract` (end of negotiate, before any generate) to close the iteration-0
tamper window.
