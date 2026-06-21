# Sandbox Warm Pools — generalizing pre-warmed pods to cut session cold-start

**Status:** design + phased plan. **Phase-2 claim-bind found INFEASIBLE on the current dispatch (see §0); safe cold-start levers shipped instead.**
**Goal:** cut the ~30–60s cold-start before a `durable/run` agent does useful work, by serving sessions from pre-warmed pods instead of cold-provisioning a per-session sandbox each time.

## 0. Update (2026-06-21) — claim-bind blocker + shipped safe levers

**The §6b claim "claim-bind is NATIVE, no controller needed" is INCOMPLETE — it ignores Dapr dispatch routing.** Verified against the live cluster:

- `durable/run` dispatches `ctx.call_child_workflow(app_id=<X>, instance_id=<session>)`, routed by **Dapr placement** to the daprd registered under app-id `X`. The cold lane works because sandbox-execution-api stamps a **per-session** `dapr.io/app-id=agent-session-<sha>` on each Sandbox → **one app-id = one pod** → placement always hits the right pod (confirmed: a live pod runs `daprd --app-id agent-session-d092718…`).
- **Warm pods are generic, created before the session, so they share a static app-id from their `SandboxTemplate`.** With N pods on one app-id, placement spreads workflow *instances* across them by hash → the session can land on a pod we did **not** claim and did **not** inject creds into. This breaks both routing AND the per-user-credential invariant. (Same root cause the fire-and-poll dispatch #74/#75 was reverted for: "call_child_workflow routes via PLACEMENT, not DNS.") The existing browser-use pool only works because it uses a **shared single-pod app-id** — the very model §2 says CLI/dapr can't use.
- **Therefore true claim-bind needs per-pod-unique, post-claim-discoverable daprd app-ids** (e.g. a mutating webhook setting `dapr.io/app-id = <pod name>` on warm pods + the bridge targeting the *claimed* pod's app-id). That's a medium-large, webhook-touching, higher-risk effort — NOT the additive build §4/§6 implied. Deferred pending an explicit decision to take it on.

**Shipped instead (stacks `baf269707`, dev-live; safe, no dispatch-path change) — directly fixes the OBSERVED failure** (concurrent cold-starts stuck Kueue `status=queued` → orchestrator 600s readiness timeout → `durable/run` errors):
1. **PSI memory gate relaxed** — `PSI_MAX_MEMORY_AVG60_PCT` 10→60. `memory.some.avg60` trips on benign page-cache reclaim during concurrent npm-install/CLI boots; it was fail-closing every agent-pod admission. `memory.full.avg60` (genuine saturation) stays the real gate at 5%. Mirrors the existing `cpu.some→cpu.full` / `io.full` treatment — memory was the last gate left on the noisy `.some` signal.
2. **Host-readiness timeout** `AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS` 600→900 — slack so a transiently-queued pod admits once capacity frees instead of erroring.

Effect: raises safe concurrent `durable/run` from ~2–3 to ~6–8 with zero routing risk. **Remaining safe lever (not yet done): quick-win B — shrink `seed-openshell-config` to busybox + baked config + Secret mTLS** (cuts init seconds; medium risk → do carefully, it can ENOENT-break `active_gateway` for ALL sessions). Capacity math + the per-run footprint that motivated this: see `docs/session-resource-metrics-and-kueue-admission.md`.

## 1. Where the time actually goes (measured)

From the per-session **provisioning timeline** (`session.provisioning_*` events, `docs/browser-session-live-view-and-recording.md` infra), across recent CLI sessions on dev:

| Phase | Typical | Warmable by a pre-warmed pod? |
| --- | --- | --- |
| Kueue admission + pod scheduling | ~7–9s | ✅ (pod already scheduled) |
| Init containers (`seed-openshell-config` mTLS, daprd init, plugin fetch) | ~7–20s | ✅ (already init'd) |
| Image pull | **~0s** (node-cached; Spegel mirrors ghcr.io) | n/a — *not* a factor |
| After `Running`: CLI TUI boot (herdr) + MCP server start + first LLM call | +N s | ✅ (already booted) |

**Image pull is not the bottleneck** — Spegel (DaemonSet 9/9 dev, 3/3 ryzen, mirrors `ghcr.io`) + node cache make repeat pulls ~0ms. The cost is **scheduling + init containers + CLI/MCP boot**, all of which a pre-warmed, already-running pod eliminates. Spegel still matters here: a warm pool spread across nodes relies on P2P layer sharing for first-pull on each node.

## 2. Why this isn't a trivial extension of the browser-use warm pool

`browser-use-agent` already sets `requiresWarmPool: true` and gets a `SandboxWarmPool` via `registry-sync.ts` → `sandbox-warmpool-builder.ts`. **But that mechanism does not fit CLI/dapr:**

- **It's scale-to-zero, not pre-warm.** `buildBrowserSandboxWarmPool` defaults `replicas: 0`; `spawn.ts` *wakes* it to 1 on demand (`wakeAgentRuntime`) and an idle reaper resets to 0. So no pod is actually kept warm — the wake still creates a pod on the request path. True latency wins require **`replicas ≥ 1` kept warm**.
- **It dispatches to a per-slug SHARED host.** `spawn.ts:408` uses `targetAppId = sessionHost?.agentAppId ?? runtimeRoute.appId` — the warm-pool lane targets the per-*slug* app-id (one shared host), whereas the cold Kueue-Sandbox lane uses a per-*session* `agent-session-<sha20>` app-id. A shared host is fine for browser-use but **violates CLI isolation + the credential invariant** (`ANTHROPIC_API_KEY`/subscription tokens must never be shared across users; each CLI session is per-user).
- **The builder is browser-specific** (`browserAgentSandbox*` names, chromium + playwright-mcp sidecars, browser env).

**Conclusion:** CLI/dapr need a **claim-bind-recycle** pool (pool of *generic* pods → claim one per session → inject the session's agentConfig/persona/credentials at claim → recycle/reset after), which is a *different* model than browser-use's wake-shared-host, and it changes the dispatch critical path for every agent run.

## 3. Design — one warm pool per sandbox IMAGE (not per persona)

The per-session pod differs only by **image**, and within an image the runtime is selected at session time:

- **`cli-agent-py-sandbox` is ONE image for all three CLIs.** The specific CLI is chosen at *session time* by `start_cli_activity` (`cli_lifecycle.py:195` → `get_adapter(adapter_name_for(input_data))`), **not** at pod start. So **one cli-agent-py warm pool can become claude / codex / agy at claim** — no per-persona pools.
- **`dapr-agent-py-sandbox` is a second image** → its own pool. (It also has a legacy static `Deployment` replicas:4 that already warms it for the benchmark coding pool; per-session `durable/run` uses the cold lane.)
- `browser-use-agent` already has its pool.

So: **~3 pools keyed by image** (`cli-agent-py`, `dapr-agent-py`, `browser-use`). The runtime registry SSOT already carries the driving fields (`mainContainerName`, image key, `requiresWarmPool`).

### Claim-bind-recycle (the core mechanism to settle)
A warm pod is generic (no user creds, no persona). On dispatch:
1. **Claim** a Ready pod from the image's pool (upstream `agents.x-k8s.io` SandboxWarmPool / Sandbox claim — *verify the upstream claim+recycle semantics; this is the key open question*).
2. **Bind** the session to that pod's app-id (the deterministic `agent-session-<sha>` binding must move from "create" to "adopt the claimed pod").
3. **Inject** session config at claim — agentConfig, mcpServers, prompt, and per-user credential (`cliAuth`) — via the existing session-start activities (`seed_session_activity` / `start_cli_activity`), which already run at session time.
4. **Recycle** on session end — reset the pod (clear creds/workspace) and return it to the pool, or discard + let the pool replenish. Reset-correctness (no cred/workspace bleed between users) is mandatory.

## 4. Phased plan

- **Phase 0 — measure (DONE).** Provisioning timeline captures per-phase cold-start; use it for before/after.
- **Phase 1 — generalize the builder.** Refactor `sandbox-warmpool-builder.ts` to `(image, containerSpec, poolName)` — browser becomes one case (with sidecars); cli/dapr are cases without. Key pools off **image** (dedupe), not slug. Type-safe, no behavior change until wired.
- **Phase 2 — claim-bind dispatch lane (the crux + highest risk).** Add a claim-from-pool path in `spawn.ts` for `requiresWarmPool` runtimes that **binds the session to a claimed pod with per-session isolation + per-claim cred injection** (NOT the shared-host model). Validate the upstream SandboxWarmPool claim/recycle API supports this; if not, use a thin claim controller.
- **Phase 3 — stacks.** `SandboxWarmPool` CRs per image with **`replicas ≥ 1`** on the **`background-warm` queue + preemptible `background-workload` priority** (warm pods yield to real workloads under PSI/Kueue pressure). Small counts (1–2/image). Roll pools on image-pin change.
- **Phase 4 — verify + tune.** Trigger runs, compare provisioning-timeline phase durations (expect scheduling+init+boot → ~0 on a warm claim), tune replica counts vs idle cost.

## 5. Caveats / invariants
- **Credentials:** warm pods boot with **no user creds**; inject only at claim. `ANTHROPIC_API_KEY` must never reach CLI pods.
- **Isolation + recycle:** no workspace/credential bleed between sessions — reset or discard on release.
- **Idle cost vs latency:** `replicas ≥ 1` costs idle resources; mitigate with preemptible priority + tiny pools.
- **Image freshness:** a new image pin must roll the pool (warm pods pin an image).
- **Spegel:** keep it healthy (it underpins fast first-pull on each warm node); minor hygiene — make `mirroredRegistries` explicit and confirm the `discard_unpacked_layers=false` containerd patch on all Talos nodes (Spegel is serving today, so it's applied, but it's undocumented in stacks).

## 6b. Upstream capabilities (agent-sandbox + openshell) — RESOLVES the claim-bind question

Researched against what we deploy (agent-sandbox **v0.4.5**, CRDs `extensions.agents.x-k8s.io/v1alpha1`; OpenShell = NVIDIA OpenShell, image `ghcr.io/nvidia/openshell-community/sandboxes/base`):

- **Claim-bind-recycle is NATIVE — we don't build a controller.** `SandboxWarmPool` keeps **N pre-warmed pods** (`spec.replicas`, set `≥1`; `sandboxTemplateRef`; `scale` subresource → HPA-driftable) and **`SandboxClaim`** adopts a Ready pod, marks the claim ready (`status.sandbox.{name,podIPs}`), and the pool auto-replenishes. **Both CRDs are already installed in stacks but unused.** "Recycle" = **discard + replenish a fresh pod** (no in-place reset hook) — which is the *safer* default for our credential-bleed invariant (every session gets a clean pod).
- **MAKE-OR-BREAK GOTCHA:** injecting per-session config via the claim's `spec.env[]` or `volumeClaimTemplates` **forces a COLD start** (upstream type comments are explicit) — it defeats the pool. So **keep warm pods generic** and inject agentConfig/credentials **post-bind** via the existing session-start activities (`seed_session_activity` / `start_cli_activity` writing into the already-running pod over its pod-IP), *never* via claim mutation. This is the pivot of the whole design.
- **Snapshot / suspend-resume (CRIU) is GKE-Autopilot-gVisor ONLY** → **not usable** on our Talos/ryzen clusters. Drop it as a cold-start lever; warm pools are the path.
- **Upgrade path:** **v0.4.5 → v0.4.6 now** (safe; opt-in headless Service `spec.service:false` + direct Pod-IP routing `X-Sandbox-Pod-IP` — aligns with how we already reach pods by IP, cuts kube-proxy/DNS overhead). **v0.5.x later via CLEAN install** (v1alpha1→v1beta1 is *not* in-place upgradable) — it brings 4.26× faster warm-pool reconcile, 4× better P99 claim latency, `warmPoolRef`, Kueue admission, + adoption/metadata security hardening. **Build the warm-pool feature against `v1beta1`** to avoid the soon-deprecated v1alpha1 claim API.
- **OpenShell init-time levers (independent, lower-risk wins on the ~7–20s init):**
  1. **Shrink `seed-openshell-config`** — it currently runs the *full `dapr-agent-py` image with `imagePullPolicy: Always`* just to `cp`/`cat` a `metadata.json`/`active_gateway` + certs. Replace with a **tiny busybox image + baked config + Secret-mounted mTLS** → removes an Always-pull of a big image on every session start. Pure win, no upstream dependency.
  2. OpenShell supervisor **`sideloadMethod: image-volume`** (vs `init-container` copy step) — needs K8s ≥1.33 (ImageVolume GA 1.36).
  3. Move to OpenShell's intended **shared central gateway + `pkiInitJob`/cert-manager Secret PKI** instead of per-session seeding (caveat #888: gateway restart regenerates the CA → mount from Secret, don't bake the CA).
  - OpenShell has **no** warm-pool feature; pooling stays on agent-sandbox.

## 6. Recommendation
Generalize to **one warm pool per image** (`SandboxWarmPool` `replicas ≥ 1` preemptible) + a **`SandboxClaim` dispatch lane** — both **native in agent-sandbox (CRDs already installed)**, so no custom claim controller. The Phase-2 gating question is now answered; the **one rule that makes-or-breaks it** is: **never put per-session `env`/`volumeClaimTemplates` on the claim (forces cold start) — keep warm pods generic and inject creds/config post-bind over pod-IP** via the existing session-start activities. Recycle = discard+replenish (clean pod per session — satisfies the credential invariant for free).

Sequence (each measured with the provisioning timeline), with two low-risk wins that can land in parallel:
- **Quick win A (low risk, parallel):** upgrade agent-sandbox **v0.4.5 → v0.4.6** (Pod-IP routing).
- **Quick win B (low risk, parallel):** shrink `seed-openshell-config` to **busybox + baked config + Secret mTLS** — directly cuts a chunk of the ~7–20s init with no dispatch change.
- **P1:** generalize the builder to per-image `SandboxTemplate` + `SandboxWarmPool` (v1beta1-ready).
- **P2:** add the `SandboxClaim` dispatch lane (generic pod → claim → post-bind cred/config inject over pod-IP → discard on end).
- **P3:** stacks pools (`replicas≥1`, `background-warm` preemptible) per image.
- **P4:** verify + tune; plan the clean-install cutover to v0.5.x (`v1beta1`) for the faster reconcile/claim + hardening.
