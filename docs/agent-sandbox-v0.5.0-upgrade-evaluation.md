# agent-sandbox v0.5.0 — Upgrade Evaluation

**Status:** EVALUATION / RECOMMENDATION (no code or cluster changes made). Assesses
[kubernetes-sigs/agent-sandbox **v0.5.0**](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v0.5.0)
against our current usage (controller **v0.4.5 / v1alpha1**): which features can replace our custom logic,
offer alternate methods, or improve performance/reliability — and what an upgrade costs.

**Bottom line:** Upgrade is worth doing, **primarily for the security + reliability + controller-perf
hardening** (and faster warm-pool ops), **not** to replace our custom logic — our Lifecycle Controller,
pause/resume, dispatch, and admission are **Dapr-coupled and stay ours**. The only hard code dependency is
`spec.replicas` → `spec.operatingMode`. v0.5.0 does **not** fix our two open infra problems (the warm-pool
Dapr-app-id blocker, slow builds). Recommended path: a **staged ryzen-canary → dev** upgrade (mirroring the
Dapr-1.18 rollout), gated on one key risk — the new controller's `isAdoptable`/reject-unowned behavior
versus our directly-created Sandbox CRs.

Related: `dapr-agent-py-sandbox-architecture.md`, `sandbox-warm-pools.md`,
`session-resource-metrics-and-kueue-admission.md`, `workflow-lifecycle-termination.md`.

---

## 1. What we use today (grounded in code)

- **Sandbox CRs constructed directly** in `services/sandbox-execution-api/src/app.py`
  (`build_agent_workflow_host_sandbox_manifest`): `apiVersion: agents.x-k8s.io/v1alpha1` (`@1709`),
  **`spec.replicas: 1`** (`@1695`), a fully **inlined `podTemplate`**, and **already**
  `spec.shutdownPolicy:Delete` + `spec.shutdownTime` (`@1706-1707`) for self-reaping.
- **No `SandboxClaim` / `SandboxTemplate` / `SandboxWarmPool`** used by sandbox-execution-api — the pod
  template is inlined per session. A **browser-use `SandboxWarmPool` builder** exists
  (`src/lib/server/agents/sandbox-warmpool-builder.ts`, emits `extensions.agents.x-k8s.io/v1alpha1`,
  scale-to-zero `replicas`), and two `SandboxTemplate` CRs (`dapr-agent`, `workflow-builder-dev`) live in
  stacks — but **0 static `SandboxWarmPool` CRs** are instantiated.
- **Volumes = manually-created PVCs + ownerRef** (per-session transcript, per-execution shared-workspace)
  plus `emptyDir` (localScratchMounts, `/sandbox`) — **not** `volumeClaimTemplates`
  (`app.py:1485-1570`; PVCs provisioned `@1044/1859`; ownerRef bound `@2194`).
- **Custom owner-adoption**: `OWNER_RUN_ID_ANNOTATION` + a 409 adopt-or-recreate flow
  (`app.py:1147-1178`, `2141-2162`); the existence check reads `…/v1alpha1` (`@1160`).
- **Lifecycle Controller** (`src/lib/server/lifecycle/*`): stop/terminate/purge, cross-app Dapr
  fan-out, **cross-app wedge-finalize**, boundary-anchored state-row purge, terminal confirmation/finalization —
  **deeply Dapr-coupled** (`call_child_workflow` placement, per-session app-id).
- **Pause/resume** (`lifecycle/pause.ts`): Dapr `suspend_workflow`, reached via **pod-IP:8002** (per-session
  Kueue pods are not Dapr-service-invokable). **Workflow-level** — the pod stays alive and reachable.
- **Deploy** (stacks): controller in ns `agent-sandbox` (ArgoCD, image hard-pinned, v0.4.5); **no
  `sandbox-router`** deployed; pods reached via Dapr app-id / pod-IP, not the router.

---

## 2. Feature-by-feature verdict

