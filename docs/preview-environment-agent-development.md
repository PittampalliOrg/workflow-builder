# Agent Development In A PreviewEnvironment

This guide operates the current `app-live` agentic development path on the
physical `dev` cluster. Platform provisioning, recovery, and resource-level
inspection live in the
[stacks runbook](https://github.com/PittampalliOrg/stacks/blob/main/docs/preview-environment-runbook.md).

## Safety Rules

- Use the `dev` cluster only. This workflow is not a ryzen inner loop.
- Start from deployed `main` revisions and record both Workflow Builder and
  stacks SHAs before launch.
- Do not trigger ArgoCD syncs, preview-platform changes, image-pin changes, or
  host BFF rollouts while a proof run is active. Restarting the command path can
  surface as a child 502.
- Use a unique `environmentName` for every run.
- Never merge the draft PR produced by a proof run. It is an artifact showing
  exact captured source, not a delivery branch.
- Keep `retainOnFailure` off for normal use. Turn it on only when live
  diagnostics require the failed environment to survive.

## Preconditions

Before launching, confirm:

1. physical-dev Workflow Builder and the separately pinned preview platform are
   healthy;
2. the seeded `preview-development-lifecycle` parent and
   `preview-ui-development-gan` child match the merged fixtures;
3. every requested service is `previewNative` in
   `services/shared/dev-preview-service-catalog.json`;
4. `PREVIEW_DEV_MULTISERVICE=true` is deployed when requesting more than one
   service;
5. no conflicting preview with the selected name is provisioning, retained, or
   tearing down.

Repository validation:

```bash
pnpm catalog:dev-preview:check
pnpm exec vitest run \
  services/script-evaluator/src/preview-development-lifecycle.test.ts \
  services/script-evaluator/src/preview-ui-development-gan.test.ts \
  scripts/seed-workflows.preview-lifecycle.test.ts
```

Run the stacks preview validation suite before changing platform behavior. In
particular, the launch-boundary test must pass before any preview Job admission
policy edit.

## Launch From The Product

The Dev Environments surface resolves the seeded parent by name and presents
its current input schema. A standard single-service run needs only:

```json
{
  "intent": "Implement and verify the requested Workflow Builder change.",
  "environmentName": "app-live-example-01"
}
```

The full API shape is:

```json
{
  "intent": "Implement and verify the requested change across both services.",
  "environmentName": "app-live-example-02",
  "services": ["workflow-builder", "workflow-orchestrator"],
  "builderProfile": "pydantic-ai-k3-ui",
  "targetRoutes": ["/dashboard"],
  "ttlHours": 8,
  "retainAfterCompletion": false,
  "retainOnFailure": false,
  "interactiveHandoff": false,
  "impactReview": true,
  "diffScope": [
    "src/routes/dashboard",
    "services/workflow-orchestrator/workflows"
  ],
  "maxIterations": 2
}
```

`builderProfile` is a closed policy selector. Use `pydantic-ai-k3-ui` for a
high-craft Workflow Builder UI task that needs broader theme/source inspection,
up to 40 Pydantic AI turns, a 60-minute agent window, and multiple fresh atomic
HMR generations. The fixed saved agent is
`pydantic-ai-k3-preview-ui-builder-agent` on `pydantic-ai-agent-py` with
`kimi/kimi-k3`; callers cannot provide an agent slug or runtime. Set
`targetRoutes` to every application route the workflow must smoke before
capture and draft-PR promotion.

The supported preview-native service IDs are listed in
[Preview environments](preview-environments.md#agentic-development).

For a retained interactive handoff, set both controls:

```json
{
  "intent": "Apply the requested change, then leave an interactive session for follow-up.",
  "environmentName": "app-live-handoff-01",
  "services": ["workflow-builder"],
  "ttlHours": 8,
  "retainAfterCompletion": true,
  "interactiveHandoff": true
}
```

## Launch Through The API

Use an authenticated platform-admin token. Keep credentials outside shell
history:

```bash
BASE_URL=https://workflow-builder-dev.tail286401.ts.net
WORKFLOW_ID=<seeded-workflow-row-id>

curl -fsS \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d @input.json \
  "$BASE_URL/api/dev-environments/workflows/$WORKFLOW_ID/execute"
```

The request body is `{ "input": <the object above> }`. The response identifies
the host execution. Observe it in the run UI or through the Workflow Builder
MCP execution-status tool.

If a newly merged property returns `400 additional properties`, the seeded
database row has stale script metadata. Refresh the existing row with the
merged fixture, which also re-stamps `meta`:

```bash
jq -n --rawfile script \
  scripts/fixtures/dynamic-scripts/preview-development-lifecycle.js \
  '{spec:{engine:"dynamic-script",script:$script}}' > /tmp/preview-parent.json

curl -fsS -X PUT \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/preview-parent.json \
  "$BASE_URL/api/workflows/$WORKFLOW_ID"
```

Refreshing a seeded row is recovery for deployment drift, not a substitute for
the seed test or normal rollout path.

## Observe The Run

The parent progresses through `Provision`, `Start development`, `Observe`, and
`Finalize`. Record these identifiers as soon as they appear:

```text
host execution ID
preview name and environment request ID
platform/source revisions and catalog digest
child execution ID and child workflow digest
adopted service pod names
live-sync generation receipts
source artifact and promotion receipt IDs
draft PR URL
teardown ticket and cleanup checks
```

For a failure in remote activity start or status, stream logs while the preview
still exists. The adopted workload is deleted with the preview, so
post-failure-only inspection loses the most useful evidence.

```bash
# Physical dev: adopted service and sidecar logs.
kubectl --context admin@dev -n vcluster-<preview> get pods -w
kubectl --context admin@dev -n vcluster-<preview> logs -f \
  <wfb-dev-preview-service-pod> --all-containers=true --prefix

# Virtual cluster: workflow/orchestrator and runtime logs.
# Obtain the preview kubeconfig through the stacks runbook, then:
kubectl --kubeconfig <preview-kubeconfig> -n workflow-builder logs -f \
  deploy/workflow-orchestrator --all-containers=true --prefix
```

Use labels rather than guessed pod names where the deployment exposes them.
The critical correlation is the exact preview request and child execution, not
the newest pod in a namespace.

## Edit And Sync Contract

The child receives only scoped development capabilities. It cannot use
Kubernetes, GitHub, broker, or provider credentials.

Single-service development exports receiver-owned source, applies one atomic
generation to that receiver, and verifies health before capture. Multi-service
development seeds one sparse checkout at `/sandbox/work/repo`; per-service
configuration lives under `/sandbox/work/.syncenv.d`. Each logical edit must
run:

```bash
/sandbox/work/activate-repo.sh
/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1
```

Acceptance requires an `APPLIED` line for every requested service and one final
line shaped like:

```text
SYNCED generation=<generation> services=<count> convergence=healthy
```

Do not run one generation per service. Capture and gate authority depend on all
receivers reporting the same shared generation.

## Gate Behavior

With `impactReview=true`, a generation is evaluated before snapshot. A broken
route, failed probe, missing convergence receipt, or out-of-scope source path
becomes feedback for the next iteration. It is valid proof only when the run
records both the rejected generation and the corrected accepted generation.

For diff-scope testing, choose prefixes that include the intended files and
request one clearly out-of-scope source edit. The result must include
`out_of_scope_changes`, and the final captured generation must exclude that
file. Read scope evidence from the receiver status, not from the helper
checkout.

## Promotion

After a generation passes its applicable checks, the child snapshots the exact
receiver generation and asks the physical broker to create a draft PR. The
parent independently verifies the durable receipt before success.

Inspect the artifact PR for:

- the exact requested service set;
- only receiver-owned source from the accepted generation;
- no generated catalog, seed bundle, or migration-journal churn;
- a draft state and expected `main` base;
- no unrelated files from an earlier iteration.

Do not merge the artifact PR.

## Retained Follow-Up

A retained non-interactive run must report freeze success, and a direct
`/__sync` write after completion must be rejected. An interactive handoff must
instead report that freeze was skipped for `interactive-handoff`, include a
session URL, and permit a follow-up shared generation while that session owns
the lease.

After releasing the session lease, use the product continuation action to
attach a second session. Confirm that it opens against the same preview,
request ID, source revision, and workspace rather than launching a new
environment.

Retained environments still expire. Tear them down explicitly when inspection
is complete unless the proof specifically requires the environment to remain.

## Teardown And Residue

For non-retained runs, parent success is incomplete until all twelve cleanup
checks are true. Use the product teardown-status route for the signed ticket;
use Kubernetes only to diagnose a check that remains false.

After cleanup, verify absence of the PreviewEnvironment, Argo Application,
agent registration and namespaces, isolated database/NATS state, Headlamp and
tailnet registrations, physical host namespace, storage scope, and runner
identity. Helper Sandboxes and their owner-referenced PVCs have their own
shutdown path; inspect them separately instead of treating the vCluster check
set as proof of helper cleanup.

## Failure Triage

| Symptom                             | First check                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent input rejects a new property | Refresh the seeded row from the merged fixture and rerun its seed test.                                                                        |
| Child start returns 404             | Confirm the preview-local seed hook published the pinned child; the parent retries only the bounded seed race.                                 |
| Child activity returns 409 or 502   | Stream adopted service, dev-sync sidecar, preview SEA, and preview-local orchestrator logs before teardown. Check concurrent rollout activity. |
| Multi-service request is rejected   | Verify `PREVIEW_DEV_MULTISERVICE=true` and every ID is preview-native in the deployed catalog.                                                 |
| Shared sync does not converge       | Inspect each `APPLIED` receipt and generation; do not capture a partial service set.                                                           |
| Scope gate sees no intended diff    | Query receiver `/__status`; helper checkout state is not authority.                                                                            |
| Promotion exists but parent fails   | Compare the physical receipt's target, execution, service set, branch, commit, base SHA, and PR URL.                                           |
| Teardown stalls                     | Read each cleanup check and follow the corresponding stacks recovery section. Do not force-delete around the finalizer.                        |

The protocol and success criteria are defined in
[Host-orchestrated preview development lifecycle](host-preview-development-lifecycle.md).
