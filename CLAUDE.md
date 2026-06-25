# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. SvelteKit serves as UI + BFF proxy; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs** (`docs/`): `agent-runtime-comparison.md` (dapr-agent-py vs claude-agent-py + swap-blockers), `dapr-agent-py-sandbox-architecture.md` (**EVALUATION** — is dapr-agent-py's openshell/sandbox model right? dapr = stateless agent pod + REMOTE openshell sandbox reached by per-tool mTLS RPC + full-image `seed-openshell-config` init; it buys workspace-sharing + reschedule-durability the *hardest* way. `juicefs-shared` (CLI family) gives the SAME with pod-local file semantics — no RPC/stdout-truncation/cold-start. The 3-backend split forces `WorkspaceBackendMismatchError` + blocks cross-family agent mixing. REC: keep openshell for browser-use; phased-converge non-browser runtimes onto ONE shared-FS backend; the `sandbox.scope` knob is complementary, not a fix), `durable-session-runtime-contract.md` (swappable runtime contract + registry), `interactive-cli-sessions.md` (**interactive-cli SSOT** — Claude Code TUI in herdr-backed sandbox pods: web terminal, hooks/transcript event mirroring, subscription-token auth, verified herdr socket protocol), `cli-conversation-durability.md` (CLI history durability/resume — DB-backed FUSE (JuiceFS-on-Postgres) vs statestore snapshot/restore; prototype GO), `activepieces-integration-architecture.md` (**AP integration SSOT** — deterministic activities + MCP exposure + UI + maintenance roadmap), `activepieces-catalog-expansion.md` (665 available-only catalog pieces vs bundled-runnable subset; generator/seed/admin gate), `per-piece-runtime-images.md` (per-piece-image vs single-bundle packaging — memory/dep-conflict/build trade-offs + build-on-enable), `activepieces-auth.md`, `mcp-agent-workflows.md`, `hooks-and-plugins.md`, `event-driven-invocation-and-unified-hooks.md` (**DESIGN/feasibility** — event-driven agent invocation + standardizing hooks across `dapr-agent-py` + the CLI family. dapr_agents "extensions" activation-hook API is NOT in our pinned dapr-agents (probe: legacy pod on 1.0.3, `add_activation`/`ActivationContext` absent; pin says 1.0.4 → drift) → recommend an **additive pub/sub trigger** that creates a `session_workflow` run via the EXISTING placement-routed dispatch, NOT a dispatch migration (cli-agent-py has no `DurableAgent`; per-session sandboxes aren't service-invokable). Hooks standardized via a **portable `agentConfig.hooks`** honored on all 4 runtimes (dapr-agent-py already executes it; translate into each CLI's native hook config + run via the relay/HookProcessor, blocking where the CLI protocol allows — claude exit-2, codex/agy advisory), NOT the dapr_agents 4-slot Hooks API; + `eventDrivenInvocation`/`portableHooks` registry descriptors; phased P1 cli-pubsub→P2 dapr-pubsub→P3 portable-hooks→P4 descriptors), `CLICKHOUSE_OBSERVABILITY.md`, `openshell-capabilities.md`, `cma-parity.md`, `callable-agents.md` (`CallAgent` peer-delegation), `tiered-crawl-pipeline.md` (crawl4ai v2 + browserresearchfanout01 v3), `workflow-artifacts.md`, `workflow-execution-architecture.md` (SW 1.0 interpreter vs Dapr workflows-as-code — storage/listing/runtime-creation options), `workflow-lifecycle-termination.md` (**lifecycle SSOT**), `goal-loop.md` (**goal-loop SSOT**), `goal-loop-evaluator-design.md` (proposal: replace self-judged goal completion with an independent adversarial EVALUATOR gated on explicit acceptance criteria + real evidence/active-tests — Anthropic harness + Dapr evaluator-optimizer; BFF-orchestrated so it's runtime-agnostic, unifies completion authority), `goal-authoring-and-claude-alignment.md` (alignment of our evaluator-gated loop with Claude Code `/goal` — aligned on loop/independent-evaluator/bounding, deliberately stronger via ground-truth vs transcript; the goal-loop input contract; + proposal for a `planGoal` authoring pre-step (interactive Goal Workbench + workflow PLAN→SOLVE node) turning intent into a validated typed `goal_spec` artifact), `agent-node-and-workflow-sandbox-architecture.md` (reflection + proposal: the runtime-agnostic agent-node holds at dispatch but the goal/terminate/output contract leaks per-runtime → formalize a registry "goal-lifecycle adapter"; + standardize the two sandbox shapes (shared-retained vs per-agent-ephemeral) behind one `sandbox.scope` knob), `generator-critic-multi-agent.md` (proposal: rubric-gated generator+critic loops — generator without `update_goal`, independent critic holds completion authority; tiered BFF-as-authority design (deterministic evidence → isolated LLM critic+rubric → critic AGENT node for subjective/interactive design review); maps LangChain RubricMiddleware + Anthropic harness decomposed-design-dimensions + Dapr-agents/Diagrid evaluator-optimizer onto our existing primitives; with/without-orchestrator analysis), `session-resource-metrics-and-kueue-admission.md` (usage/resource metrics we capture + gaps + Kueue usage-aware admission: PSI AdmissionCheck already live, request right-sizing recommended), `interchangeable-agents-and-per-phase-selection.md` (**interchangeable-agents SSOT** — making cli-agents ↔ dapr-agent-py swappable + per-phase plan/generator/critic mix-and-match: dispatch is ALREADY per-node runtime-agnostic; within-family mix works now via 3 trigger inputs; cross-family mixing blocked ONLY by the interactive-cli-only `/sandbox/work` shared mount; `modelSpec` is dapr-only/no-op-for-cli; phased plan W1–W4), `monitoring-ui-unification.md` (**monitoring-UX direction** — unify the scattered fleet/sessions/runs/capacity/cost/usage surfaces into ONE "Observe" master-detail hub that drills Fleet→Run→Session in place: the same recursive list+detail+aggregate shape is implemented 3× today; reuses the just-built Run Console + `fleet-detail-sheet` + capacity components; conservative run-tab pruning (drop Steps, conditional Code/Plan/Browser/Agents, kill MLflow link); phased P1 dedupe→P2 Observe shell→P3 polish→P4 measured-capacity), `browser-session-live-view-and-recording.md` (options eval for showing the Playwright-MCP critic's browser **live** + persisting a **recording** artifact: we already have a 1fps screenshot-poll live view + `workflow_browser_artifacts` `video`/`trace` kinds + ffmpeg-in-image; recommends **R1 Playwright-native `.webm`** persisted-default + **L1 on-demand CDP `Page.startScreencast`** live. **R1 CAPTURE GOTCHA (verified v0.0.76): `@playwright/mcp` has TWO video systems — `contextOptions.recordVideo` (via `--config`) is DELETED-on-close since v0.0.40 (issue #1084) → 0-byte files; the WORKING path is `--caps=devtools` + the `browser_start_video`/`browser_stop_video` tools (`browser_stop_video` flushes WITHOUT `browser_close` + returns the path). Process SIGTERM/EOF never flush. Claude won't call the tools itself → robust fix = run @playwright/mcp over HTTP in-pod + a SUPERVISOR (cli-agent-py) calls start/stop, OR inject a trailing `browser_stop_video`.** `.webm` push (cli-agent-py `browser_video_sync`) + run-page `<video>` renderer shipped (#238).), `sandbox-warm-pools.md` (**warm-pool SSOT** — cut ~30–60s session cold-start: measured breakdown (scheduling ~8s + init-containers ~7–20s + CLI/MCP boot; image-pull ~0 via Spegel/node-cache); the existing browser-use SandboxWarmPool is scale-to-zero-wake + per-slug-SHARED-host → does NOT fit CLI (needs per-session isolation + per-user creds); design = ONE warm pool per IMAGE (1 cli-agent-py covers claude/codex/agy since CLI chosen at session-time by start_cli_activity; 1 dapr-agent-py; browser-use exists) with a **claim-bind-recycle** dispatch lane + `replicas≥1` preemptible; phased P1 builder→P2 claim-lane(crux/risk)→P3 stacks→P4 measure. Spegel verified healthy (9/9 dev, 3/3 ryzen, mirrors ghcr.io)), `juicefs-sandbox-storage.md` (**JuiceFS-for-sandboxes review** — JuiceFS CE 1.3.1 with metadata+data BOTH in Postgres backs `/sandbox/work` per-run workspaces; the `juicefs-webdav` gateway feeds the run-page Files tab. Sourced findings: data-in-Postgres `jfs_blob` is NOT the prod tier (node_modules → thousands of tiny rows on the app DB) → move DATA to an object store (MinIO/S3) + consider Redis metadata; per-run `juicefs quota --inodes` guardrail; CSI `pathPattern`; recursive listing is NOT cache-accelerated → **never `PROPFIND Depth: infinity`, browse lazily `Depth:1`** (SHIPPED #244); `--trash-days 0`+`gc --delete` reclaim; harden gateway `--read-only`+auth+`--open-cache`; close-to-open = in-flight files lag the gateway), `event-driven-workflow-triggers.md` (**DESIGN/SSOT for UI-parameterized workflow triggers** — fire a workflow whenever the right external signal arrives. KEY fact: Dapr Workflow has NO native start-on-event/schedule → every trigger = "ingress delivers signal to a route that calls workflow-START with a deterministic instanceID (idempotency)". Recommends ONE `trigger` node + a `triggerType` CATEGORY (not per-source event nodes; SW 1.0 has one entry + `config.triggerType` already exists) driven by a `trigger-registry.json`; most-native backing per class — **Dapr Jobs/Scheduler** (schedule, durable+replica-dedup, beats per-replica cron binding), **declarative `Subscription` v2alpha1 CEL routes+DLQ** (topic), **input bindings** (cloud queue/kafka), **Argo Events EventSource** (webhook/github/calendar/k8s-resource long-tail Dapr has no binding for); ALL funnel to ONE `workflow.triggers` topic → one idempotent start handler; Argo→Dapr handoff = Sensor HTTP→BFF-publish (default) or NATS→separate-subject (decoupled); **activation/reconcile** model (Active toggle → `workflow_triggers` row → reconciler provisions backing CR/Component/Job via GitOps). Argo-webhook→workflow path already dev-verified; phased P1 start-spine→P2 registry+UI→P3 schedule+topic→P4 argo sources→P5 queues+lifecycle), `code-version-persistence.md` (**DESIGN/eval** — durable persist→preview→apply for code-producing workflows. Today: diff artifacts give durable PREVIEW but the produced CODE dies with the reaped `/sandbox/work` (`workflow_code_checkpoints` exist per-edit but `remoteStatus=skipped` — 115/115 on the last run — so commits aren't pushed anywhere durable); `pr` node applies only during-run. Industry: git-as-truth (Jules/Copilot/Aider) vs cheap-checkpoint→PR-on-accept (Devin blockdiff microVM snapshots, Cursor VM checkpoint+Temporal, Replit CoW-chunks+Neon, Claude Code file-snapshots + **git bundles for teleport**); NO platform uses a hosted git server/bundles/bare-repo as the durable store. REC: Pattern B2 = **git bundles (source-only, KB–MB) in the Files API** keyed on the checkpoint row (matches Claude Code teleport) → re-accessible versions with ZERO standing compute; + cross-run Versions browser + **Promote→PR on accept** (no PR-per-iteration). Rejects: reintroducing Gitea (standing stateful svc we removed), VM snapshots (overkill), bundles-on-JuiceFS (no speed win, reaped domain). Phased P1 bundle-on-checkpoint→P2 promote→P3 versions hub→P4 fork-from-version), `agent-workspace-build-and-gan-loop-best-practices.md` (**research synthesis** — external best practices for durable-shared-workspace-vs-fast-build + the generator↔evaluator GAN loop, mapped to our setup. KEY: almost nobody builds over a slow shared FS — cloud agents use git-as-truth + ephemeral local build + warm dep-snapshot, OpenHands uses a CoW `:overlay`, upstream agent-sandbox uses a block PVC for build state + RWX only for *sharing*. So the correct pattern for us = keep source on the `/sandbox/work` JuiceFS RWX mount (needed for GAN cross-pod sharing) but put `node_modules`/build/cache on per-pod LOCAL `emptyDir` via a **bind-mount at `<workdir>/node_modules`** (NOT a self-symlink — preserve-symlinks bugs; NOT building over JuiceFS — the W3-disabled state is fine for tiny repos, slow for large) — the clean replacement for the clobbering W3 edit-in-scratch scheme — plus bake base deps into the warm-pool image (incremental install). OpenShell(NVIDIA) is a *security* tool, not a workspace/build answer. GAN-loop upgrades = execution-grounded two-tier evaluator + frozen evaluator-owned contract + no-op-diff detection (would've caught the W3 clobber) + test anchors + objective K-no-progress stall. Recs R1–R6), `agent-sandbox-v0.5.0-upgrade-evaluation.md` (**EVALUATION** — kubernetes-sigs/agent-sandbox v0.5.0 vs our v0.4.5/v1alpha1. VERDICT: upgrade worth it mainly for SECURITY+RELIABILITY+controller-perf hardening (SSRF/router-auth/NetworkPolicy/status-patching/orphan-adoption) + faster/smarter warm-pool ops — NOT to offload logic. KEEP CUSTOM (Dapr-coupled, out of upstream scope): Lifecycle Controller cascade/wedge-finalize/reaper, pause/resume (workflow-level via pod-IP:8002), per-session app-id dispatch, PSI/Kueue admission. REQUIRED migration: `spec.replicas:1`→`spec.operatingMode:"Running"` (sandbox-execution-api app.py:1695, the one hard dep) + v1alpha1→v1beta1 (conversion-webhook-eased). SKIP: SandboxClaim+volumeClaimTemplates (we create PVCs+ownerRef directly), gVisor snapshots (PVC-rebind+git-bundles instead), operatingMode=Suspended (pod-suspend risks wedging the Dapr-owned workflow — defer). KEY RISK: v0.5.0 `isAdoptable` reject-unowned may GC our directly-created Sandbox CRs → gate the canary on it. NOT FIXED: warm-pool app-id blocker (needs per-pod-app-id webhook) + slow builds/F2. Staged ryzen-canary→dev; DOC-ONLY, upgrade not executed).

