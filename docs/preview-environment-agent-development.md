# Agent Development In A Dev PreviewEnvironment

This is the application inner-loop and promotion contract for an interactive
agent changing multiple workflow-builder microservices inside an isolated dev
vCluster. The cluster ownership and operator procedures live in the stacks
repository:

- `docs/preview-environment-architecture.md`
- `docs/preview-environment-runbook.md`

The goal is a fast live loop without turning disposable pod state into a second
source of truth. GitHub remains authoritative; strict capture and promotion are
explicit boundary transitions.

## Development POC Scope

This first iteration proves the developer experience; it is not a hostile
multi-tenant execution service. Launch remains restricted to authenticated
platform administrators, repositories are fixed to PittampalliOrg, and the
environment persists exact source and platform SHAs. Purpose tokens, namespace
isolation, quota, TTL, and allowlisted `/__run` commands remain required because
they are inexpensive protections for normal development mistakes.

POC acceptance requires one representative five-service session: observe one UI
HMR edit and one backend reload, run focused allowlisted checks, capture one
coherent multi-service generation, replay changed production images in a fresh
environment, and teardown cleanly. It does not require every command for every
service, adversarial fork testing, exhaustive failure injection, a split broker
process, strict GitHub branch protection, or long-duration soak testing. Those
are post-POC hardening and should not delay a usable inner loop.

This guide distinguishes implemented contracts from wet evidence. Commands and
expected results below describe the current implementation; they do not prove a
particular PreviewEnvironment run passed. Record the bounded replay evidence in
the dedicated section below before declaring the POC complete.

## Dev Operations Read Model And Observability

The Dev environments UI is a presentation of existing authoritative state, not
a new control-plane database. Preserve the hexagonal read path:

```text
browser presentation
  -> authorized application read services and ports
  -> physical, tuple-bound adapters
  -> PreviewEnvironment, SEA, workflow-data, and GitOps authorities
```

The browser receives serialized read models only. It must not import server
adapters, query Kubernetes directly, or hold credentials for SEA, Argo CD,
telemetry backends, or preview sidecars. The application boundary applies the
appropriate project, owner, or platform-admin authorization before calling a
port. Physical preview adapters additionally bind each operation to the exact
environment name, request ID, platform SHA, source SHA, and catalog digest.

Current preview lifecycle truth is the latest physical snapshot exposed through
the vCluster preview application service and `VclusterPreviewGatewayPort`
(`listWithCounts`, `get`, `runtimeForIdentity`, and `cleanup`). The application
service constructs the immutable `PreviewControlIdentity`, authorizes the actor,
and calls the tuple-bound observation port; the SEA adapter validates that tuple
before and after its Kubernetes reads, embeds the authoritative preview record,
and returns the same tuple as a receipt. The legacy name-only `runtime` method
remains an adapter-compatibility path and is not used by the browser route.
Durable workflow executions, session provisioning marks,
and sequence-ordered session events are the truth for workflow and agent
progress. SSE notifications may wake the browser and trigger a fresh read, but
they do not replace lifecycle snapshots or the durable event log. Tier-1 service
readiness and HMR evidence remain behind
`DevEnvironmentReadRepository` and the exact execution/service-scoped
`DevPreviewSidecarPort`.

The persistent dev BFF reads physical SEA directly. A preview-deployed BFF
cannot see host `vcluster-*` namespaces, so composition selects the
tuple-leaf `BrokeredVclusterPreviewGateway` observation adapter for `get` and
`runtimeForIdentity`. That adapter sends the preview's derived control leaf and
five-field immutable identity to the physical broker, never the shared broker
token. The broker route authenticates the leaf, calls the physical observation
use case through `PreviewEnvironmentObservationBrokerPort`, applies source
authority policy to the already tuple-fenced record, and returns a strict
receipt. This is one SEA operation rather than several serial status reads. HTTP
capability checks and physical SEA access remain adapters. The outbound adapter
selects and validates every domain field before returning through the port; raw
Kubernetes fields cannot cross into the application or browser.

The inbound SvelteKit routes obtain use cases through
`getApplicationAdapters()`; they must not construct concrete adapters. The
application composition root injects the access policy, deployment-scope
policy, and outbound gateways. A BFF without a preview deployment identity is
the canonical control plane. Preview deployments receive that identity through
`PREVIEW_ENVIRONMENT_ID` on the reconciled path or the runner-staged canonical
`PREVIEW_ENVIRONMENT_NAME` contract. Either form server-scopes the BFF to its
exact preview name: it may read that preview and access its own product data
through ordinary application use cases, but fleet execution proxying,
pull-request inspection, cross-preview feeds, launch, sleep, wake, and teardown
operations fail closed regardless of the browser user's admin role. This is an
application policy enforced before any physical adapter call, not a UI hiding
rule.

An `app-live` preview, its live-sync mutations, and its captured source bundles
are development evidence, not deployed GitOps state. GitOps Change Journey
begins only when delivery is Git-backed or reconciled: for example, a pinned
manifest-candidate PR, or a promoted source bundle that has become a GitHub PR
and then entered the build, image-pin, Source Hydrator, and GitOps Promoter
lanes. Preview readiness must never be presented as a promoted deployment.

Preview traces use a bounded east-west adapter rather than exposing the host
observability stack. The physical `vcluster-<name>` namespace owns one small
OTLP gateway. vCluster replicates only that gateway Service into the tenant;
Ingress and IngressClass synchronization remain disabled. The gateway overwrites
the complete immutable preview tuple on every resource and exports to the
dedicated physical preview ingest pipeline. That pipeline accepts only gateway
traffic, applies memory and batch limits, and writes traces to ClickHouse through
the existing dev-to-hub Tailscale transport. It has no MLflow receiver, exporter,
secret, or experiment configuration. Tempo is deliberately deferred for this POC
because dev has no local Tempo and no existing bounded hub transport for it.

