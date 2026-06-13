# Activepieces Catalog Expansion — 200+ Available, Admin‑Enabled Subset

**Question:** AP's public catalog has 200+ pieces; we surface ~45. Can we make **all 200+ available as options** but only **enable a curated subset** at a platform/admin level?

**Short answer:** Yes — and it's the right model — **but the right lever is metadata‑only listing for the 200+ plus a curated, *bundled* runnable subset, NOT bundling or provisioning all 200+.** Idle pods are free (scale‑to‑zero); the costs that matter are the **bundled image size**, the **Knative control‑plane object count**, and the **per‑agent tool surface** — all of which a "metadata‑available / curated‑enabled" split keeps near today's footprint.

---

## 1. Current system — how a piece is filtered, listed, and run

Today **available == enabled == bundled**: one source (the pieces compiled into the `piece-mcp-server` image) drives both what you can *see* and what you can *run*. There is no decoupling yet.

### 1a. The filter (two hand‑synced halves)
- `services/piece-mcp-server/package.json` pins exactly **46** `@activepieces/piece-*` packages at exact versions.
- `services/piece-mcp-server/src/piece-registry.ts` statically `import`s those 46 + 1 in‑repo custom `mcp` piece into the `PIECES` record (**47 entries**). Adding a package to `package.json` alone does nothing — it must also be imported and added to `PIECES`.
- The piece set is **baked at build time** (`Dockerfile`: `npm install --omit=dev` materializes every piece's transitive deps; `build.mjs` esbuilds our `src` with `packages:"external"`). One image carries all pieces; `PIECE_NAME` selects which one a given Knative Service serves.

### 1b. Code == metadata (the crux)
Each AP package exports **one `Piece` object** holding *both* the executable `run()` action code *and* the metadata (displayName, logoUrl, auth descriptor, per‑action props/inputSchema). `metadata-catalog.ts::buildPieceCatalogRow` derives a catalog row by **importing the live `Piece`** and reading `.actions()/.auth/.categories`. So **producing listing metadata uses the exact same bundled code needed to run the piece** — there is no metadata‑only path, and **no remote AP‑catalog / npm / cloud fetch exists anywhere** (verified: grep empty across `services/piece-mcp-server/src` + `src/lib/server`). This is the single most important fact for the expansion: getting 200+ pieces *listed* today would require bundling 200+ packages' code.

### 1c. Available side (the catalog + pickers)
The `piece_metadata` DB table is the **single catalog**, populated **only** by the stacks metadata‑sync Job (`node dist/sync-metadata.js`, run from the bundled image; ArgoCD sync hook). All four picker surfaces read it with **no enablement filter**:
- `src/lib/server/action-catalog/piece-metadata-source.ts` (canvas action catalog — hardcodes `registered:true/ready:true/insertable:true`)
- `src/routes/api/pieces/+server.ts` (connection‑picker combobox)
- `src/routes/api/mcp-connections/catalog/+server.ts` (integrations catalog)
- `src/lib/server/mcp-availability.ts` (MCP availability)

Because `piece_metadata` only ever holds the bundled set, **"available in the UI" == "bundled."**

### 1d. Enabled side (the reconciler + a hard runtime coupling)
The stacks reconciler (`CronJob activepieces-mcp-reconciler`, every `*/2`) builds a desired set by precedence — `pinned` (`PINNED_PIECES=github,google-calendar,openai`), `workflow-referenced` (`workflow_connection_ref`), `mcp-enabled` (`mcp_connection` ENABLED), and a load‑bearing **`catalog` branch** (`reconcile.sh` ~L342‑354) that gives **every `piece_metadata` row** a scale‑to‑zero `ap-<piece>-service`. `pinned`/`workflow-referenced` → `minScale=1` (warm); everything else → `minScale=0`. The comment is explicit: *"ALL catalog pieces get a (scale‑to‑zero) service so workflow activities never depend on an mcp_connection row."*

The runtime coupling that makes "selectable but unprovisioned" unsafe: `function-router/src/core/registry.ts` resolves any AP slug to `ap-<sanitized>-service` and Dapr‑invokes it directly — **a selectable‑but‑unprovisioned piece 404s.** And piece‑runtime boot **hard‑requires the bundle**: `getPiece()` exits if `PIECE_NAME` isn't bundled; `fetchPieceMetadata` exits if no DB row; `validateCatalogMetadata` rejects on a `catalogDigest` mismatch (bundle vs DB).

> **Invariant to preserve:** *enabled‑and‑runnable ⊆ bundled.* Anything an admin can enable must be in the image (code + digest‑matching `piece_metadata` row).

### 1e. Live footprint (verified, dev)
- **47** `ap-*-service` Knative Services; **3** warm pods (the pinned `github`/`google-calendar`/`openai`), 44 at zero.
- Whole‑cluster Knative objects: **48 Services + 48 Configurations + 48 Routes + 237 Revisions** (~5 Revisions/ksvc, **accumulating per image bump, not GC'd**).
- Per‑pod: requests `50m CPU / 160Mi`, limits `500m / 512Mi` (the converged bundle **OOMed at 384Mi**).
- Knative control plane is **single‑replica** (controller/activator/autoscaler/webhook all 1/1). Only platform‑admin concept is `users.platform_role==='ADMIN'` (`src/routes/(admin)/+layout.server.ts`); **no piece‑allowlist table exists** today. `services/shared/piece-catalog-snapshot.json` is a roadmap artifact that does **not** exist yet.

---

## 2. The goal — split the two tiers

| Tier | Means | Cost today | Cost we want |
|------|-------|-----------|--------------|
| **Available** (an *option* in the picker) | a `piece_metadata` row | bundled code (because code==metadata) | **just a DB row** (metadata‑only, code‑free) |
| **Enabled** (a runnable `ap-<piece>-service`) | a reconciler‑provisioned KService + bundled code | every catalog row → a KService | **admin‑curated subset only** |

---

## 3. Options

| Option | Available (200+) | Enabled (subset) | Verdict |
|--------|------------------|------------------|---------|
| **A — Bundle all 200+ + allowlist‑gate** | Add 200+ to `package.json`+`piece-registry.ts`; sync writes 200+ rows | Reconciler `catalog` branch → allowlist | ❌ Wrong lever — pays the bundle cost for 200 to list metadata |
| **B — Decouple metadata from code (RECOMMENDED)** | Metadata‑only rows from a CI snapshot (no bundling) | Reconciler `catalog` branch → allowlist; subset stays ⊆ bundled | ✅ Right cost model, reuses all existing infra |
| **C — Dynamic per‑pod install** | Metadata‑only (as B) | Pod `npm install`s the piece at start; no rebuild to enable | ❌ Breaks the baked‑bundle/digest invariant; over‑engineered |

### A — Bundle all 200+, gate provisioning with an allowlist
**How:** add all 200+ deps + imports so `sync-metadata` writes 200+ `piece_metadata` rows (every picker lights up, no BFF change); then replace the unconditional reconciler `catalog` query with a curated allowlist so only the admin subset gets a KService.
**Pros:** the *available* side is trivial (reuses the code==metadata path; metadata is real + digest‑validated); enabling is a one‑query swap; any enabled piece is guaranteed runnable.
**Cons:** **bundling 200+ is the dominant cost.** The 47‑piece bundle already needs 512Mi heap (384Mi OOMed) and ~937M `node_modules`; 200+ risks **transitive dep‑version conflicts** (different `axios`/`typebox`/`ai` pins — the likely reason the curated 46 exists), big build time/size, and a higher memory floor for **every** `ap-service`. You pay the bundle cost for 200 pieces to list metadata you could get for free.

### B — Decouple metadata (200+ available, code‑free) from bundling (curated subset runnable) — **RECOMMENDED**
**How:**
- *Available:* a CI step ephemerally `npm install`s each AP package, runs `buildPieceCatalogRow`, and commits the already‑planned `services/shared/piece-catalog-snapshot.json`. Seed `piece_metadata` from the snapshot, marking rows **available‑only** (existing `packageType`/`catalogSourceImage` fields, or a new `available_only` bool). The 4 picker surfaces already read `piece_metadata`, so 200+ options appear with no read‑path change beyond honoring the flag.
- *Enabled:* a platform‑admin **allowlist** (new `platform_enabled_piece` table or an `enabled` column) + swap the reconciler `catalog` branch to select only allowlisted pieces. The enabled subset **must remain ⊆ the bundled set** (still needed to run `/execute` + `/mcp` and pass digest validation).
- *UX:* the canvas marks available‑not‑enabled pieces non‑insertable / "Enable to use" (admin‑gated); `mcp-availability` already emits `SERVER_NOT_REGISTERED` — extend `wantedPieces` so available‑not‑enabled pieces render amber "Available — request enablement."

**Pros:** right cost model — 200+ listed cheaply (trivial Postgres rows; zero image/heap/conflict cost), **N curated pieces actually bundled+running** (control‑plane footprint stays near today's 47). Reuses end‑to‑end: `piece_metadata`, all 4 read paths, `getMcpAvailability`'s registered∪configured model, `SERVER_NOT_REGISTERED`, the `(admin)` `platformRole` gate, and the reconciler TTL‑cleanup (un‑enabling auto‑reaps the KService). The enablement gate is a **single reconciler query swap**. Matches the planned snapshot + filter‑pills roadmap.
**Cons:** enabling a piece *not yet in the bundle* still needs an image rebuild + re‑sync (the runnable subset is bounded by `piece-registry.ts`). Two metadata provenances (snapshot‑derived available‑only vs bundle‑derived runnable) must be reconciled (sync must not clobber available‑only rows). Requires building the CI snapshot generator (doesn't exist yet).

### C — Dynamic per‑piece install at pod start
**How:** metadata‑only listing as in B; for *enabled*, the `ap-<piece>-service` (or a generic image) `npm install`s `@activepieces/piece-<name>@<ver>` at pod startup, then `getPiece` dynamically.
**Pros:** an admin can enable **any** of the 200+ with no image rebuild; closest to upstream AP's dynamic loader; smallest base image.
**Cons:** largest change + most risk — cold‑start now includes an `npm install` (slow, network‑dependent, breaks air‑gapped/GHCR‑only, per‑pod supply‑chain surface), **undermines the deterministic digest‑validation invariant**, and moves dep conflicts from build‑time to run‑time. Over‑engineered for a curated subset that changes rarely.

---

## 4. Resource & control‑plane verdict

**Reasonable — provided the lever is metadata‑only listing + curated bundling, not bundling/provisioning all 200+.** Idle pods are genuinely 0 (scale‑to‑zero), so idle compute is **not** the concern. The real knobs:

1. **Bundled image size / per‑pod memory floor (dominant).** 47 pieces already need 512Mi heap (384Mi OOMed); 200+ bloats build time, image size, and the memory floor of *every* `ap-service`, plus dep‑conflict risk. → keep the bundle ≈ curated‑subset‑sized (Option B).
2. **Control‑plane object count (the second real cost — not pods).** Today 48 Services + 48 Configs + 48 Routes + **237 Revisions** (~5/ksvc, ungc'd). Provisioning 200+ KServices ≈ **4× the objects immediately** and ~1000+ Revisions over a few rebuilds, all reconciled by a **single‑replica** Knative control plane and a single bash `*/2` CronJob whose wall‑time grows ~4×. etcd object count jumps ~4× for AP alone.
3. **Per‑agent tool surface.** 200+ attachable MCP servers would overwhelm the agent tool picker / per‑agent tool budget; a curated enabled subset keeps this bounded.

**Sizing:** 200+ **available** as metadata‑only options is cheap (trivial Postgres rows, zero Knative/image cost). An admin‑enabled **subset (~20–50)** provisioned as KServices keeps the control‑plane footprint near today's 47. **Also recommended regardless:** add Knative **Revision retention** (config‑gc / per‑Configuration revision limit) — already a latent concern at 47 (~5 Revisions/ksvc, ungc'd).

---

## 5. Recommended path (Option B, phased)

**Phase 1 — ENABLED gate first** (small, high‑value, no piece additions; ship + validate against the current 47‑piece bundle):
1. Add a platform‑scoped allowlist: `platform_enabled_piece (platform_id, piece_name, enabled_by, enabled_at)` in `src/lib/server/db/schema.ts` — or a `status`/`enabled` column on `piece_metadata`.
2. Swap the reconciler `catalog` branch (`reconcile.sh` ~L342‑354) from "every `piece_metadata` row" to a join over the allowlist; keep `pinned`/`workflow-referenced`/`mcp-enabled` reasons unchanged.
3. Admin API + UI under `src/routes/(admin)/` (reuse the `platformRole==='ADMIN'` gate): list `piece_metadata` rows with enable/disable toggles writing the allowlist.
4. **Verify:** de‑allowlisted pieces lose their KService within one TTL window (`RECONCILE_TTL_SECONDS=900`); the `activepieces-mcp-catalog` ConfigMap shrinks; `getMcpAvailability` shows the shrunk `registered` set; `function-router` still resolves enabled pieces (the `enabled==provisioned` invariant holds). This alone lets an admin shrink the running surface to ~20–30 pieces and proves the gate.

**Phase 2 — AVAILABLE widening to 200+:**
5. Build the CI snapshot generator → `services/shared/piece-catalog-snapshot.json` (ephemeral `npm install` per target piece → `buildPieceCatalogRow` → commit the action‑schema JSON).
6. Extend `sync-metadata.ts` to seed `piece_metadata` from the snapshot, flagging **available‑only** rows; ensure the bundle‑derived sync does **not** delete available‑only rows.
7. Thread the flag through the UI: `action-catalog/piece-metadata-source.ts` stops hardcoding `registered/ready/insertable:true` (grey available‑not‑enabled with "Enable to use"); `getMcpAvailability` adds all `piece_metadata` names to `wantedPieces` marked `registered=false` (amber "Available — request enablement"); `/api/mcp-connections/catalog` + `/api/pieces` left‑join the allowlist to add an `enabled` field for the planned **All | Connected | Available | Enabled** filter pills.

**Phase 3 — control‑plane hygiene** (orthogonal, do regardless): add Knative Revision retention to cap the ~5‑Revisions/ksvc accumulation.

**Throughout:** preserve *enabled‑and‑runnable ⊆ bundled*. Enabling a not‑yet‑bundled piece is an image‑rebuild + re‑sync step (the existing "Adding piece" flow). Do **not** pursue Option C dynamic install.

---

## 6. Open questions (decide before Phase 2)
- **Available‑metadata provenance:** CI snapshot (no runtime network, fits GitOps/offline, but a new CI job that `npm install`s ~200 packages, possible version‑conflict noise) **vs** AP's public cloud metadata API (no bundling/CI, but a runtime/sync dependency on `cloud.activepieces` and its API shape).
- **Allowlist scope:** platform‑wide (one `platform_enabled_piece`, simplest, matches single‑platform reality) **vs** per‑project (`mcp_connection` is already per‑project; but the reconciler provisions one KService per piece cluster‑wide).
- **Do dep conflicts actually block bundling beyond ~46?** Cheap experiment: add ~20 more pieces, measure heap + npm conflicts before committing to a larger *runnable* subset.
- **Enabled subset size** (~20–50?) — drives the control‑plane / Revision‑retention math.
- **In‑app "request enablement"** flow (non‑admin clicks an available‑not‑enabled piece → notify admin) vs the admin toggle UI alone — affects whether the amber state needs a write path.
