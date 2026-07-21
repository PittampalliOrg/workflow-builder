# Preview Environments

This page is the entry point for Workflow Builder preview-environment behavior.
It describes the product surface and links to the operational and platform
contracts that own the implementation details.

## What Is A Preview?

Workflow Builder uses two related isolation levels:

- A development session gives one workflow execution an ephemeral sandbox and
  service-scoped development tools. It does not create a virtual cluster.
- A `PreviewEnvironment` creates a cold, isolated vCluster on the physical
  `dev` spoke. It binds an immutable platform revision, source revision,
  catalog digest, owner, service set, profile, and request ID into one
  generation.

This documentation is about the second level. Runtime `SandboxWarmPool`
resources are a separate agent-startup optimization and are not a pool of
reusable `PreviewEnvironment` instances.

## Documentation Map

| Question                                                          | Authoritative document                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| What does the product launch and how is it operated?              | [Agent development in a preview](preview-environment-agent-development.md)                                         |
| How does the host-to-preview agentic lifecycle work?              | [Host-orchestrated lifecycle](host-preview-development-lifecycle.md)                                               |
| How do labeled pull requests request previews?                    | [Pull-request previews](pr-previews.md)                                                                            |
| What evidence is required before preview-sensitive changes merge? | [Preview governance gate](preview-governance-gate.md)                                                              |
| How are multi-service sync receipts normalized?                   | [Dev-sync normalization](dev-sync-normalization.md)                                                                |
| Who owns vCluster resources, security, teardown, and recovery?    | [Stacks architecture](https://github.com/PittampalliOrg/stacks/blob/main/docs/preview-environment-architecture.md) |
| What commands should a cluster operator run?                      | [Stacks runbook](https://github.com/PittampalliOrg/stacks/blob/main/docs/preview-environment-runbook.md)           |

The product repository owns inputs, authorization, workflow behavior, source
capture, promotion, and UI read models. The stacks repository owns the CRD,
controllers, runner Jobs, ArgoCD topology, credentials, storage, capacity, and
physical cleanup.

## Lifecycle

All supported launch paths converge on the same domain lifecycle:

```text
authorize -> resolve immutable authority -> launch -> reconcile -> ready
  -> adopt selected services -> develop/observe -> capture -> promote or discard
  -> retain until expiry, or generation-fenced teardown -> cleanup proof
```

Current launch paths are:

- `preview-development-lifecycle`, a physical-dev workflow that provisions a
  preview and starts the pinned preview-local development workflow;
- the Dev Environments product surface for direct operator launch and control;
- same-repository pull-request automation admitted from canonical GitHub state;
- immutable manifest or host candidates used for platform validation.

Launch input is not infrastructure authority. Repository, actor, project,
source revision, platform revision, catalog digest, workflow digest, URLs, and
credentials are derived or revalidated by server-side application services.

## Profiles

The principal profiles are:

- `app-live`: a mutable application preview with adopted workloads and
  generation-based live sync;
- `manifest-candidate`: an immutable platform candidate used to validate a
  rendered stacks revision;
- `host-candidate`: an immutable candidate used for physical host/platform
  changes.

Profiled allocation is cold-only. The retired vCluster claim/bake pool is not a
supported launch path.

## Agentic Development

The physical parent and preview-local child are separate durable executions
because each cluster has its own workflow state store. The parent owns
provisioning, exact-target correlation, physical receipt verification, and
teardown. The child owns service adoption, the agent iteration loop, live sync,
gates, source capture, and draft-PR promotion.

The current preview-native catalog contains:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `mcp-gateway`
- `workflow-mcp-server`

Multi-service development is admitted only when
`PREVIEW_DEV_MULTISERVICE=true`. The child seeds all requested services in one
workspace. Each logical edit runs one shared `sync.sh` generation and must
produce one `APPLIED` receipt per service followed by a global
`SYNCED ... convergence=healthy` receipt.

With `impactReview=true`, the multi-service path also requires convergence,
route smoke, service probes where the catalog defines them, and receiver-owned
diff-scope checks. An out-of-scope source edit rejects the iteration as
`out_of_scope_changes`; generated capture-only artifacts do not satisfy or
violate the scope.

## Retention And Interactive Handoff

`retainAfterCompletion=true` keeps a successful environment until explicit
teardown or bounded expiry. By default, the child freezes live sync after the
accepted generation is promoted, so later writes to `/__sync` are rejected.

`interactiveHandoff=true` is the explicit exception: it keeps live sync open,
creates a persistent session against the retained preview, and returns the
session URL in host status. After the original lease is released, a second
session can attach to the same retained generation through the normal
continuation path.

`retainOnFailure=true` is a diagnostic control. It preserves a failed preview
for inspection but does not turn a failed execution into success.

## Observation And Archive

The control-plane UI observes a preview through tuple-authorized application
ports. It does not route callers directly to arbitrary preview URLs or expose
preview credentials.

| Variable                              | Default | Behavior                                                                                              |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `PREVIEW_READ_PROXY_ENABLED`          | off     | Enables bounded execution-list and execution-detail reads from a preview. Disabled routes return 404. |
| `PREVIEW_ARCHIVE_ON_TEARDOWN`         | off     | Archives compact run summaries and unpromoted source bundles before explicit teardown.                |
| `PREVIEW_TTL_ARCHIVE_GRACE_MINUTES`   | `60`    | Retry window before an expired mutable preview is quarantined and forcibly torn down.                 |
| `PREVIEW_TTL_FAIRNESS_WINDOW_SECONDS` | `60`    | Stable rotation window for bounded expiry work.                                                       |

Preview-local Workflow MCP diagnostics keep execution discovery, overview,
journal reads, and workspace authorization in the preview BFF. Deep trace
evidence is read through the physical preview-control broker: the BFF presents
its five-field immutable tuple leaf plus a short-lived proof bound to the
authorized user, workspace, execution, time window, primary trace, and session.
The broker revalidates physical preview ownership and dev workspace membership,
then applies the complete tuple to every span and log query. LLM rows must join
back to a tuple-stamped trace/span pair. ClickHouse endpoints and credentials,
workspace API keys, and Kubernetes credentials never enter the vCluster.

Preview trace summaries use nested default budgets: 12 seconds for each
physical query, 18 seconds for the broker transport, and 25 seconds for the
Workflow MCP request. Optional service and text filters are applied with
`HAVING countIf(...)` after full-trace aggregation, avoiding a second scan of
the trace table for matching trace IDs. A `preview_trace_timeout` response
includes only the attempted range and a narrower retry range; Workflow MCP
turns that contract into a follow-up `query_preview_traces` action.

The durable hub-observability follow-up is a materialized
`obs.preview_trace_spans` projection keyed by the immutable preview tuple,
timestamp, and trace ID, following the existing `obs.llm_spans` and
`obs.tool_spans` ownership pattern. That hub schema migration is intentionally
outside this dev-only application repair.

Archive files are stored on the host under
`preview-archive:<preview-name>`. Promoted source is already durable in GitHub
and is not copied again. Active or incomplete generations remain visible as
incomplete archive evidence; archive policy decides whether deletion can
continue.

## Teardown Contract

Teardown is generation-fenced and asynchronous. Completion requires all twelve
checks:

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

An incomplete check set is not success. Current runner Job retention is 24
hours for successful `up` receipts and 30 minutes for successful `down`
receipts. A separate scheduled collector removes released preview transcript
and workspace PV objects after their configured grace period.

## Current Dev Evidence

The last full proof set was recorded on 2026-07-18 against Workflow Builder
`d70d6b6f6dfd56f4d73e1fc29425f61e98fb3a45` and stacks
`254f4280d8bdd6a2b743a35b4529fe1171a7a355`.

| Contract                | Evidence                                                                                                           | Result                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Retained single service | host `sfvLVn4L5Gj0o5iCI4W_9`, preview `app-live-item1-p2`, reattach session `8WrQnFMYUwtXYxV_JbX86`, draft PR #699 | session URL returned, follow-up HMR applied, freeze rejected later writes, second session reattached   |
| Two services            | host `PFFG0U4vt2boUHO_51P0E`, preview `app-live-proofc2-p4`, draft PR #701                                         | batch adoption, shared generation, both services captured, 12/12 cleanup                               |
| Five services           | host `JJ7gAZEETThWvQu0-2N5n`, preview `app-live-proofc5-p2`, draft PR #704                                         | all five catalog services completed, 12/12 cleanup                                                     |
| Gate correction         | host `WbLfErpT_5bH6SgtvhOue`, preview `app-live-proofd-gate-p6`, draft PR #710                                     | broken generation rejected, corrected generation accepted, 12/12 cleanup                               |
| Diff scope              | host `EA_PpjUa0qRShaK9-sDzu`, preview `app-live-proofd-scope-p3`, draft PR #714                                    | `src/routes/proof-d-out-of-scope.ts` rejected; final dashboard-only generation accepted; 12/12 cleanup |

These draft PRs are proof artifacts, not delivery branches, and must not be
merged. Replace this table when a newer complete proof supersedes it; do not
append execution transcripts to architecture or runbook pages.

## Executable Sources

When prose and code disagree, use these sources in order:

- `scripts/fixtures/dynamic-scripts/preview-development-lifecycle.js`
- `scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js`
- `src/lib/server/application/preview-target-development.ts`
- `src/lib/server/workflows/dev-preview-registry.ts`
- `services/shared/dev-preview-service-catalog.json`
- `src/lib/server/application/preview-archive.ts`
- the focused route, application-service, fixture, and catalog tests beside
  those files

Keep documentation about current behavior here. Keep rollout receipts in a
compact dated evidence table, historical failure analysis in issues or PRs, and
enforceable guarantees in tests.
