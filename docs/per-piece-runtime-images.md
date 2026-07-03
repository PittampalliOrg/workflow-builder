# Per-Piece Runtime Images — scoping the alternative to the single bundle

**Question:** Today every `ap-<piece>-service` runs ONE shared `piece-mcp-server` image carrying all bundled pieces. What if each piece had its **own** Knative Service backed by its **own** image — built/deployed **only when enabled**? How resource-intensive is that?

**Short answer:** It's the structurally correct model for "enable any of the ~665 catalog pieces." It **removes** the three costs that the single-bundle model keeps hitting (per-pod memory that scales with bundle size, cross-piece dependency conflicts, and a full-bundle rebuild per change), at the price of **N small images to build/store** and a **build-on-enable pipeline**. **Yes, you can build+deploy strictly on enable** — that's the main win. Idle compute stays at zero either way (scale-to-zero); the real new cost is image storage (~150–250 MB incremental per enabled piece) and CI build orchestration.

---

## 1. Why this is on the table — the single-bundle costs (all hit live, 2026-06-13)

The converged piece-runtime (`docs/activepieces-integration-architecture.md`) compiles **all bundled pieces into ONE image**; every `ap-<piece>-service` runs that image parameterized by `PIECE_NAME` and calls `getPiece(PIECE_NAME)`. Bundling **ntfy** (47→48 pieces) surfaced every cost of that coupling:

1. **Per-pod memory scales with the *whole* bundle.** Each per-piece pod imports **all** bundled pieces at module load (the static `PIECES` registry), even though it serves one. 47 pieces fit in `--max-old-space-size=400` / 512 Mi; adding ntfy (+ a nested `framework@0.30.0`) **OOMKilled** `ap-ntfy-service` (exit 139, allocation failure ~384 MB) → had to bump **every** `ap-<piece>-service` to 640-heap / 896 Mi. This grows with each piece, for all services.
2. **Cross-piece dependency conflicts.** ntfy needs `pieces-framework@0.30.0` while the bundle pins `0.25.2`; other catalog pieces pull a broken `axios@1.15.2`. The bundle is curated to ~46 partly to dodge this — you **cannot** bundle arbitrary pieces.
3. **A change to one piece rebuilds everything.** Adding ntfy = rebuild the whole image + re-pin + re-sync; a bad piece can break the bundle build for all.
4. **The seed/reconcile also load the bundle** → the metadata-sync OOM'd, and the reconcile slowed as the catalog grew.

The catalog expansion makes **665 pieces discoverable as metadata**, but the bundle can only ever *run* the curated handful. Per-piece images close that gap.

---

## 2. What the per-piece-image model looks like

### 2a. Images: one thin base + a per-piece layer
- **`piece-runtime-base`** — the `piece-mcp-server` server code (the `/execute` + `/mcp` + `/options` + `/health` shell) with **no pieces**. Built once.
- **`ap-piece-<name>:<piece-version>`** — `FROM piece-runtime-base` + `RUN npm install @activepieces/piece-<name>@<ver>` (the piece + the exact framework version IT declares). This is exactly what the catalog snapshot generator already does per piece (isolated install) — promoted from "extract metadata" to "bake a runnable image."
- GHCR **deduplicates the shared base layer**, so the incremental storage per piece is just its `node_modules` diff (~150–250 MB).

### 2b. Runtime: load the one installed piece, not a static bundle
`piece-mcp-server` changes from importing the static `PIECES` map to resolving the **single installed** package matching `PIECE_NAME` (a few-line change to `getPiece` / `piece-registry` — dynamic `import(@activepieces/piece-${PIECE_NAME})`). A pod then loads **one** piece → memory bounded to ~one piece + framework (~150–250 MB), regardless of catalog size. No `--max-old-space-size` arms race.

