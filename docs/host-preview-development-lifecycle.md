# Host-Orchestrated Preview Development Lifecycle

## Status

Implementation is proved on the dev cluster. The current accepted proof is
`app-live-gan-proof26`: a physical dev workflow provisioned a fresh `app-live`
preview, started the preview-local GAN UI-development workflow, used GLM 5.2 to
edit the Workflow Builder dashboard through HMR/live sync, captured the exact
source, opened a draft PR, and completed generation-fenced teardown. The
pointer-only stacks change that advances the `dev-preview-platform` Application
to a revision containing the down-job TTL admission compatibility fix has also
merged and reconciled on dev.

### Checkpoints

- [x] Confirm the live host and preview-local boundaries.
- [x] Freeze the parent/child command contract.
- [x] Implement the preview-local child control and promotion path.
- [x] Implement the exact-tuple host-to-preview command adapter.
- [x] Implement the host lifecycle workflow and launch UI.
- [x] Require a physical durable promotion receipt before successful completion.
- [x] Replace the manual interactive-session handoff with the automated
      preview UI development GAN workflow.
- [x] Pass repository and rendered-manifest validation.
- [x] Deploy the helper-cleanup checkpoint through GitHub, GHCR, and GitOps to
      dev.
- [x] Re-prove prompt to HMR to draft PR to teardown on a fresh preview after
      the helper-cleanup checkpoint is live.
- [x] Advance the dev `dev-preview-platform` Application pointer to the stacks
      revision containing the down-job TTL admission compatibility fix and
      verify ArgoCD converges on dev.

## Objective

A user submits one task from the physical dev Workflow Builder. One durable host
workflow provisions an isolated `app-live` PreviewEnvironment, starts the pinned
`preview-ui-development-gan` workflow inside it, and waits for that child to
finish. The child runs `zai/glm-5.2` through `dapr-agent-py-juicefs`, receives
the submitted task as its first work item, plans a dashboard change, applies it
through the existing HMR receiver, verifies the live preview, captures the strict
source generation, and opens an idempotent draft pull request. The happy path
does not pause for manual approval. Discard/cancel remains available as an
operator control, but approval is no longer required to create the proof PR. The
host run then verifies the physical promotion receipt and performs
generation-fenced teardown unless the launch requested retention.

## Orchestration Boundary

This is one logical lifecycle implemented by two durable executions:

1. `preview-development-lifecycle` is stored and run on the physical dev cluster.
   It owns provisioning, correlation, approval, receipt reconciliation, and
   whole-environment teardown.
2. `preview-ui-development-gan` is stored and run inside the target vCluster. It
   owns service adoption, the shared HMR workspace, the GLM plan/generate/verify
   loop, strict source capture, and PR promotion.

The executions are not related with Dapr `call_child_workflow`. The physical dev
cluster and every vCluster have separate workflow state stores and task hubs. A
narrow application port treats the preview-local execution as a remote durable
resource and exposes only start, status, and typed signal commands.

The child is not the trust authority for promotion. After the child reports a
submission receipt ID, the parent invokes a physical-only verification command.
The physical broker reauthorizes the exact generation and owner, reads the
durable promotion receipt by its complete scope, and requires the receipt's
service set to equal the original host submission. Only that canonical proof can
move the parent to normal completion.

## User Input

The initial host submission accepts:

- `intent`: required task text for the agent.
- `services`: non-empty subset of the server-owned preview service catalog.
- `environmentName`: a validated preview name.
- `ttlHours`: bounded PreviewEnvironment lifetime.
- `retainAfterCompletion`: whether successful completion skips automatic
  teardown.

The submitted intent is persisted in the host execution input, copied into the
preview-local execution input, and recorded as the initial interactive-session
event. It is appended as delimited task data after the fixed activation, HMR,
testing, and credential-safety instructions. It is never interpolated into a
shell command.

The submission does not accept user IDs, project IDs, execution IDs, origins,
source or platform revisions, workflow digests, arbitrary URLs, repository write
credentials, Kubernetes credentials, or broker credentials. Those values are
derived and checked by application services.

## Exact Target Tuple

Every command after launch is bound to:

```text
parentExecutionId
previewName
environmentRequestId
platformRevision
sourceRevision
catalogDigest
childWorkflowDigest
requestedServices
```

The host derives the actor and project from `parentExecutionId`, repeats the
platform-admin check, and resolves the expected published child workflow digest.
The physical broker checks the immutable PreviewEnvironment identity before
minting a target-scoped command. The preview-local adapter checks its own
deployment identity and published workflow digest before starting or signaling
the child. No caller-supplied URL participates in routing.

## Typed Control

The primary proof path is automatic. The preview-local child captures and
promotes the accepted HMR generation itself, then returns only a bounded receipt
summary to the host. Manual control is still retained for interruption and
cleanup. If a child run reaches an explicit control point, it waits durably on
the fixed event `preview.development.control`. The only accepted payloads are:

```json
{ "action": "submit_preview_pr" }
{ "action": "discard" }
```

The host parent exposes this through its normal durable control surface:

