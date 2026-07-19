# Host-Orchestrated Preview Development Lifecycle

`preview-development-lifecycle` is the supported agentic path from a task
submitted on physical dev to an isolated preview, live source changes, a draft
pull request, and either retention or proved teardown.

## Ownership Boundary

One logical lifecycle uses two durable executions:

1. The physical-dev parent provisions the `PreviewEnvironment`, binds the
   immutable target, starts and observes the child, verifies the physical
   promotion receipt, and owns teardown.
2. The preview-local child adopts the selected services, runs the development
   loop, applies shared live-sync generations, evaluates gates, captures exact
   source, and requests draft-PR promotion.

This is not a Dapr child-workflow relationship. Physical dev and each vCluster
have separate workflow state stores and task hubs. The product application
layer treats the preview execution as a remote durable resource and exposes
only bounded start, status, signal, and verification operations.

Preview application code is mutable and is not promotion authority. The parent
accepts success only after the physical broker reconstructs and verifies the
append-only promotion receipt for the exact target and service set.

## Input Contract

The parent accepts this closed schema:

| Field                   | Required | Default                | Constraint                                      |
| ----------------------- | -------- | ---------------------- | ----------------------------------------------- |
| `intent`                | yes      | -                      | non-empty string, at most 12,000 characters     |
| `environmentName`       | yes      | -                      | lowercase DNS-style name, at most 40 characters |
| `services`              | no       | `['workflow-builder']` | unique catalog service IDs, 1-16 items          |
| `ttlHours`              | no       | `8`                    | integer from 2 through 24                       |
| `retainAfterCompletion` | no       | `false`                | retain a successful environment                 |
| `retainOnFailure`       | no       | `false`                | retain a failed environment for diagnosis       |
| `interactiveHandoff`    | no       | `false`                | create a persistent session on retained success |
| `impactReview`          | no       | `false`                | enable multi-service impact gates               |
| `diffScope`             | no       | service roots          | non-empty path-prefix allowlist                 |
| `maxIterations`         | no       | `2`                    | integer from 1 through 3                        |

More than one service is admitted only when
`PREVIEW_DEV_MULTISERVICE=true`. The server-side gate is authoritative even
though the fixture always permits the schema's upper bound.

The user does not provide actor, project, repository, source or platform SHA,
catalog digest, workflow digest, origin, execution ID, URLs, or credentials.
Those values are derived and revalidated by the application layer. `intent` is
passed as task data and is never interpolated into infrastructure commands.

## Exact Target

Every remote operation remains bound to the original authority:

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

The physical broker verifies the actor and project from the parent execution,
the immutable `PreviewEnvironment` identity, the published child digest, and
the requested service set. The preview-local adapter verifies its deployment
identity before starting or signaling the child. A caller-supplied URL never
participates in routing.

## Parent Phases

### Provision

The parent calls `preview/environment-launch` with the name, service set, TTL,
and retention intent, then polls `preview/environment-status`. Readiness means
the exact requested generation is reconciled and its selected development
surface is available; a similarly named or stale environment is not accepted.

### Start Development

The parent calls `preview/workflow-start` for the pinned child. It forwards only
the development request and optional retention/gate controls. A short 404 while
the preview-local seed hook publishes the child is retryable. Bounded 409 and
502 responses are treated as transient; contract and authorization failures
remain permanent.

### Observe And Verify

The parent polls `preview/workflow-status` with deterministic exponential
backoff. Its time budget scales with service count while keeping action-call
count bounded. The child must return a draft-PR receipt whose preview,
generation, execution, service set, branch, commit, base SHA, and repository are
internally consistent.

The parent then calls `preview/workflow-verify-promotion`. Only a physically
verified receipt for `PittampalliOrg/workflow-builder`, the exact child
execution, and the exact requested service set permits normal completion.

### Finalize

The parent retains only when one of these conditions is true:

- normal completion and `retainAfterCompletion=true`;
- abnormal completion and `retainOnFailure=true`.

Otherwise it calls `preview/environment-teardown` and, when needed, polls
`preview/environment-teardown-status` with the signed teardown ticket. A
teardown response without either complete cleanup or a ticket is a lifecycle
failure.

The `finally` path owns this decision, so provisioning or child failures do not
silently skip cleanup.

## Preview-Local Development

The child obtains tuple-bound service metadata from `dev/preview`. On the
single-service path it preserves the proven receiver export/sync behavior. On
the multi-service path it:

1. obtains metadata for every requested service in one batch;
2. builds one sparse checkout in the shared workspace;
3. materializes one private sync configuration per service;
4. runs the agent against that checkout;
5. executes `/sandbox/work/sync.sh` once per logical generation;
6. requires one `APPLIED` receipt per service and one shared healthy
   convergence receipt.

The child does not commit or push. After verification it calls
`dev/preview-snapshot` for the accepted receiver-owned generation and
`dev/preview-promote` for the exact service set. GitHub credentials remain in
the physical broker.

## Impact Gates

`impactReview=true` changes only the multi-service path. After each generation
and before snapshot, the child checks:

- all requested services report one shared generation;
- configured routes remain smoke-testable;
- each service is healthy and catalog-defined probes pass;
- receiver-owned changed paths remain within `diffScope`.

A failed gate is iteration feedback, not an immediate promotion. The next
iteration may correct the source until `maxIterations` is exhausted. Scope is
computed from each receiver's `/__status` receipt for the current generation;
the helper checkout is not diff authority. Out-of-scope files produce
`out_of_scope_changes`. Generated capture-only files are excluded before the
scope decision.

## Retention And Sessions

On retained success without interactive handoff, the child calls
`dev/preview-freeze` after promotion. The environment remains reachable, but
new `/__sync` generations are rejected.

With `interactiveHandoff=true`, the child deliberately skips freeze and starts
a persistent interactive agent session against the retained workspace. Child
and host status include its session URL. Once the original session lease is
released, the continuation endpoint may create a second session bound to the
same retained preview and source authority.

Retention never removes TTL or cleanup ownership. Explicit teardown and the
bounded lifecycle reaper still use the exact request/source generation.

## Action Boundary

The parent uses these first-class actions:

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

Mutating operations use deterministic operation IDs. The function-router and
BFF routes require the purpose-specific `PREVIEW_ACTION_INTERNAL_TOKEN`; agent
sandboxes receive neither that token nor platform, Kubernetes, GitHub, or
provider credentials. Responses crossing from mutable preview code are
allowlisted and size-bounded.

## Success Contract

A non-retained success records one correlated chain:

```text
host execution -> PreviewEnvironment generation -> child execution
-> live-sync generation -> source artifact -> verified draft PR receipt
-> teardown ticket -> 12-check cleanup proof
```

A retained success records the same chain through promotion, plus retention,
freeze or interactive-handoff evidence. Teardown proof requires the twelve
checks listed in [Preview environments](preview-environments.md#teardown-contract).

## Source Of Truth

- Parent fixture: `scripts/fixtures/dynamic-scripts/preview-development-lifecycle.js`
- Child fixture: `scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js`
- Target application service: `src/lib/server/application/preview-target-development.ts`
- Route adapters: `src/routes/api/dev-environments/`
- Fixture tests: `services/script-evaluator/src/preview-development-lifecycle.test.ts`
  and `services/script-evaluator/src/preview-ui-development-gan.test.ts`
- Seed contract: `scripts/seed-workflows.preview-lifecycle.test.ts`

Current live evidence is maintained only in
[Preview environments](preview-environments.md#current-dev-evidence).