> **Skills**: `skaffold-dev-loop` (inner/outer dev loop), `gitops` (stacks/ArgoCD/promotion), `workflow-builder` (SW 1.0 authoring/debug), `evaluations` (SWE-bench/benchmarks), `dapr-agents-workflow` (Dapr Agents framework). Prefer these for deep operational detail.

## Architecture

All workflow execution lives in `workflow-builder` namespace:

- **SvelteKit BFF** (port 3000, Dapr sidecar) — UI + proxy. Calls workflow-orchestrator over Dapr.
- **workflow-orchestrator** (Python/Dapr) — SW 1.0 interpreter. `durable/run` → `ctx.call_child_workflow`; all other slugs → Dapr svc invoke → function-router. Resolves the target agent runtime via the runtime registry SSOT (`core/runtime_registry.py`).
- **Runtime registry (SSOT)** — `services/shared/runtime-registry.json` is the single source of truth for the 5 agent runtimes (`dapr-agent-py`, `claude-agent-py`, `adk-agent-py`, `browser-use-agent`, `claude-code-cli`): per-runtime identity (app-id/image/container) + capability descriptor (durability granularity incl. `per-session`, MCP/hooks/permission support, providers, `interactiveTerminal`, `executionClass`, `cliAuth`, **`workspaceBackend`**). `scripts/sync-runtime-registry.mjs` generates the orchestrator + BFF build-context copies (drift-guarded). **`workspaceBackend`** (`juicefs-shared` cli-family / `openshell-shared` dapr-agent-py+browser-use / `pod-local` claude-agent-py+adk) is the filesystem SHARING domain: `resolveSpecAgentRefs` REJECTS (`WorkspaceBackendMismatchError`) workflows whose `durable/run` nodes share a `workspaceRef` but resolve to different backends — per-phase agent mix-and-match is allowed only WITHIN one backend family (the two families use physically different storage; see `docs/interchangeable-agents-and-per-phase-selection.md`).
- **interactive-cli family** (`claude-code-cli` via `services/cli-agent-py`, image `cli-agent-py-sandbox`): the REAL Claude Code TUI in a herdr pane inside a per-session Kueue sandbox pod; web-terminal-first sessions, lifecycle-wrapping `session_workflow`, hooks+transcript event mirroring, per-user subscription tokens (`/settings/cli-tokens`, `user_cli_credentials`). `durable/run` CAN dispatch this family (registry `workflowDispatch: auto-turn` + the `ensure-for-workflow` bridge stamps `cliAdapter` and resolves the user's linked CLI credential via `cliAuth`; a run without a linked credential 400s at dispatch). **`ANTHROPIC_API_KEY` must never reach these pods** (outranks subscription auth → flips billing). See `docs/interactive-cli-sessions.md` (SSOT).
- **Per-session Sandbox pods** — non-browser runtimes dispatch as per-session ephemeral `agent-sandbox` (kubernetes-sigs/agent-sandbox) pods (image-only diff, Kueue-admitted, self-reaped on session end); `browser-use-agent` via `SandboxWarmPool`. Pod shape + the legacy `Deployment-dapr-agent-py` carve-out: see Agent Runtime Model.
- **function-router** — slug routing + credential audit point. Routes to fn-system / per-piece piece-runtime (`ap-<piece>-service`) / openshell-agent-runtime / code-runtime / crawl4ai-adapter.
- **piece-runtime** (image `piece-mcp-server`) — converged per-piece execution surface: `/execute` (deterministic activities) + `/mcp` (StreamableHTTP tools) + `/options` (canvas dropdowns) from ONE image. Per-piece Knative Services (`ap-<piece>-service`, scale-to-zero) provisioned by the stacks `activepieces-mcps` CronJob reconciler. (`fn-activepieces` DELETED 2026-06.)
- **Infra** — Redis, PostgreSQL, OTEL Collector. MCP services: workflow-mcp-server (deployed; goal + workflow tools), per-piece piece-runtime + mcp-gateway.

Per-session sandbox pods (chromium + OpenShell workspace containers) live in `openshell` namespace, addressed over mTLS. Agent sandbox pods MUST colocate with the orchestrator — Dapr workflow sub-orchestration doesn't cross namespaces.

**Key dispatch invariants**
- **Runtime resolution is registry-driven**: the orchestrator's `sw_workflow.py::_resolve_native_agent_runtime` is a thin shim over `runtime_registry.resolve()`, which reads the generated `core/runtime_registry.json`. The descriptor supplies dispatch app-id, instance prefix, container image, and capabilities — no scattered string enumerations.
- **Two-name dispatch**: `durable/run` dispatches the Dapr workflow literal `session_workflow` (`descriptor.dispatch_workflow_name`); the workflow-session bridge-eligibility sentinel is `agent_workflow` (`descriptor.bridge_gate_token`). Distinct strings/roles.
- **No wake/idle**: NO per-agent `AgentRuntime` CR, NO Kopf wake/idle annotation, NO `agent-runtime-controller` (details: Agent Runtime Model).
- `durable/run` is a **Dapr child workflow**, not HTTP. `spawn_session_for_workflow` activity POSTs to `/api/internal/sessions/ensure-for-workflow` (see Workflow → Session Bridge). Parent yields `ctx.call_child_workflow("session_workflow", app_id=<descriptor app-id>, instance_id=<deterministic session_id>, autoTerminateAfterEndTurn=true)`. Retry resilience lives on the **agent callee** — `dapr-agent-py` decorates `session_workflow` with `WorkflowRetryPolicy(max_attempts=8)` wrapping `call_llm`; the orchestrator's own activities/`CreateInstance` carry **no** `retry_policy`.
- **Swap-safety gate** (`src/lib/server/agents/swap-safety.ts`): derives an agent's required capabilities from `agentConfig` vs the target runtime's DECLARED capabilities → `{decision: allow|warn|reject, drops[]}`. MCP-loss + provider-mismatch are REJECT-class; hooks/plugins/permission/durability downgrades WARN-class. WARN-first unless `AGENT_RUNTIME_REJECT_LOSSY_SWAP=true`. Wired into `src/lib/server/sessions/spawn.ts`.
- **Direct (UI-initiated) sessions** go through `src/lib/server/sessions/spawn.ts`, which resolves the runtime via the BFF registry (`runtime-registry.ts`) and calls Dapr `StartInstance` via service invoke (bare app-id). Both spawn paths call `rewriteMcpForBrowserSidecar` (`mcp-sidecar.ts`) — Playwright entries become `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`.
- **Dapr Component visibility**: `workflowstatestore` is the only `actorStateStore=true` Component visible to agents; `dapr-agent-py-statestore` + legacy `agent-workflow` are non-actor stores. New agents must NOT be added to Component scopes.
- Every non-agent action: `orchestrator → Dapr service invoke → function-router → {fn-system | ap-<piece>-service (piece-runtime) | openshell-agent-runtime | code-runtime | crawl4ai-adapter}` (via `activities/dapr_invoke.py`, no raw HTTP). `openshell-agent-runtime` consolidates `workspace/* + browser/* + openshell/*`. AP slugs use registry type `activepieces` → dynamic `ap-<sanitized-piece>-service` resolution; AP activity calls carry `AP_RETRY_POLICY` + pause mapping (DELAY → `create_timer`, WEBHOOK → `wait_for_external_event`) in `_handle_call_task`.
- The **BFF** owns credential decryption — `src/lib/server/security/encryption.ts` does `createDecipheriv('aes-256-cbc')`. For AP routes function-router is the **credential audit point**, not a plaintext broker: it forwards `X-Connection-External-Id` (audit-only `credential_access_logs` row) and the piece-runtime self-resolves via BFF `/api/internal/connections/<id>/decrypt` at point of use — the same mechanism for activities AND MCP tools. Non-AP routes keep router-side decrypt-fetch. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python, `dapr-ext-workflow==1.17.1`) via workflow-orchestrator; Dapr control plane 1.17.9
- **Durable AI Agents**: 4 runtimes via the runtime registry SSOT, each registering Dapr workflow `session_workflow` + sharing one CMA session-event HTTP ingest contract. `dapr-agent-py` (per-ACTIVITY loop, multi-provider/9 adapters) is built ON the GA dapr-agents framework (subclasses `DurableAgent`; pinned `dapr-agents==1.0.3`); its adapters monkeypatch `DaprChatClient.generate` for DIRECT provider calls. `claude-agent-py` (Claude Agent SDK, whole loop in ONE activity, Anthropic-only, supports MCP), `adk-agent-py` (Google ADK), `browser-use-agent` (browser/vision, warm-pool). Durable-state/payload ceiling = 16 MiB gRPC `max-body-size` (Postgres store). See `docs/agent-runtime-comparison.md`.
- **Function Execution**: function-router (Dapr invoke) → fn-system / per-piece piece-runtime / openshell-agent-runtime / code-runtime
- **Activepieces**: ~45 AP piece npm packages (single pin set in `services/piece-mcp-server/package.json`), OAuth2 PKCE, encrypted app connections
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