- Approve sends `submit_preview_pr` only for runs that intentionally reached a
  manual control point.
- Deny sends `discard`.
- Cancellation leaves an auditable result and invokes guarded cleanup according
  to the archive policy.

On automatic or manual submission the child runs `dev/preview-snapshot` for the
exact selected service set, then `dev/preview-promote`. Both actions bind their
execution ID from trusted activity context. Promotion remains draft-only and the
GitHub App credential remains in the physical broker.

## Action Contract

The host workflow uses first-class actions rather than public browser routes:

```text
preview/environment-launch
preview/environment-status
preview/workflow-start
preview/workflow-status
preview/workflow-signal
preview/workflow-verify-promotion
preview/environment-teardown
preview/environment-teardown-status
```

Each mutating action has a deterministic operation ID derived from the parent
execution and logical call. Replays return the original receipt. Status actions
are read-only. Teardown requires the accepted generation identity and converges
through the existing signed teardown ticket and cleanup proof.

All eight host lifecycle actions and the six existing `dev/preview*` HMR,
capture, promotion, build, acceptance, and teardown actions require the
purpose-specific `PREVIEW_ACTION_INTERNAL_TOKEN` on function-router ingress.
The workflow orchestrator adds that header only for this fixed slug set, and the
router forwards the same purpose header to the corresponding BFF routes. Those
routes do not accept the broader `INTERNAL_API_TOKEN`. Physical dev and each
preview receive different secrets, and agent sandboxes receive neither action
token.

Transient router or BFF failures remain typed retryable results and execute
inside the existing durable action-runner retry policy. Contract, authorization,
and generation conflicts are permanent results and are not retried. Both proxy
hops have fixed deadlines.

When the child exposes a GLM session, status must resolve at most one session
linked to the child execution. The result includes the preview-local,
workspace-scoped session URL so the host run detail can take the operator
directly to the active GLM session. Duplicate or ambiguous links fail the
contract instead of presenting controls. Normal automated runs may complete
without a manual handoff session URL if all proof artifacts and the physical
promotion receipt are present.

Preview application code is mutable and therefore not a trust authority. The
physical broker reconstructs start, status, signal, session-link, and terminal
receipt responses from an allowlist; unknown fields and raw child output never
cross into the host execution. Leaf HTTP bodies are streamed under a 256 KiB
limit. Candidate-controlled error bodies are discarded and mapped from HTTP
status to fixed messages before crossing the physical boundary.

## Hexagonal Ownership

- Presentation adapters parse browser or function-router envelopes only.
- The application layer validates identity, authorization, state transitions,
  and exact tuple consistency.
- Existing PreviewEnvironment launch, observation, archive, promotion, and
  teardown ports remain authoritative.
- A new preview-target development port owns only remote workflow start, status,
  typed signal, and physical promotion verification.
- HTTP, Dapr, database, Kubernetes, and GitHub details remain outbound adapters.
- Agent pods receive only task text and scoped HMR capabilities.

## Browser And Raystation Access

Browser authority follows the same port-and-adapter boundary as HMR and source
promotion. Workflows ask for a browser inspection of a preview route; they do not
receive a raw Raystation endpoint, host browser credential, kubeconfig, or
Tailscale authority. The application layer resolves the request against the
exact PreviewEnvironment tuple and returns only a scoped browser session handle,
allowed origins, and artifact references.

For the first development version, the default browser path remains the existing
preview-local Playwright/browser action surface plus screenshot or video
artifacts. When a browser agent session must use Raystation on the host, model it
as an outbound browser adapter behind the physical broker:

- the host adapter owns the Raystation connection and any host-only credential;
- the adapter only opens tuple-bound preview URLs or approved external test URLs;
- the workflow receives observations, screenshots, recordings, and a session
  handle, not the host browser control channel;
- the same run/preview/session correlation is persisted so the Dev page can show
  browser state alongside provisioning, HMR, workflow progress, source capture,
  and PR receipt.

This keeps Raystation useful for high-fidelity browser-agent sessions without
turning the host browser into preview input or weakening the preview isolation
contract.

## Delivery Topology

The repository change rebuilds `workflow-builder`, `function-router`,
`workflow-orchestrator`, and `script-evaluator` through the normal GitHub to hub
Tekton to GHCR release-pin path. Physical dev consumes those release pins through
Source Hydrator and GitOps Promoter.

The physical preview-control broker is deployed by the separately pinned
`dev-preview-platform` Application. After all four release pins converge on the
same Workflow Builder source SHA, its exact stacks revision must be advanced in a
pointer-only change. This prevents a fresh preview from pairing a new host BFF
with an older broker contract. A proof preview is created only after the physical
dev workloads and that broker revision are both healthy.

## Proof Contract

Completion requires a fresh dev-cluster run that records one correlated chain:

```text
host execution -> PreviewEnvironment generation -> preview child execution
-> GLM session -> HMR generation -> source artifact -> draft PR receipt
-> teardown ticket -> cleanup proof
```

The proof must show the submitted intent in the child/session provenance, a
visible Workflow Builder UI change served through HMR without replacing the
adopted service pod, the intended source diff in the draft PR, and no remaining
test preview, session, sandbox, or stale ownership resources after cleanup.

