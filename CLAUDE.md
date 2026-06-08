# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. SvelteKit serves as UI + BFF proxy; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs** (`docs/`):
> - `agent-runtime-comparison.md` — `dapr-agent-py` vs `claude-agent-py`: verified surface-by-surface comparison + rationale + swap-blockers
> - `durable-session-runtime-contract.md` — the swappable runtime contract + declarative runtime registry (`core/runtime_registry.json`)
> - `activepieces-auth.md` — AP auth + integration
> - `mcp-agent-workflows.md` — MCP-enabled `dapr-agent-py` workflow method
> - `hooks-and-plugins.md` — `dapr-agent-py` hooks + plugins (Claude Code port)
> - `CLICKHOUSE_OBSERVABILITY.md` — ClickHouse observability stack
> - `openshell-capabilities.md` — OpenShell sandbox capabilities
> - `cma-parity.md` — CMA console parity: workspaces, members, sessions, custom skills, limits
> - `callable-agents.md` — `CallAgent` peer-delegation tool (native `WorkflowContextInjectedTool`)
> - `tiered-crawl-pipeline.md` — `crawl4ai-adapter` v2 + `browserresearchfanout01` v3 (canonical multi-URL research pattern)
> - `workflow-artifacts.md` — Standardized `workflow_artifacts` surface
> - `workflow-lifecycle-termination.md` — **lifecycle SSOT**: the vetted stop/terminate/purge for workflows + agent runs (the server-side Lifecycle Controller, `/stop` routes + modes, root-cause fixes, GitOps safety nets) — IMPLEMENTED (PR1–PR4)

## Architecture

All workflow execution lives in `workflow-builder` namespace:

- **SvelteKit BFF** (port 3000, Dapr sidecar) — UI + proxy. Calls workflow-orchestrator over Dapr.
- **workflow-orchestrator** (Python/Dapr) — SW 1.0 interpreter. `durable/run` → `ctx.call_child_workflow`; all other slugs → Dapr svc invoke → function-router. Resolves the target agent runtime via the runtime registry SSOT (`core/runtime_registry.py`).
- **Runtime registry (SSOT)** — `services/shared/runtime-registry.json` is the single source of truth for the 4 agent runtimes (`dapr-agent-py`, `claude-agent-py`, `adk-agent-py`, `browser-use-agent`): per-runtime identity (app-id/image/container) + capability descriptor (durability granularity, MCP/hooks/permission support, providers). `scripts/sync-runtime-registry.mjs` generates the orchestrator + BFF build-context copies (drift-guarded).
- **Per-session Sandbox pods** — non-browser runtimes are dispatched as per-session ephemeral `agent-sandbox` (kubernetes-sigs/agent-sandbox) pods differing only by container image, Kueue-admitted and self-reaped on session end. `browser-use-agent` uses a `SandboxWarmPool` carve-out. Each runs `session_workflow` + `daprd` sidecar + `seed-openshell-config` init container + optional `chromium` + `playwright-mcp` sidecars. A legacy static `Deployment-dapr-agent-py` survives only for the `openshell-durable-agent` enum + the benchmark coding pool.
- **function-router** — slug routing + credential broker. Routes to fn-system / fn-activepieces / openshell-agent-runtime / code-runtime / crawl4ai-adapter.
- **Infra** — Redis, PostgreSQL, OTEL Collector. MCP services (workflow-mcp-server, piece-mcp-server, mcp-gateway) retained on-demand.

Per-session sandbox pods (chromium + OpenShell workspace containers) live in `openshell` namespace, addressed over mTLS. Agent sandbox pods MUST colocate with the orchestrator — Dapr workflow sub-orchestration doesn't cross namespaces.

**Key dispatch invariants**
- **Runtime resolution is registry-driven**: the orchestrator's `sw_workflow.py::_resolve_native_agent_runtime` is a thin shim over `runtime_registry.resolve()` (`services/workflow-orchestrator/core/runtime_registry.py`), which reads the generated `core/runtime_registry.json`. The descriptor supplies the dispatch app-id, instance prefix, container image, and capabilities — no scattered string enumerations.
- **Two-name dispatch**: `durable/run` dispatches the Dapr workflow literal `session_workflow` (`descriptor.dispatch_workflow_name`); the workflow-session bridge-eligibility sentinel is `agent_workflow` (`descriptor.bridge_gate_token == config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME`). Distinct strings/roles.
- **Per-session Sandbox, no wake/idle**: there is NO per-agent `AgentRuntime` CR, NO Kopf wake/idle annotation, NO `agent-runtime-controller`. Each session dispatches an ephemeral `agent-sandbox` pod (Kueue-admitted, self-reaped on session end); `browser-use-agent` uses a `SandboxWarmPool`.
- `durable/run` is a **Dapr child workflow**, not HTTP. `spawn_session_for_workflow` activity POSTs to `/api/internal/sessions/ensure-for-workflow` which finds-or-creates the session row, rewrites Playwright stdio MCP presets to per-pod sidecar URL, and ensures the per-session sandbox is admitted. Parent then yields `ctx.call_child_workflow("session_workflow", app_id=<descriptor app-id>, instance_id=<deterministic session_id>, autoTerminateAfterEndTurn=true)`. Retry resilience lives on the **agent callee** — `dapr-agent-py` decorates `session_workflow` with `WorkflowRetryPolicy(max_attempts=8)` (`src/main.py:5897`) wrapping `call_llm`; the orchestrator's own internal activities/`CreateInstance` carry **no** `retry_policy`.
- **Swap-safety gate** (`src/lib/server/agents/swap-safety.ts`): derives an agent's required capabilities from its `agentConfig` (MCP/hooks/plugins/permission-gating/provider/durability) and compares against the target runtime's DECLARED capabilities → `{decision: allow|warn|reject, drops[]}`. MCP-loss + provider-mismatch are REJECT-class; hooks/plugins/permission/durability downgrades are WARN-class. WARN-first by default; only rejects when `AGENT_RUNTIME_REJECT_LOSSY_SWAP=true`. Wired into `src/lib/server/sessions/spawn.ts`.
- **Direct (UI-initiated) sessions** go through `src/lib/server/sessions/spawn.ts`, which resolves the runtime via the BFF registry (`src/lib/server/agents/runtime-registry.ts`) and calls Dapr `StartInstance` via service invoke (bare app-id, no `.namespace` suffix).
- **MCP sidecar rewrite**: both paths call `rewriteMcpForBrowserSidecar` (`src/lib/server/agents/mcp-sidecar.ts`) — Playwright entries become `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`.
- **Dapr Component visibility**: `workflowstatestore` is the only `actorStateStore=true` Component visible to agents; `dapr-agent-py-statestore` and legacy `agent-workflow` are non-actor stores. New agents must NOT be added to Component scopes.
- Every non-agent action: `orchestrator → Dapr service invoke → function-router → {fn-system | fn-activepieces | openshell-agent-runtime | code-runtime | crawl4ai-adapter}`. Orchestrator uses `activities/dapr_invoke.py` (no raw HTTP). `openshell-agent-runtime` consolidates `workspace/* + browser/* + openshell/*` (legacy `workspace-runtime` removed 2026-04-21).
- The **BFF** owns credential decryption — `src/lib/server/security/encryption.ts` does `createDecipheriv('aes-256-cbc')` (line 56). function-router is the **credential broker**: at execution it HTTP-GETs the BFF `/api/internal/connections/<id>/decrypt` endpoint (`function-router/src/core/credential-service.ts`) and writes the `credential_access_logs` audit — it does NOT decrypt itself. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python, `dapr-ext-workflow==1.17.1`) via workflow-orchestrator; Dapr control plane 1.17.9
- **Durable AI Agents**: 4 runtimes selected per-agent via the runtime registry SSOT (`services/shared/runtime-registry.json`), each registering the Dapr workflow `session_workflow` and sharing one CMA session-event HTTP ingest contract. `dapr-agent-py` (per-ACTIVITY loop: each LLM turn + tool call is its own Dapr activity; multi-provider, 9 adapters) is built **ON the GA dapr-agents framework** (subclasses `DurableAgent`, reuses `DaprChatClient`/`AgentRunner`/`MCPClient`; pinned `dapr-agents==1.0.3`, boot-guarded via `assert_dapr_agents_version()`); its 9 LLM adapters monkeypatch `DaprChatClient.generate` for DIRECT provider calls (bypassing the still-ALPHA Dapr Conversation API). `claude-agent-py` (Claude Agent SDK, whole loop in ONE activity, Anthropic-only; **now supports MCP** — `agentConfig.mcpServers` wired into the SDK), `adk-agent-py` (Google ADK), and `browser-use-agent` (browser/vision, warm-pool) round out the set. The swap-safety gate (`src/lib/server/agents/swap-safety.ts`) guards lossy runtime swaps. Dispatched as per-session ephemeral `agent-sandbox` pods (Kueue-admitted, self-reaped). Durable-state/payload ceiling = the 16 MiB gRPC `max-body-size` (Postgres store).
- **Function Execution**: function-router (Dapr invoke) → fn-system / fn-activepieces / openshell-agent-runtime / code-runtime
- **Activepieces**: 42 AP piece packages, OAuth2 PKCE, encrypted app connections
- **Observability**: OpenTelemetry → OTEL Collector → Jaeger / MLflow
- **Deployment**: Docker, Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start SvelteKit dev server (local, no cluster)
pnpm build            # Production build
pnpm check            # Svelte type checking
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations
pnpm db:studio        # Drizzle Studio
pnpm test:e2e         # Playwright E2E tests
```

## Dev Loop (Skaffold, ryzen cluster)

Skaffold is the in-cluster dev loop. `devspace.yaml` + `scripts/devspace-dev-ryzen.sh` were retired in Phase 1; `bash scripts/skaffold-dev.sh` is the canonical entry point.

```bash
# Inner loop (HMR file-sync into a Skaffold-owned dev pod):
pnpm dev:skaffold                              # workflow-builder (default)
pnpm dev:skaffold:orchestrator                 # workflow-orchestrator
pnpm dev:skaffold:all                          # active modules
bash scripts/skaffold-dev.sh function-router   # any single module by name
bash scripts/skaffold-dev.sh workflow-builder workflow-orchestrator  # subset