Skaffold is the in-cluster dev loop (`devspace.yaml` retired). **For full detail use the `skaffold-dev-loop` and `gitops` skills.**

```bash
# Inner loop (HMR file-sync into a Skaffold-owned dev pod):
pnpm dev:skaffold                              # workflow-builder (default)
pnpm dev:skaffold:orchestrator                 # workflow-orchestrator
bash scripts/skaffold-dev.sh function-router   # any single module by name

# Outer loop (build prod image → push → commit kustomize pin → Argo deploys):
pnpm deploy:skaffold                                # workflow-builder
bash scripts/skaffold-deploy.sh function-router     # any single service

pnpm skaffold:doctor                                # read-only preflight
```

Module set (Local→Container port): workflow-builder 3002→3000, workflow-orchestrator 3013→8080, function-router 3014→8080, mcp-gateway 3018→8080, swebench-coordinator 3019→8080. **`fn-system` is excluded** (Knative scale-to-0); per-piece piece-runtime services are reconciler-owned Knative Services, not Skaffold modules (deliver via image rebuild + metadata re-sync). (`fn-activepieces` module DELETED.)

Key facts (full detail in the `skaffold-dev-loop` skill):
- `SKAFFOLD_DEFAULT_REPO=ghcr.io/pittampalliorg` (host needs `docker login ghcr.io`). The wrapper traps SIGINT/SIGTERM/EXIT to resume ArgoCD; recover a `kill -9` with `ARGO_APPS=workflow-builder bash skaffold/hooks/argo-resume.sh`.
- **commit-pin** is the single image-pin writer on GitHub `main` for Skaffold-owned services (`SKAFFOLD_OWNED_DEFAULT`), via a dedicated clone at `~/.cache/skaffold/stacks-ryzen`. Most services: textual `newTag` edit of `workloads/<svc>/manifests/kustomization.yaml`. **`workflow-builder` + `workflow-mcp-server` are the exception** — commit-pin UPSERTS the flat pins file `…/release-pins/workflow-builder-images-ryzen.yaml`, renders the ryzen-image Component locally, and `refresh=hard`es the ryzen spoke-local app.
- **No `kubectl set image`** — the live cluster is mutated only by ArgoCD. **Ryzen single-pin**: the render-generated Component is the SOLE ryzen image authority; Application-object `spec.source.kustomize.images` overrides are forbidden (CI guard `validate-ryzen-no-app-image-overrides`).
- **commit-pin's HTTPS push can 403 on this NixOS host**; image+pin commit are still made — push with `git -C ~/.cache/skaffold/stacks-ryzen push "https://x-access-token:$(gh auth token)@github.com/PittampalliOrg/stacks.git" HEAD:main`, then hard-refresh `ryzen-<svc>`.
- **Dev auto-promote covers ALL Skaffold-owned services**: hub Tekton `github-outer-loop` per-service triggers (merge to `main` touching `services/<svc>/**`, or `[build all]`) → `outer-loop-build` → GHCR → `update-stacks` → source-hydrator → GitOps Promoter → `dev-<svc>`. Don't `deploy:skaffold` a commit the GitHub outer-loop also builds (digest mismatch) — commit-pin the existing GHCR tag instead. Bring a stale service current via a `outer-loop-build` PipelineRun with `git_sha=<main HEAD>`.

