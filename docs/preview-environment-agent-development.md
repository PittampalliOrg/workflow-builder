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

## Preconditions

- Launch an `app-live` PreviewEnvironment on the dev spoke from Workflow
  Builder's `/workspaces/<workspace>/dev` page.
- Record the exact 40-character stacks platform SHA and workflow-builder source
  SHA. A branch name may be resolved at launch, but the persisted environment
  carries only complete SHAs.
- Select only services with `capabilities.previewNative: true` in
  `services/shared/dev-preview-service-catalog.json`.
- Use `mode: preview-native` and the preview's HTTPS origin when starting the
  `microservice-dev-session` workflow.
- Pass the exact source SHA to the workflow. Do not let the agent begin from a
  moving default branch.

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

## Start The Session

Launch `microservice-dev-session` with an input shaped like:

```json
{
  "services": [
    "workflow-builder",
    "workflow-orchestrator",
    "function-router",
    "mcp-gateway",
    "workflow-mcp-server"
  ],
  "mode": "preview-native",
  "sourceRevision": "<exact-workflow-builder-sha>",
  "previewOrigin": "https://wfb-<preview>.<tailnet-suffix>",
  "keepPreview": "true",
  "agentSlug": "cli-dev-agent"
}
```

The workflow provisions one dev pod per selected service, then creates exactly
one checkout at `/sandbox/work/repo`. It writes:

```text
/sandbox/work/repo/                 one detached monorepo checkout
/sandbox/work/.preview-services.json provision results
/sandbox/work/.syncenv.d/<service>  service-to-pod mappings
/sandbox/work/sync.sh               catalog-driven fan-out client
```

Do not clone the same monorepo once per service. Cross-service edits and shared
contract fixtures must come from one filesystem and one source revision.

The interactive agent is instructed not to commit or push. Its authority is to
edit the checkout, run the bounded sync/test adapters, and inspect the isolated
application. GitHub writes happen later through the promotion adapter.

## Edit And Sync

Edit any selected service under the one checkout, then run one fan-out:

```bash
cd /sandbox/work
./sync.sh
```

One invocation creates one logical generation and sends it to every selected
service with `x-sync-generation` and `x-sync-service`. UI source reaches Vite
HMR; Python and Node backends reload through their cataloged sidecar/plugin
adapter. The client also stages each service's `extraSync` mappings, including
shared contract fixtures.

The live transport is not a distributed transaction. If one POST fails, earlier
services may already contain that generation and `sync.sh` exits nonzero. Fix the
failure and rerun the complete fan-out. Strict capture rejects an incomplete or
mixed-generation set, so a partial sync cannot become acceptance evidence.

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
capture.

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
shared JuiceFS checkout. The `/__run` API accepts only names from the catalog; it
does not execute caller-provided shell commands.

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

## Rebuild Development Images

Live sync is the default loop for source-only changes. When an edit changes a
development Dockerfile or another image-baked dependency, invoke the bounded
`dev/preview-build` action instead of asking the agent to run Docker or Tekton:

```yaml
call: dev/preview-build
with:
  services:
    - workflow-builder
    - function-router
  origin: https://wfb-<preview>.<tailnet-suffix>
  adopt: true
```

`adopt` is required and explicit. Use `true` for an interactive session whose
preview URL should move to the rebuilt dev pods; use `false` when replacing the
control-plane BFF would interrupt the workflow driving the operation.

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
guarded teardown crosses the broker API, which waits for CR finalizers before
calling SEA.

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

After all selected services report one generation and their tests pass, invoke
the workflow action `dev/preview-snapshot`:

```yaml
call: dev/preview-snapshot
with:
  executionId: ${ .runtime.executionId }
  nodeId: dev-preview
  iteration: 1
  services:
    - workflow-builder
    - workflow-orchestrator
```

The caller supplies the expected service set, not trust metadata. The BFF
derives the platform SHA, source SHA, and catalog digest from the persisted
preview session and environment. The route always requests immutable provenance.

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
promotion action can then select the accepted iteration rather than reading
whatever happens to be live later.

## Promote Through GitHub

Invoke `dev/preview-promote` with the same `services[]` and a stored strict
iteration:

```yaml
call: dev/preview-promote
with:
  executionId: ${ .runtime.executionId }
  iteration: best
  bestIteration: 1
  services:
    - workflow-builder
    - workflow-orchestrator
  draft: true
  title: Cross-service preview feature
```

The preview first transfers the strict artifact to the physical control plane
under its tuple capability. The physical promotion broker re-authorizes the
current preview generation, applies the captured mappings into one GitHub
checkout, verifies the exact branch ancestry, and opens a PR. Repository, base,
branch prefix, and GitHub credentials are broker-owned and are not accepted from
the workflow. The response includes the PR URL, branch, exact `commitSha`, and
affected service set.

Promotion requires the execution owner to be a platform admin. Never install a
Gitea instance in the preview, point Argo CD at mutable session Git, or push from
the interactive agent. The preview receives neither a GitHub write credential
nor a Git-capable promotion runner. A source bundle is not durable until the
physical broker has materialized it in GitHub.

## Clean Acceptance Replay

Use the promotion response's exact verified PR tuple with
`dev/preview-acceptance`:

```yaml
call: dev/preview-acceptance
with:
  executionId: ${ .runtime.executionId }
  pullRequest: ${ .promote.pullRequest }
```

The acceptance route accepts only the exact PR tuple returned by source
promotion. The physical broker re-resolves the open GitHub PR, its complete
changed-path set, the preview's immutable source baseline and catalog, and the
platform-admin owner. Callers cannot assert a source SHA, stacks SHA, service
set, image, or retention policy.

The application service then:

1. submits one bounded hub `preview-acceptance-build` PipelineRun for each
   requested service;
2. builds the exact source SHA and records the returned GHCR digest;
3. rejects missing, duplicate, extra, cross-revision, or non-immutable images;
4. cold-provisions a fresh `app-live/reconciled` vCluster at the exact stacks
   SHA with one digest pin per service;
5. waits for the controller-owned Argo Application to become ready;
6. verifies `/api/health`, `preview-data-plane-smoke`, and
   `preview-agent-smoke` through product HTTP APIs;
7. tears the acceptance environment down after every launched replay.

Failures return a typed stage: `freshness`, `build`, `capacity`, `readiness`,
`runtime`, `verification`, `cleanup`, or `reporting`. A failed cleanup remains
subject to the bounded TTL and lifecycle reaper; it is never treated as retained
acceptance evidence. Acceptance does not update stacks release pins,
environment branches, or GitOps Promoter state.

After GitHub and the physical PreviewEnvironment authority verify the exact open
PR tuple, the physical broker publishes the `preview/immutable-acceptance`
commit-status context on that PR's full head SHA. It publishes `pending` before
submitting any build and a final `success`, `failure`, or `error` after replay.
Failure to publish the pending status stops the build; failure to publish the
final result makes the broker response fail closed at the `reporting` stage.
The mutable preview BFF never receives the GitHub write credential.

Configure repository branch protection to require only the aggregate
`preview/gate`, bound to GitHub App `2970091`. The base-owned reconciler consumes
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
- GitHub is the handoff between ephemeral source and durable review. GitOps is
  the handoff between reviewed source and shared environments.

These boundaries preserve the hexagonal architecture: workflow/application
services express policy through ports, while GitHub, SEA, sidecar sync, Tekton,
HTTP verification, and Kubernetes remain adapters.