| v0.5.0 change | Verdict | Why (for us) |
|---|---|---|
| Security + reliability hardening — router bearer-auth + input validation; **SSRF redirect-disable** in Go/Python SDKs; NetworkPolicy IPv6-block + namespace scoping; **pod-metadata override protection**; **warm-pool poisoning prevention**; ReDoS fix; build-injection sanitization; trace `sandbox.command` sanitization | **ADOPT** | Free with the controller upgrade; strictly improves security/reliability of the runtime we already run. Primary reason to upgrade. |
| **`SandboxClaim` status `.Patch()`** (fewer conflicts at scale) + **fixed orphan adoption** + **parallel warm-pool create/delete** + **smart warm-pool selection** (ready-first, node-spread, in-memory) | **ADOPT** | Controller-side perf/correctness; directly speeds our browser-use warm-pool scale ops. Free with the upgrade. |
| **`operatingMode: Running/Suspended`** (replaces `spec.replicas`) | **MIGRATE (required) + future** | We set `spec.replicas:1` → must become `operatingMode:"Running"`. The *Suspended* mode is a NEW pod-suspend capability (beyond our workflow-level pause) — **defer** (see §4): the pod's daprd owns the workflow, so suspending the pod risks wedging the run. |
| `volumeClaimTemplates` in `SandboxClaim` (policy-merged per-session PVCs) | **SKIP** | Only available via `SandboxClaim`, which we don't use. Our manual PVC-create + ownerRef flow works; switching is a large sandbox-execution-api refactor for marginal benefit. |
| Python **Snapshot SDK** (restore-from-snapshot, timestamp filter; gVisor) | **SKIP** | gVisor-gated + same-instance (non-portable). We use PVC-rebind for resume + git bundles for versioning. Doesn't fit. |
| Go client **PodIP routing** (DNS-less); SDK **dynamic timeout propagation**; AsyncClient `cleanup=True` | **N/A** | We don't use the upstream SDKs/router — we dispatch via Dapr (app-id placement) and reach pods by pod-IP ourselves. No adoption needed. |
| **`SandboxClaim.warmpoolRef`** required; `templateRef`/`warmpool` policy removed; `replicas:0` for cold start | **N/A** | We don't use `SandboxClaim`. |
| `v1alpha1` → **`v1beta1`** graduation (+ conversion webhook) | **MIGRATE (required)** | Move our apiVersion strings; the conversion webhook eases the transition. |
| `sandbox-router` → `agent-sandbox-system` ns + NetworkPolicy scoping | **CONFIRM** | We deploy no router — likely N/A; must confirm v0.5.0's `manifest.yaml` doesn't force a router/NetworkPolicy that blocks our pod-IP:8002 / Dapr paths. |

### Keep custom — v0.5.0 cannot replace (all Dapr-coupled / out of upstream scope)
The **Lifecycle Controller** (cross-app cascade, wedge-finalize, state-row purge), **terminal finalization**,
**per-session deterministic app-id + dispatch**, **pause/resume** (workflow-level), and **PSI/Kueue
admission** all depend on Dapr placement/task-hubs, which agent-sandbox has no notion of. These remain ours.

### Not fixed by v0.5.0 (still our problems)
- **Warm-pool app-id blocker** (CLI warm pools): claim-bind still needs **per-pod-unique daprd app-ids**
  (a mutating webhook) — v0.5.0's warm-pool work doesn't touch Dapr app-id. The new
  `warmpoolRef`-required / `replicas:0`-for-cold-start is upstream API churn, not a fix for us.
- **Slow builds** (the F2 copy-to-local-build issue) and the **cross-app Dapr wedge** — out of scope upstream.

---

## 3. Required migration work + risks

**Breaking changes that touch us:**
1. **`spec.replicas: 1` → `spec.operatingMode: "Running"`** (`app.py:1695`) — the one hard code dependency.
2. **apiVersion `…/v1alpha1` → `…/v1beta1`** — in `app.py` (Sandbox `@1709`; adoption read `@1160`) and
   `sandbox-warmpool-builder.ts` (SandboxWarmPool/Template). The **conversion webhook** keeps v1alpha1
   working during transition, so these can land just before/with the controller bump.
3. **Owner-adoption vs `isAdoptable`/reject-unowned (KEY RISK):** v0.5.0 hardens the controller to reject
   adopting unowned resources (anti-warm-pool-poisoning). Our Sandbox CRs are **created directly** with our
   `owner-run-id` annotation but **no controller-managed owner** — must verify the v0.5.0 controller does
   **not** garbage-collect or refuse to reconcile them. **Gate the dev rollout on this.**
4. **sandbox-router / NetworkPolicy:** confirm v0.5.0's install manifest doesn't introduce a router or
   default NetworkPolicy that interferes with our pod-IP:8002 / Dapr traffic (we run no router today).

**Deploy mechanics (stacks):** bump
`packages/base/manifests/agent-sandbox/Deployment-agent-sandbox-controller.yaml` image v0.4.5→v0.5.0;
update `packages/base/manifests/agent-sandbox-crds/*` to the v0.5.0 **v1beta1 CRDs + conversion webhook**
(CRDs at sync-wave -100, before the controller at 49); ArgoCD apps `packages/base/apps/agent-sandbox{,-crds}.yaml`.

---

## 4. Recommended staged-upgrade runbook (NOT executed here)