### GitOps activity stream (`/admin/gitops/system`)

Observable live via **Argo Events** (hub) → BFF ingest `POST /api/internal/gitops/events/ingest` (`gitops/activity-events.ts` → `gitops_activity_events`) → SSE `GET /api/v1/gitops/events/stream?since=<seq>`. The "Kargo lens" pipeline (`pipeline-model.ts`, `activity-overlay.ts`) renders event-first; the overlay never mutates authoritative inventory health/sync. Build feedback + the Commit→Build→Pin→Promote→Deploy timeline are INVENTORY-sourced, not event-sourced (the stream is ~100% ArgoCD). **App-wide deployment notifications** (toast + sidebar bell, `deployment-notifications.svelte.ts`) fire on inventory-diff (new live image tag-SET while `Synced`), admin-gated.

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, SW 1.0 interpreter |
| **agent-sandbox pod** (per-session) | n/a | Ephemeral runtime pod (`dapr-agent-py`/`claude-agent-py`/`adk-agent-py`) differing only by image; Kueue-admitted, self-reaped. `browser-use-agent` via `SandboxWarmPool`. (AgentRuntime CRD + Kopf controller RETIRED.) |
| **dapr-agent-py** (legacy Deployment) | n/a | Static replicas:4; survives only for `openshell-durable-agent` enum + benchmark coding pool |
| **function-router** | 8080 | Slug routing + credential audit point + Knative proxy. `function-registry` CM authoritative over built-in fallback. |
| **fn-system** | 8080 | system/* (http-request, database-query, condition) |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external clients |
| **workflow-mcp-server** | 3200 | Deployed MCP server: goal tools (`create/update/get_goal`) + workflow tools |
| **piece-runtime** (`piece-mcp-server` image, `ap-<piece>-service` per piece) | dynamic | Converged per-piece surface: `/execute` (activities) + `/mcp` (tools) + `/options` (dropdowns); Knative scale-to-zero, reconciler-provisioned |
| **openshell-sandbox** | — | Custom sandbox image (Chromium/Playwright); per-session pods in `openshell` ns |

## Project Structure

- `src/routes/` — API routes (`api/workflows`, `api/orchestrator`, `api/app-connections`, `api/internal/{connections,mcp,agent}`, `api/events/ingest`, `api/v1/auth`, `api/pieces`) + pages
- `src/lib/components/workflow/` — Svelte Flow canvas, side-panel, toolbar, base-sw-node, animated-edge
- `src/lib/server/` — `db/schema.ts` (Drizzle), `dapr-client.ts`, `auth.ts`, `security/encryption.ts`, `app-connections/oauth2.ts`, `internal-auth.ts`, `workflows/external-event-registry.ts`, `otel/clickhouse.ts`
- `services/` — `workflow-orchestrator/`, `dapr-agent-py/`, `claude-agent-py/`, `adk-agent-py/`, `function-router/`, `fn-system/`, `workflow-mcp-server/`, `piece-mcp-server/` (piece-runtime), `mcp-gateway/`, `openshell-sandbox/`, `crawl4ai-adapter/`, plus `shared/runtime-registry.json` (runtime SSOT)
- `drizzle/` — migration SQL. `scripts/` — dev/seed/test. `docs/` — supplementary docs.

## Action Routing

Routed by `actionType` slug prefix. Orchestrator → function-router uses Dapr service invoke; `durable/run` bypasses function-router via `ctx.call_child_workflow`.

| Prefix | Service | Notes |
|--------|---------|-------|
| `durable/run` | per-session agent-sandbox pod | Native Dapr child workflow `session_workflow`. Target runtime + app-id resolved via `runtime_registry.resolve()` from the agent's `runtime`; falls back to registry default only when neither `agentAppId` nor `agentSlug` is stamped. |
| `system/*` | fn-system | http-request, database-query, condition |
| `workspace/*` | openshell-agent-runtime | Plus `persist_workspace_session` activity after `workspace/profile` with `keepAfterRun=true` |
| `browser/*` | openshell-agent-runtime | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | OpenShell helper routes |
| `code/*` | code-runtime | Saved TS/Python code execution |
| `*` (default) | piece-runtime (`ap-<piece>-service`) | All AP piece actions; registry type `activepieces` resolves the per-piece Knative Service dynamically; `X-Connection-External-Id` reference-forwarding |

Rejected slugs (orchestrator raises): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, any `mastra/*` or `agent/*`.

## Agent Runtime Model

The runtime registry (`services/shared/runtime-registry.json`) is the dispatch SSOT — `scripts/sync-runtime-registry.mjs` generates the orchestrator copy (`core/runtime_registry.json`, read by `core/runtime_registry.py`) and the BFF copy (`src/lib/server/agents/runtime-registry.data.json`, read by `runtime-registry.ts`); a `--check` mode + tests guard drift. Each descriptor carries identity (`appIdConfigKey`, `instancePrefix`, `mainContainerName`, `imageEnvKey`, `agentMetadataFramework`, `benchmarkEligible`) + capabilities (`durabilityGranularity`, `supportsMcp`, `supportsHooks`, `supportsPermissionGating`, `incrementalEvents`, `ownsSandbox`, `requiresWarmPool`, `requiresBrowserSidecars`, `multiProvider`, `supportedProviders`).

On publish, `src/lib/server/agents/registry-sync.ts` mirrors agent metadata into the Dapr agent registry (its `runtime` selects a descriptor). No per-agent `AgentRuntime` CR / Kopf controller — upstream kubernetes-sigs/agent-sandbox + Kueue dispatches per-session pods; `browser-use-agent` uses a `SandboxWarmPool` carve-out.

**Pod shape**:
- `seed-openshell-config` init container — writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + mTLS certs. Without it, OpenShell tools fail ENOENT on `active_gateway`.
- runtime main container (`dapr-agent-py` / `claude-agent-py` / `adk-agent-py`, per `descriptor.mainContainerName`) — registers `session_workflow` + plugins/hooks. `claude-agent-py` wires `agentConfig.mcpServers` into the Claude Agent SDK.
- `daprd` sidecar — injected by `openshell-sandbox-dapr-webhook` (matches `openshell` + `workflow-builder`). Requires `openshell-sandbox-dapr` Configuration in the pod's namespace.
- *(Optional)* `chromium` + `playwright-mcp` browser sidecars when `requiresBrowserSidecars`/Playwright MCP preset applies (`mcp:3100`).

**Lifecycle**: per-session Sandbox pods created on dispatch, self-reaped on session end — no scale-to-0 Deployment, no wake/idle annotations. Legacy static `Deployment-dapr-agent-py` (replicas:4) survives only for the `openshell-durable-agent` enum + `agent-runtime-pool-coding` benchmark pool.

**Dapr Component visibility** in `workflow-builder` ns: `workflowstatestore` (`actorStateStore=true`, Dapr workflow/actor history); `dapr-agent-py-statestore` (false, agent/session state); `agent-workflow` (false, legacy, no active consumers). A Dapr sidecar refuses to start if it sees >1 `actorStateStore=true` Component. New agents: register in the runtime/Dapr agent registry; do NOT patch Component scopes.

## Workflow → Session Bridge

Every `durable/run` step goes through a session bridge so workflow-driven runs appear in the same `/sessions/[id]` UI as direct sessions.

**Flow** (`workflows/sw_workflow.py` + `activities/spawn_session.py`):
1. Orchestrator yields `spawn_session_for_workflow` with `bridge_payload` (agentAppId, agentSlug, workspaceRef, sandboxName, agentConfig, durable/run body).
2. Activity POSTs to BFF `/api/internal/sessions/ensure-for-workflow`. Handler rewrites `agentConfig.mcpServers` for browser sidecar, finds/creates session row (keyed by `child_instance_id = <exec>__<kind>__<node>__run__<index>`), creates ephemeral `agents` row if inline, ensures sandbox admitted (non-blocking), returns `{sessionId, agentId, agentVersion, childInput, reused}`.
3. Orchestrator yields `ctx.call_child_workflow("session_workflow", input=childInput, instance_id=child_instance_id, app_id=target["app_id"])`. Child runs with `autoTerminateAfterEndTurn: true` — one turn, emits `session.status_idle{end_turn}` + `session.status_terminated`. Parent resumes; final output persists to `workflow_executions.output`.

### Safety nets on the agent side

Defensive layers prevent `durable/run` hangs:
- **Empty-response circuit breaker** (`dapr-agent-py` `call_llm`): after `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3) consecutive empty/no-tool responses, raises `AgentError`. Catches Anthropic SDK #1204 (empty `end_turn`).
- **Host-monitor thread** (`_run_session_host_monitor`, logic in `session_host_monitor.py`): out-of-band background thread polling for start/idle stalls. The old in-workflow session-turn timer (`when_any([child, timer])`) was REMOVED (commit `72154581`). Default action is `"warn"` (`DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION`); only `terminate` kills. This is hang-detection, NOT the stop watchdog — explicit stops route through the Lifecycle Controller; stuck DB↔Dapr divergence is reconciled by the `lifecycle-terminal-reaper` CronJob.
- **Image tool_result compaction** (`anthropic_adapter.py`): keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) image tool_result blocks; prevents 1M-token overflow.

### Workspace session persistence

- **`persist_workspace_session` activity**: after `workspace/profile` with `keepAfterRun=true`, UPSERTs `workflow_workspace_sessions` (status=`active`, keyed on `workspace_ref`). Read by `getExecutionSandboxPreviewInfo` for live-preview proxy.
- **Cleanup gate**: `_should_cleanup_workspaces` walks the SW 1.0 spec for `workspace/*` steps with `with.keepAfterRun: true`.

## Lifecycle: Stop / Terminate / Purge (Lifecycle Controller)

A single vetted server-side **Lifecycle Controller** in the BFF (`src/lib/server/lifecycle/{cascade,resolvers,index,reaper,ownership}.ts`) is the SSOT for stopping/terminating/purging Dapr Workflows + durable agent runs. Every user-facing "stop" routes through it. **Full detail: `docs/workflow-lifecycle-termination.md`** (IMPLEMENTED PR1–PR4, hardened wfb #69–#79).

**Entry point**: `stopDurableRun(target, { mode })`. `target.kind ∈ workflowExecution | session | evalRun`. Modes:
- **`interrupt`** — cooperative only (raise `session.terminate` / `user.interrupt`, bounded wait). "Pause, keep the run."
- **`terminate`** — graceful raise → Dapr terminate parent + every child app-id → poll to terminal. "Stop."
- **`purge`** — terminate → confirm terminal → Dapr purge (recursive; **purge-force** when worker gone) → reap Sandbox CRs → flip DB rows terminal. "Stop & clean."
- **`reset`** (dev) — purge + delete deterministic-ID occupants so the next run starts byte-clean.

**Request/confirm** (#69/#71): stop persists a `stop_requested_at` intent (migration `0071`), returns **HTTP 202 "stopping"** while the durable tree converges, and only flips DB / reaps once Dapr is confirmed terminal — finalized by `GET …/stop/status` → `confirmDurableStop` and/or the reaper. 200 confirmed · 202 stopping · 409 only on genuine non-request failure. Cascade timing env-tunable (`LIFECYCLE_CASCADE_WAIT_SECONDS` default 90; cooperative-first `LIFECYCLE_TERMINATE_GRACE_SECONDS` default 5).

**Single stop authority** (#70/#79): a benchmark/eval **instance** is NOT stoppable via the generic per-execution **or** per-session Stop — both 409 `coordinator_owned` (`ownsBenchmarkOrEvalRun(ForSession)`); cancel the owning **run** (`/api/{benchmarks,evaluations}/runs/[id]/cancel`). Standalone runs / direct sessions keep their Stop.

**Cross-app fan-out (no implicit cascade)**: `session_workflow` children run under per-session sandbox app-ids = separate task hubs, so Dapr's native recursive cascade does NOT reach them. The BFF controller does explicit per-session app-id fan-out (terminate + purge each). The orchestrator's `terminate_durable_runs_by_parent_execution` activity was RETIRED.

**Cross-app `durable/run` Stop WEDGE** (kept `call_child_workflow`; BFF-only fix, #77, hardened #78/#79): the cross-app sub-orchestration is on a separate task hub, so a task-hub-bounded terminate can't reach it → the SW-interpreter parent hangs `RUNNING`. `confirmDurableStop` **force-finalizes** the wedged parent after a grace on **positive evidence** — the parent's live `currentNodeId` is a `durable/run` node whose child session is DB-terminated (`shouldForceFinalizeCrossAppWedge`; `LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS` default 180s; state-row purge boundary-anchored via `daprStateKeyMatchPattern`). **Rejected:** fire-and-forget + status-poll dispatch (#74/#75) reverted (#76) — per-session Kueue sandboxes aren't Dapr-service-invokable (`call_child_workflow` routes via PLACEMENT, not DNS). Don't re-attempt fire-and-poll.

**Orchestrator-side**: `_workflow_http_post` forwards query params; `purge_workflow` is recursive-by-default + forwards `force`. `_idempotent_schedule`'s purge-before-reuse is GUARDED to only the DB-terminal-but-Dapr-non-terminal divergence.

**Runtime/sandbox-side**: sandbox-execution-api stamps an owner-run-id annotation, adopting only the SAME run else delete+recreate. dapr-agent-py's cancel-key write/read AGREE for `durable/run` (check strips `__turn__N` / `:turn-N`). claude-agent-py has management parity (`POST /api/v2/agent-runs/{id}/{terminate,pause,resume}` + `DELETE` purge).

**GitOps safety nets (stacks, PR4)**: `workflow-builder-sandbox-gc` CronJob (age-GC orphaned Sandbox CRs); unified Dapr `stateRetentionPolicy = 168h` across parent + per-session child Configs; `lifecycle-terminal-reaper` CronJob → `POST /api/internal/lifecycle/reap-terminal` (reconciles DB stuck non-terminal vs terminal/gone Dapr, even during benchmark activity, priority stop-requested pass); `runbooks/phase0-lifecycle-clean-slate.{sh,md}` (guarded, NOT auto-run).

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
- **workflow_artifacts**: standardized typed outputs (see Workflow Artifacts section)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Three paths:
1. **Activepieces piece MCP services**: per-piece in-cluster endpoints, backed by `mcp_connection.connection_external_id` + encrypted `app_connection` credential.
2. **dapr-agent-py MCP client**: reads `durable/run.with.agentConfig.mcpServers`, connects at runtime, exposes alongside built-in OpenShell tools.
3. **mcp-gateway / workflow-mcp-server / piece-mcp-server**: hosted MCP surfaces for external-client/on-demand flows.

**Playwright sidecar rewrite** (`src/lib/server/agents/mcp-sidecar.ts`): any `agentConfig.mcpServers` entry matching Playwright (by name, URL containing `playwright-mcp`, or args containing `@playwright/mcp`) is rewritten to `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`. Called from BOTH spawn paths. Controller adds `chromium` + `playwright-mcp` sidecars when matched.

For UI-runnable agent workflows: SW 1.0 `durable/run` with `agentConfig.mcpServers` and `x-workflow-builder.input` prompt metadata. See `docs/mcp-agent-workflows.md`. MCP Apps use `@modelcontextprotocol/ext-apps` (`tool-widget.tsx`).

## Hooks + Plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins surface. Feature-flagged via `DAPR_AGENT_PY_HOOKS_ENABLED=true` + `DAPR_AGENT_PY_PLUGINS_ENABLED=true`; plugins ship via `fetch-claude-plugins` init container cloning `anthropics/claude-plugins-official` to `/etc/dapr-agent-py/plugins`.

- **Events v1**: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification
- **Hook types v1**: `command` (subprocess JSON stdin/stdout, exit-code 2 = blocking) + `callback` (in-process Python)
- **Per-run overlay**: `durable/run.with.agentConfig.hooks` + `agentConfig.plugins` layered on startup registry
- **Durability**: PreToolUse/PostToolUse/PostToolUseFailure fire inside durable `run_tool` activity; session-level events gated by `not ctx.is_replaying`

> See `docs/hooks-and-plugins.md`.

## Activepieces Integration

- Credentials: AES-256-CBC encrypted in `app_connections`. Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`.
- Flow: create → encrypted in DB → at execution the piece-runtime self-resolves plaintext from the BFF `/decrypt` via `X-Connection-External-Id` (function-router writes the audit row; see credential invariant above).
- Adding piece: (1) npm dep + `piece-registry.ts` in `services/piece-mcp-server/`, (2) rebuild image, (3) re-run metadata sync (`sync-metadata.ts` / stacks Job) so `piece_metadata` + the canvas catalog pick it up.
- Deterministic-activity semantics (idempotency gate via `piece_execution`, retryable/permanent error classes, pause mapping, >4 MiB artifact offload): see `docs/activepieces-integration-architecture.md`.

> See `docs/activepieces-integration-architecture.md` (SSOT) + `docs/activepieces-auth.md`.

## CMA Parity (Managed Agents Console)

Mirrors platform.claude.com/dashboard surface-for-surface. Workspace scoping is the unifying invariant: every user-facing resource carries `project_id`; `hooks.server.ts` resolves scope from `X-Workspace` header or URL slug into `locals.session.projectId`.

- **Workspaces** (`/workspaces`, `/workspaces/[slug]/*`; non-member 404s at layout guard) · **Members** (`/settings/members`, CRUD via `/api/v1/projects/[projectId]/members`; last-admin demote/remove blocked).
- **Sessions**: CMA-shape event stream (`agent.message/thinking/tool_use/tool_result`, `session.status_*`). **Fork**: `POST /api/v1/sessions/[id]/fork` with `fromSequence`.
- **Custom skills**: `sourceType="custom"` in `agent_skill_registry`, scoped via `project_id` (`POST /api/agent-skills` + `PATCH …/[id]`, prompt edit bumps version). Curated/global rows visible to all.
- **Usage + cost** (`/api/v1/usage`, `/api/v1/cost`, workspace-scoped, fall back to `userId`) · **Limits** (`/settings/limits`, 15s refresh via `/api/v1/limits/live`, computed from `sessions.usage`+`status`).
- **Observability deep-link**: session detail → Phoenix + ClickHouse (`session.id` span filter). **Workflow → session cross-link** via `/api/workflows/executions/[executionId]/sessions`.

Full map: `docs/cma-parity.md`.

## Goal Loop (Codex `/goal` parity) + Session Pulse

**Full detail: `docs/goal-loop.md` (goal-loop SSOT).** One ACTIVE goal per session (`thread_goals`, migration `0079`, partial unique index). BFF driver `src/lib/server/goals/{goal-loop,repo,render}.ts`, event-driven off `appendEvent`: `agent.llm_usage` accrues budget; `session.status_idle{end_turn}` injects the next continuation as a `user.message` (verbatim codex templates). Exactly-once = atomic iteration claim + latest-event-is-idle gate + deterministic `sourceEventId`.
- **Completion contract**: MCP tools `create_goal`/`update_goal`/`get_goal` (workflow-mcp-server), session-scoped via `X-Wfb-Session-Id` header + AsyncLocalStorage; `update_goal` accepts ONLY `"complete"`. `spawn.ts` AUTO-WIRES the goal MCP server into every MCP-capable session (opt-out `GOAL_MCP_AUTO_WIRE=false`).
- **Budget = codex semantics**: delta = `input + output + cache_creation` — cache READS excluded. SYSTEM INVARIANT: all dapr-agent-py adapters emit `agent.llm_usage.input_tokens` NET of cache reads (openai/alibaba normalize gross→net; gross counting over-burned budgets ~20x). Goal budgets, Pulse cost, and the `context_*` window-occupancy stamp all depend on it.
- **Guardrails**: tokenBudget → `budget_limited` + exactly ONE wrap-up turn (`budget_steered_at`); `maxIterations` hard cap (`stop_reason=iteration_cap`); stop/interrupt pauses the goal; terminal sessions halt the driver. Re-set replaces active AND budget_limited rows (re-arm): goalId rotates, accounting resets.
- **Crash-safety**: `goal-loop-tick` CronJob (stacks, */2) → `POST /api/internal/goal-loop/tick` + lost-idle probe (`GOAL_LOOP_LOST_IDLE_GRACE_SECONDS=180`) — ingest is fire-and-forget, so a dropped idle can't freeze the loop (Dapr buffers a mid-turn raise).
- **API/UI**: `GET/POST/PATCH /api/v1/sessions/[id]/goal`; Goal card on session detail. **Session Pulse** vitals strip (`session-pulse.svelte`): tokens in/out, cache-hit %, live cost via `GET /api/v1/pricing?model=` (`MODEL_PRICING`), provider-truth Context % (the `local_advisory` heuristic undercounts 20–25%), elapsed, turns, goal tile.

