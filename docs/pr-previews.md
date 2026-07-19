# Pull-Request PreviewEnvironments

A same-repository pull request against `main` can request an isolated
`app-live` environment by carrying the `preview` label. PR automation is an
inbound adapter to the normal `PreviewEnvironment` lifecycle, not a second
provisioning system.

## Authority

The webhook is notification only. The internal command accepts this closed
shape:

```json
{
  "action": "up",
  "prNumber": 42,
  "headSha": "<40-character lowercase SHA>",
  "verify": true
}
```

The physical preview-control broker reloads canonical GitHub state and requires:

- an open PR in `PittampalliOrg/workflow-builder`;
- base branch `main` and a branch from the same repository;
- the `preview` label;
- an exact match between the reported and canonical head SHA;
- a complete changed-file listing within the 3,000-file bound;
- every runtime path to map to a preview-native catalog service;
- a server-resolved immutable stacks platform SHA.

Renames classify both old and new paths. An unmapped runtime path fails closed.
Forks are rejected because this lane executes source with trusted development
dependencies.

GitHub reads and status writes use short-lived installation tokens minted by
the physical broker. The App private key and installation tokens are not
available to the persistent BFF or vCluster workloads.

## Launch

Accepted authority is persisted in `pr_previews`, then translated into the
canonical lifecycle command:

```text
profile: app-live
mode: live
allocation: cold
lifecycle: ephemeral
owner: automation / pr-preview:<number>
origin: pull-request / PittampalliOrg/workflow-builder#<number>
sourceRevision: verified PR head SHA
platformRevision: resolved stacks SHA
services: exact catalog-derived set
ttlHours: 24
```

PR previews are create-only and never claim a reusable vCluster. Duplicate
delivery for the same persisted authority is idempotent. A force-push first
tears down the old generation with complete cleanup evidence, then launches a
new generation for the new SHA.

## Data Path

```text
GitHub pull_request event
  -> hub governance dispatch
  -> persistent BFF command proxy
  -> immutable preview-control broker
  -> PR authority admission
  -> PreviewEnvironment application service
  -> SEA cold app-live launch
  -> exact readiness
  -> selected service adoption
  -> verified-head source seed through /__sync
  -> optional configured critic
```

The source helper fetches the pull-request head and verifies that it still
equals persisted authority before syncing bytes. Every selected service must
be ready and adopted; partial adoption is failure.

## Durability And Cleanup

`pr_previews` is the cross-replica state record. Stage transitions are
generation-owned compare-and-swap updates, and recovery uses only persisted
authority. Legacy rows without the complete authority tuple fail closed.

A create-only conflict is not readiness. The existing environment must match
the request ID, platform and source revisions, profile, mode, owner, allocation,
catalog digest, and exact service set.

Failures after launch request typed teardown and preserve both the original
error and cleanup status. Close or unlabel also initiates generation-fenced
teardown. The record is not considered cleared until the standard twelve-check
cleanup proof is complete.

## Configuration

| Variable                                      | Purpose                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `PR_PREVIEWS_ENABLED`                         | Enables the internal PR command and product read surfaces.                  |
| `PR_PREVIEW_REPO`                             | Canonical source repository; defaults to `PittampalliOrg/workflow-builder`. |
| `PREVIEW_PLATFORM_REPOSITORY`                 | Canonical stacks repository.                                                |
| `PREVIEW_PLATFORM_REF`                        | Server-side platform ref resolved to a full SHA.                            |
| `PREVIEW_CONTROL_GITHUB_APP_ID`               | Preview-control GitHub App ID.                                              |
| `PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID`  | Installation used for scoped token exchange.                                |
| `PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY_FILE` | Broker-only private-key mount.                                              |
| `PREVIEW_CONTROL_BROKER_URL`                  | Persistent-BFF address of the physical broker.                              |
| `PREVIEW_CONTROL_BROKER_TOKEN`                | Purpose-specific BFF-to-broker credential.                                  |
| `PREVIEW_GOVERNANCE_DISPATCH_TOKEN`           | Purpose-specific hub dispatch credential.                                   |
| `PR_PREVIEW_VERIFY_ENABLED`                   | Enables the optional post-seed critic.                                      |
| `PR_PREVIEW_VERIFY_WORKFLOW`                  | Seeded workflow name used by that critic.                                   |

The dispatch route accepts `X-Preview-Governance-Dispatch`; broad internal and
broker credentials are rejected. The event does not supply changed files,
head-ref authority, platform refs, or service selection.

## Verification

For a live proof:

1. label a same-repository PR and verify persisted source/platform SHAs and
   current catalog digest;
2. confirm SEA receives the exact cold `app-live` request and service set;
3. verify selected services receive the exact PR source without an image build;
4. force-push and prove full old-generation cleanup before replacement;
5. prove an unmapped path, fork, stale SHA, incomplete file listing, oversized
   PR, or non-`main` base fails before cluster mutation;
6. close or unlabel and require all twelve cleanup checks.

See [Preview environments](preview-environments.md) for lifecycle ownership and
the [stacks runbook](https://github.com/PittampalliOrg/stacks/blob/main/docs/preview-environment-runbook.md)
for cluster inspection.