The tenant receives an OTLP endpoint, not an observability credential. It never
receives ClickHouse or Tempo network access. Browser reads go through
`ApplicationPreviewTraceService` and `PreviewTraceQueryPort`; preview deployments
use the tuple-authenticated HTTP broker adapter, while the physical broker owns
the ClickHouse adapter. Every query authorizes the preview owner or a platform
admin, binds all five tuple attributes, accepts only bounded time/service/status/
search filters, and returns compact trace summaries. Raw SQL, spans, collector
configuration, Kubernetes access, and backend credentials never cross the
application port.

This is intentionally a trace-only POC. Preview log export, arbitrary trace
detail queries, tenant-created collectors, and north-south observability routes
remain out of scope. Ingress syncing would expand the host admission and cleanup
surface without helping OTLP delivery, so it is not a prerequisite for tracing.

| Concern                                      | Source of truth                                                                       | Authorized read path                                                     | POC verification                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle and capacity                       | Physical PreviewEnvironment/SEA snapshot                                              | vCluster preview application service -> `VclusterPreviewGatewayPort`     | Phase, allocation counts, boot time, up-Job state, reconciliation, and service container readiness agree                                       |
| Dev services and HMR                         | Active workflow workspace rows plus brokered sidecar status                           | Workflow-data/dev-environment read port -> `DevPreviewSidecarPort`       | Every selected service is ready; last sync generation advances while pod UID and restart count stay stable                                     |
| Workflow and agent progress                  | Durable execution/session records and ordered session events                          | Authorized `WorkflowDataService` reads and scoped status/SSE routes      | Execution state, provisioning marks, session snapshot, and monotonic event replay agree                                                        |
| Preview identity and access                  | Persisted PreviewEnvironment contract                                                 | Owner/admin policy -> tuple-bound physical broker                        | Name, request ID, owner, platform/source SHAs, and catalog digest match exactly                                                                |
| Source checkpoints and promotion             | Strict local artifact plus append-only physical promotion receipt                     | Preview-session continuation -> tuple-bound promotion broker             | UI artifact, stable draft PR, physical receipt, and exact branch head correlate without exposing GitHub credentials or PR tuple authority      |
| Teardown                                     | Physical cleanup convergence proof                                                    | Preview lifecycle service -> `cleanup` snapshot                          | Terminal result proves all required application, database, stream, namespace, storage, and identity resources absent                           |
| GitOps delivery                              | GitHub commit/PR, immutable image pins, Source Hydrator, Promoter, and live inventory | Existing GitOps application ports -> Change Journey                      | PR/head SHA, image digest, hydrated revision, promotion health, and live deployment correlate without copying preview state                    |
| Preview traces                               | Tuple-stamping physical gateway -> dedicated ingest -> ClickHouse                     | Owner/admin policy -> `PreviewTraceQueryPort` -> physical broker adapter | A generated trace is returned only for the exact name, request ID, platform SHA, source SHA, and catalog digest; another tuple returns no rows |
| Preview logs and arbitrary telemetry queries | No POC authority                                                                      | None                                                                     | No backend credential, raw query language, or ingress sync enters the vCluster                                                                 |

## Preconditions

- Launch an `app-live` PreviewEnvironment on the dev spoke from Workflow
  Builder's `/workspaces/<workspace>/dev` page.
- Record the exact 40-character stacks platform SHA and workflow-builder source
  SHA. A branch name may be resolved at launch, but the persisted environment
  carries only complete SHAs.
- Select only services with `capabilities.previewNative: true` in
  `services/shared/dev-preview-service-catalog.json`.
- Start the host `preview-development-lifecycle` workflow from the physical dev
  Workflow Builder. It provisions the preview, starts the preview-local
  `preview-ui-development-gan` child, and derives the preview origin, source
  SHA, platform SHA, catalog digest, workflow digest, and credentials from
  trusted server state.
- Do not supply an agent slug. The handoff is fixed to
  `glm-juicefs-builder-agent` on `dapr-agent-py-juicefs` with model
  `kimi/kimi-k3`, max reasoning, and a 1,048,576-token context window. The slug
  remains stable for durable-run compatibility; caller-selected agents are
  outside this POC contract.

Current preview-native services:

```bash
jq -r '.services[] | select(.capabilities.previewNative == true) | .service' \
  services/shared/dev-preview-service-catalog.json
pnpm catalog:dev-preview:check
```

The catalog check proves that the executable TypeScript registry, canonical JSON
artifact, and generated stacks mirrors have not diverged. `swebench-coordinator`
remains explicitly host-throwaway only; it is not silently dropped from a
preview-native request.

When this path changes, run only its focused POC regressions before the bounded
wet replay:

```bash
pnpm exec vitest run \
  services/script-evaluator/src/producer-ports.test.ts \
  services/script-evaluator/src/preview-development-lifecycle.test.ts \
  src/lib/server/application/preview-target-development.test.ts \
  src/lib/server/application/adapters/preview-target-development.test.ts \
  src/routes/api/internal/_shared/preview-target-development.test.ts \
  src/routes/api/internal/preview-development/target/preview-target-development-route.test.ts \
  src/lib/server/application/workflow-data.test.ts \
  src/lib/server/action-catalog/preview-development.test.ts
```

## Start The Session

Launch `preview-development-lifecycle` on physical dev with an input shaped like:

```json
{
  "intent": "Enhance the workflow-builder dashboard with useful preview-environment status and workflow progress signals.",
  "services": [
    "workflow-builder"
  ],
  "environmentName": "app-live",
  "ttlHours": 4,
  "retainAfterCompletion": false
}
```

Do not pass `previewOrigin`. The earlier `microservice-dev-session` proof path
required that field because it could be launched directly inside a preview. The
new host-orchestrated path derives the correct origin from the provisioned
PreviewEnvironment tuple and starts the child immediately.

