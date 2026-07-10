# Pull-request PreviewEnvironments

> **Optional POC adapter:** the first development POC may launch and validate
> environments through the authenticated product workflow without completing
> every PR-webhook, force-push, status, and branch-governance scenario below.
> Keep this adapter fail closed if enabled. Its exhaustive automation matrix is
> post-POC hardening; the core POC gates are the interactive app-live loop,
> immutable replay, manifest candidate, and teardown.

A pull request carrying the `preview` label can request an isolated live
development environment on the physical `dev` cluster. PR automation is a
specialized inbound adapter to the same `PreviewEnvironment` domain used by
interactive and workflow-driven development. It is not a second vCluster
lifecycle system.

## Authority

The webhook payload is a notification, not deployment authority. The internal
route accepts only:

```json
{
  "action": "up",
  "prNumber": 42,
  "headSha": "<full 40-character lowercase SHA>",
  "verify": true
}
```

The persistent BFF validates this narrow shape and forwards it with only the
dedicated broker credential. The immutable physical preview-control broker then:

1. Reads the canonical `PittampalliOrg/workflow-builder` PR from GitHub.
2. Requires the PR to be open, carry `preview`, be based on `main`, and be
   sourced from the same repo.
3. Requires GitHub's head SHA to equal the exact SHA observed by the webhook.
4. Fetches every changed-file page, validates the declared count, and rejects
   PRs over the 3,000-file hard cap. Renames classify both old and new paths.
5. Classifies paths through the versioned development service catalog. Any
   unmapped runtime path fails closed; there is no workflow-builder fallback.
6. Resolves the configured stacks platform ref to a full immutable SHA.

Fork PRs are deliberately rejected because this lane executes source with
trusted development dependencies. A separate untrusted-code lane is required
before forks can be admitted.

GitHub reads, source seeding, comments, and commit statuses use short-lived
installation tokens minted by the broker from the preview-control GitHub App.
Read/status and source-write adapters request separate repository and permission
sets. The App private key is available only to the physical broker and the
base-only trusted gate workflow; neither it nor an installation token is
present on the persistent BFF or inside a vCluster.

## Launch contract

The server persists those facts in `pr_previews.authority`, then launches the
canonical domain command:

```text
profile: app-live
capabilities: [service-live-sync]
mode: live
allocation: cold
lifecycle: ephemeral
owner: automation / pr-preview:<number>
origin: pull-request / PittampalliOrg/workflow-builder#<number>
sourceRevision: verified PR head SHA
platformRevision: resolved stacks SHA
services: exact catalog-derived preview-native set
ttlHours: 24 (bounded by the PreviewEnvironment policy)
```

Cold allocation is intentional. The unified launch adapter sets
`createOnly=true`; PR automation does not claim or mutate a warm pool member.
An idempotent delivery for the same persisted authority returns the existing
status. A force-push first tears down the old generation with full cleanup
proof, then performs a new create-only launch.

The sandbox-execution-api rejects unprofiled `up` and warm `claim` creation.
There is no 422 retry which strips lifecycle, owner, origin, or provenance.

## Data path

```text
GitHub pull_request webhook
  -> hub Tekton label gate and purpose-specific governance dispatch
  -> persistent BFF compatibility route (credential-free command proxy)
  -> immutable preview-control broker
  -> ApplicationPrPreviewService authority admission
  -> ApplicationPreviewEnvironmentService
  -> SEA PreviewEnvironment controller (cold app-live/live)
  -> exact-contract readiness check
  -> adopt only selected preview-native dev pods
  -> seed verified PR head through authenticated /__sync
  -> optional Playwright critic
```

The seed helper fetches `pull/<number>/head`, verifies the fetched commit is
still the persisted SHA, and aborts on a force-push rather than syncing newer
bytes under older authority. Each selected service must have a ready adopted
pod and catalog sync metadata. Partial adoption is an error.

## Durability and teardown

`pr_previews` is the cross-replica pipeline record. Every `up`, retry, resume,
or teardown owns a generation; stage writes are compare-and-swap updates.
The record includes the server-derived PR, path, service, catalog, and platform
authority. Legacy rows without authority fail closed on resume.

A stale `provisioning` or `seeding` owner may be claimed by one replica. Resume
uses only persisted authority. A create-only conflict is not treated as
success by itself: exact readiness must prove platform revision, source
revision, profile, mode, owner, allocation, request ID, catalog, and service
set.

All failures after launch request typed PreviewEnvironment teardown and retain
the original error plus cleanup status. Explicit `down` first creates a newer
fencing generation, waits for every cleanup check (environment, Argo
Application, agent registration/namespaces, database, NATS stream, Headlamp
registration, tailnet egress, and host namespace), then conditionally deletes
only that generation. An incomplete cleanup remains visible as an error record.

## Configuration

| Variable                                      | Purpose                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `PR_PREVIEWS_ENABLED`                         | Enables the internal PR command/status routes.                                               |
| `PR_PREVIEW_REPO`                             | Canonical source repo; defaults to `PittampalliOrg/workflow-builder`.                        |
| `PREVIEW_PLATFORM_REPOSITORY`                 | Canonical stacks repository.                                                                 |
| `PREVIEW_PLATFORM_REF`                        | Server-side platform ref resolved to an immutable SHA.                                       |
| `PREVIEW_CONTROL_GITHUB_APP_ID`               | Preview-control GitHub App identifier.                                                       |
| `PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID`  | Installation used for bounded repository token exchanges.                                    |
| `PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY_FILE` | Broker-only read-only mount containing the App private key.                                  |
| `PREVIEW_CONTROL_BROKER_URL`                  | Persistent BFF address for the immutable broker.                                             |
| `PREVIEW_CONTROL_BROKER_TOKEN`                | Dedicated BFF-to-broker command credential.                                                  |
| `PREVIEW_GOVERNANCE_DISPATCH_TOKEN`           | Dedicated hub webhook credential accepted only by PR-preview and activation dispatch routes. |
| `PR_PREVIEW_VERIFY_ENABLED`                   | Enables the optional critic after the environment is ready.                                  |
| `PR_PREVIEW_VERIFY_WORKFLOW`                  | Workflow name for the configured critic.                                                     |

The hub dispatcher uses `X-Preview-Governance-Dispatch`; broad internal and
broker tokens are rejected. Its Task has fixed repository, BFF TLS host, egress
Service, and poll budgets. It must send only `action`, `prNumber`, `headSha`,
and optional `verify`. `headRef` and `changedFiles` are rejected because
accepting them would restore webhook-supplied authority.

## Validation

1. Open a same-repo PR against `main`, add the `preview` label, and verify the
   persisted authority contains exact source/platform SHAs and current catalog
   digest.
2. Confirm SEA receives an `app-live`, `live`, `cold`, `createOnly` request with
   automation owner, pull-request origin, TTL, provenance, and exact services.
3. Confirm every selected service hot-reloads the PR source and the public UI
   reflects a UI edit without an image build.
4. Force-push and prove the previous environment is fully absent before the new
   create-only launch.
5. Change an unmapped runtime path and prove admission fails before launch.
6. Attempt a fork, non-`main` base, stale head SHA, incomplete file page, and
   oversized PR; each must fail before persistence or cluster mutation.
7. Close or unlabel the PR and verify typed cleanup completes before the record
   disappears.

See `preview-environment-agent-development.md` for the full interactive,
workflow, manifest-candidate application/management lanes, and physical
host-candidate architecture.