## Browser Validation (In-Sandbox Screenshots)

`browser/validate` (`POST /api/browser/validate` in openshell-agent-runtime) captures screenshots inside the coding agent's OpenShell sandbox (no second sandbox). Image: `services/openshell-sandbox/Dockerfile` (Ubuntu 24.04 + Chromium via Playwright at `/opt/pw-browsers`). Storage: `workflow_browser_artifacts` + `…_blob_payloads`; UI: Artifacts tab in run detail. Constraints: PNGs base64-encoded + read in 4KB `dd` chunks (OpenShell stdout truncates >4KB); base64-encoded scripts (no heredoc through OpenShell API); `imagePullPolicy: Always` for sandbox images.

## Standardized Workflow Artifacts

Any SW 1.0 task can declare typed outputs via an `artifacts:` block alongside `with:` — a list of entries `{ kind, slot (primary|secondary|aux), title, from (jq), contentType?, if? (jq guard) }`. `_persist_task_artifacts` walks `task_data["artifacts"]`, evaluates jq, yields `persist_workflow_artifact` per entry. Activity ID is deterministic (`sha256(workflowId|executionId|nodeId|kind|title)[:24]`) so retries UPSERT. **Storage**: `workflow_artifacts` table (drizzle 0067), inline payload (jsonb ≤256 KB) or `file_id` for blobs.

