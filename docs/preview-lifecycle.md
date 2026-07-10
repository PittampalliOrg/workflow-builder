# PreviewEnvironment Lifecycle

PreviewEnvironment is the dev-spoke lifecycle for full-system isolated vCluster
environments. Immutable source authority, inner-loop development, capture, and
promotion are described in
[`preview-environment-agent-development.md`](preview-environment-agent-development.md).

## Allocation

Profiled PreviewEnvironment allocation is cold-only:

```json
{ "kind": "cold" }
```

The old profiled vCluster claim/bake pool is retired. A generic bake could not
prove the complete platform revision, source revision, catalog digest, service
set, reconciliation result, and capability generation required by a launch.
`VCLUSTER_PREVIEW_POOL_SIZE` is therefore ignored and the claim endpoint fails
before Kubernetes access. Agent-runtime `SandboxWarmPool` resources are separate
and remain supported.

## Coordination

Bounded preview runners and coordination objects live in
`VCLUSTER_PREVIEW_CONTROL_NAMESPACE` (default `preview-control-system`). Each
Job uses `ServiceAccount/vcpreview-<name>` and exact matching bindings; no shared
runner identity exists. The SEA creates and proves the restricted
`vcluster-<name>` namespace and identity before Job admission, then removes the
identity only after a successful down and proof that the namespace is absent.
Application workloads remain in the vCluster's `workflow-builder` namespace.

Every mutable operation acquires `Lease/vcpreview-op-<name>` in the control
namespace. The holder is injected into the runner Job, and destructive actions
repeat request/source generation fencing while holding that Lease. Capacity uses
a separate Lease in the same namespace.

## Agent Registration

The hub PreviewEnvironment controller owns registration for
`preview-<name>`. It creates a cert-manager `Certificate` and its single leaf
Secret in `preview-agent-certs`, plus an `ExternalSecret` in `argocd`. A
namespace-local `SecretStore` projects that leaf into the Argo resource-proxy
cluster mapping. The controller never reads or writes Secrets in `argocd`, and
the runner has no hub kubeconfig.

The Certificate duration is `216h`, with `renewBefore: 24h`. Preview TTL is
bounded to `168h`, and both the controller and runner require the actual leaf to
outlive `expiresAt` by at least 24 hours. The controller also verifies the leaf
CN, RSA key and private-key match, client/key usages, current validity, exact
Certificate status expiry, CA BasicConstraints, and signature chain before it
creates the mapping `ExternalSecret`.

Transport into the virtual cluster is deliberately one-shot. The runner reads
only `<agent>-agent-cert`, validates it independently, stages the leaf in the
virtual `argocd` namespace, and removes the physical transport copy. There is no
claim of virtual certificate rotation; the fixed lifetime covers the maximum
preview TTL plus cleanup margin. The `preview.stacks.io/agent-registration`
finalizer first foreground-deletes the mapping `ExternalSecret`, then removes
the Certificate, isolated leaf, and agent namespace. Its controller has no
Secret verb in `argocd`.

## Capabilities

The HMAC root stays in the physical broker. An up Job receives six tuple-derived
leaf capabilities only:

- preview control
- dev sync
- preview action
- sandbox execution
- runtime inference
- storage lifecycle

The runtime capability is staged only into the physical runtime egress adapter;
it is not copied to a virtual workload Secret. Provider credentials never enter
the preview.

## Storage

The trusted runner creates `StorageClass/preview-jfs-<scope-id>` on the host.
Its JuiceFS `pathPattern` is fixed to
`previews/v1/<scope-id>/${.pvc.name}` and its secret references remain physical.
The vCluster receives a read-only StorageClass projection and non-secret scope
metadata only.

SEA creates deterministic dynamic PVCs:

- `ptx-<sha256(conversation-key)[:32]>` for transcripts
- `pws-<sha256(workspace-key)[:32]>` for shared workspaces

Preview SEA rejects path syntax, caller-supplied prefixes, partial immutable
identity, wrong StorageClass/scope labels, static subPath PVs, and root mounts.
Same-scope seed and purge jobs mount only derived PVCs. Teardown cannot report
complete until `storage-scope-absent` is true.

## Sleep, TTL, And Capacity

`touch` records activity and resumes a slept environment. Explicit sleep scales
the vCluster control plane and synchronized workloads down while retaining its
storage and host route. The lifecycle reaper can enforce explicit expiry,
global TTL, awake capacity, and total capacity.

| Environment variable                           | Default | Purpose                                             |
| ---------------------------------------------- | ------- | --------------------------------------------------- |
| `VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES`         | `0`     | Sleep tracked idle previews.                        |
| `VCLUSTER_PREVIEW_TTL_HOURS`                   | `0`     | Global age limit. Per-preview expiry still applies. |
| `VCLUSTER_PREVIEW_MAX`                         | `6`     | Maximum awake previews.                             |
| `VCLUSTER_PREVIEW_TOTAL_MAX`                   | `0`     | Maximum total previews; `0` is unlimited.           |
| `VCLUSTER_PREVIEW_ACTIVE_MINUTES`              | `30`    | Recently active protection window.                  |
| `VCLUSTER_PREVIEW_LIFECYCLE_RECONCILE_SECONDS` | `60`    | Reaper interval.                                    |

SEA's legacy reaper never submits a down Job for any profiled, trusted cold
PreviewEnvironment. It may sleep mutable `app-live/live` environments and
reports `archiveRequired`; immutable reconciled and manifest candidates report
`applicationReaperRequired`. The persistent BFF lifecycle reaper owns expiry:
it archives mutable environments, directly admits immutable environments, then
sends an exact guarded teardown to the physical broker. `retained` means keep
the environment until explicit teardown or its bounded expiry, not forever.

After a successful host archive, an explicit mutable-live teardown must present
both the exact request/source ownership tuple and
`X-Preview-Archive-Teardown-Token`, timing-safe equal to the host SEA's
`PREVIEW_ARCHIVE_TEARDOWN_TOKEN`. The static proof is shared only by the host BFF
and host SEA. It is not a runner environment variable, capability leaf, virtual
Secret, or vCluster workload credential. Missing archive/provenance proof
preserves the environment.

The physical broker is the only hub desired-state writer. It deletes the exact
UID/request/source-owned PreviewEnvironment and waits for both controller
finalizers before asking SEA to run `down`. The hub controller only marks an
expired CR `Expired`; it never initiates deletion. This ordering prevents an
orphan Argo Application or agent registration when TTL cleanup races with SEA.

## Completion Proof

The down runner succeeds only after proving all broker-owned resources absent:

- PreviewEnvironment and Argo application
- agent registration and namespaces
- isolated database and local NATS state
- Headlamp registration and tailnet egress
- host vCluster namespace
- tuple-derived storage scope

SEA independently observes runner success and host namespace absence. The
application treats the complete cleanup-check set, including
`storage-scope-absent`, as mandatory.
