# Activepieces Integration Architecture — Deterministic Activities + MCP Exposure

**Status**: Approved 2026-06-10 (architecture SSOT for the Activepieces integration).
**Scope**: How Activepieces (AP) piece actions execute as deterministic Dapr workflow activities, how pieces are exposed as MCP servers, how the UI surfaces both, and how the system stays current as pieces update upstream.

This document is the evaluation + decision record. Implementation phases 1–3 are in flight; phases 4–6 are roadmap.

---

## 1. Current state (verified 2026-06-10)

### 1.1 The deterministic-activity path existed in code but was dead in production

The SW 1.0 interpreter's path for an AP slug (`github/create-issue`, anything not matching an explicit route prefix):

```
SW1.0 call task → _handle_call_task (sw_workflow.py)
  → ctx.call_activity(execute_action)            # NO RetryPolicy anywhere in the orchestrator
  → dapr_invoke(function-router, "execute")      # Dapr service invoke, 16 MiB body cap
  → function-registry "_default"                 # → fn-activepieces (Knative type)
  → fn-activepieces /execute                     # ← service has NO workload manifest in stacks
```

Verified findings:

- **`fn-activepieces` was never deployed.** It has CI builds, release pins, and the `_default` registry route — but no Deployment/Knative Service manifest in stacks. Every AP activity dispatch 404'd. (This matches the deliberate omission of the fn-activepieces Application; AP slugs have been unusable as workflow actions on every cluster.)
- **The `ap_<piece>_<action>` Dapr activities registered by fn-activepieces (`dapr-activities.ts`) were unreachable dead code.** Dapr workflow activities are app-scoped: the Python orchestrator can only call activities registered in its own `WorkflowRuntime`. Cross-app activity invocation does not exist in Dapr.
- **The AP pause contract was dropped.** `fn-activepieces/src/executor.ts` detects piece pauses (`DELAY` / `WEBHOOK`) and `activities/execute_action.py` forwards `result["pause"]` — but `_handle_call_task` never read it. Pause-capable pieces (delays, approvals) could never work.
- **No retry semantics.** Zero `RetryPolicy` usage in the orchestrator; `execute_action` never raises on retryable errors, so even adding a policy would have been inert.
- **Version skew already happened.** fn-activepieces pinned `@activepieces/piece-github@^0.7.3` (a caret range, not even a pin) while piece-mcp-server pinned `0.6.4`. `piece_metadata` is synced from the **piece-mcp-server** image (`catalogSourceImage`), so canvas/MCP schemas described 0.6.4 while activities would have executed 0.7.x.
- **The canvas catalog depended on the dead service.** `src/lib/server/action-catalog/index.ts` sourced AP actions only by live fetch to fn-activepieces (`/api/metadata/actions`, `/catalog/functions`), and the dynamic-dropdown proxy (`/api/action-catalog/[actionId]/options`) targeted `getFnActivepiecesUrl()` — so AP actions never appeared in the picker and dropdowns 502'd.
- **CI gaps.** `services/piece-mcp-server/src/package-parity.test.ts` (guarding the two services' pin sets) never ran — `pr-checks.yml` had no test step. piece-mcp-server was `enabled=false` in `nix/images.nix` and absent from nix-ci path triggers.

### 1.2 The MCP path is live and good

- `services/piece-mcp-server/` is a **parameterized single-piece MCP server**: `PIECE_NAME` env selects the piece; tools are mapped from `piece_metadata` rows (`piece-to-mcp.ts`) over StreamableHTTP; sessions are in-memory per replica.
- A stacks **CronJob reconciler** (`workloads/activepieces-mcps`, every 2 min) provisions per-piece **Knative Services** (`ap-<piece>-service`, minScale=0; pinned pieces minScale=1; TTL cleanup; catalog ConfigMap) from enabled `mcp_connection` rows + `PINNED_PIECES`.
- **Credentials**: the MCP server self-resolves via `X-Connection-External-Id` → BFF `GET /api/internal/connections/<id>/decrypt` (`auth-resolver.ts`, AsyncLocalStorage + 5-min TTL cache). Agents receive only the endpoint + connection external id — never provider secrets.
- **Extensions registry** (`extensions/index.ts`) layers custom actions (e.g. OneDrive resumable upload) onto vendored pieces without forking npm packages.
- **Metadata**: `sync-metadata.ts` + the stacks metadata-sync Job upsert `piece_metadata` keyed `(name, version, platform_id)` with `catalogDigest` (stable schema hash) + `catalogSourceImage` — drift detection between DB metadata and the deployed image.
- **Agent wiring**: `agentConfig.mcpServers` explicit entries, or `mcpConnectionMode=project` resolved by orchestrator `activities/resolve_mcp_config.py` from enabled `mcp_connection` rows. `mcp-gateway` gates external MCP clients (hosted workflows).
- piece-mcp-server duplicates ~80% of fn-activepieces internals (context-factory, piece-registry, input normalization) — but stubbed `pause` and lacked `/execute` + `/options`.

### 1.3 Upstream Activepieces facts that constrain us

- MIT-licensed except `packages/ee` — we depend only on community framework/pieces.
- The AP engine has **no standalone execute-one-action operation**; it always wraps actions in full flow context. Upstream's MCP feature maps **flows → tools** (via `MCP_TRIGGER_PIECE_NAME`), not piece actions → tools. Their `AgentPieceTool` fills props via LLM (non-deterministic). **Conclusion: our piece-action→tool/activity mapping is and remains our own code** (it already exists in `piece-to-mcp.ts` and the executor).
- The action runtime contract is `action.run(ctx)` with `ctx.auth` (an `AppConnectionValue` discriminated union), `ctx.propsValue`, plus store/files/connections managers and pause/stop/respond hooks. We construct that context ourselves (`context-factory.ts`).
- Pieces are published to npm as `@activepieces/piece-*` (semver, 0.x — every minor is potentially breaking). Upstream offers no deprecation/migration mechanism.

---

## 2. Decisions

### 2.1 Execution surface — **converged per-piece runtime** ("piece-runtime")

`piece-mcp-server` is promoted to the single per-piece execution surface (the service/image name stays `piece-mcp-server`; "piece-runtime" is the role):

```
                        ┌──────────────────────────────────────────────┐
SW1.0 step ─ orchestrator ─ function-router ──► ap-<piece>-service     │
  (RetryPolicy,            (audit, registry      [ONE piece-runtime    │
   pause mapping)           type=activepieces)    image per piece]     │
                                                  POST /execute  ◄─ workflow activities
agents (dapr-agent-py, ────────────────────────►  POST /mcp      ◄─ StreamableHTTP MCP
  claude-agent-py, external via mcp-gateway)      POST /options  ◄─ canvas dropdowns
                                                  GET  /health        │
                        └──────────────────────────────────────────────┘
```

`services/fn-activepieces/` is **deleted** (full cutover). One image per piece bump makes metadata/version skew structurally impossible: the same digest that serves MCP tools executes activities, and `piece_metadata.catalogDigest/catalogSourceImage` describe exactly that image.

| Option | Verdict |
|---|---|
| **Converged piece-runtime** (chosen) | One pin set, one credential path, one metadata source; per-piece isolation + Knative scale-to-zero retained. Cold start (~2–10 s) on non-pinned activities is acceptable for durable workflows. |
| Revive fn-activepieces monolith for activities | Cheapest path to "working today" (only a manifest was missing) but institutionalizes two images importing the same 45 packages — the exact skew failure (github 0.7.3 vs 0.6.4) already observed. Rejected. |
| Single always-on monolith for both (`/mcp/<piece>` path-routed) | Regresses the live per-piece architecture, loses isolation/scale-to-zero, piece bumps restart everything. Rejected. |

Cold-start mitigation: the reconciler provisions **all catalog pieces** at minScale=0 (activities never depend on an `mcp_connection` row existing) and pins (minScale=1) the union of `PINNED_PIECES` and **workflow-referenced pieces** (pieces appearing in deployed workflow specs).

### 2.2 Credential flow — **reference-forwarding** (revises the credential-broker invariant)

For AP routes, function-router **stops fetching/forwarding plaintext** (`credentials_raw`). It forwards `X-Connection-External-Id`; piece-runtime self-resolves via its existing auth-resolver — the exact mechanism the MCP path already uses.

- ONE credential path per piece service for both activities and MCP tools, with identical OAuth2-refresh semantics.
- The BFF remains the **sole decryptor** (`security/encryption.ts`); plaintext flows only BFF → piece-runtime at point of use.
- function-router keeps the **audit-only** credential log (executionId, nodeId, pieceName, connectionExternalId — no plaintext) and remains the routing/logging/OTEL choke point for every non-agent action.

Rejected alternatives: keeping router plaintext-forwarding (two divergent credential paths per piece forever); orchestrator→piece direct invocation (forks the "all non-agent actions go through function-router" invariant and re-implements routing/audit in Python).

### 2.3 MCP serving shape — keep per-piece Knative + reconciler; **no Dapr sidecars on piece pods**

- **ToolHive / kagent kmcp (MCPServer CRDs)** — rejected for now: they replace only the easy 20% (creating a Service), lose Knative scale-to-zero (both deploy plain Deployments), and still require a DB→CR translator for `mcp_connection`-driven enablement — i.e. the reconciler survives in a different costume plus a new controller per spoke.
- **kgateway v2.1 + agentgateway (aggregated MCP endpoint)** — deferred: agents natively consume multiple servers from `agentConfig.mcpServers`; per-connection `X-Connection-External-Id` binding breaks under one endpoint without per-tool-prefix backend header mapping; it adds a third gateway stack. The UI is deliberately designed so per-piece URLs can collapse into one URL later (see §5) without IA change.
- **Dapr sidecars on piece pods (Diagrid mcp-access-control pattern)** — rejected for this tier: Dapr app-id resolution bypasses the Knative activator, so a scaled-to-zero service is unreachable — sidecars would force minScale=1 on all pieces. Security is achieved instead with cluster-local visibility + a **NetworkPolicy** restricting piece-service ingress to function-router, agent namespaces, mcp-gateway and the BFF, plus the token-gated decrypt endpoint. The Diagrid pattern's mTLS/ACL posture stays where sidecars already exist (orchestrator, function-router, agents).

**Re-evaluation triggers** (documented, checked when circumstances change):
1. External clients need multi-piece federation through one URL → adopt agentgateway/kgateway in front of per-piece services.
2. >20 enabled pieces per project causing agent session fan-out pain → same.
3. An MCP operator gains native scale-to-zero, or catalog governance must span teams/repos → re-evaluate ToolHive/kmcp.
4. agentregistry (CNCF sandbox, 2026) gains ArgoCD OCI-source integration → adopt OCI catalog publication (on-ramp: one ORAS push of the catalog snapshot from CI).

### 2.4 Durability semantics (the actual "deterministic activities" contract)

| Concern | Mechanism |
|---|---|
| Retries | `AP_RETRY_POLICY` (first interval 2 s, ×2 backoff, 5 attempts, 60 s cap) on the `execute_action` activity call. piece-runtime classifies errors: 429/5xx/network → `errorClass: "retryable"`; 4xx/validation/auth-missing → `"permanent"`. `execute_action` **raises** only for retryable (so the policy actually fires) and returns failure for permanent. |
| Idempotency | `piece_execution` table; `idempotency_key = workflowId:executionId:taskName` (stable across retries AND replay). `/execute` gates with `INSERT … ON CONFLICT DO NOTHING`; a completed row returns the cached result — a retried `send-email`/`create-issue` produces exactly one side effect. Fail-closed; per-action `idempotent: true` opt-out skips the gate. The table doubles as the per-execution piece audit trail. |
| Pause | `pause.type == "DELAY"` → `ctx.create_timer(resumeDateTime)` then re-invoke `/execute` with `execution_type: "RESUME"`. `pause.type == "WEBHOOK"` → `ctx.wait_for_external_event("ap.resume.<task>")`, raised by BFF `POST /api/internal/executions/[id]/ap-resume/[requestId]`; `generateResumeUrl` returns that URL, gated on `AP_RESUME_PUBLIC_BASE_URL` (unset ⇒ clean "unsupported on this cluster" error — dev/ryzen have no public webhook base). |
| Payload ceiling | The 16 MiB Dapr body cap binds on the orchestrator↔router legs. `/execute` offloads results > 4 MiB inline to the workflow-artifacts path and returns `{artifactRef, preview, truncated: true}`. |
| Piece state across pause | Postgres-backed `ctx.store` adapter, scoped to an allowlist of verified pause-capable pieces (upstream `ctx.store` is AP-DB-specific; ours is keyed by execution). |

### 2.5 Maintainability — "pieces get the runtime-registry treatment" (Phase 4 roadmap)

Mirrors the proven `services/shared/runtime-registry.json` pattern:

- `services/shared/piece-registry.json` SSOT (status/deprecation/smoke/extension metadata; versions stay in the single package.json so Renovate works natively) + `scripts/sync-piece-registry.mjs` (codegens `piece-registry.ts`, regenerates the committed snapshot, `--check` drift guard in CI).
- `services/shared/piece-catalog-snapshot.json` — committed full action-schema catalog; every bump PR shows the exact schema delta in the git diff.
- Renovate: grouped weekly `@activepieces/*` PR, `rangeStrategy: pin` (kills caret drift). CI gates: snapshot diff → breaking-change classifier (removed/renamed action, new required prop, auth shape change) → merge blocked without a `pieces-breaking-approved` label → canary boot + `tools/list` smoke (no credentials needed).
- Version stamping: BFF stamps `pieceVersion` + `actionDigest` into workflow spec nodes at save; orchestrator validates at execution **start** (input re-validation against the current schema — not digest equality, so doc-only churn doesn't block). Fail-forward for mid-flight instances (typed `PieceSchemaMismatch`, non-retryable) — **no side-by-side piece versions** (large permanent complexity tax for rare long-running instances; rejected per full-cutover preference).
- Deprecation lifecycle: registry `status` → `piece_metadata` columns → UI badges → block new use → sunset (classifier flags removal as BREAKING).

---

## 3. Request flows (target)

### 3.1 Deterministic activity

```
1. _handle_call_task: AP slug detected (registry _default → type "activepieces")
   idempotency_key = f"{workflow_id}:{db_execution_id}:{task_name}"
   ctx.call_activity(execute_action, retry_policy=AP_RETRY_POLICY, input={…, idempotencyKey, connectionExternalId})
2. execute_action → dapr_invoke(function-router, "execute")              [Dapr leg, ≤16 MiB]
3. function-router: type "activepieces" → ap-<sanitized-piece>-service DNS (same sanitize as reconciler);
   audit row (no plaintext); POST /execute + X-Connection-External-Id    [direct HTTP via Knative activator]
4. piece-runtime /execute: idempotency gate → resolveAuth (BFF decrypt) → normalize input
   → action.run(ctx with pauseRef) → classify errors → offload large results
   → {success, data|artifactRef, error?, errorClass?, pause?, pieceVersion, durationMs}
5. execute_action: raise (retryable) | return failure (permanent) | return result
6. _handle_call_task: pause.DELAY → create_timer + RESUME re-invoke; pause.WEBHOOK → wait_for_external_event
```

### 3.2 Agent MCP tool call

Unchanged from today: agent connects StreamableHTTP to `ap-<piece>-service:…/mcp` (from explicit `agentConfig.mcpServers` or project mode via `resolve_mcp_config.py`); the server resolves credentials per `X-Connection-External-Id`; tools are registered from `piece_metadata` filtered by the connection's tool selection (§5.2).

---

## 4. What changed vs the previous invariants (CLAUDE.md deltas)

1. **Action routing**: `_default` no longer names a service; it is type `activepieces` with dynamic per-piece resolution (`ap-<piece>-service/execute`).
2. **Credential broker**: function-router is the **credential audit point**, not a plaintext broker, for AP routes. The BFF stays sole decryptor; piece-runtime resolves at point of use.
3. **fn-activepieces**: deleted (service, pins, skaffold module, catalog fetchers). `piece-mcp-server` (role: piece-runtime) is the only piece execution surface.
4. **Orchestrator**: `_handle_call_task` gained retry policy + pause mapping for AP slugs; `execute_action` distinguishes retryable vs permanent failures.

---

## 5. UI design (reference-grounded, inspected live 2026-06-10)

References inspected in Chrome: **Perplexity** `/computer/connectors`, **Activepieces Cloud**, **Claude Console** (platform.claude.com). Each surface below adopts a specific observed pattern (per our port-reference-UX practice), adapted only where our domain differs.

### 5.1 Integrations hub — evolve `/workspaces/[slug]/connections` (Perplexity catalog pattern)

- Search + filter pills `All | Connected | Available` + category dropdown (data: `piece_metadata` via `/api/mcp-connections/catalog` + `/availability`).
- **Connected-first section** with bound account identity (Perplexity: "Outlook — Vinod@…  ✓").
- "Popular" curated row = reconciler-pinned pieces.
- Cards: logo, 2-line description, capability chips `[Actions ✓][MCP ✓]`, status dot.

### 5.2 Piece detail — NEW `[pieceName]` subroute (Perplexity connector-detail pattern; page not modal, for deep links)

- Header: logo, description, `Connect account` CTA (existing OAuth popup flow, extracted to `src/lib/connections/oauth-popup.ts`).
- Overview capability bullets + docs links.
- **Searchable Actions/Tools list grouped read-only vs write, with per-tool enable toggles + group-level policy dropdown** (Perplexity's per-tool `Allow | Disable`). Persisted to `mcp_connection.metadata.toolSelection`; enforced at tool registration in `piece-to-mcp.ts`.
- Connections list with **usage counts** (AP Cloud's "Flows" column ← `workflow_connection_ref`).
- Capability toggles: "available as workflow actions", "exposed as MCP server" (creates/enables the `mcp_connection` row; reconciler provisions ≤2 min — show a "provisioning" state).
- Health card (Phase 5 plumbing): metadata sync age, image drift vs release pin, Knative ready/cold, last smoke.

### 5.3 MCP Server panel (AP Cloud pattern)

Per-project panel listing enabled piece servers, each with a copyable in-cluster URL + collapsible **JSON client-config snippet**; an external-clients section shows the mcp-gateway URL + auth instructions. AP Cloud presents **one project-level MCP URL** (`cloud.activepieces.com/mcp`, OAuth, grouped tool checkboxes with n/m counts) — that is the UX north star the Phase 6 aggregated endpoint would enable; this panel is designed so per-piece URLs collapse into one without IA change.

### 5.4 Canvas picker + step side-panel (AP builder pattern)

- Picker popover: search + category tabs (`Core | Apps | AI & Agents | Code`) + Popular/Highlights columns; search results **grouped piece → actions**.
- Step side-panel (`ap-function-config.svelte`): header gains piece logo + **version badge** (AP shows `v0.8.3`); **Connection select pinned at top** with tri-state `✓ Connected / Connect required / OAuth app missing` + inline Connect popup; dynamic dropdowns get a cold-start "warming… auto-retry" state (the `/options` proxy maps Knative cold-start to `503 {warming:true}`); **`Test step`** button runs `/execute` with sample input; node chrome gets validation dots (unresolved `{{connections[…]}}` refs, version drift).

### 5.5 Agent MCP config (Claude Console pattern; Phase 5)

Read view: "MCPs and tools" cards with tool counts + permission chips (CMA shows expandable "Tool permissions (8)" + `Always allow`). Edit: per-server checkboxes with expandable real tool lists (`tools/list` with cache write-back), per-tool `Allow | Disable`, per-server connection binding, JSON/YAML escape hatch (CMA parity). Default mode `auto`; per-node `overrides.mcpServers` narrowing in `sw-agent-config.svelte` honored by `resolve_mcp_config.py`.

### 5.6 Stretch (doc-only)

Perplexity-style **`@`-mention** in the session composer (`@github` attaches an enabled piece MCP server to the session ad hoc); run/transcript piece attribution (logo + "via GitHub MCP · connection …" in tool views).

---

## 6. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | This document + CLAUDE.md updates | done |
| 1 | Converged piece-runtime: `/execute` + `/options` in piece-mcp-server; function-router `activepieces` type + reference-forwarding; BFF catalog from `piece_metadata`; reconciler all-catalog; NetworkPolicy; delete fn-activepieces | in flight |
| 2 | Durability: `piece_execution` idempotency gate, error classification, `AP_RETRY_POLICY`, pause mapping (DELAY/WEBHOOK), >4 MiB artifact offload, Postgres `ctx.store` | in flight |
| 3 | Core UI: Integrations hub, piece detail subroute, MCP Server panel, canvas picker/side-panel upgrades | in flight |
| 4 | Maintainability pipeline: piece-registry SSOT, committed catalog snapshot, Renovate + breaking-change classifier gates, version stamping + start-time validation, deprecation lifecycle | roadmap |
| 5 | UI polish: agent MCP config, transcript attribution, health/status plumbing, `@`-mention | roadmap |
| 6 | Trigger-based: aggregated MCP endpoint (agentgateway/kgateway), OCI catalog publication (agentregistry) | deferred w/ triggers (§2.3) |

## 7. Risks

- **Cold start** (~2–10 s) on non-pinned piece activities — acceptable for durable workflows; the escape hatch is widening the pinned set, never resurrecting a monolith.
- **Single image = blast radius for all pieces** — mitigated by pinned digests, per-piece Knative revision rollout, catalogDigest drift detection; the Phase 4 CI canary is the long-term guard.
- **github 0.6.4 → 0.7.x convergence** may change action schemas under saved workflows/connections — the sync-metadata diff must be reviewed at cutover.
- **Streamable-HTTP MCP sessions are in-memory per replica** (pre-existing): Knative scale-down can drop sessions; agents must tolerate re-init; `scale-down-delay=30s` is the buffer.
- **All-catalog KServices (~45/spoke)** add K8s object load — verify on ryzen/dev before hub.
- **Reference-forwarding cutover**: any consumer relying on router-injected `credentials` env-dicts for AP slugs breaks — grep before cutover (none found in-repo at decision time; re-verify at implementation).