The preview-local child provisions one adopted dev pod per selected service and
uses the preview receiver's `/__export` and `/__sync` capability to mutate only
cataloged source paths. It does not receive GitHub credentials, Kubernetes
credentials, the preview-control token, or a caller-selected origin. The shared
workspace may contain HMR helper metadata such as:

```text
/sandbox/work/.preview-services.json provision results
/sandbox/work/.syncenv.d/<service>  service-to-pod mappings
/sandbox/work/dashboard-gan-contract.json planned dashboard acceptance contract
```

The handoff does not accept an agent override. Before creating a session or its
initial event, the application verifies the exact slug, agent-row runtime,
published-config runtime, and model. It then requires a new per-session workflow
host using the `dapr-agent-py-juicefs` execution class. Provisioning errors and a
null host fail the handoff; it never falls back to a warm pool, persisted runtime
app ID, or caller-selected route.

The Dapr JuiceFS agent uses only the tuple-bound preview runtime egress for model
calls. Provider credentials remain at the physical broker; the preview receives
a purpose-specific runtime capability and inert provider placeholders. No host
CLI subscription credential, GitHub credential, or checkpoint Gitea credential
is delivered to the agent host.

At the start of the persistent agent session, activate the checkout once before
reporting ready:

```bash
/sandbox/work/activate-repo.sh
cd /sandbox/work/repo
git rev-parse HEAD
```

Activation copies the archive once to a private pod-local temporary file,
verifies its digest and exact Git revision, extracts it atomically to
`/tmp/wfb-dev-repo`, and points `/sandbox/work/repo` at that directory. A repeat
activation in the same pod returns `REUSED` and preserves dirty edits. The
archive, digest, activator, generated mappings, and symlink are excluded from
Git status and promotion inputs.

Preview-native multi-service adoption is a staged transaction. SEA first creates
the exact Lease and Sandbox for every selected service. Each staged pod carries
the adopted Service selector except for one holder-derived quarantine value, so
it can become Ready without joining the live primary or generated Dapr Service.
The reconciled Deployments continue serving while the complete staged set is
proved.

The caller then submits one sorted, exact batch. SEA persists its deterministic
identity and `scheduled` phase on the anchor Sandbox before returning HTTP
`202`. The durable workflow repeats the identical request through the router and
BFF, binds every receipt to the exact requested service set and stable batch ID,
and accepts only HTTP `200` with phase `active` before its bounded deadline.
On replay, the BFF reconstructs the complete exact batch from persisted session
records before any SEA write and sends only the same activation request. A
pending retry must not stage or delete a service again. Partial persistence is
retryable; contradictory persistence fails closed.
After the response-path grace, SEA locks and revalidates the whole set, scales
every old Deployment to zero, proves every old primary and Dapr routing surface
empty, releases every selector gate, and requires each active surface to contain
exactly its selected dev pod. Validation or cutover failure quarantines every
new routing surface and restores an old Deployment only where that quarantine
is proved. If any quarantine is uncertain, that Service remains unavailable
with `activation-rollback-incomplete` evidence rather than serving mixed
versions. SEA persists an observable `failed` phase. Pending batches are
redriven after an SEA restart. Single-service preview-native adoption is not a
shortcut; it must use the same batch contract. Do not replace this handshake
with independent per-service timers.

Do not clone the same monorepo once per service. Cross-service edits and shared
contract fixtures must come from the one activated pod-local checkout and one
source revision.

The interactive agent is instructed not to commit or push. Its authority is to
edit the checkout, run the bounded sync/test adapters, and inspect the isolated
application. GitHub writes happen later through the promotion adapter.

## Edit And Sync

Edit any selected service under the one checkout, then run one fan-out:

```bash
cd /sandbox/work/repo
/sandbox/work/sync.sh
```

One invocation first freezes an immutable archive for every selected service,
then sends one logical generation to every receiver with `x-sync-generation` and
`x-sync-service`. UI source reaches Vite HMR; Python and Node backends reload
through their cataloged sidecar/plugin adapter. The client also stages each
service's `extraSync` mappings, including shared contract fixtures.

The live transport is not a distributed transaction. If a POST fails or the
client is interrupted, earlier services may already contain the pending
generation, but `sync.sh` retains the complete archive set and replays that exact
generation on the next invocation. Receivers treat the same generation plus
archive digest as idempotent. Edits made after the pending snapshot are deferred
until recovery completes and a subsequent invocation creates a new generation.
Strict capture rejects the temporary mixed-generation set, and only the final
global `SYNCED ... convergence=healthy` line is a success event; per-service
`APPLIED` lines are receipts, not fan-out completion.

Recovery is bounded by `DEV_SYNC_FANOUT_ATTEMPTS` and the upload timeout settings.
Normally, rerun `sync.sh`. If the saved receiver contract intentionally changed,
`DEV_SYNC_REBASE_PENDING=1 sync.sh` discards the local pending snapshot and
converges the current checkout as a fresh generation.

Check the generated mappings and the last generation when debugging:

```bash
sed -n '1,120p' /sandbox/work/.syncenv.d/*

for cfg in /sandbox/work/.syncenv.d/*; do
  (
    . "$cfg"
    status_url="$(printf '%s' "$SYNCURL" | sed 's#/__sync$#/__status#')"
    curl -fsS ${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$status_url" | jq .
  )
done
```

The sidecar status must show the expected service and generation before strict
capture. For the bounded POC, also record the UI and backend dev pod UIDs and
restart counts before sync. Observe the UI edit and backend response after sync
with those UIDs and restart counts unchanged; a rollout or replacement does not
prove HMR or process reload.

## Dependencies

The catalog defines a `deps` action for each development image. `sync.sh` hashes
Node and Python dependency manifests after every successful sync. The first run
records a baseline; a later manifest change automatically invokes
`POST /__run?cmd=deps` inside the app container.

If the detached source SHA already differs from the dependency manifests baked
into the dev image, run `deps` explicitly once after the first sync:

```bash
SERVICE=workflow-orchestrator
(
  . "/sandbox/work/.syncenv.d/$SERVICE"
  run_url="$(printf '%s' "$SYNCURL" | sed 's#/__sync$#/__run#')"
  curl -fsS -X POST ${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} \
    "$run_url?cmd=deps" | jq .
)
```

Dependency installs run in the app container's pod-local workdir, not in the
agent's pod-local checkout or the shared JuiceFS bridge. The `/__run` API accepts
only names from the catalog; it does not execute caller-provided shell commands.

After syncing a new file under `drizzle/`, apply it to the isolated preview
database explicitly. Hot sync updates the filesystem but does not rerun the
pod's startup migration:

```bash
SERVICE=workflow-builder
(
  . "/sandbox/work/.syncenv.d/$SERVICE"
  run_url="$(printf '%s' "$SYNCURL" | sed 's#/__sync$#/__run#')"
  curl -fsS -X POST ${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} \
    "$run_url?cmd=migrate" | jq .
)
```

`migrate` is allowlisted as `node scripts/db-migrate-runtime.mjs`. It uses the
preview pod's `DATABASE_URL`, Drizzle's migration ledger, and a session advisory
lock, so retries and concurrent agents converge on the same preview schema.

## Tests And System Inspection

Run the smallest cataloged checks after each coherent edit. For example:

```bash
# List the allowlisted commands for the selected services.
jq -r '
  .services[] |
  select(.capabilities.previewNative == true) |
  .service as $service |
  .development.testCommands |
  to_entries[] |
  [$service, .key, .value] | @tsv
' services/shared/dev-preview-service-catalog.json

# Run one allowlisted check in its live app container.
SERVICE=workflow-builder
COMMAND=check
(
  . "/sandbox/work/.syncenv.d/$SERVICE"
  run_url="$(printf '%s' "$SYNCURL" | sed 's#/__sync$#/__run#')"
  curl -fsS -X POST ${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} \
    "$run_url?cmd=$COMMAND" | jq .
)
```

For a workflow-data boundary change, edit the shared fixtures under
`services/shared/workflow-data-contract/fixtures`, sync the whole service set,
and run `cmd=contract` for both `workflow-builder` and
`workflow-orchestrator`. Both sides must replay the same fixtures successfully.

Unit checks are necessary but not sufficient. Open the PreviewEnvironment URL
and exercise the actual cross-service behavior. Inspect UI state, the affected
API path, Dapr workflow completion, and any agent path changed by the feature.
The persistent dev application is not a valid substitute for this isolated
system check.

## Bounded Wet Proof Record

This sanitized record captures the completed dev replay. It records public
commit and image identities plus bounded outcomes, but no tokens, cookies,
kubeconfigs, archive contents, private receipt payloads, or other credentials.

```text
overall POC status: passed
app-live preview name / request ID: app-live-490e-0713a / 6b620de7-f8f2-4d2e-8c93-6a650b201b5e
platform SHA / source SHA / catalog digest: 5e14cb3b1adbc5fbf713cd29c1914f8e89fcb3d0 / 490e4177ffb892885e62d01bcd1d009ff447be25 / sha256:d3da1060e818849faa04b68df115ac9a9a2cd42afcf5ec7d5a225a7fc7cdc329
five selected services: function-router, mcp-gateway, workflow-builder, workflow-mcp-server, workflow-orchestrator
execution / session: bZGjoJ8ghABCWyWc-fQO3 / ahFmtkl4GUP7AnlPyv4mb
agent-host pod / vCluster pod UID / host mirror UID: agent-host-agent-session-7575fa13e5f91a910084 / 44d3455e-5b97-4708-97d0-6d00f9e5b204 / 4a3def59-fb20-48ff-a57d-a39ed2b37110
agent slug / runtime / model: dapr-juicefs-dev-agent / dapr-agent-py-juicefs / deepseek-v4-pro
activation result and exact checkout SHA: ACTIVATED, then REUSED in the same session / 490e4177ffb892885e62d01bcd1d009ff447be25
UI pod UID + restarts before/after / observed HMR result: b78863c1-2c18-439e-9884-39fb19580b81 / 0 -> 0 / authenticated preview page showed "Preview live-sync 490e"
backend pod UID + restarts before/after / observed reload result: a0abbe9b-a24f-4e7a-8971-5a9357608594 / 0 -> 0 / workflow-orchestrator /healthz returned previewLiveSync="490e" after in-process reload
one shared sync generation across all five services: 57836a11-fefa-4608-8467-4f37a2b8861b; every receiver reported the same generation
allowlisted tests: workflow-builder contract exit 0 (23/23 corresponding exact-source tests); workflow-orchestrator contract exit 0 (42/42 corresponding exact-source tests)
strict capture artifact / capture ID / coherence: 36b35db77d93e80b9a7d200b / d2ff0f29-eb44-48dd-98cb-97fa784b5bc4 / atomic-generation-v2, acceptanceEligible=true, five services at generation 57836a11-fefa-4608-8467-4f37a2b8861b
authoritative promotion: workflow-builder PR 546; base 490e4177ffb892885e62d01bcd1d009ff447be25; head 798927e9e39109d514adce4d5987f65f3e529b94; affected services workflow-builder and workflow-orchestrator
non-authoritative promotion drafts: workflow-builder PRs 544 and 545 remained open drafts and supplied no acceptance authority
immutable acceptance receipt digest: sha256:e9d7d084174a430577ccd3f145152db950ba72ca9ad835be6ff45b2150e2b461
immutable production images: workflow-builder@sha256:dd57f63a09ee4a08b5a046e20e08b60ec6274652df6f29ecfc8f293e65a6cea8; workflow-orchestrator@sha256:79136ef5edaf595b7bad14b6b2bf70023cd6e2cf779fdf4d8a51b1fedd390a6b
immutable acceptance preview: accept-pr546-798927e9e391 passed BFF health, data-plane workflow, and agent workflow smoke paths; typed cleanup passed all 12 absence checks
manifest candidate: stacks draft PR 4009 at b04d86d443ce1e99a7a71143e8f9bd6134ab46db changed only packages/components/workloads/function-router/manifests/Deployment-function-router.yaml
manifest candidate reconciliation: manifest-candidate-overlay was Synced/Healthy and the isolated function-router carried preview.stacks.io/manifest-candidate-proof=function-router-20260711; persistent dev had no candidate annotation and remained unchanged
manifest candidate disposition: typed teardown completed and PR 4009 remained draft and unmerged
app-live archive and teardown: archive completed; typed teardown left the PreviewEnvironment CR, physical namespace, hub namespace and Application, mapping, certificate, storage scope, and operation Lease absent
teardown receipt retention: the controller's down Job remains as a bounded receipt; it is not an active preview and holds no operation Lease
DELETE retry observation: the first client timed out after initiating teardown; a later retry returned 403 after physical cleanup removed the authoritative owner, so terminal absence proof was required
post-POC DELETE hardening: retain a terminal outcome lookup so an idempotent retry can return the completed result after owner removal instead of 403
legacy phase 2: completed on attempt 4 with 3 prior attempt-history records, 5 logical-subpath absence proofs, temporaryResourcesAbsent=true, and verified receipt/checksum manifests
final gate: the zero-preview live validator passed; persistent dev remained Synced/Healthy and its authenticated route returned the expected HTTP 302 reachability response
```