Mirrors the proven Dapr-1.18 **ryzen-canary → dev** rollout.

- **P1 — code prep (low risk, conversion-webhook-safe).** `app.py` `replicas`→`operatingMode` + v1beta1
  apiVersions + adoption-read version; `sandbox-warmpool-builder.ts` → v1beta1; add a unit test asserting
  the emitted manifest shape. Runs fine on the current v0.4.5 controller (webhook converts) until it's bumped.
- **P2 — ryzen canary.** Install v0.5.0 CRDs + conversion webhook + controller on ryzen. **Verify:** our
  existing Sandbox CRs reconcile (no `isAdoptable`/orphan-rejection events); a GAN run dispatches, runs, and
  **self-reaps**; the browser-use warm pool scales; the Lifecycle Controller stop/purge still reaps CRs.
- **P3 — dev rollout.** Promote to dev; re-verify a full GAN run + a browser-use run end-to-end.
- **P4 — (defer) `operatingMode: Suspended` spike.** Only if idle-pod compute cost becomes a priority, and
  only after proving resume + Dapr-workflow reconnect on a suspended pod doesn't wedge the run.

**Rollback:** re-pin controller v0.4.5 + v1alpha1 CRDs (keep both available during the canary).

---

## 5. Recommendation

**Do the upgrade, staged, for the hardening + warm-pool perf** — not to offload our logic. Concretely:
adopt the security/reliability/perf fixes and faster warm-pool ops; make the required `operatingMode` +
v1beta1 changes; **gate on the `isAdoptable` risk** at the ryzen canary; keep the Dapr-coupled
Lifecycle/pause/dispatch/admission stack custom; and treat `operatingMode:Suspended`,
`SandboxClaim`+`volumeClaimTemplates`, and snapshots as out-of-scope (skip/defer). The warm-pool app-id
blocker and slow builds are separate workstreams unaffected by this release.

## 6. Addendum (2026-07-20): upstream volumes docs vs our JuiceFS

Review of https://agent-sandbox.sigs.k8s.io/docs/volumes/ (two guides:
`volume-claim-template`, `gcsfuse-csi`), against the question "is our JuiceFS
the same kind of thing as gcsfuse, and would it work with their
volumeClaimTemplates strategy?"

**Same architectural role, stronger semantics.** gcsfuse CSI and JuiceFS CSI
are both FUSE filesystems over object storage exposed through a CSI driver
and mountable RWX. Differences that matter: gcsfuse is a thin stateless
bucket mapping (weak POSIX: non-atomic rename, slow listings, no separate
metadata tier) and its sidecar injection (`gke-gcsfuse/volumes: "true"` +
Workload Identity) is **GKE-managed — unusable on our Kind/Talos clusters**.
JuiceFS keeps a real metadata engine (our Postgres) with chunked data in
MinIO/S3, giving full POSIX (atomic rename, close-to-open consistency,
cached metadata) cloud-agnostically. So the gcsfuse guide is not a usable
resource for us directly; it *validates* JuiceFS-on-MinIO as the
self-hosted equivalent of the pattern upstream is blessing.

**volumeClaimTemplates compatibility: yes mechanically, no for run
workspaces.** `SandboxTemplate.spec.volumeClaimTemplates` (v1beta1,
StatefulSet-like: per-sandbox PVC `\<claim\>-\<pod\>`, stable across pod
recreation, pre-provisionable in warm pools) provisions via any
StorageClass — a `juicefs` StorageClass with `pathPattern` works fine. But
its key is **per-sandbox**, and our `/sandbox/work` key is
**per-run/workspaceRef**: one workspace shared by multiple sandboxes
(generator+critic), remounted by resume-from-step forks, retained past the
sandbox. volumeClaimTemplates cannot express "mount run X's workspace" —
this is exactly why the v0.5.0 eval kept SEA-created PVCs+ownerRef for
workspaces, and that stands.

**Where it IS worth adopting (post-upgrade, complements §5):**
1. **Per-sandbox durable scratch for pod-local runtimes** (e.g.
   pydantic-ai-agent-py `/sandbox`): a small RWO claim template would make a
   rescheduled/evicted pod resume with its files — reschedule-durability
   without moving the runtime onto shared FS.
2. **Warm-pool dependency-cache volumes**: pre-provisioned PVCs carrying
   baked caches align with the build-state guidance in
   `agent-workspace-build-and-gan-loop-best-practices.md` (block PVC for
   build state, RWX only for sharing — the same position upstream takes).

Both require the v1beta1/v0.5.0 upgrade this doc already recommends; neither
changes the workspace architecture.