**Standard kinds**: `markdown`, `json`, `text`, `table`, `image` (blob via fileId), `link`, `card`; unknown kinds fall back to JSON dump (payload shapes: `docs/workflow-artifacts.md`).

**Consumer**: `<ArtifactList artifacts={...} mode="primary|all" />` (`src/lib/components/workflow/execution/artifact-list.svelte`). APIs: `GET /api/workflows/executions/[id]/artifacts` (workspace-scoped read); `POST /api/internal/workflows/executions/[id]/artifacts` (internal-token write). Activity is best-effort.

> See `docs/workflow-artifacts.md`.

## Tiered Crawl Pipeline (research workflows)

`browserresearchfanout01` v3 is the canonical pattern for multi-URL "fetch + extract + synthesize" (`trigger {topic,urls,extractionPrompt}` → `for url` → `web/crawl.async` durable activity → `durable/run text-research-synthesizer`, a pure text agent). Replaces v2 browser-use-agent for research/extraction; browser-use stays for *interactive* (vision/click) tasks. **Full detail: `docs/tiered-crawl-pipeline.md`.**

**crawl4ai-adapter v2** (`services/crawl4ai-adapter/`): `POST /crawl/jobs { url, jobId?, tiers?, extractionSchema?, cacheTtlSeconds? }`; `GET /crawl/jobs/{id}` → `{ complete, success, data, error }`. PG-backed (`crawl4ai_jobs` + `crawl4ai_cache`), idempotent jobIds `j_<sha256(workflowId|nodeId|url)>[:32]`, cache keyed on `sha256(url|tier_chain|schemaHash)` (1h), tier escalation (default `[http]`) on block-detect, optional `extractionSchema` → Anthropic `tool_use` in `result.extracted`, startup watchdog + lazy resume re-kick stale jobs.