The bounded run met the acceptance contract: unchanged UI and backend pod
identities proved the live loop, one coherent generation supplied selective
build inputs, a fresh environment replayed immutable production digests without
`/__sync` state, and typed teardown proved both test environments absent. The
DELETE timeout and post-cleanup `403` are a retry-observability defect to address
after the POC; they do not replace the required terminal absence scan.

## Rebuild Development Images

Live sync is the default loop for source-only changes. When an edit changes a
development Dockerfile or another image-baked dependency, invoke the bounded
`dev/preview-build` action instead of asking the agent to run Docker or Tekton:

```yaml
call: dev/preview-build
with:
  services:
    - function-router
  origin: https://wfb-<preview>.<tailnet-suffix>
  adopt: true
```

`adopt` is required and explicit. Use `true` only when the selected set excludes
`workflow-builder`, so the interactive preview URL can move to rebuilt peer
services without terminating the BFF coordinating the operation. A request that
combines `adopt: true` with `workflow-builder` fails before capture or build.
For an image-baked `workflow-builder` change, use `adopt: false`, inspect the
direct sandbox result, then promote and run a fresh immutable acceptance replay.
Source-only UI and backend changes should stay on the live-sync/HMR path above.

The request cannot choose a repository, branch, source revision, image,
Dockerfile, build context, kubeconfig, or host mode. The application service:

1. captures one strict atomic generation for the selected preview-native
   service set;
2. validates it with the same acceptance trust boundary;
3. materializes the bundle on a server-owned GitHub branch without opening a PR
   or issuing an acceptance attestation;
4. verifies the branch direct parent is the captured baseline SHA, records the
   PR base separately, and derives the affected-service closure from the exact
   changed paths;
5. submits one `preview-development-build` PipelineRun per affected service
   using the catalog's `development.build` tuple and exact candidate SHA;
6. uses a service-specific preview-only registry cache and returns the immutable
   GHCR digest; the dedicated builder clones the public repository without a
   token and removes `.git` before evaluating the candidate Dockerfile;
7. only after the entire affected build batch succeeds, atomically replaces
   that affected subset in `preview-native` mode, rolling back a partial
   replacement and preserving per-service failure truth in the response.

Both production and development Dockerfiles are cataloged as `captureOnly`
inputs. `sync.sh` stages them below `.preview-capture/` in the dev pod, so strict
capture maps an edit back to its real repository path while the running process
never hot-applies the Dockerfile itself. Package/native manifests remain normal
cataloged sync inputs so dependency actions and the eventual image build see the
same generation.

The BFF talks to hub Tekton only through the
`PREVIEW_DEVELOPMENT_HUB_KUBECONFIG{,_PATH,_CONTENT,_YAML,_CONTEXT}` credential
profile. That profile has no fallback to the broad hub or acceptance builder
credential. A branch from this loop is still disposable evidence; use the PR
promotion and clean acceptance paths below for durable review.

Hub PreviewEnvironment desired state uses a separate
`PREVIEW_ENVIRONMENT_HUB_KUBECONFIG{,_PATH,_CONTENT,_YAML,_CONTEXT}` profile on
the physical preview-control broker. Its RBAC is limited to PreviewEnvironment
CRUD in `preview-system`. The persistent BFF never receives that credential;
guarded teardown crosses the broker API. The CR finalizer persists a deletion
intent; the dev broker proves SEA cleanup and acknowledges it before the hub
controller removes hub resources or releases that finalizer.

PipelineRun names are deterministic only for idempotency. On an API create
conflict the Tekton adapter reads the existing object and requires exact
canonical API version, kind, name, namespace, labels, annotations, and spec
before adopting its Kubernetes UID. Result-bearing TaskRuns are used only when
their controller owner reference names that PipelineRun and carries the exact
UID; PipelineRun results remain authoritative when both surfaces report a key.
This prevents a pre-created name or forged `tekton.dev/pipelineRun` label from
selecting a different build or image digest.

## Infrastructure Candidates

Infrastructure testing starts from an open `PittampalliOrg/stacks` pull request
number. The preview-control broker, not the browser or agent, reads the complete
changed-file set from GitHub and pins the exact head SHA. Its mounted path policy
then selects one substrate:

| Profile                                  | Substrate                                                          | Authority                                                          |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `manifest-candidate`, lane `application` | restricted reconciled vCluster on dev                              | broker may launch automatically                                    |
| `manifest-candidate`, lane `management`  | restricted reconciled vCluster on `admin@dev` with a 1-24 hour TTL | operator runs `deployment/scripts/preview-management-candidate.sh` |
| `host-candidate`                         | exclusive physical dev cluster lease                               | operator runs `deployment/scripts/preview-host-candidate.sh`       |

This POC wet-tests only the `manifest-candidate` application lane. Management
and host candidates receive static/dry-run validation now; their full wet
cycles are post-POC hardening.

The management candidate fetches a read-only exact-SHA bundle from GitHub and
stages it through an ephemeral TLS Gitea instance for isolated Argo
reconciliation. That Gitea is a disposable fixture data plane, not a source of
truth, an agent write target, or a replacement for GitHub and GitOps Promoter.
It exists only in the management candidate and is deleted with that environment.

Management and host requests return a typed operator action; the persistent BFF
never receives the admin kubeconfig, cloud/Talos credentials, or Gitea bootstrap
credentials. Mixed, unmapped, oversized, or stale PR paths fail before any
cluster mutation.

All PreviewEnvironment allocations are cold. The retired profiled vCluster warm
pool could not prove the exact platform/source/catalog/service tuple and is not
an admissible shortcut. This does not affect agent-runtime `SandboxWarmPool`
resources, which are a separate execution concern.

Preview storage is dynamically provisioned through a host-created StorageClass
named `preview-jfs-<scope-id>`. Its JuiceFS `pathPattern` is fixed to the
tuple-derived `previews/v1/<scope-id>` prefix. The vCluster receives neither the
storage capability nor the JuiceFS Secret; SEA creates only deterministic
transcript/workspace PVCs against that class and cannot mount the filesystem
root. Teardown is not complete until `storage-scope-absent` is proven.

## Strict Atomic Capture

The primary operator path is the **Code versions** panel on the dev-environment
detail page. After all selected services report one generation and their tests
pass, choose **Capture checkpoint**. The UI submits the complete service set to
the preview-session continuation boundary; the application derives execution,
project, preview identity, platform revision, source revision, and catalog
digest. A partial or mixed-generation response is displayed as a failed capture
and does not create an acceptance-eligible checkpoint.

Internal dynamic workflows may invoke the compatibility action
`dev/preview-snapshot`. It applies the same strict-capture rules and remains
useful for workflow automation, but it is not the product UI boundary:

```yaml
call: dev/preview-snapshot
with:
  nodeId: dev-preview
  iteration: 1
  services:
    - workflow-builder
    - workflow-orchestrator
    - function-router
    - mcp-gateway
    - workflow-mcp-server
```

The caller supplies the expected service set, not trust metadata. Function-router
derives execution authority from the trusted `db_execution_id` activity envelope;
never add `executionId` to a `dev/preview*` action's `with` block. The BFF derives
the platform SHA, source SHA, and catalog digest from the persisted preview
session and environment. The route always requests immutable provenance.

A successful strict artifact is a version 2 `tar-overlay-set` containing:

- one capture ID and timestamp;
- one sync generation shared by every service;
- exact platform and source SHAs;
- the canonical catalog digest;
- repository/base metadata;
- cataloged capture mappings per service;
- a SHA-256 content digest and compressed overlay per service;
- `captureProtocol: atomic-generation-v2` and `acceptanceEligible: true`.

Treat `missing_expected_services`, `incomplete_export_set`,
`generation_mismatch`, `missing_sync_generation`, revision failures, and
`catalog_digest_mismatch` as hard failures. Do not fall back to a legacy v1
capture for acceptance.

Capture each meaningful iteration if an agent is evaluating alternatives. The
operator can then promote the chosen checkpoint rather than reading whatever
happens to be live later. Capture persists a source artifact; it does not by
itself create a GitHub branch or pull request.

## Promote Through GitHub

Choose **Promote** on the selected strict checkpoint in **Code versions**. A
strict `atomic-generation-v2` artifact is promotable only through the
preview-session continuation port. The generic
`/versions/<artifactId>/promote` route remains available for legacy,
non-preview source bundles and must not be used to bypass preview identity and
source-authority checks.

The UI sends the preview-local artifact ID, an optional title/body, and
`draft: true`. The preview transfers that exact artifact to physical control;
the browser and preview never choose the repository, base, branch, or GitHub
credential. Internal workflows may still invoke `dev/preview-promote` as a
compatibility path:

```yaml
call: dev/preview-promote
with:
  iteration: best
  bestIteration: 1
  services:
    - workflow-builder
    - workflow-orchestrator
    - function-router
    - mcp-gateway
    - workflow-mcp-server
  draft: true
  title: Cross-service preview feature
```

The preview first transfers the strict artifact to the physical control plane
under its tuple capability. The physical promotion broker re-authorizes the
current preview generation, applies the captured mappings into one GitHub
checkout, verifies that the promoted commit is parented by the preview's
immutable captured `sourceRevision`, and opens a PR. Repository, target branch,
branch prefix, and GitHub credentials are broker-owned and are not accepted from
the workflow or browser. The live target branch may advance while the preview
is active; that does not change the captured ancestry proof. Capture coherence
covers all five services, but the broker derives the affected set from the
actual changed paths. Only those changed production services proceed to
acceptance builds.

One preview execution owns one deterministic branch and one draft pull request.
The first promoted checkpoint creates them. A later checkpoint for the same
preview execution updates that branch and the existing draft PR, using the
latest verified receipt head as a Git lease. The runner pushes with
`--force-with-lease`; an unexpected branch or PR head fails closed instead of
overwriting concurrent work. Promotion of the same artifact is an idempotent
receipt replay.

Moving the pull request out of draft is the manual freeze boundary for the
session branch. Do that only after the final checkpoint and acceptance run are
complete. The broker checks the live PR identity and draft state immediately
before every leased push and verifies them again afterward; once the PR is
ready for review, later checkpoint promotion fails closed. This POC does not
try to coordinate a concurrent GitHub ready-for-review click with a distributed
lock, so operators should not change draft state while a promotion is running.