### 2c. Provisioning: the reconciler picks a per-piece image ref
Today the reconciler templates **one** `PIECE_MCP_IMAGE` into every KService. Instead it reads a **per-piece image ref** (from a `piece_images` table / the registry: `{piece, version, image, digest}`) and provisions `ap-<piece>-service` with **that** image. KService **count is unchanged** — only the image each runs changes.

### 2d. The enable flow (the part you asked about)
```
admin clicks "Enable ntfy"
  → CI builds ap-piece-ntfy:0.2.5  (if not already cached)   ← compat gate: install+import+smoke test
  → records {ntfy, 0.2.5, ghcr.io/…/ap-piece-ntfy:0.2.5, digest}
  → reconciler provisions ap-ntfy-service from that image
  → ntfy is runnable (scale-to-zero)
disable → reaper removes the KService (image stays cached for re-enable)
```

---

## 3. Your three questions, answered

### Q1 — "What would it look like?"
A **base runtime image** + **per-piece images** (base + one `npm install`), a **small runtime refactor** (load the installed piece dynamically instead of the static bundle), a **`piece_images` registry** mapping piece→image, a **reconciler tweak** (per-piece image ref, not the shared one), and a **per-piece build job** (reuse the snapshot generator's isolated-install + a compat gate). Everything else — the `ap-<piece>-service` KService shape, scale-to-zero, function-router dispatch, credential reference-forwarding — is unchanged.

### Q2 — "Can we deploy only after enabling?" → **Yes, and that's the point.**
- The **665-piece catalog stays metadata-only** (no images, no KServices) — exactly as it is now.
- **Enabling** a piece is what triggers `build image → register → provision KService`. Available-only pieces are **never built or deployed**.
- This is strictly better than the bundle's "enable = rebuild the whole image": per-piece, enable builds **one small image**, isolated, with no conflict risk and no OOM blast radius. **An admin can enable *any* of the 665** (no curation ceiling), because each piece's deps are isolated in its own image.

### Q3 — "How resource-intensive?"
| Dimension | Single bundle (today) | Per-piece images |
|---|---|---|
| **Idle compute** | 0 pods (scale-to-zero) | 0 pods (scale-to-zero) — **same** |
| **Memory / active pod** | **640 MB heap / 896 Mi, grows with bundle** | ~150–250 Mi (one piece) — **bounded, flat** |
| **Image storage** | 1 image ~1 GB | base + N diffs; ~150–250 MB **incremental** per *enabled* piece (GHCR dedups base). ~20–50 enabled ≈ **5–12 GB** |
| **Build** | 1 bundle build (~3–5 min) **for any change** | N builds (~1–2 min each), **parallel, only on enable** |
| **Control-plane objects** | KService per provisioned piece | **same count** (image differs, not count) |
| **Dep conflicts** | Real — caps the bundle ~46 | **None** — each image isolated → enable *any* piece |
| **Blast radius of a bad piece** | Breaks the bundle build for all | Isolated to that piece's build |

**Net:** idle cost identical; **per-pod memory drops and stops growing**; the genuinely new costs are **image storage** (single-digit GB for a realistic enabled set) and a **per-piece build pipeline**. You only ever build/store **enabled** pieces (~tens), not all 665.

---

## 4. Trade-offs / what gets harder
- **Image proliferation** → need a GC policy for `ap-piece-*` images (untag on long-disabled).
- **Per-piece build orchestration** in CI (vs one bundle build) — but each build is the isolated install we already do for the snapshot, plus a smoke test.
- **A runtime refactor** of `piece-mcp-server` (dynamic single-piece load) + a `piece_images` registry + the reconciler image-ref change.
- **Cold-start** is per-piece-image pull instead of one warm shared image — comparable (~tens of MB diff layer), and the warm-pool/min-scale knobs still apply.

## 5. Recommendation
For the catalog-expansion goal (enable any of 665), **per-piece images are the right target** — they delete the memory-scaling, dep-conflict, and full-rebuild costs in one move and make "enable" a clean, isolated, build-on-demand operation. It's a real but bounded refactor (runtime single-piece load + registry + reconciler ref + build job). The single bundle stays simpler for a *small fixed* set; it does not scale to the catalog. Suggested sequencing: keep the bundle for the current ~48, build the per-piece path behind a flag, migrate piece-by-piece (a piece can run from either an entry in `piece_images` or the bundle fallback during transition).

## 6. Implementation status (SHIPPED)

**Phase A — functional core (2026-06-10/13).** `piece_images` table (drizzle 0087); the
`piece-mcp-server` single-piece seam (`SINGLE_PIECE_MODE`, `loadPieceDynamic`,
`Dockerfile.base` + `Dockerfile.piece`); the reconciler dual-path (per-piece image when a
ready row exists, else bundle). Proven on dev/ryzen: `ap-ntfy-service` + `ap-json-service`
run on their own `ap-piece-<name>` images (~145 MB RSS / 256 Mi, no OOM).

**Self-contained metadata (2026-06-13).** A single-piece image now derives its catalog
metadata **directly from the installed piece package** (`buildPieceCatalogRow`) instead of
the DB, gated on `SINGLE_PIECE_MODE`. This (a) removes the `DATABASE_URL` startup
dependency, (b) lets the build pipeline smoke the image with no database, and (c) fixes
**incomplete available-only snapshots** — e.g. the `json` piece's `convert_json_to_text`
action was missing `inputSchema` in the DB snapshot but is complete from the package. The
shared bundle image still reads the DB (one catalog, many pieces).

**Phase B — build-on-enable automation (2026-06-13).**
- **Enable is per-cluster + instant when the image exists.** The `ap-piece-<name>:<ver>`
  image is GLOBAL (GHCR), so enabling splits from building:
  `workflowData.enableAdminPieceRuntimeImage()` resolves the catalog version, HEAD-checks
  GHCR through the admin piece image adapter (authed via `GITHUB_TOKEN`), and either writes
  a `ready` `piece_images` row instantly or writes `building` + triggers a hub build. Surfaces: admin REST
  `POST /api/admin/pieces/[piece]/enable` + the admin pieces page "Available to enable"
  section; the build callback is `POST /api/internal/pieces/[piece]/image-registration`.
- **Enable signal = the `piece_images` row, NOT an `available_only` flip.** `available_only`
  is owned by the metadata-sync as "bundle membership" and is reverted on its next run, so
  the reconciler instead provisions any available-only piece that has a **ready + enabled**
  `piece_images` row (relaxed `AO_FILTER`). "Runnable" is no longer ⊆ "bundled".
- **Hub Tekton build pipeline** (`stacks .../outer-loop-builds/`): `perpiece-image-build`
  (validate → buildkit `FROM piece-runtime-base` + `npm install` one piece → dind `/health`
  smoke under 256 Mi → register callback), an isolated `perpiece-build` EventListener
  (github-HMAC interceptor; BFF signs `X-Hub-Signature-256`), and a `piece-runtime-base`
  build wired into the existing outer-loop.

**Remaining follow-ups.**
- Create secret `perpiece-build-secrets` (`internal-api-token` + `webhook-secret`) in
  `tekton-pipelines` (ExternalSecret), and wire `PIECE_BUILD_TRIGGER_URL` +
  `PIECE_BUILD_TRIGGER_SECRET` into the BFF env — this activates the live build-trigger
  path for not-yet-built pieces. (The GHCR-exists fast path needs none of this.)
- `piece-runtime-base:latest` must stay current + self-contained — the outer-loop builds
  `:git-<sha>`; the per-piece pipeline defaults to `:latest`. (Published manually for now.)
- Image GC for long-disabled `ap-piece-*` images.

> Companion to `docs/activepieces-catalog-expansion.md` (metadata side) — this is the **runtime/packaging** side of the same "available-vs-enabled" split.