## Current Dev Proof

The accepted proof run was submitted from the physical dev Workflow Builder and
used a fresh `app-live` preview named `app-live-gan-proof26`.

```text
hostExecutionId: iXqP79VryvXlDXQtsTpqR
parentWorkflow: preview-development-lifecycle-eb45df2ffdba3cb2dcef
previewName: app-live-gan-proof26
environmentRequestId: 017b3825-1c2e-495e-b628-d91ddd147287
platformRevision: 7b33ab3a0126da5a859a16baf4af07a215fb3404
sourceRevision: bd4dce2e39b69765a28520329cacebb70fecb335
catalogDigest: sha256:22877c5349ccf8ffce018c1df99954cfbbb472ab17bb6fd18434c6e8d78e619d
childExecutionId: pdc_7a6f18e119b02deaa3d82daa40a7326cc68bae19f2b112d34ebdd7b89ec8
childInstanceId: dsw-preview-ui-development-gan-exec-pdc_7a6f18e119b02deaa3d82daa40a7326cc68bae19f2b112d34ebdd7b89ec8
childWorkflowDigest: sha256:35d0108a74a1f45c3ce94e963daffb00e9ad3c526cf368248ba330c7d469c464
agent: glm-juicefs-builder-agent
executionClass: dapr-agent-py-juicefs
model: zai/glm-5.2
```

The host run reached `status=success`, `phase=completed`, `success=true`, and
`promotionVerification.verified=true`. The workflow started immediately from
the host-submitted dashboard-enhancement prompt; it did not wait for manual
instructions or a manual submit approval. The preview-local runtime log
confirmed the requested model path:

```text
[gateway-adapter] llm-glm-5.2 -> model=glm-5.2
```

The HMR proof used one adopted `workflow-builder` development pod in the host
namespace `vcluster-app-live-gan-proof26`:

```text
pod: wfb-dev-preview-workflow-builder-pdc-7a6f18e119b02de-b5449834d6
sync: drizzle,lib,scripts,services/shared/workflow-data-contract,src,static
syncSize: 7119655B
syncApplyElapsed: 1522ms
changedPaths: src/routes/dashboard/+page.svelte
```

The adopted service pod stayed in place while the HMR receiver applied the
source update. The generated dashboard change added a `Preview Development
Status` panel with quadrants for preview environment, workflow progress, source
capture, and draft PR handoff, using existing dashboard data and no new API
routes. A live smoke test returned `/api/health` 200 and loaded `/dashboard`
through the expected unauthenticated redirect path without Svelte or server
errors.

Source promotion created a durable source artifact and draft PR:

```text
sourceArtifactId: pca_86f566bacb093997fa1bbb27b7c5d5649581f001046e54e8f6b8f3981cec7afc
receiptId: pspr_9047f7a75463f8516508c3a1a6e5db309a3ae6d54e66e1067e33980ab38ff52e
branch: preview-feature-0c81000a3320f709e0a7ea58047bb28f
commitSha: b7f3856ab1d97729212ace7521d6e650921ce469
baseSha: bd4dce2e39b69765a28520329cacebb70fecb335
pullRequest: https://github.com/PittampalliOrg/workflow-builder/pull/677
pullRequestState: open draft
changedPaths: src/routes/dashboard/+page.svelte
```

The physical broker verified the append-only promotion receipt before the parent
completed. A transient GLM 5.2 minute-token-limit error was retried by the
runtime and did not require manual intervention.

The parent performed generation-fenced teardown after promotion verification.
The signed cleanup proof for `app-live-gan-proof26` reached completion; all
preview-environment cleanup checks were true:

```text
runnerSucceeded
previewEnvironmentAbsent
applicationAbsent
agentRegistrationAbsent
agentNamespacesAbsent
databaseAbsent
natsStreamAbsent
headlampRegistrationAbsent
tailnetEgressAbsent
hostNamespaceAbsent
storageScopeAbsent
runnerIdentityAbsent
```

The `PreviewEnvironment`, hub certificate resources, and dev namespace for
`app-live-gan-proof26` were absent after teardown. The source-promotion Sandbox
uses `shutdownPolicy: Delete`; its pod was gone after completion and its
transcript/workspace PVCs remained only until the scheduled Sandbox
`shutdownTime`, at which point the Sandbox controller is expected to reap the
owner-referenced storage.

One durable platform issue was found during proof teardown. The dev
`dev-preview-platform` ArgoCD Application was still pinned to
`35f8a10ae3846cfce2d535ccf04a70e3deaff2fe`, so the live admission policy lacked
the merged down-job `ttlSecondsAfterFinished == 1800` compatibility. A manual
application of the current policy allowed the proof26 down job to complete. The
durable fix advanced the dev overlay pointer to
`7b33ab3a0126da5a859a16baf4af07a215fb3404`; ArgoCD converged to `Synced
Healthy`, and the live admission policy now accepts either an absent down-job
TTL or `ttlSecondsAfterFinished == 1800`.