Every distinct successfully promoted checkpoint creates a new immutable,
append-only physical promotion receipt keyed to its imported artifact. The
receipt binds the preview tuple, execution, repository, base SHA, branch,
commit SHA, draft PR number, services, and changed paths. The preview stores
only a local projection on its source artifact: the opaque receipt ID and
bounded PR details needed to render **Code versions** and continue the session.
The projection carries no GitHub or acceptance authority. Physical control
revalidates its receipt and
the live draft PR before every update or replay.

The receipt keeps two Git revisions with different meanings. `sourceRevision`
is the immutable preview baseline and remains the required parent/ancestry
proof. `baseSha` is the live head of the PR target branch observed when that
exact receipt was issued. An unrelated `main` advance therefore does not
invalidate a stored artifact replay or prevent a later checkpoint from leasing
the same draft PR. The receipt itself remains immutable: acceptance replays the
exact repository, PR number, recorded base SHA, and head SHA. If the PR target
moves after receipt issuance, acceptance fails the exact-tuple freshness check;
promote a newer checkpoint to issue a fresh receipt before running acceptance.

Promotion requires the execution owner to be a platform admin. Never install a
Gitea instance in the preview, point Argo CD at mutable session Git, or push from
the interactive agent. The preview receives neither a GitHub write credential
nor a Git-capable promotion runner. A source bundle is not durable until the
physical broker has materialized it in GitHub.

## Clean Acceptance Replay

Choose **Run acceptance** on the promoted strict checkpoint. The browser sends
only the preview-local artifact ID. The preview-session continuation service
loads that artifact's local promotion projection and sends its opaque receipt
ID, together with server-derived preview identity, to physical control. The
physical receipt resolver recovers the exact repository, PR number, base SHA,
and head SHA from the append-only receipt before invoking the existing immutable
acceptance broker. Neither the browser nor the mutable preview supplies that PR
tuple. The bounded outcome is projected back onto the local artifact for the UI.

The existing workflow action below accepts the exact tuple returned by its own
promotion step. It remains an internal compatibility path for trusted workflow
automation; do not use it for the interactive product flow or add tuple fields
to the preview-session continuation request:

```yaml
call: dev/preview-acceptance
with:
  pullRequest: ${ .promote.pullRequest }
```

On that compatibility path, the acceptance route accepts only the exact PR tuple
returned by source promotion. The physical broker re-resolves the open GitHub
PR, its complete changed-path set, the preview's immutable source baseline and
catalog, and the platform-admin owner. Callers cannot assert a source SHA,
stacks SHA, service set, image, or retention policy.

The application service then:

1. submits one bounded hub `preview-acceptance-build` PipelineRun for each
   catalog-derived affected service;
2. builds the exact source SHA and records the returned GHCR digest;
3. rejects missing, duplicate, extra, cross-revision, or non-immutable images;
4. cold-provisions a fresh `app-live/reconciled` vCluster at the exact stacks
   SHA with the full system baseline and one digest pin per affected service;
5. waits for the controller-owned Argo Application to become ready;
6. verifies `/api/health`, `preview-data-plane-smoke`, and
   `preview-agent-smoke` through product HTTP APIs;
7. tears the acceptance environment down after every launched replay.

Core replay failures return a typed stage: `freshness`, `build`, `capacity`,
`readiness`, `runtime`, `verification`, or `cleanup`. Strict status reporting
adds the separate `reporting` stage described below. A failed cleanup remains
subject to the bounded TTL and lifecycle reaper; it is never treated as retained
acceptance evidence. Acceptance does not update stacks release pins,
environment branches, or GitOps Promoter state.

In the default `PREVIEW_GOVERNANCE_STATUS_MODE=strict`, after GitHub and the
physical PreviewEnvironment authority verify the exact open PR tuple, the
physical broker publishes the `preview/immutable-acceptance` commit-status
context on that PR's full head SHA. It publishes `pending` before submitting
any build and a final `success`, `failure`, or `error` after replay. Failure to
publish the pending status stops the build; failure to publish the final result
makes the broker response fail closed at the `reporting` stage. The mutable
preview BFF never receives the GitHub write credential.

For the admin-only development POC, set
`PREVIEW_GOVERNANCE_STATUS_MODE=poc` on the physical control broker. That mode
omits only immutable-acceptance status publication and aggregate
`preview/gate` reconciliation, so a GitHub status outage cannot convert an
otherwise successful replay into a `reporting` failure. The physical replay,
source authority, receipt attestation, GitHub PR reads, and source-promotion
credentials remain unchanged. `strict` is the default and is the required
mode for post-POC governance.

For post-POC governance, configure repository branch protection to require only
the aggregate `preview/gate`, bound to GitHub App `2970091`. This protection is
not required for the first admin-only development proof. The base-owned reconciler consumes
`preview/immutable-acceptance` and any activation-image evidence as subordinate
contexts; requiring them directly would strand N/A and multi-service PRs. The
older `pr-preview` context proves live preview readiness only and is not a
substitute for immutable-image acceptance.

## Durable Handoff

After acceptance passes:

1. review and merge the workflow-builder GitHub PR;
2. let the ordinary hub outer loop resolve the broker-authored acceptance
   receipt, or rebuild if any proof has changed;
3. observe Source Hydrator and GitOps Promoter advance dev;
4. verify the persistent dev deployment and exact live image;
5. tear down any retained PreviewEnvironment and close the interactive session.

Dev-session teardown first establishes an execution-wide intent in SEA, then
unions the product rows with SEA's live Sandbox inventory. Provisioning persists
its product row before its final intent confirmation, so teardown either sees
the row or the late provision observes the intent and compensates. Inventory,
database drop, durable-run stop, or orphan-restore uncertainty is a failed or
pending teardown, never success.

