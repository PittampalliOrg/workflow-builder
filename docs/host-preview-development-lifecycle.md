# Host-Orchestrated Preview Development Lifecycle

## Status

Implementation in progress. This document is the contract and checkpoint log for
the first dev-cluster proof.

### Checkpoints

- [x] Confirm the live host and preview-local boundaries.
- [x] Freeze the parent/child command contract.
- [x] Implement the preview-local child control and promotion path.
- [x] Implement the exact-tuple host-to-preview command adapter.
- [x] Implement the host lifecycle workflow and launch UI.
- [x] Require a physical durable promotion receipt before successful completion.
- [x] Make the interactive-session handoff replay-safe and prove one linked session.
- [x] Pass repository and rendered-manifest validation.
- [ ] Deploy through GitHub, GHCR, and GitOps to dev.
- [ ] Prove prompt to HMR to draft PR to teardown on a fresh preview.

## Objective

A user submits one task from the physical dev Workflow Builder. One durable host
workflow provisions an isolated `app-live` PreviewEnvironment, starts the pinned
`microservice-dev-session` inside it, and reports the preview session. The agent
runs `zai/glm-5.2` through `dapr-agent-py-juicefs`, receives the submitted task as
its first work item, changes the selected services through the existing HMR
receiver, and leaves the preview available for inspection. A durable approval on
the host run submits or discards the changes. Submission captures the receiver's
strict source generation, opens an idempotent draft pull request, returns the
receipt to the host run, and then performs generation-fenced teardown unless the
launch requested retention.

## Orchestration Boundary

This is one logical lifecycle implemented by two durable executions:

1. `preview-development-lifecycle` is stored and run on the physical dev cluster.
   It owns provisioning, correlation, approval, receipt reconciliation, and
   whole-environment teardown.
2. `microservice-dev-session` is stored and run inside the target vCluster. It
   owns service adoption, the shared HMR workspace, the interactive agent
   session, source capture, and PR promotion.

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

The preview-local child waits durably on the fixed event
`preview.development.control`. The only accepted payloads are:

```json
{ "action": "submit_preview_pr" }
{ "action": "discard" }
```

The host parent exposes this through its normal durable approval surface:

- Approve sends `submit_preview_pr`.
- Deny sends `discard`.
- Cancellation leaves an auditable result and invokes guarded cleanup according
  to the archive policy.

On submission the child runs `dev/preview-snapshot` for the exact selected
service set, then `dev/preview-promote`. Both actions bind their execution ID
from trusted activity context. Promotion remains draft-only and the GitHub App
credential remains in the physical broker.

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

When the child reaches `await_control`, status must resolve exactly one session
linked to the child execution. The result includes the preview-local,
workspace-scoped session URL so the host approval surface can take the operator
directly to the active GLM session. Zero, duplicate, or ambiguous links fail the
contract instead of presenting an approval.

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