**For-task jq output**: per-URL outputs at `<for_name>/<sub_name>[<idx>]`; envelope has ONE unwrap applied — read `.data.tier`, `.data.extracted` (NOT `.tier` / `.extracted`). **Don't use for** interactive browser control — use browser-use-agent.

## Troubleshooting

- **Agent timeout** → Check the per-session agent-sandbox pod logs + workflow-orchestrator logs
- **Agent stops early** → Check `maxTurns` (default 50, per-node configurable)
- **OAuth2 token expired** → Auto-refresh; check `AP_ENCRYPTION_KEY`. **AP decrypt fails** → verify `INTERNAL_API_TOKEN` matches across services
- **Tool fails ENOENT on `active_gateway`** → `seed-openshell-config` init container didn't run; verify the sandbox pod template includes it AND `openshell-sandbox-dapr-webhook` covers `workflow-builder`
- **daprd `no X509 SVID / failed to get configuration`** → `openshell-sandbox-dapr` Configuration missing in pod's namespace
- **daprd `detected duplicate actor state store`** → a Component with `actorStateStore=true` became visible; partition scopes (see Agent Runtime Model)
- **`ctx.call_child_workflow` times out `app may not be available`** → target pod isn't placement-registered (sandbox not admitted/started, or cross-namespace — sub-orchestration is intra-namespace only)
- **`Ignoring unexpected taskCompleted event with ID = N`** → NOT stuck; normal `call_child_workflow` replay chatter. Real stuck: sandbox pod never `Running`, or pattern persists >5 min with daprd placement flaps
- **Per-session agent-sandbox never starts** → check Kueue admission (`kubectl get workloads -n workflow-builder`) + the agent-sandbox controller (no wake annotation — controller RETIRED)
- **BFF `/execute` `ECONNREFUSED`** → orchestrator CrashLoopBackOff; common cause is image predating `activities/crawl4ai.py`
- **Workflow-driven sessions show raw agent IDs** → ephemeral agents filtered from `/api/agents` by design
- **Agent loops with empty responses** → Anthropic SDK #1204. Circuit breaker in `call_llm` trips after 3; look for `[call-llm] circuit-breaker tripped`
- **Child session hangs with no LLM traffic** → host monitor defaults to `"warn"` (see Safety nets; `…TIMEOUT_ACTION=terminate` to kill); stop via the Lifecycle Controller; orphans reconciled by `lifecycle-terminal-reaper`
- **Want to stop a running session / workflow run** → Lifecycle Controller: `POST /api/v1/sessions/[id]/stop` or `/api/workflows/executions/[id]/stop` with `{mode}`. A stop that can't confirm in-request returns **202 "stopping"** (not a hard 409). A **benchmark/eval instance** 409s `coordinator_owned` — cancel the owning run (see Lifecycle)
- **`Could not purge … instance is not in a terminal state`** → purge requires terminal; the Controller terminates first (purge-force when worker gone). Don't reuse a deterministic ID over a stuck non-terminal instance
- **Anthropic 400 `prompt is too long`** → too many image tool_results; `_compact_image_tool_results` keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3). **`Streaming is required`** → all calls route through `_stream_final_message`; lower `DAPR_AGENT_PY_MAX_TOKENS` (default 16384)
- **dapr-agent-py code changes need TWO image builds**: `dapr-agent-py:git-<sha>` (legacy Deployment) + `dapr-agent-py-sandbox:latest` (per-session pods, `imagePullPolicy: Always`)
- **Node service prod build fails `ERR_PNPM_IGNORED_BUILDS`** → unpinned `npm install -g pnpm` pulled v10; pin **`pnpm@9`** (don't use `--ignore-scripts`). Recover with the "bring a stale service current" PipelineRun
- **Live-preview 404 "Retained sandbox not found"** → `workflow_workspace_sessions` row missing/`cleaned`. Verify `persist_workspace_session` fired + spec `with.keepAfterRun: true`. Revive: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`
- **`${ .trigger.X }` reaches agent as literal string** → SW 1.0 jq-template eval only fires for ENTIRE-value `${...}`. Wrap whole value in one jq expression
- **`web/crawl.async` times out** → adapter restarted + lazy-resume too slow. Reset: `UPDATE crawl4ai_jobs SET state='FAILED' WHERE state IN ('PENDING','RUNNING') AND updated_at < now() - interval '2 minutes'`
- **Synthesizer calls WebSearch / hangs** → per-URL corpus has nulls from missing envelope unwrap. Use `.data.tier` / `.data.extracted`
- **`artifacts:` block declared but no rows** → activity is best-effort. Check orchestrator logs for `persist_workflow_artifact` warnings (BFF 503, missing `INTERNAL_API_TOKEN`, jq `null` + `if:` true)
- **MLflow Traces UI shows `IN_PROGRESS` after success** → FIXED via `finalize_mlflow_trace_root` activity (raw OTLP POST, empty parent_span_id — must NOT use the SDK tracer); disable via `WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN=false`
- **SvelteKit type errors** → `pnpm check`

---

**Last Updated**: 2026-06-10