# Outer loop (build prod image → push → commit kustomize pin → Argo deploys):
pnpm deploy:skaffold                                # workflow-builder
pnpm deploy:skaffold:orchestrator                   # workflow-orchestrator
bash scripts/skaffold-deploy.sh fn-activepieces     # any single service
bash scripts/skaffold-deploy.sh workflow-builder workflow-orchestrator  # batch
skaffold build -m workflow-builder                  # build+push only (no pin commit)

# Read-only preflight:
pnpm skaffold:doctor                                # Skaffold + GitHub-main pin readiness
pnpm --silent skaffold:doctor -- --json             # machine-readable agent output
```

The outer-loop uses `scripts/skaffold-deploy.sh` rather than `skaffold run` because:
- `skaffold run -m <svc>` also redeploys the dev kustomize overlay (which Argo immediately reverts but causes pod restarts).
- Skaffold artifact `hooks.after` doesn't fire on cache hits, so `skaffold run` would silently miss commit-pin when re-pushing the same SHA.

The wrapper invokes `skaffold build --file-output`, parses the resolved tag, and unconditionally runs `commit-pin.sh` with it. Commit-pin maintains a dedicated clone at `~/.cache/skaffold/stacks-ryzen` (tracking GitHub `main` — the same origin as the developer's stacks/main worktree; the `stacks-ryzen` dir name is legacy). It is the single image-pin writer on GitHub `main` for the Skaffold-owned services (`SKAFFOLD_OWNED_DEFAULT` in `scripts/_modules.sh`); every other ryzen workload is pinned by the hub outer-loop `update-stacks-image` Tekton task.

Module set:

| Module | Type | Local→Container port |
|---|---|---|
| workflow-builder | SvelteKit BFF (Node 22) | 3002→3000 |
| workflow-orchestrator | Python/FastAPI Dapr workflow | 3013→8080 |
| function-router | Node BFF→backend router | 3014→8080 |
| mcp-gateway | Node hosted MCP endpoint | 3018→8080 |
| swebench-coordinator | Python SWE-bench coordinator | 3019→8080 |
| fn-activepieces | Node Activepieces piece executor | 3016→8080, inactive by default |

**`fn-system` is excluded** — it's a Knative Service (scale-to-0; not a regular Deployment). Inner-loop file-sync into a transient Knative pod is impractical. Use the cluster's existing fn-system (Argo-managed) as a dependency; `scripts/sandbox-dev.sh` is the experimental sandbox-based alternative for Knative-style workloads.

**`fn-activepieces` is inactive by default** — Skaffold config remains in-tree, but the current ryzen cluster does not expose it as a regular Argo Application/Deployment. Default `ALL` sessions skip it; use `SKAFFOLD_ALLOW_INACTIVE=1 bash scripts/skaffold-dev.sh fn-activepieces` only when deliberately restoring/testing that path.

Inner-loop notes:
- The wrapper `scripts/skaffold-dev.sh` exports `SKAFFOLD_DEFAULT_REPO=ghcr.io/pittampalliorg` so the dev image gets pushed to GHCR (ryzen pulls it via the authenticated `ghcr.io/hosts.toml` containerd mirror + Spegel P2P). The host running `skaffold dev` needs GHCR push creds (`docker login ghcr.io`). Override via `SKAFFOLD_DEFAULT_REPO=…` for other clusters.
- The wrapper traps SIGINT/SIGTERM/EXIT to resume ArgoCD reliably. If skaffold is `kill -9`'d, recover with `ARGO_APPS=workflow-builder bash skaffold/hooks/argo-resume.sh`.
- File sync rules in `skaffold/workflow-builder.skaffold.yaml` define which paths trigger HMR vs a full image rebuild. Edits to `src/`, `lib/`, `static/`, `drizzle/`, `vite.config.ts`, etc. trigger HMR without rebuild. Edits to `package.json`/`pnpm-lock.yaml` force a full image rebuild + redeploy.
- The dev kustomize overlay at `skaffold/dev/workflow-builder/` extends **only** `Deployment-workflow-builder.yaml` from `stacks/main/.../workloads/workflow-builder/manifests` (via `LoadRestrictionsNone`) and strategic-merge-patches it; all other resources (Dapr Components, ExternalSecrets, Services) stay as Argo deployed them. Because the base prod `images:` rewrite is bypassed, the patch must pin **both** the main container AND the `db-migrate` init container to the `workflow-builder-dev` artifact — leaving db-migrate unpatched fails the deploy with `ErrImagePull` on `workflow-builder:latest` (fixed in PR #28; the dev image bakes in `scripts/db-migrate-runtime.mjs` + `drizzle/`, so it runs migrations fine). No postgres rewrite is needed — `docker.io/library/postgres` pulls via the containerd `docker.io/hosts.toml` mirror.
- `pnpm skaffold:doctor` checks command availability, kubectl context, the GHCR default-repo, the stacks worktree + GitHub-main pin cache, per-module Argo/Deployment state + pin drift, and Argo skip-reconcile leaks.

Outer-loop notes:
- Build hook `skaffold/hooks/commit-pin.sh` writes the new tag to GitHub `main` and `git push`es. For most Skaffold-owned services it does a textual edit of the bare `packages/components/workloads/<service>/manifests/kustomization.yaml` `newTag` (nested Python parser). **`workflow-builder` + `workflow-mcp-server` are the exception** (C1 unification, stacks #2443 / wfb #33): commit-pin UPSERTS the flat pins file `packages/components/hub-spoke-appsets/release-pins/workflow-builder-images-ryzen.yaml` (images/imageRefs/digests/sourceShas) and pushes — it does NOT touch their manifests `newTag`. The bare `images:` block was deleted from `workloads/workflow-builder/manifests/kustomization.yaml`, which now `components:`-includes a render-generated Component at `packages/components/workloads/workflow-builder-ryzen-image/kustomization.yaml` carrying the workflow-builder + workflow-mcp-server pin; ryzen's workflow-builder Application sources `manifests/` directly, so that Component IS ryzen's effective pin. For latency, commit-pin ALSO renders + commits that Component **locally** (from its fresh hard-reset `~/.cache/skaffold/stacks-ryzen` clone — not stale; the render is deterministic) and then `refresh=hard`es the **ryzen spoke-local** app, so ryzen reconciles in seconds. (ryzen is an autonomous argocd-agent with no fast inbound refresh: it has no argocd-server, and the principal does NOT relay a refresh to autonomous agents on argocd-agent v0.8.1 — verified empirically; the hub mirror annotation is a no-op, so commit-pin must refresh the spoke-local app directly.) The stacks CI action `.github/workflows/render-ryzen-image.yml` re-renders the Component on push (author github-actions[bot], via `scripts/gitops/render-workflow-builder-release-overlays.sh` `WFB_RENDER_ENVS=ryzen`) as a **drift-correction safety net** — it commits only on a diff, so it no-ops when commit-pin's local render already matches. A writer-precedence guard refuses to push for any non-Skaffold-owned service (override the owned set via `SKAFFOLD_OWNED_SERVICES`; the remote via `STACKS_REMOTE_URL`). ryzen's local autonomous ArgoCD reconciles `packages/overlays/ryzen@main` within ~30s; an `argocd.argoproj.io/refresh=hard` annotation accelerates the poll.
- No `kubectl set image` — the live cluster is mutated only by ArgoCD.
- Bare-manifests workloads image pins use bare `name: <svc>` match-keys (`workflow-orchestrator`/`function-router`/`mcp-gateway` were flipped from the retired `gitea-ryzen.tail286401.ts.net/giteaadmin/<svc>` long-form in stacks PR #2435; image-neutral). commit-pin matches `name == <svc>` OR `name endswith /<svc>`. (This bare-manifests path applies to every Skaffold-owned service EXCEPT `workflow-builder`/`workflow-mcp-server`, which pin via the flat ryzen pins file → render-ryzen-image CI → render-generated Component — see the Build-hook note above.)
- **commit-pin's HTTPS push can 403 on this NixOS host** (read-only git config → denied OAuth fallback). The image + pin commit are still made; push the cached pin with `git -C ~/.cache/skaffold/stacks-ryzen push "https://x-access-token:$(gh auth token)@github.com/PittampalliOrg/stacks.git" HEAD:main`, then hard-refresh `ryzen-<svc>`. **Don't `deploy:skaffold` a commit the GitHub outer-loop also builds** (right after merging a PR to `main` that touches `services/<svc>/**` — the hub github-outer-loop now auto-builds that service for dev) — both build the same `git-<sha>` tag with different digests, so the GitHub build's release-pins digest then mismatches GHCR; to deliver a just-merged commit to ryzen, commit-pin the existing GHCR tag instead of rebuilding (`SKAFFOLD_IMAGE=ghcr.io/pittampalliorg/workflow-builder:git-<sha> bash skaffold/hooks/commit-pin.sh workflow-builder`). For `workflow-builder`/`workflow-mcp-server` this writes the flat ryzen pins file, renders the Component locally, and refreshes the ryzen spoke-local app (the `render-ryzen-image` CI re-renders on push as a drift net). commit-pin's hard-refresh tries `ryzen-${service}` before the bare name (ryzen's autonomous argocd-agent names apps `ryzen-<svc>`; bare-name annotate no-ops). NOTE: this `refresh=hard` only works against the ryzen **spoke** (ns `argocd` on the ryzen cluster); annotating the hub mirror does NOT relay to an autonomous agent.
- ryzen reconciles `packages/overlays/ryzen@main` directly via its local autonomous ArgoCD (no inner-loop branch, no source-hydrator, no Promoter for ryzen); commit-pin is the single image-pin writer for Skaffold-owned services. Use `clu`/cluster-update for stacks manifest edits, Skaffold for live source hot reload, and release-pins/GitOps Promoter for **dev** (staging is dormant — no staging cluster; promotion is ryzen + dev, stacks PR #2436/#2437).
- **Dev auto-promote covers ALL Skaffold-owned services, not just workflow-builder** (verified end-to-end 2026-06-05 for workflow-builder, workflow-orchestrator, function-router, mcp-gateway, swebench-coordinator). The hub Tekton EventListener `github-outer-loop` has **per-service triggers** (CEL: a merge to `main` touching `services/<svc>/**`, or commit message `[build all]`) → the **parameterized, service-agnostic** `outer-loop-build` Pipeline builds the image → GHCR → the `update-stacks` task pins the SHARED `packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml` (one file holds EVERY service's dev pin) + renders the dev overlay (`workflow-builder-system-overlays/dev`) → source-hydrator → GitOps Promoter → `env/spokes-dev` → `dev-<svc>` rolls. (The earlier "only workflow-builder auto-builds" belief was wrong — the per-service triggers were live but had simply never been exercised. workflow-builder's own trigger additionally fires on `src/`, `lib/`, `scripts/`, `static/`, `drizzle/`, `Dockerfile`, `package.json` changes.) github-outer-loop deliberately does NOT touch ryzen's pin — ryzen is the Skaffold commit-pin lane.
- **Push-retry backoff (stacks #2455)**: `update-stacks`'s `git push origin main` now retries 6× with 4/8/12/16/20s backoff and a rebase between attempts. The old loop (3 tries in ~1s, no backoff) could DROP a build's dev promotion on a transient GitHub 500 / push contention (e.g. a build racing a concurrent merge); transient push failures now self-heal.
- **Bring a stale service current without a source change**: create a PipelineRun from `outer-loop-build` with params `git_url=https://github.com/PittampalliOrg/workflow-builder.git`, `git_sha=<current main HEAD>`, `image_name=<svc>`, `dockerfile=services/<svc>/Dockerfile`, `context=.` (Node: function-router/mcp-gateway) or `services/<svc>` (Python: workflow-orchestrator/swebench-coordinator); workspaces `shared-workspace` (emptyDir), `dockerconfig` (secret `ghcr-push-credentials`), `buildah-cache` (PVC `buildah-cache-<svc>`). Per-service `image_name`/`dockerfile`/`context` mirror each `outer-loop-<svc>` TriggerBinding. Builds from current main → `update-stacks` re-pins dev. (Used 2026-06-05 to bring mcp-gateway/swebench-coordinator/function-router current.)
- The `workflow-builder` ryzen outer-loop is FULLY AUTOMATED end-to-end once you commit-pin (C1, validated): build → commit-pin upserts the flat ryzen pins file **+ renders the Component locally + `refresh=hard`es the ryzen spoke-local app** → push → ryzen's autonomous local ArgoCD reconciles `overlays/ryzen@main` in **seconds** (no waiting on CI or the 30s poll). The `render-ryzen-image` CI re-renders on push as a drift-correction net (no-ops on match). No manual render step.
- **Ryzen single-pin (2026-06-05) — the render-generated Component is the SOLE ryzen image authority.** The `root-ryzen` overlay (`packages/overlays/ryzen/kustomization.yaml`) USED TO also patch the `ryzen-workflow-builder` Application's `spec.source.kustomize.images` to a hardcoded sha. ArgoCD applies `spec.source.kustomize.images` ON TOP of the rendered kustomization, so that override silently WON over the Component commit-pin maintains — commit-pin updated the Component + flat pins, the app showed `Synced`, but the Deployment stayed FROZEN on the stale sha (`argocd-repo-server` restart did NOT help — override-precedence, not a cache). That override was REMOVED (the app keeps only its non-image `patches:`; ArgoCD docs call Application-object image overrides a GitOps anti-pattern). A CI guard `validate-ryzen-no-app-image-overrides` (stacks `.github/workflows/` + `scripts/gitops/`) fails the build if any ryzen-overlay Application reintroduces it. **Telltale of the old trap:** the app's `spec.source.kustomize.images` shows an OLD sha while `kubectl kustomize packages/components/workloads/workflow-builder/manifests` renders the NEW image. Verified end-to-end across BOTH lanes 2026-06-05: one merged SHA reached dev (Promoter lane) and ryzen (commit-pin lane) with no overlay edit.

### GitOps activity stream (Argo Events → `/admin/gitops/system`)

The delivery system is observable LIVE in the admin UI at `/admin/gitops/system` (the "Kargo lens" pipeline), fed by **Argo Events** on the hub:
- **Producers** (stacks `packages/components/hub-management/manifests/gitops-activity-events/`): an `EventBus` + resource `EventSource`s watching ArgoCD `Application`s, Tekton `PipelineRun`/`TaskRun`s, and GitOps-Promoter CRs → `Sensor`s POST normalized events to the BFF.
- **Ingest**: `POST /api/internal/gitops/events/ingest` → `src/lib/server/gitops/activity-events.ts` classifies `source` (tekton/promoter/argocd), extracts a `correlation` map (imageName, gitSha, argocdApp, syncRevision, branch, hydratedSha, …), and appends to `gitops_activity_events` (monotonic `sequence`).
- **UI**: SSE `GET /api/v1/gitops/events/stream?since=<seq>` (sequence-resume + backoff reconnect + fallback poll). `src/lib/gitops/activity-overlay.ts` correlates events onto the pipeline model (overlay attaches `activity` only — never mutates the authoritative inventory health/sync). Graph/list/drawer render event-first (shared tone in `activity-tone.ts`, freshness from one shared clock, node/edge flow pulse on each batch); raw firehose behind `?debug=1`. The header `build <sha>` badge is the image THAT cluster's pod is running, doubling as the per-cluster delivery proof.

**Build feedback + delivery timeline (INVENTORY-sourced, not event-sourced).** The pipeline also surfaces image-build status and the full Commit→Build→Pin→Promote→Deploy chain — but from the **hub inventory**, NOT the Argo-Events stream (the stream is ~100% ArgoCD; Tekton events are buried). `pipeline-model.ts` threads the inventory's per-app `build` (`{pipelineRun,status,startedAt,finishedAt}` → `StageBuild`) and `imageHistory` provenance (`StageProvenance`: commit/pin). So **no Tekton TaskRun triggers were added — the Tekton EventSource is unchanged.**
- **Stage cards**: a persistent build chip (`buildVisual` in `kargo-status.ts`: Built/Building/Failed + `formatDurationMs` + a Tekton PipelineRun deep-link via `tektonPipelineRunUrl`, ns `tekton-pipelines`). Warehouse headers get a compact build pip.
- **Drawer "Delivery" timeline** (`PipelineDrawer.svelte`): inter-step **gaps** (`↓ +1m`), phase **durations** (build, soak), a **`commit→live` lead-time** header, and ONE absolute "live since" on Deploy. A per-row "N mins ago" collapses to one value because the automated outer-loop runs as one sub-minute burst, so durations/gaps carry the signal. **Lane-aware Promote**: dev shows the promoted hydrated sha + soak/gate; ryzen shows "direct to main · no Promoter gate".
- **Data quirk**: `imageHistory.committedAt` is the *pin*-commit time (from the stacks release-pins git log), so Commit≈Pin and the lead-time anchors on `build.startedAt` (the earliest real event).

**App-wide deployment notifications (toast + sidebar bell).** Beyond the pipeline page, a notification fires on EVERY authenticated page when an image actually replaces a deployment — a component's LIVE image tag changes on a cluster. Surfaces as a svelte-sonner toast (reusing the mounted `<Toaster>`) + a sidebar notification bell (`src/lib/components/chrome/notification-bell.svelte`: unread badge + localStorage history, mark-read/clear). Admin-gated (the inventory/SSE endpoints require it).
- **Store**: `src/lib/stores/deployment-notifications.svelte.ts` — a singleton runes store started once from the root `+layout.svelte` `onMount` (admin only), `onDestroy`/HMR-disposed. Detection = **inventory-diff** (not the event stream): it baselines each `env:component`'s SET of live image tags from `/api/v1/gitops/deployment-metadata` and fires when a genuinely new tag appears while `Synced`. The gitops SSE stream is a debounced re-check trigger; a 25s poll is the fallback. Toast-spam capped (>3 simultaneous → one summary toast).
- **Detection gotcha**: `live.images` mid-rollout holds BOTH old+new component tags (coexisting ReplicaSets) and `desired.image` is a full ref WITH a tag, not a repo — so the diff is a tag-SET diff (`current − baseline`), not a single "current tag" (which returns the old tag and never fires).

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, SW 1.0 interpreter |
| **agent-sandbox pod** (per-session) | n/a | Ephemeral runtime pod (`dapr-agent-py`/`claude-agent-py`/`adk-agent-py`) differing only by image; Kueue-admitted, self-reaped. `browser-use-agent` via `SandboxWarmPool`. (AgentRuntime CRD + Kopf `agent-runtime-controller` RETIRED → upstream kubernetes-sigs/agent-sandbox + Kueue.) |
| **dapr-agent-py** (legacy Deployment) | n/a | Static replicas:4 pod; survives only for `openshell-durable-agent` enum + benchmark coding pool |
| **function-router** | 8080 | Sync credential broker + Knative proxy. `function-registry` ConfigMap is authoritative over built-in fallback. |
| **fn-system** | 8080 | system/* (http-request, database-query, condition) |
| **fn-activepieces** | 8080 | AP piece executor |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external clients |
| **workflow-mcp-server** | 3200 | Retained MCP server |
| **piece-mcp-server** | dynamic | On-demand piece MCP |
| **openshell-sandbox** | — | Custom sandbox image (Chromium/Playwright); per-session pods in `openshell` ns |

## Project Structure

- `src/routes/` — API routes (`api/workflows`, `api/orchestrator`, `api/app-connections`, `api/internal/{connections,mcp,agent}`, `api/events/ingest`, `api/v1/auth`, `api/pieces`) + pages
- `src/lib/components/workflow/` — Svelte Flow canvas, side-panel, toolbar, base-sw-node, animated-edge
- `src/lib/server/` — `db/schema.ts` (Drizzle), `dapr-client.ts`, `auth.ts`, `security/encryption.ts`, `app-connections/oauth2.ts`, `internal-auth.ts`, `workflows/external-event-registry.ts`, `otel/clickhouse.ts`
- `services/` — `workflow-orchestrator/`, `dapr-agent-py/`, `claude-agent-py/`, `adk-agent-py/`, `function-router/`, `fn-activepieces/`, `fn-system/`, `workflow-mcp-server/`, `piece-mcp-server/`, `mcp-gateway/`, `openshell-sandbox/`, `crawl4ai-adapter/`, plus `shared/runtime-registry.json` (runtime SSOT)
- `drizzle/` — migration SQL. `scripts/` — dev/seed/test. `docs/` — supplementary docs.

## Action Routing

Routed by `actionType` slug prefix. Orchestrator → function-router uses Dapr service invoke; `durable/run` bypasses function-router via `ctx.call_child_workflow`.

| Prefix | Service | Notes |
|--------|---------|-------|
| `durable/run` | per-session agent-sandbox pod | Native Dapr child workflow `session_workflow`. Target runtime + app-id resolved via `runtime_registry.resolve()` from the agent's `runtime`; falls back to the registry default only when neither `agentAppId` nor `agentSlug` is stamped. |
| `system/*` | fn-system | http-request, database-query, condition |
| `workspace/*` | openshell-agent-runtime | Plus `persist_workspace_session` activity after `workspace/profile` with `keepAfterRun=true` (UPSERTs `workflow_workspace_sessions` for live-preview proxy) |
| `browser/*` | openshell-agent-runtime | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | OpenShell helper routes |
| `code/*` | code-runtime | Saved TS/Python code execution |
| `*` (default) | fn-activepieces | All AP piece actions |

Rejected slugs (orchestrator raises): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, any `mastra/*` or `agent/*`.

## Agent Runtime Model

The runtime registry (`services/shared/runtime-registry.json`) is the dispatch SSOT — `scripts/sync-runtime-registry.mjs` generates the orchestrator copy (`services/workflow-orchestrator/core/runtime_registry.json`, read by `core/runtime_registry.py`) and the BFF copy (`src/lib/server/agents/runtime-registry.data.json`, read by `src/lib/server/agents/runtime-registry.ts`); a `--check` mode + tests guard drift. Each descriptor carries identity (`appIdConfigKey`, `instancePrefix`, `mainContainerName`, `imageEnvKey`, `agentMetadataFramework`, `benchmarkEligible`) + a capability descriptor (`durabilityGranularity`, `supportsMcp`, `supportsHooks`, `supportsPermissionGating`, `incrementalEvents`, `ownsSandbox`, `requiresWarmPool`, `requiresBrowserSidecars`, `multiProvider`, `supportedProviders`).

On publish, `src/lib/server/agents/registry-sync.ts` mirrors agent metadata into the Dapr agent registry (its `runtime` selects a descriptor). There is **no per-agent `AgentRuntime` CR and no Kopf controller** — deployment is upstream kubernetes-sigs/agent-sandbox + Kueue: each session dispatches an ephemeral `agent-sandbox` pod (differing only by container image), Kueue-admitted and self-reaped on session end. `browser-use-agent` uses a `SandboxWarmPool` carve-out for Chromium boot latency.

**Pod shape**:
- `seed-openshell-config` init container — writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + mTLS certs from `openshell-client-tls` + `openshell-server-client-ca` Secrets. Without it, OpenShell tools fail with ENOENT on `active_gateway`.
- runtime main container (`dapr-agent-py` / `claude-agent-py` / `adk-agent-py`, per `descriptor.mainContainerName`) — registers `session_workflow` + plugins/hooks. Reads bootstrap MCP servers from env. `claude-agent-py` now wires `agentConfig.mcpServers` into the Claude Agent SDK.
- `daprd` sidecar — injected by `openshell-sandbox-dapr-webhook` (matches `openshell` and `workflow-builder`). Requires `openshell-sandbox-dapr` Configuration in the pod's namespace.
- *(Optional)* `chromium` + `playwright-mcp` browser sidecars when the descriptor's `requiresBrowserSidecars`/agent Playwright MCP preset applies, with a per-session `mcp:3100` endpoint.

**Lifecycle**: per-session Sandbox pods are created on dispatch and self-reaped on session end — no scale-to-0 Deployment, no wake/idle annotations. The legacy static `Deployment-dapr-agent-py` (replicas:4) survives only for the `openshell-durable-agent` enum + `agent-runtime-pool-coding` benchmark pool.

**Dapr Component visibility** in `workflow-builder` ns:

| Component | `actorStateStore` | Used by |
|---|---|---|
| `workflowstatestore` | true | Dapr workflow/actor history |
| `dapr-agent-py-statestore` | false | Agent/session state |
| `agent-workflow` | false | Legacy openshell-durable-agent (no active consumers) |

A Dapr sidecar refuses to start if it sees more than one `actorStateStore=true` Component. New agents: register in the runtime registry / Dapr agent registry; do NOT patch Component scopes.

## Workflow → Session Bridge

Every `durable/run` step goes through a session bridge so workflow-driven runs appear in the same `/sessions/[id]` UI as direct sessions. Structural invariant — old `WORKFLOW_USE_SESSIONS` flag removed.

**Flow** (`services/workflow-orchestrator/workflows/sw_workflow.py` + `activities/spawn_session.py`):

1. Orchestrator yields `spawn_session_for_workflow` with `bridge_payload` (agentAppId, agentSlug, workspaceRef, sandboxName, agentConfig, durable/run body).
2. Activity HTTP-POSTs to BFF's `/api/internal/sessions/ensure-for-workflow`. Handler rewrites `agentConfig.mcpServers` for browser sidecar, finds/creates session row (keyed by `child_instance_id = <exec>__<kind>__<node>__run__<index>`), creates ephemeral `agents` row if inline, ensures the per-session agent-sandbox is admitted (non-blocking — Dapr retries if the pod takes longer), returns `{sessionId, agentId, agentVersion, childInput, reused}`.
3. Orchestrator yields `ctx.call_child_workflow("session_workflow", input=childInput, instance_id=child_instance_id, app_id=target["app_id"])`.
4. Child runs on the per-session agent-sandbox pod with `autoTerminateAfterEndTurn: true` — one turn, emits `session.status_idle{end_turn}` + `session.status_terminated`.
5. Parent resumes; final output persists to `workflow_executions.output`.

### Safety nets on the agent side (2026-04-21)

Defensive layers prevent `durable/run` hangs:

- **Empty-response circuit breaker** (`services/dapr-agent-py/src/main.py` `call_llm`): tracks consecutive empty-content + no-tool-calls responses (or exceptions counted as empty). After `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3), raises `AgentError`. Catches Anthropic SDK [#1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204) (Opus 4.7 + thinking + tools emits empty `end_turn`).
- **Host-monitor thread** (`services/dapr-agent-py/src/main.py` `_run_session_host_monitor`, started at boot; logic in `session_host_monitor.py`): an **out-of-band** background thread polling workflow state for start/idle stalls. The old in-workflow durable **session-turn timer** (`when_any([child, timer])`, default 600s) was **removed** in commit `72154581`. The host-monitor's default idle/start action is **`"warn"`** (env `DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION`); only `terminate` actually kills the session. This thread is a *hang-detection* heuristic, **not** the stop watchdog — explicit user stops route through the Lifecycle Controller (below) and stuck DB↔Dapr divergence is reconciled by the `lifecycle-terminal-reaper` CronJob.
- **Image tool_result compaction** (`anthropic_adapter.py` `_compact_image_tool_results`): keeps only last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) intact image tool_result blocks; older ones replaced with placeholder text. Prevents 1M-token overflow from screenshot accumulation.

### Workspace session persistence

Orchestrator owns the DB write for `workflow_workspace_sessions` post `workspace/*` cutover:
- **`persist_workspace_session` activity**: after `workspace/profile` with `keepAfterRun=true`, UPSERTs the row (status=`active`, sandbox_state JSONB) keyed on `workspace_ref`. Read by `getExecutionSandboxPreviewInfo` for the live-preview proxy.
- **Cleanup gate**: `_should_cleanup_workspaces` walks the SW 1.0 spec for `workspace/*` steps with `with.keepAfterRun: true` (openshell-agent-runtime's response doesn't echo the flag back).

## Lifecycle: Stop / Terminate / Purge (Lifecycle Controller)

A single vetted server-side **Lifecycle Controller** in the BFF (`src/lib/server/lifecycle/{cascade,resolvers,index,reaper,ownership}.ts`) is the SSOT for stopping/terminating/purging Dapr Workflows + durable agent runs. Every user-facing "stop" affordance routes through it; ad-hoc terminate/purge code paths were removed. See `docs/workflow-lifecycle-termination.md` (the lifecycle SSOT; IMPLEMENTED PR1–PR4, then hardened for **reliable termination** in wfb #69–#72 — request/confirm + stop-surface ownership + cooperative-first; see doc Part 7).

**Entry point**: `stopDurableRun(target, { mode })`.
- `target.kind ∈ workflowExecution | session | evalRun`.
- `mode ∈ interrupt | terminate | purge | reset`:
  - **`interrupt`** — cooperative only (raise `session.terminate` / `user.interrupt`, bounded wait). "Pause the agent, keep the run."
  - **`terminate`** — graceful raise → Dapr terminate parent + every child app-id → poll to terminal. "Stop."
  - **`purge`** — terminate (if needed) → confirm terminal → Dapr purge (recursive; **purge-force** when the worker is gone) → reap per-session Sandbox CRs → flip all DB rows terminal. "Stop & clean."
  - **`reset`** (dev) — purge + delete the deterministic-ID occupants so the next run starts byte-clean.
- **Request/confirm (not one-shot fail-closed)** (#69/#71): stop persists a `stop_requested_at` intent (migration `0071`), returns **HTTP 202 "stopping"** while the durable tree converges (a `terminate` blocked inside a long activity applies late), and **only flips DB / reaps once Dapr is confirmed terminal** — finalized by a status poll (`GET …/stop/status` → `confirmDurableStop`, idempotent) and/or the reaper; the UI shows "Stopping…". 200 confirmed · 202 stopping · 409 only on a genuine non-request failure. Generalized from (and now shared with) the benchmark cancellation cascade (`cleanupBenchmarkDurableWorkflowCascade`). Cascade timing is env-tunable (`LIFECYCLE_CASCADE_WAIT_SECONDS` default 90; cooperative-first via `LIFECYCLE_TERMINATE_GRACE_SECONDS` default 5).
- **Single stop authority** (#70): each durable unit is stoppable only on the surface owned by its lifecycle authority. A benchmark/eval **instance** (a `workflow_executions` row driven by its run coordinator) is NOT stoppable via the generic per-execution Stop — that 409s (`coordinator_owned`, via `lifecycle/ownership.ts::ownsBenchmarkOrEvalRun`) and the UI hides the button + links to the owning **run's** Cancel. Standalone runs / direct sessions keep their Stop.

**User stop surfaces all route through it**:
- `POST /api/v1/sessions/[id]/stop` and `POST /api/workflows/executions/[id]/stop`; session interrupt; workflow-execution terminate; eval cancel.
- Delete/Archive are **BLOCKED** (409 "Stop the run first") while a run is active.
- UI: **Stop** / **Stop & Reset** buttons on the session-detail + workflow-run pages; the sessions-list "Archive" row action was relabeled **"Delete"** (it always hard-DELETEd).
- Auth: `/api/workflow-ops/*` now **requires platform admin** (was an unauthenticated JSON API). The dead, unauthenticated `DELETE /api/orchestrator/workflows/[id]` route + dead api-client methods (`workflows.terminateExecution`, `orchestrator.terminate/raiseEvent`) were **removed**.

**Cross-app-id fan-out (no implicit cascade)**: `session_workflow` children run under **per-session sandbox app-ids** = separate task hubs, so Dapr's native recursive cascade does NOT reach them. The BFF controller does **explicit per-session app-id fan-out** (terminate + purge each child app-id). The orchestrator's `terminate_durable_runs_by_parent_execution` activity was **RETIRED** (it only ever fanned out to the legacy `claude-code-agent` app-id); same-task-hub children rely on Dapr's native recursive cascade.

**Cross-app `durable/run` Stop WEDGE (kept `call_child_workflow`; BFF-only fix)**: because the agent child is a cross-app sub-orchestration on a separate per-session task hub, Dapr's task-hub-bounded recursive terminate can't reach it — so on Stop the cascade terminates the child but the SW-interpreter **parent hangs `RUNNING`**. Resolved BFF-side (#77, hardened #78/#79): `confirmDurableStop` **force-finalizes** the wedged parent (force-delete its durable state rows = the `reset` mechanism + flip DB) after a grace, on **positive evidence** — the parent's live `currentNodeId` is a `durable/run` node whose child **session is DB-terminated** (`shouldForceFinalizeCrossAppWedge`; `LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS` default 180s). The state-row purge is boundary-anchored (`daprStateKeyMatchPattern` — no sibling over-delete). **Rejected alternative:** replacing `call_child_workflow` with fire-and-forget + status-poll dispatch was tried (#74/#75) and **reverted (#76)** — per-session Kueue sandboxes aren't Dapr-service-invokable (`call_child_workflow` routes via PLACEMENT, not DNS), a start-ready cap broke SWE-bench, and the agent's first turn didn't fire under `StartInstance` → "Inference stalled". `call_child_workflow` is the proven dispatch; don't re-attempt fire-and-poll.

**Single stop authority (#70/#79)**: a benchmark/eval **instance** (a `workflow_executions` row or its agent session) is NOT stoppable via the generic per-execution **or** per-session Stop — both routes check `ownsBenchmarkOrEvalRun(ForSession)` and 409 `coordinator_owned`; cancel the owning **run** (`/api/benchmarks/runs/[id]/cancel`, `/api/evaluations/runs/[id]/cancel`). The reaper's aged stuck-execution pass likewise skips an execution owned by a still-active coordinator run.

**Orchestrator-side changes** (`workflow-orchestrator`):
- `_workflow_http_post` now **forwards query params**; `purge_workflow` is **recursive-by-default** + forwards `force` (purge-force, Dapr 1.17.9).
- `_idempotent_schedule` purge-before-reuse is **GUARDED** to only the DB-terminal-but-Dapr-non-terminal divergence — it NEVER kills a legitimately running instance.

**Runtime/sandbox-side changes**:
- **sandbox-execution-api**: no longer blindly 409-adopts an existing Sandbox CR — it stamps an **owner-run-id** annotation and adopts only the SAME run, else deletes + recreates (no inherited stale pod state).
- **dapr-agent-py**: the cancel-key write/read now AGREE for `durable/run` (the check reads candidate keys, stripping `__turn__N` / `:turn-N`), so a mid-turn `user.interrupt` / `session.terminate` actually halts.
- **claude-agent-py**: management **parity** with dapr-agent-py — `POST /api/v2/agent-runs/{id}/{terminate,pause,resume}` + `DELETE` purge (via `DaprWorkflowClient`), cancellation persistence, a between-turn cooperative-cancel check, and `TERMINAL_CONTROL_EVENT_TYPES`.

**GitOps safety nets (stacks, PR4)** — manual SQL/scripts are no longer the cleanup path:
- **`workflow-builder-sandbox-gc` CronJob** — age-based GC of orphaned per-session agent-host Sandbox CRs in the `workflow-builder` namespace (excludes SandboxWarmPool-owned).
- **Unified Dapr `stateRetentionPolicy = 168h`** across the parent (`workflow-orchestrator-no-tracing`) AND the per-session child Configs (`workflow-builder-agent-runtime`, `openshell-sandbox-dapr`) — closing the cascade-termination race (children were auto-purged before the parent finished; the old split was 168h vs 30m).
- **`lifecycle-terminal-reaper` CronJob** → `POST /api/internal/lifecycle/reap-terminal` — reconciles DB rows stuck non-terminal vs terminal/gone Dapr instances + purges orphans. Since #69 it reconciles the terminal/gone divergence **even during benchmark activity** (the per-row terminal/gone guard is the safety — a leaked lease must not blind it to a real orphan; the old all-or-nothing benchmark skip was removed), runs a priority **stop-requested** pass (finalize `stop_requested_at` rows the moment Dapr is terminal/gone, no age cutoff), and checks a **session's** terminal state via its per-session agent-runtime handle (not the orchestrator hub).
- **`runbooks/phase0-lifecycle-clean-slate.{sh,md}`** — guarded, dry-run-by-default one-time purge (NOT auto-run).

## Node Types

| Node Type | Purpose |
|-----------|---------|
| `trigger` | Workflow start node |
| `action` | Function execution (plugins + AP pieces + agents) |
| `activity` | Dapr call_activity() primitives |
| `approval-gate` | Wait for external event with timeout |
| `timer` | Dapr create_timer() delay |
| `loop-until` | Repeat until condition |
| `if-else` | Conditional branching |
| `set-state` | Set workflow variable |
| `transform` | JSON template output |
| `publish-event` | Dapr pub/sub publish |
| `note` | Non-executing annotation |

## Database Schema (Key Tables)

- **workflows**: `id`, `name`, `nodes` (JSONB), `edges` (JSONB), `engine_type`, MCP trigger config
- **workflow_executions**: `id`, `workflow_id`, `dapr_instance_id`, `status`, `output` (JSONB)
- **functions**: `id`, `slug`, `name`, `plugin_id`, `execution_type`, `is_builtin`
- **app_connections**: encrypted credentials (`OAUTH2`/`SECRET_TEXT`/etc) in `value` JSONB
- **piece_metadata**, **mcp_connection**, **mcp_server**, **mcp_run**, **workflow_connection_ref**
- **api_keys**: JWT keys (`wfb_` prefix, SHA-256 hashed at rest); rotation keeps `id` stable
- **CMA parity**: workspace-scoped via `project_id` — `sessions`, `vaults`, `agents`, `environments`, `agent_skill_registry` (nullable for curated-global). Scope from `locals.session.projectId` resolved by `hooks.server.ts`.
- **project_members**: `(project_id, user_id, role)` with `ADMIN | EDITOR | OPERATOR | VIEWER`. Last-admin demote/remove blocked.
- **sessions**: `workflow_execution_id` links workflow-driven sessions back to parent `durable/run` node
- **session_events**: append-only CMA event log (`sevt_` id prefix). SSE at `/api/v1/sessions/[id]/events/stream`
- **files**: standalone files API; SHA-1 dedup, 25 MB cap. Session-output auto-upload from `/mnt/session/outputs` + `/sandbox/outputs`
- **Browser artifacts**: `workflow_browser_artifacts` (manifest), `workflow_browser_artifact_blob_payloads` (base64 PNG)
- **workflow_artifacts**: standardized typed outputs (see Workflow Artifacts section)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Three paths:

1. **Activepieces piece MCP services**: per-piece in-cluster endpoints, backed by `mcp_connection.connection_external_id` + encrypted `app_connection` credential.
2. **dapr-agent-py MCP client**: reads `durable/run.with.agentConfig.mcpServers`, connects at runtime, exposes alongside built-in OpenShell tools.
3. **mcp-gateway / workflow-mcp-server / piece-mcp-server**: hosted MCP surfaces for external-client/on-demand flows.

**Playwright sidecar rewrite** (`src/lib/server/agents/mcp-sidecar.ts`): any `agentConfig.mcpServers` entry matching Playwright (by name, URL containing `playwright-mcp`, or args containing `@playwright/mcp`) is rewritten to `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`. Called from BOTH spawn paths (`src/lib/server/sessions/spawn.ts` and `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts`). Controller adds `chromium` + `playwright-mcp` sidecars when matched.

For UI-runnable agent workflows: SW 1.0 `durable/run` with `agentConfig.mcpServers` and `x-workflow-builder.input` prompt metadata. See `docs/mcp-agent-workflows.md`. MCP Apps use `@modelcontextprotocol/ext-apps` (`tool-widget.tsx`).

## Hooks + Plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins surface. Feature-flagged via `DAPR_AGENT_PY_HOOKS_ENABLED=true` + `DAPR_AGENT_PY_PLUGINS_ENABLED=true`; plugins ship via `fetch-claude-plugins` init container cloning `anthropics/claude-plugins-official` to `/etc/dapr-agent-py/plugins`.

- **Events v1**: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification
- **Hook types v1**: `command` (subprocess JSON stdin/stdout, exit-code 2 = blocking) + `callback` (in-process Python)
- **Per-run overlay**: `durable/run.with.agentConfig.hooks` + `agentConfig.plugins` layered on startup registry (mirrors `mcpServers`)
- **Durability**: PreToolUse/PostToolUse/PostToolUseFailure fire inside durable `run_tool` activity; session-level events gated by `not ctx.is_replaying`

> See `docs/hooks-and-plugins.md`.

## Activepieces Integration

- Credentials: AES-256-CBC encrypted in `app_connections`
- Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`
- Flow: User creates → encrypted in DB → at execution function-router fetches plaintext from the BFF `/decrypt` endpoint (BFF does the AES-256-CBC decryption; function-router brokers + audits)
- Adding piece: (1) `installed-pieces.ts`, (2) npm dep to fn-activepieces, (3) `piece-registry.ts`, (4) rebuild

> See `docs/activepieces-auth.md`.

## CMA Parity (Managed Agents Console)

Mirrors platform.claude.com/dashboard surface-for-surface. Workspace scoping is the unifying invariant: every user-facing resource carries `project_id`; `hooks.server.ts` resolves scope from `X-Workspace` header or URL slug into `locals.session.projectId`.

- **Workspaces**: `/workspaces` membership; `/workspaces/[slug]/*` canonical path. Non-member 404s at layout guard.
- **Members**: `/settings/members` — CRUD via `/api/v1/projects/[projectId]/members`. Last-admin demote/remove blocked.
- **Sessions**: CMA-shape event stream (`agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `session.status_*`). **Fork**: `POST /api/v1/sessions/[id]/fork` with `fromSequence`.
- **Custom skills**: `sourceType = "custom"` in `agent_skill_registry`, scoped via `project_id`. `POST /api/agent-skills` + `PATCH /api/agent-skills/[id]` (prompt edit bumps version). Curated/global rows visible to all workspaces.
- **Usage + cost**: `/api/v1/usage` and `/api/v1/cost` workspace-scoped; fall back to `userId` if no project. Joins `agents.name`.
- **Limits dashboard**: `/settings/limits` auto-refreshes every 15s via `/api/v1/limits/live`. Computed on-demand from `sessions.usage` + `sessions.status`.
- **Observability deep-link**: session detail → Phoenix + ClickHouse trace explorer (`session.id` span attribute filter).
- **Workflow → session cross-link**: workflow run Overview lists sessions via `/api/workflows/executions/[executionId]/sessions`.

Full map: `docs/cma-parity.md`.

## Browser Validation (In-Sandbox Screenshots)

`browser/validate` action captures screenshots inside the coding agent's OpenShell sandbox (no second sandbox needed).

- **Custom sandbox image**: `services/openshell-sandbox/Dockerfile` — Ubuntu 24.04 + Chromium via Playwright at `/opt/pw-browsers`
- **Composite endpoint**: `POST /api/browser/validate` in openshell-agent-runtime
- **Screenshot transfer**: PNGs base64-encoded in sandbox, read in 4KB chunks via `dd` (OpenShell stdout truncates >4KB outputs)
- **Storage**: `workflow_browser_artifacts` + `workflow_browser_artifact_blob_payloads`
- **UI**: Artifacts tab in run detail, auto-expands first completed

**Constraints**: chunked file reads for >4KB outputs; base64-encoded scripts (no heredoc through OpenShell API); browsers at `/opt/pw-browsers`; `imagePullPolicy: Always` for sandbox images.

## Standardized Workflow Artifacts

Any SW 1.0 task can declare typed outputs via `artifacts:` block alongside `with:`. Generic table + discriminated-union renderer.

```yaml
synthesize:
  call: durable/run
  with: ...
  artifacts:
    - kind: markdown
      slot: primary             # primary | secondary | aux
      title: "Research synthesis"
      from: "${ .data.content }"  # jq, evaluated against expression context
      contentType: "text/markdown"
      if: "${ .data.content != null }"
```

`_persist_task_artifacts` walks `task_data.get("artifacts", [])`, evaluates jq, yields `persist_workflow_artifact` per entry. Activity ID is deterministic (`sha256(workflowId|executionId|nodeId|kind|title)[:24]`) so retries collapse to UPSERT.

**Storage**: `workflow_artifacts` table (drizzle 0067). Inline payload (jsonb ≤256 KB) or `file_id` for blobs.

**Standard kinds**:

| `kind` | `inline_payload` | UI renderer |
|---|---|---|
| `markdown` | `{ markdown: string }` | `Response` (Streamdown + Shiki) |
| `json` | `{ value: any }` | `JsonViewer` |
| `text` | `{ text: string }` | `<pre>` |
| `table` | `{ columns, rows }` | inline table |
| `image` | `{ alt }` (blob via fileId) | `<img>` |
| `link` | `{ url }` | anchor |
| `card` | `{ body, footer? }` | shadcn `<Card>` |

Unknown kinds fall back to JSON dump. `from:` jq value auto-wrapped per kind.

**Consumer**: `<ArtifactList artifacts={...} mode="primary|all" />` (`src/lib/components/workflow/execution/artifact-list.svelte`). APIs: `GET /api/workflows/executions/[id]/artifacts` (workspace-scoped read); `POST /api/internal/workflows/executions/[id]/artifacts` (internal-token write). Activity is best-effort — failures logged, not propagated.

> See `docs/workflow-artifacts.md`.

## Tiered Crawl Pipeline (research workflows)

`browserresearchfanout01` v3 is the canonical pattern for multi-URL "fetch + extract + synthesize". Replaces v2 browser-use-agent for research/extraction; browser-use stays for *interactive* (vision/click) tasks.

```
trigger {topic, urls, extractionPrompt}
  → for { url in .trigger.urls }            ← orchestrator-side sequential
       web/crawl.async                       ← single durable activity sequence
         (start_job + poll loop with timer)
         (deterministic per-URL jobId, Postgres-backed, retry-safe)
         (tier escalation http→pw→stealth)
         (Anthropic schema-validated `extracted` field)
  → durable/run text-research-synthesizer    ← pure text agent (no browser)
       (workspaceRef: "local", no MCP, no tools)
```

**crawl4ai-adapter v2** (`services/crawl4ai-adapter/`):
- API: `POST /crawl/jobs { url, jobId?, tiers?, extractionSchema?, cacheTtlSeconds? }`; `GET /crawl/jobs/{id}` → `{ complete, success, data, error }`
- **State**: PG tables `crawl4ai_jobs` + `crawl4ai_cache`. DDL auto-applied. Single-replica but state externalised.
- **Idempotent jobIds**: `j_<sha256(workflowId|nodeId|url)>[:32]`. Adapter returns existing for terminal/in-flight; FAILED resets to PENDING + re-kicks.
- **Cache** keyed on `sha256(url|tier_chain|schemaHash)`. Default 1h TTL.
- **Tier escalation**: `tiers: [http, playwright, stealth]` (default `[http]`). Escalates on block-detect (empty body, 403/429, Cloudflare/Akamai/PerimeterX/Captcha markers).
- **Schema-driven extraction**: optional `extractionSchema` → Anthropic `tool_use` validated output in `result.extracted`. Skipped if `ANTHROPIC_API_KEY` unset.
- **Orphan recovery**: startup watchdog scans stale PENDING/RUNNING; lazy resume in `GET /crawl/jobs/{id}` re-kicks from stored request.

**For-task jq output**: per-URL outputs at `<for_name>/<sub_name>[<idx>]`; envelope `{complete, success, data: {tier, url, extracted, ...}, error}` has ONE unwrap applied — read `.data.tier`, `.data.extracted` (NOT `.tier` / `.extracted` — that was the v3-iter1 bug).

**text-research-synthesizer agent** (`runtime: dapr-agent-py`): pure text, no MCP, no browser, no sandbox. Receives corpus + topic + extractionPrompt, emits structured JSON + cross-URL synthesis.

**Don't use this for**: interactive browser control (form fills, login, clicks, vision-based extraction) — use browser-use-agent path instead.

## Troubleshooting

- **Missing credentials** → Add API keys to Azure Key Vault or create app connections
- **Agent timeout** → Check the per-session agent-sandbox pod logs (`kubectl logs -n workflow-builder <session-sandbox-pod>`) + workflow-orchestrator logs
- **Agent stops early** → Check `maxTurns` (default 50, per-node configurable)
- **OAuth2 token expired** → Auto-refresh; check `AP_ENCRYPTION_KEY`
- **AP credential decrypt fails** → Verify `INTERNAL_API_TOKEN` matches across services
- **Tool fails ENOENT on `active_gateway`** → `seed-openshell-config` init container didn't run; verify the per-session agent-sandbox pod template includes it AND `openshell-sandbox-dapr-webhook` namespaceSelector covers `workflow-builder`
- **daprd `no X509 SVID / failed to get configuration`** → `dapr.io/config` Configuration missing in pod's namespace. `openshell-sandbox-dapr` must exist in `workflow-builder` (declared at `packages/components/workloads/workflow-builder/manifests/Configuration-openshell-sandbox-dapr.yaml`)
- **daprd `detected duplicate actor state store`** → Component with `actorStateStore=true` and no restrictive scopes became visible. Partition scopes (see Agent Runtime Model)
- **`ctx.call_child_workflow` times out `app may not be available`** → target pod isn't placement-registered. Either the per-session agent-sandbox didn't get admitted/started (Kueue queue backlog / image pull) OR a different namespace from parent (sub-orchestration is intra-namespace only)
- **`Ignoring unexpected taskCompleted event with ID = N`** → NOT stuck; normal `call_child_workflow` replay chatter. Real stuck signals: the per-session sandbox pod never reached `Running`, or the pattern persists >5 min with daprd placement flaps
- **Per-session agent-sandbox never starts** → check Kueue admission (`kubectl get workloads -n workflow-builder`) + the agent-sandbox controller; the AgentRuntime CRD + Kopf `agent-runtime-controller` are RETIRED, so there is no wake annotation / controller restart to perform
- **BFF `/execute` `ECONNREFUSED` to orchestrator** → orchestrator CrashLoopBackOff; common cause is image predating `activities/crawl4ai.py`
- **Session rows with `project_id=NULL`** → can't happen post migration 0040. If seen, something inserts outside BFF + bridge paths
- **Workflow-driven sessions show raw agent IDs** → ephemeral agents filtered from `/api/agents` by design. `listSessions` LEFT JOINs `agents` returns `agentName/agentSlug/agentAvatar/agentEphemeral`
- **Agent loops with empty responses** → Anthropic SDK [#1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204). Circuit breaker in `call_llm` trips after 3 (`DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD`); look for `[call-llm] circuit-breaker tripped`
- **Child session hangs with no LLM traffic** → the in-workflow session-turn timer was REMOVED (commit `72154581`); there is no durable `when_any([child, timer])` cutoff anymore. The out-of-band `_run_session_host_monitor` thread observes idle/start stalls but its default action is `"warn"` (set `DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION=terminate` to make it kill; search logs for `[session-host]`). To actually stop it, use the Lifecycle Controller — `POST /api/v1/sessions/[id]/stop` (mode `terminate`/`purge`). A genuinely orphaned run (DB stuck non-terminal vs terminal/gone Dapr instance) is reconciled by the `lifecycle-terminal-reaper` CronJob within one interval — no manual SQL needed
- **Want to stop a running session / workflow run** → route through the Lifecycle Controller (`src/lib/server/lifecycle/`): `POST /api/v1/sessions/[id]/stop` or `POST /api/workflows/executions/[id]/stop` with `{mode}` (`interrupt`/`terminate`/`purge`/`reset`). UI: **Stop** / **Stop & Reset** buttons. Request/confirm (#69/#71): a stop that can't confirm in-request returns **202 "stopping"** (persists `stop_requested_at`, converges via the `GET …/stop/status` poll + the reaper) — NOT a hard 409; it still never flips DB / reaps until Dapr is confirmed terminal. Explicit per-session app-id fan-out; Delete/Archive 409 ("Stop the run first") while active. **A benchmark/eval instance is NOT stoppable here** — the per-execution stop 409s `coordinator_owned` and the UI links to the owning **run's** Cancel (#70)
- **Stop "didn't work" on a run blocked in a long activity** → expected pre-#69 (the cascade waited 45s one-shot; a `terminate` only applies when the long activity yields, often minutes later → false 409 + stuck `running`). Fixed: stop now returns 202 + persists intent; the reaper/`stop-status` poll finalizes once Dapr goes terminal. If it's a **benchmark instance** (`sw-swebench-instance-exec-…`), cancel its **benchmark run** (the coordinator re-drives a non-terminal instance). Cooperative-first (`LIFECYCLE_TERMINATE_GRACE_SECONDS`, default 5s) lets the dapr-agent-py cancel-key halt the agent at the next turn/tool boundary before forcing
- **Mid-turn `user.interrupt` / `session.terminate` did nothing on durable/run** → was the dapr-agent-py cancel-key write/read mismatch (write `session-cancel:{session_instance}`, read `session-cancel:{<session>__turn__N}`). FIXED — the check now reads candidate keys, stripping `__turn__N` / `:turn-N`, so the keys AGREE. For claude-agent-py, cooperative cancel is a between-turn check (it now has management parity: `POST /api/v2/agent-runs/{id}/{terminate,pause,resume}` + `DELETE` purge)
- **DB rows stuck `running`/non-terminal after a pod died** → the `lifecycle-terminal-reaper` CronJob (`POST /api/internal/lifecycle/reap-terminal`) reconciles DB rows against terminal/gone Dapr instances, purges orphans, and flips DB rows terminal. Post-#69 it reconciles the terminal/gone divergence **even during benchmark activity** (the per-row terminal/gone guard is the safety); post-#79 only its *aged stuck-execution* pass defers to an execution owned by a **still-active** coordinator run. Orphaned per-session Sandbox CRs in `workflow-builder` are age-GC'd by the `workflow-builder-sandbox-gc` CronJob. The retired `scripts/reconcile-stale-*`/`dev-purge-stale-*` manual paths are superseded
- **`Could not purge … instance is not in a terminal state`** → purge requires terminal; the Lifecycle Controller terminates first (and uses **purge-force** when the worker pod is already gone, Dapr 1.17.9). `purge_workflow` is recursive-by-default + forwards `force`. Don't reuse a deterministic ID over a stuck non-terminal instance — `_idempotent_schedule`'s purge-before-reuse is GUARDED to only the DB-terminal-but-Dapr-non-terminal divergence (it never kills a legitimately running instance)
- **Re-run of a workflow node inherits stale pod filesystem/state** → was the sandbox-execution-api 409-adopt of a deterministic-named Sandbox CR. FIXED — it stamps an owner-run-id annotation and adopts only the SAME run, else deletes + recreates
- **Anthropic 400 `prompt is too long: N > 1000000`** → too many image tool_results. `_compact_image_tool_results` keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3); lower if still overflowing
- **Anthropic 400 `Streaming is required ...`** → non-streaming call estimated >10 min. Fixed 2026-04-21 by routing all calls through `_stream_final_message`. Lower `DAPR_AGENT_PY_MAX_TOKENS` (default 16384) if reappears
- **dapr-agent-py code changes need TWO image builds**: `dapr-agent-py:git-<sha>` (legacy static Deployment, GitOps tag bump) + `dapr-agent-py-sandbox:latest` (per-session agent-sandbox pods, `imagePullPolicy: Always`)
- **Node service prod build fails `ERR_PNPM_IGNORED_BUILDS` at `RUN pnpm build`** (wfb PR #42, function-router) → the Dockerfile's unpinned `npm install -g pnpm` pulled pnpm v10, which blocks esbuild/protobufjs build scripts behind an approval gate. FIX: pin **`pnpm@9`** (like mcp-gateway); do NOT use `--ignore-scripts` (leaves esbuild's binary missing for the build stage). Such a break can HIDE indefinitely — the per-service auto-build trigger only fires on a `services/<svc>/` change, so the image just stays frozen at the last successful build (function-router was stuck at a May-21 image for weeks). Recover with the "bring a stale service current" PipelineRun (see Dev Loop outer-loop notes).
- **Live-preview 404 "Retained sandbox not found"** → `workflow_workspace_sessions` row missing or `status='cleaned'`. Verify `persist_workspace_session` fired, spec has `with.keepAfterRun: true`, `_should_cleanup_workspaces` honoured it. Revive: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`
- **`${ .trigger.X }` reaches agent as literal string** → SW 1.0 jq-template eval only fires for ENTIRE-value `${...}` (`core/sw_expressions.py::is_expression_string`). Embedded `${...}` passes through. Wrap whole value in one jq expression
- **`web/crawl.async` times out at per-URL `timeoutMs`** → adapter pod restarted while RUNNING + lazy-resume didn't fire fast enough. Reset stuck rows: `UPDATE crawl4ai_jobs SET state='FAILED' WHERE state IN ('PENDING','RUNNING') AND updated_at < now() - interval '2 minutes'`. Tighten `CRAWL4AI_ORPHAN_AFTER_SECONDS` if recurrent
- **Synthesizer calls WebSearch / hangs / hits step budget** → per-URL corpus has nulls (agent compensates). Cause: jq path missing envelope unwrap. Use `.data.tier` / `.data.extracted` (NOT `.tier` / `.extracted`)
- **`artifacts:` block declared but no rows** → activity is best-effort. Check orchestrator logs for `persist_workflow_artifact` warnings. Common causes: BFF route 503 (DB pool), missing `INTERNAL_API_TOKEN`, jq returned `null` AND `if:` guard true. Verify: `SELECT id, kind, title FROM workflow_artifacts WHERE workflow_execution_id=?`
- **MLflow Traces UI shows `IN_PROGRESS` after success** -> FIXED 2026-05-12 via `finalize_mlflow_trace_root` activity. Orchestrator POSTs synthetic OTLP `ResourceSpans` proto directly to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` over raw HTTP (parent_span_id empty). MLflow's OTLP receiver flips state IN_PROGRESS -> OK. **Must use raw HTTP, not SDK tracer** (BatchSpanProcessor would attach as child of active context). Disable via `WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN=false`. Optional workflow node spans are frozen into new workflow inputs from `WORKFLOW_ORCHESTRATOR_MLFLOW_NODE_SPANS=false` (default off).
- **SvelteKit type errors** → `pnpm check`

> See Dapr component YAMLs in stacks repo for service scoping.

---

**Last Updated**: 2026-06-07