Before the first active product teardown, the application reads the complete
requested service set from the scoped workflow execution's stored, post-default
trigger input. The current active product rows must match that set exactly;
partial, duplicate, malformed, or unexpected services fail closed before any
receiver changes state. The application also verifies platform-administrator
authority before establishing teardown intent or pausing a receiver. The route
only authenticates and delegates this policy through the teardown application
port.

The preview provisioner first establishes the SEA execution-wide intent, then
uses the receiver-only capability to run a two-phase barrier across the exact
service set. `POST /__freeze?phase=prepare` persistently and reversibly pauses
source writes. Only after every receiver reports the same generation does
`phase=commit` atomically persist its one-way `frozen` state. A busy receiver or
generation mismatch causes `phase=abort` on every prepared peer, so a partial
sync can be rerun instead of becoming a permanent mixed freeze. The operation
ID is deterministic per execution; a lost response or partial commit replays
the same operation until all services converge. Agent-action credentials cannot
prepare, commit, or abort the receiver fence. Sync and allowlisted run commands
return `409` while prepared or frozen; status and export remain readable for
checkpoint recovery. Receiver state survives process restarts.

The server then resolves one strict capture through the same preview-session
continuation port. The artifact must match the frozen generation, exact service
set, and current preview-control identity. Its per-service export digests remain
independent artifact-integrity proofs: they intentionally differ from the freeze
receipts, which hash the last sync uploads rather than newly materialized export
archives. When the latest strict artifact matches the frozen generation and
service set and carries a valid promotion projection, teardown reuses it instead
of exporting and capturing the same frozen source again. Otherwise it performs
a normal strict capture.

In both cases the server invokes the idempotent physical promotion continuation,
revalidating the append-only receipt and live draft PR before cleanup. The
physical artifact store binds the complete import identity, source snapshot, and
file digest; mutable local `promotion`, `acceptance`, and `teardownCheckpoint`
metadata are projections over that capture and are excluded from its physical
content identity. Only after the preview-local artifact carries the broker
receipt does the server atomically merge a version 2 teardown marker bound to
the freeze receipts, artifact, central artifact, repository, PR, branch, and
head SHA.

Freeze, capture, promotion, or marker failure returns HTTP `409`; preview
resource deletion and durable-run cleanup are not invoked. A failure after
freeze intentionally leaves the environment read-only: retry teardown to reuse
the frozen export and stable draft PR, or use **Discard changes and tear down**.
The server accepts that override only from a platform administrator. Once
destructive cleanup starts, retries may observe only a subset of active product
rows. They validate the stored marker against its artifact, promotion, frozen
generation, service digests, and the original execution service contract, then
resume without requiring receivers that have already been deleted. A cleaned-row
tombstone remains the final idempotent resume proof after no active rows remain.

For the BFF and function-router, the first product
`DELETE /api/dev-environments/<executionId>` may return HTTP `202` with
`pending: true`; this proves SEA accepted cleanup before removing the pods
carrying that response. Retry the same idempotent DELETE until it returns HTTP
`200` with `complete: true`, then require the final PreviewEnvironment and orphan
scans before considering teardown complete.

The preview proves a candidate. The promoted dev lane proves the durable system.
The two lanes can use the same image bytes without giving acceptance GitOps
write authority: the broker stores an HMAC-attested receipt before terminal
success, and post-merge preflight requires GitHub main ancestry, equal accepted
head and merge trees, the same catalog-derived path subjects, a valid receipt
MAC, and unchanged GHCR tag/digest resolution. Any missing or invalid proof
selects a normal build. The release-pin commit remains the sole handoff to
Source Hydrator and GitOps Promoter.

## Trust And Ownership Boundaries

- User-facing PreviewEnvironment launch/list operations require a platform
  admin. Internal workflow actions require the internal token.
- The dev-session handoff fixes and verifies one agent slug, row runtime,
  published-config runtime, and model before session side effects. It requires a
  per-session JuiceFS host and does not take the generic runtime fallback.
- Model traffic leaves the vCluster only through tuple-bound runtime egress.
  Provider, CLI subscription, GitHub, and checkpoint Gitea credentials are not
  delivered to the interactive agent host.
- Promotion and acceptance additionally verify that the execution owner is a
  platform admin.
- Repositories, owner identity, request provenance, trust, timestamps, and
  strict capture revisions are derived server-side. Agents cannot self-attest
  them in the snapshot request.
- The service catalog is the allowlist for source paths, extra mappings,
  capture-only build inputs, dependency commands, tests, adoption targets,
  development builds, and acceptance builds.
- `/__sync` and `/__run` operate only inside selected preview dev pods. They do
  not grant Kubernetes, Argo CD, Tekton, or host-cluster authority.
- The BFF never receives the cloud/Talos credentials used for host candidates.
  Host-level infrastructure work remains an operator action in the stacks
  runbook.
- The development POC runs one SEA replica. Its teardown-intent fence and
  per-Deployment transition locks are process-local; durable multi-replica
  coordination is required before treating this as an HA control plane.
- Selector quarantine prevents staged pods from receiving Service traffic, but
  a Dapr-enabled staged pod still registers its production app ID with Placement.
  A per-batch Dapr identity or delayed sidecar registration is post-POC isolation
  hardening. Keep the POC to one isolated, idle vCluster during cutover.
- Repository activation is prompt-driven when the persistent host starts.
  Automatic activation after a pod reschedule and generic CLI finalizers that
  follow the pod-local repo symlink are post-POC work; receiver-owned strict
  capture remains authoritative in this iteration.
- GitHub is the handoff between ephemeral source and durable review. GitOps is
  the handoff between reviewed source and shared environments.

These boundaries preserve the hexagonal architecture: workflow/application
services express policy through ports, while GitHub, SEA, sidecar sync, Tekton,
HTTP verification, and Kubernetes remain adapters.
