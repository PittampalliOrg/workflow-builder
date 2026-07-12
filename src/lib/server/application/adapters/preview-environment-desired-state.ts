import { env } from "$env/dynamic/private";
import { createHash } from "node:crypto";
import { kubeApiFetchFromKubeconfig } from "$lib/server/kube/client";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";
import {
  PreviewEnvironmentDesiredStateConflictError,
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
  PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS,
} from "$lib/server/application/ports";
import type {
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentDeletionAcknowledgement,
  PreviewEnvironmentDeletionIntent,
  PreviewEnvironmentDeletionOutboxPort,
  PreviewEnvironmentDesiredStateDeleteGuard,
  PreviewEnvironmentDesiredStatePort,
  PreviewEnvironmentDesiredStateSnapshot,
  PreviewEnvironmentVersionedServiceCatalogPort,
  ValidatedPreviewEnvironmentLaunchSpec,
  VclusterPreviewGatewayPort,
  VclusterPreviewLaunchInput,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

export {
  PreviewEnvironmentDesiredStateConflictError,
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
} from "$lib/server/application/ports";

const API_GROUP = "preview.stacks.io";
const API_VERSION = "v1alpha1";
const API_PLURAL = "previewenvironments";
const CONTROL_NAMESPACE = "preview-system";
const ENVIRONMENT_CLEANUP_FINALIZER = "preview.stacks.io/environment-cleanup";
const API_PATH = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${CONTROL_NAMESPACE}/${API_PLURAL}`;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const KUBERNETES_UID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNNER_GENERATION = /^op:[0-9a-f]{32}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const PHASES = new Set([
  "Failed",
  "Blocked",
  "Provisioning",
  "Ready",
  "Expired",
  "Terminating",
]);
const CLEANUP_CHECK_NAMES = [
  "runnerSucceeded",
  "previewEnvironmentAbsent",
  "applicationAbsent",
  "agentRegistrationAbsent",
  "agentNamespacesAbsent",
  "databaseAbsent",
  "natsStreamAbsent",
  "headlampRegistrationAbsent",
  "tailnetEgressAbsent",
  "hostNamespaceAbsent",
  "storageScopeAbsent",
  "runnerIdentityAbsent",
] as const;

type KubeFetch = (
  path: string,
  init?: RequestInit & { retries?: number },
) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export type KubernetesPreviewEnvironmentDesiredStateOptions = Readonly<{
  fetch: KubeFetch;
  sleep?: Sleep;
  pollMs?: number;
  now?: () => number;
}>;

type HubKubeconfigEnvironment = Readonly<Record<string, string | undefined>>;

/** Build the only allowed transport for hub PreviewEnvironment authority. */
export function previewEnvironmentHubKubeFetch(
  environment: HubKubeconfigEnvironment = {
    ...process.env,
    PREVIEW_ENVIRONMENT_HUB_KUBECONFIG: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG,
    PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH:
      env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH,
    PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT:
      env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT,
    PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML:
      env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML,
    PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT:
      env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT,
  },
  remoteFetch: typeof kubeApiFetchFromKubeconfig = kubeApiFetchFromKubeconfig,
): KubeFetch {
  const kubeconfigPath = (
    environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG ??
    environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH ??
    ""
  ).trim();
  const kubeconfigContent = (
    environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT ??
    environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML ??
    ""
  ).trim();
  const context = (
    environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT ?? ""
  ).trim();
  if (!kubeconfigPath && !kubeconfigContent) {
    throw new PreviewEnvironmentDesiredStateError(
      "preview desired-state hub kubeconfig is not configured; set PREVIEW_ENVIRONMENT_HUB_KUBECONFIG",
    );
  }
  return (path, init = {}) =>
    remoteFetch(path, init, {
      ...(kubeconfigPath ? { kubeconfigPath } : {}),
      ...(kubeconfigContent ? { kubeconfigContent } : {}),
      ...(context ? { context } : {}),
    });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resourcePath(name: string): string {
  return `${API_PATH}/${encodeURIComponent(name)}`;
}

function expiresAt(input: ValidatedPreviewEnvironmentLaunchSpec): string {
  return new Date(
    Date.parse(input.provenance.requestedAt) + input.ttlHours * 60 * 60 * 1_000,
  ).toISOString();
}

export function buildPreviewEnvironmentDesiredStateManifest(
  input: ValidatedPreviewEnvironmentLaunchSpec,
): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    id: input.name,
    platformRevision: input.platformRevision,
    sourceRevision: input.sourceRevision,
    catalogDigest: input.catalogDigest,
    lane: input.lane,
    profile: input.profile,
    mode: input.mode,
    lifecycle: input.lifecycle,
    owner: input.owner,
    origin: input.origin,
    services: [...input.services],
    provenance: input.provenance,
    images: input.imageOverrides,
    allocation: input.allocation,
    trustedCode: true,
    ttlHours: input.ttlHours,
    expiresAt: expiresAt(input),
  };
  if (input.profile === "manifest-candidate") {
    spec.candidatePaths = [...input.candidatePaths];
  }
  return {
    apiVersion: `${API_GROUP}/${API_VERSION}`,
    kind: "PreviewEnvironment",
    metadata: {
      name: input.name,
      namespace: CONTROL_NAMESPACE,
      finalizers: [ENVIRONMENT_CLEANUP_FINALIZER],
      labels: {
        "preview.stacks.io/broker-managed": "true",
      },
      annotations: {
        "preview.stacks.io/request-id": input.provenance.requestId,
        "preview.stacks.io/platform-revision": input.platformRevision,
        "preview.stacks.io/source-revision": input.sourceRevision,
        "preview.stacks.io/catalog-digest": input.catalogDigest,
      },
    },
    spec,
  };
}

function deletionIntent(
  resource: Record<string, unknown>,
): PreviewEnvironmentDeletionIntent {
  const meta = metadata(resource);
  const spec = resourceSpec(resource);
  const name = meta.name;
  const environmentUid = meta.uid;
  const deletionTimestamp = meta.deletionTimestamp;
  const provenance = record(spec.provenance);
  const requestId = provenance?.requestId;
  const platformRevision = spec.platformRevision;
  const sourceRevision = spec.sourceRevision;
  const catalogDigest = spec.catalogDigest;
  const finalizers = Array.isArray(meta.finalizers) ? meta.finalizers : [];
  if (
    typeof name !== "string" ||
    typeof environmentUid !== "string" ||
    !KUBERNETES_UID.test(environmentUid) ||
    typeof deletionTimestamp !== "string" ||
    !deletionTimestamp ||
    typeof requestId !== "string" ||
    !requestId ||
    typeof platformRevision !== "string" ||
    !FULL_SHA.test(platformRevision) ||
    typeof sourceRevision !== "string" ||
    !FULL_SHA.test(sourceRevision) ||
    typeof catalogDigest !== "string" ||
    !SHA256.test(catalogDigest) ||
    !finalizers.includes(ENVIRONMENT_CLEANUP_FINALIZER)
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "deleting PreviewEnvironment has an incomplete outbox identity",
    );
  }
  const payload = {
    name,
    environmentUid,
    requestId,
    platformRevision,
    sourceRevision,
    catalogDigest,
    deletionTimestamp,
  };
  return {
    id: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`,
    ...payload,
    sourceRevision:
      sourceRevision as PreviewEnvironmentDeletionIntent["sourceRevision"],
    platformRevision:
      platformRevision as PreviewEnvironmentDeletionIntent["platformRevision"],
    catalogDigest:
      catalogDigest as PreviewEnvironmentDeletionIntent["catalogDigest"],
  };
}

function assertIntentStatus(
  resource: Record<string, unknown>,
  expected: PreviewEnvironmentDeletionIntent,
): void {
  const status = record(resource.status);
  const observed = record(status?.deletionIntent);
  if (!observed || canonical(observed) !== canonical(expected)) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment deletion intent does not match its immutable tuple",
    );
  }
}

function acknowledgementMatches(
  value: unknown,
  intent: PreviewEnvironmentDeletionIntent,
  nowMs: number,
): boolean {
  const ack = record(value);
  const runner = record(ack?.runner);
  const checks = record(ack?.checks);
  const observedAt =
    typeof ack?.observedAt === "string" && RFC3339_UTC.test(ack.observedAt)
      ? Date.parse(ack.observedAt)
      : Number.NaN;
  const deletionTimestamp = Date.parse(intent.deletionTimestamp);
  return Boolean(
    ack &&
    ack.intentId === intent.id &&
    ack.environmentUid === intent.environmentUid &&
    ack.requestId === intent.requestId &&
    ack.platformRevision === intent.platformRevision &&
    ack.sourceRevision === intent.sourceRevision &&
    ack.catalogDigest === intent.catalogDigest &&
    Number.isFinite(observedAt) &&
    Number.isFinite(deletionTimestamp) &&
    observedAt >= deletionTimestamp &&
    observedAt <= nowMs + 5 * 60_000 &&
    typeof ack.resourceName === "string" &&
    ack.resourceName === intent.name &&
    runner &&
    typeof runner.jobName === "string" &&
    runner.jobName === `vcpreview-down-${intent.name}` &&
    typeof runner.jobUid === "string" &&
    KUBERNETES_UID.test(runner.jobUid) &&
    typeof runner.generation === "string" &&
    RUNNER_GENERATION.test(runner.generation) &&
    checks &&
    Object.keys(checks).length ===
      PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS.length &&
    PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS.every(
      (name) => checks[name] === true,
    ),
  );
}

async function responseObject(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  const value = record(body);
  if (!value) {
    throw new PreviewEnvironmentDesiredStateError(
      `${operation} returned a non-object Kubernetes response`,
    );
  }
  return value;
}

async function responseFailure(
  response: Response,
  operation: string,
): Promise<PreviewEnvironmentDesiredStateError> {
  const body = (await response.text().catch(() => "")).slice(0, 1_024);
  return new PreviewEnvironmentDesiredStateError(
    `${operation} failed (HTTP ${response.status})${body ? `: ${body}` : ""}`,
  );
}

function metadata(resource: Record<string, unknown>) {
  const value = record(resource.metadata);
  if (!value) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment response has no metadata",
    );
  }
  return value;
}

function resourceSpec(resource: Record<string, unknown>) {
  const value = record(resource.spec);
  if (!value) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment response has no spec",
    );
  }
  return value;
}

function assertResourceEnvelope(
  resource: Record<string, unknown>,
  expectedName: string,
): { uid: string; generation: number; spec: Record<string, unknown> } {
  const meta = metadata(resource);
  const spec = resourceSpec(resource);
  const uid = typeof meta.uid === "string" ? meta.uid : "";
  const generation = meta.generation;
  if (
    resource.apiVersion !== `${API_GROUP}/${API_VERSION}` ||
    resource.kind !== "PreviewEnvironment" ||
    meta.name !== expectedName ||
    meta.namespace !== CONTROL_NAMESPACE ||
    !uid ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    spec.id !== expectedName
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment response does not identify the requested resource",
    );
  }
  return { uid, generation: generation as number, spec };
}

function assertStatusProof(
  resource: Record<string, unknown>,
  spec: Record<string, unknown>,
  generation: number,
): PreviewEnvironmentDesiredStateSnapshot["phase"] {
  const status = record(resource.status);
  if (!status || Object.keys(status).length === 0) return "Pending";
  const phase = status.phase;
  if (typeof phase !== "string" || !PHASES.has(phase)) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment status has an invalid phase",
    );
  }
  for (const field of [
    "platformRevision",
    "sourceRevision",
    "catalogDigest",
  ] as const) {
    if (status[field] !== undefined && status[field] !== spec[field]) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        `PreviewEnvironment status.${field} does not match spec`,
      );
    }
  }
  if (
    status.images !== undefined &&
    canonical(status.images) !== canonical(spec.images)
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment status.images does not match spec",
    );
  }
  if (
    status.observedGeneration !== undefined &&
    (!Number.isSafeInteger(status.observedGeneration) ||
      (status.observedGeneration as number) < 1 ||
      (status.observedGeneration as number) > generation)
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment status has an invalid observedGeneration",
    );
  }
  if (phase === "Ready") {
    const application = record(status.application);
    const expectedAgent = `preview-${String(spec.id)}`;
    if (
      status.observedGeneration !== generation ||
      status.platformRevision !== spec.platformRevision ||
      status.sourceRevision !== spec.sourceRevision ||
      status.catalogDigest !== spec.catalogDigest ||
      canonical(status.images) !== canonical(spec.images) ||
      application?.namespace !== expectedAgent ||
      application.name !== `${expectedAgent}-workflow-builder`
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "Ready PreviewEnvironment status is not bound to the current contract",
      );
    }
  }
  return phase as PreviewEnvironmentDesiredStateSnapshot["phase"];
}

function snapshot(
  resource: Record<string, unknown>,
  input: ValidatedPreviewEnvironmentLaunchSpec,
): PreviewEnvironmentDesiredStateSnapshot {
  const envelope = assertResourceEnvelope(resource, input.name);
  const desiredSpec = record(
    buildPreviewEnvironmentDesiredStateManifest(input).spec,
  )!;
  if (canonical(envelope.spec) !== canonical(desiredSpec)) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment spec does not exactly match the launch contract",
    );
  }
  const phase = assertStatusProof(resource, envelope.spec, envelope.generation);
  return {
    name: input.name,
    uid: envelope.uid,
    generation: envelope.generation,
    phase,
    ready: phase === "Ready",
  };
}

function deletionIdentity(
  resource: Record<string, unknown>,
  expectedName: string,
  guard: PreviewEnvironmentDesiredStateDeleteGuard,
) {
  const envelope = assertResourceEnvelope(resource, expectedName);
  const provenance = record(envelope.spec.provenance);
  const requestId = provenance?.requestId;
  const sourceRevision = envelope.spec.sourceRevision;
  if (
    typeof requestId !== "string" ||
    !requestId ||
    typeof sourceRevision !== "string" ||
    !FULL_SHA.test(sourceRevision) ||
    typeof envelope.spec.platformRevision !== "string" ||
    !FULL_SHA.test(envelope.spec.platformRevision) ||
    typeof envelope.spec.catalogDigest !== "string" ||
    !SHA256.test(envelope.spec.catalogDigest)
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment deletion identity is incomplete",
    );
  }
  assertStatusProof(resource, envelope.spec, envelope.generation);
  if (
    guard?.mode === "owned" &&
    (guard.requestId !== requestId || guard.sourceRevision !== sourceRevision)
  ) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment deletion guard does not own the current contract",
    );
  }
  if (guard?.mode === "superseded" && guard.protectedRequestId === requestId) {
    throw new PreviewEnvironmentDesiredStateOwnershipError(
      "PreviewEnvironment deletion would remove the protected contract",
    );
  }
  return { ...envelope, requestId, sourceRevision };
}

export class KubernetesPreviewEnvironmentDesiredStateAdapter
  implements
    PreviewEnvironmentDesiredStatePort,
    PreviewEnvironmentDeletionOutboxPort
{
  private readonly fetchImpl: KubeFetch;
  private readonly sleep: Sleep;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(options: KubernetesPreviewEnvironmentDesiredStateOptions) {
    this.fetchImpl = options.fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  async create(
    input: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentDesiredStateSnapshot> {
    const desired = buildPreviewEnvironmentDesiredStateManifest(input);
    let response: Response;
    try {
      response = await this.fetchImpl(API_PATH, {
        method: "POST",
        body: JSON.stringify(desired),
        retries: 0,
      });
    } catch (cause) {
      try {
        const observed = await this.inspect(input);
        if (observed) return observed;
      } catch (inspectionCause) {
        if (
          inspectionCause instanceof
          PreviewEnvironmentDesiredStateOwnershipError
        ) {
          throw inspectionCause;
        }
        throw new PreviewEnvironmentDesiredStateError(
          "PreviewEnvironment create failed and its durable result could not be inspected",
          { cause: new AggregateError([cause, inspectionCause]) },
        );
      }
      throw new PreviewEnvironmentDesiredStateError(
        "PreviewEnvironment create failed before ownership could be proved",
        { cause },
      );
    }
    if (response.status === 409) {
      try {
        const observed = await this.inspect(input);
        if (observed) return observed;
      } catch (cause) {
        if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
          throw new PreviewEnvironmentDesiredStateConflictError(input.name, {
            cause,
          });
        }
        throw cause;
      }
      throw new PreviewEnvironmentDesiredStateConflictError(input.name);
    }
    if (!response.ok)
      throw await responseFailure(response, "PreviewEnvironment create");
    const created = snapshot(
      await responseObject(response, "PreviewEnvironment create"),
      input,
    );
    const observed = await this.inspect(input);
    if (!observed || observed.uid !== created.uid) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment create was not durably observable",
      );
    }
    return observed;
  }

  async inspect(
    input: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentDesiredStateSnapshot | null> {
    const response = await this.fetchImpl(resourcePath(input.name), {
      retries: 0,
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw await responseFailure(response, "PreviewEnvironment read");
    return snapshot(
      await responseObject(response, "PreviewEnvironment read"),
      input,
    );
  }

  async deleteAndWait(
    input: Readonly<{
      name: string;
      guard: PreviewEnvironmentDesiredStateDeleteGuard;
      timeoutMs: number;
    }>,
  ): Promise<void> {
    if (!input.guard) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment deletion requires an ownership guard",
      );
    }
    const initial = await this.readForDeletion(input.name);
    if (!initial) return;
    const identity = deletionIdentity(initial, input.name, input.guard);
    const response = await this.fetchImpl(resourcePath(input.name), {
      method: "DELETE",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Background",
        preconditions: {
          uid: identity.uid,
        },
      }),
      retries: 0,
    });
    if (response.status !== 404 && !response.ok) {
      throw await responseFailure(response, "PreviewEnvironment delete");
    }
    const deadline = this.now() + input.timeoutMs;
    while (this.now() <= deadline) {
      const current = await this.readForDeletion(input.name);
      if (!current) return;
      const observed = deletionIdentity(current, input.name, input.guard);
      if (observed.uid !== identity.uid) {
        throw new PreviewEnvironmentDesiredStateOwnershipError(
          "PreviewEnvironment was replaced while deletion was pending",
        );
      }
      await this.sleep(this.pollMs);
    }
    throw new PreviewEnvironmentDesiredStateError(
      `PreviewEnvironment ${input.name} finalizers did not converge`,
    );
  }

  async absent(name: string): Promise<boolean> {
    return (await this.readForDeletion(name)) === null;
  }

  async listPending(): Promise<readonly PreviewEnvironmentDeletionIntent[]> {
    const response = await this.fetchImpl(API_PATH, { retries: 0 });
    if (!response.ok)
      throw await responseFailure(response, "PreviewEnvironment deletion list");
    const list = await responseObject(
      response,
      "PreviewEnvironment deletion list",
    );
    if (!Array.isArray(list.items)) {
      throw new PreviewEnvironmentDesiredStateError(
        "PreviewEnvironment deletion list returned no items array",
      );
    }
    const pending: PreviewEnvironmentDeletionIntent[] = [];
    for (const item of list.items) {
      const resource = record(item);
      if (!resource) {
        throw new PreviewEnvironmentDesiredStateOwnershipError(
          "PreviewEnvironment deletion list contains a non-object resource",
        );
      }
      const meta = metadata(resource);
      if (!meta.deletionTimestamp) continue;
      const intent = deletionIntent(resource);
      assertIntentStatus(resource, intent);
      const status = record(resource.status);
      if (
        acknowledgementMatches(
          status?.deletionAcknowledgement,
          intent,
          this.now(),
        )
      )
        continue;
      pending.push(intent);
    }
    return pending;
  }

  async acknowledge(
    intent: PreviewEnvironmentDeletionIntent,
    acknowledgement: PreviewEnvironmentDeletionAcknowledgement,
  ): Promise<void> {
    if (!acknowledgementMatches(acknowledgement, intent, this.now())) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment deletion acknowledgement is not exact",
      );
    }
    const current = await this.readForDeletion(intent.name);
    if (!current) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment disappeared before cleanup acknowledgement",
      );
    }
    const observed = deletionIntent(current);
    assertIntentStatus(current, observed);
    if (canonical(observed) !== canonical(intent)) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment deletion intent changed before acknowledgement",
      );
    }
    const resourceVersion = metadata(current).resourceVersion;
    if (typeof resourceVersion !== "string" || !resourceVersion) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment resourceVersion is missing before acknowledgement",
      );
    }
    const response = await this.fetchImpl(
      `${resourcePath(intent.name)}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          metadata: { resourceVersion },
          status: { deletionAcknowledgement: acknowledgement },
        }),
        retries: 0,
      },
    );
    if (!response.ok) {
      throw await responseFailure(
        response,
        "PreviewEnvironment cleanup acknowledgement",
      );
    }
    const patched = await responseObject(
      response,
      "PreviewEnvironment cleanup acknowledgement",
    );
    const patchedStatus = record(patched.status);
    if (
      !acknowledgementMatches(
        patchedStatus?.deletionAcknowledgement,
        intent,
        this.now(),
      )
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment cleanup acknowledgement was not durably observed",
      );
    }
  }

  private async readForDeletion(
    name: string,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(resourcePath(name), { retries: 0 });
    if (response.status === 404) return null;
    if (!response.ok)
      throw await responseFailure(response, "PreviewEnvironment read");
    return responseObject(response, "PreviewEnvironment read");
  }
}

function commandFromGatewayInput(
  input: { name: string } & VclusterPreviewLaunchInput,
  catalog: PreviewEnvironmentVersionedServiceCatalogPort,
): ValidatedPreviewEnvironmentLaunchSpec {
  const profile = input.profile ?? "app-live";
  const mode =
    input.mode ?? (profile === "manifest-candidate" ? "reconciled" : "live");
  const catalogDigest = catalog.currentDigest();
  if (
    input.ttlHours === undefined ||
    input.lifecycle === undefined ||
    input.allocation === undefined ||
    input.catalogDigest !== catalogDigest
  ) {
    throw new PreviewEnvironmentDesiredStateError(
      "SEA provision input lacks the exact bounded desired-state contract",
    );
  }
  return validatePreviewEnvironmentLaunchSpec(
    {
      name: input.name,
      profile,
      lane: input.lane ?? "application",
      capabilities: [
        profile === "manifest-candidate"
          ? "namespaced-manifests"
          : mode === "reconciled"
            ? "immutable-image-replay"
            : "service-live-sync",
      ],
      platformRevision: input.platformRevision ?? "",
      sourceRevision: input.sourceRevision ?? "",
      services: input.services ?? [],
      candidatePaths: input.candidatePaths ?? [],
      owner: input.owner ?? { kind: "automation", id: "missing-owner" },
      origin: input.origin ?? { kind: "automation" },
      ttlHours: input.ttlHours,
      mode,
      imageOverrides: input.imageOverrides,
      lifecycle: input.lifecycle,
      allocation: input.allocation,
      provenance: input.provenance as never,
    },
    catalogDigest,
  );
}

export type DesiredStateVclusterPreviewGatewayOptions = Readonly<{
  gateway: VclusterPreviewGatewayPort;
  desiredState: PreviewEnvironmentDesiredStatePort;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort;
  compensationTimeoutMs?: number;
}>;

/**
 * Transaction boundary between hub desired state and SEA execution.
 *
 * Ordering is intentional: create CR, then SEA up. Deletion is controller-driven:
 * the CR finalizer publishes an intent, the dev broker proves SEA down, and only
 * then does the hub controller release resources/finalizers. A runner therefore
 * never needs a hub kubeconfig or cross-preview RBAC.
 */
export class DesiredStateVclusterPreviewGateway implements VclusterPreviewGatewayPort {
  constructor(
    private readonly options: DesiredStateVclusterPreviewGatewayOptions,
  ) {}

  listWithCounts() {
    return this.options.gateway.listWithCounts();
  }

  get(name: string) {
    return this.options.gateway.get(name);
  }

  async provision(
    input: { name: string } & VclusterPreviewLaunchInput,
  ): Promise<VclusterPreviewRecord> {
    const command = commandFromGatewayInput(input, this.options.catalog);
    await this.options.desiredState.create(command);
    try {
      const preview = await this.options.gateway.provision(input);
      const observed = await this.options.desiredState.inspect(command);
      if (!observed) {
        throw new PreviewEnvironmentDesiredStateOwnershipError(
          "PreviewEnvironment disappeared after SEA provision",
        );
      }
      if (preview.name !== command.name) {
        throw new PreviewEnvironmentDesiredStateOwnershipError(
          "SEA provision returned a different preview identity",
        );
      }
      return preview;
    } catch (cause) {
      try {
        await this.compensate(command);
      } catch (compensationCause) {
        throw new PreviewEnvironmentDesiredStateError(
          `preview ${input.name} provision failed and compensation also failed`,
          { cause: new AggregateError([cause, compensationCause]) },
        );
      }
      throw new PreviewEnvironmentDesiredStateError(
        `preview ${input.name} provision failed and was compensated`,
        { cause },
      );
    }
  }

  async teardown(
    name: string,
    guard: Parameters<VclusterPreviewGatewayPort["teardown"]>[1],
  ): Promise<VclusterPreviewRecord> {
    if (!guard) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview teardown requires an ownership guard",
      );
    }
    await this.options.desiredState.deleteAndWait({
      name,
      guard,
      timeoutMs: this.options.compensationTimeoutMs ?? 20 * 60_000,
    });
    const cleanup = await this.options.gateway.cleanup(name);
    if (!cleanup.complete) {
      throw new PreviewEnvironmentDesiredStateError(
        `PreviewEnvironment ${name} disappeared without durable physical cleanup proof`,
      );
    }
    return {
      name,
      phase: "absent",
      ready: false,
      url: null,
      targetCluster: "dev",
      pool: null,
      state: null,
      lifecycle: null,
      origin: null,
      legacyOrigin: null,
      prNumber: null,
      expiresAt: null,
      lastActive: null,
      protected: false,
      bootSeconds: null,
      platformRevision: null,
      sourceRevision: guard.mode === "owned" ? guard.sourceRevision : null,
      profile: null,
      lane: null,
      mode: null,
      owner: null,
      services: null,
      provenance: null,
      trustedCode: null,
      allocation: null,
      images: null,
      catalogDigest: null,
    };
  }

  runtime(name: string) {
    return this.options.gateway.runtime(name);
  }

  async cleanup(name: string) {
    const cleanup = await this.options.gateway.cleanup(name);
    const desiredStateAbsent = await this.options.desiredState.absent(name);
    const checks = {
      ...cleanup.checks,
      previewEnvironmentAbsent: desiredStateAbsent,
      applicationAbsent: desiredStateAbsent,
      agentRegistrationAbsent: desiredStateAbsent,
      agentNamespacesAbsent: desiredStateAbsent,
      headlampRegistrationAbsent: desiredStateAbsent,
    };
    const complete =
      cleanup.phase !== "failed" && Object.values(checks).every(Boolean);
    return {
      ...cleanup,
      complete,
      phase: complete ? ("complete" as const) : cleanup.phase,
      checks,
      message: complete ? null : cleanup.message,
    };
  }

  touch(name: string) {
    return this.options.gateway.touch(name);
  }

  sleep(name: string) {
    return this.options.gateway.sleep(name);
  }

  private async compensate(
    command: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<void> {
    const guard = {
      mode: "owned" as const,
      requestId: command.provenance.requestId,
      sourceRevision: command.sourceRevision,
    };
    await this.options.desiredState.deleteAndWait({
      name: command.name,
      guard,
      timeoutMs: this.options.compensationTimeoutMs ?? 20 * 60_000,
    });
  }
}

export type BrokeredVclusterPreviewGatewayOptions = Readonly<{
  gateway: VclusterPreviewGatewayPort;
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

/**
 * Persistent-BFF gateway: reads and sleep/wake remain on SEA, while destructive
 * commands cross the authenticated physical-broker boundary.
 */
export class BrokeredVclusterPreviewGateway implements VclusterPreviewGatewayPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: BrokeredVclusterPreviewGatewayOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  listWithCounts() {
    return this.options.gateway.listWithCounts();
  }

  get(name: string) {
    return this.options.gateway.get(name);
  }

  provision(): Promise<VclusterPreviewRecord> {
    throw new PreviewEnvironmentDesiredStateError(
      "preview provision must use the physical environment launch broker",
    );
  }

  async teardown(
    name: string,
    guard: Parameters<VclusterPreviewGatewayPort["teardown"]>[1],
  ): Promise<VclusterPreviewRecord> {
    if (!guard) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "brokered preview teardown requires an ownership guard",
      );
    }
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ??
      env.PREVIEW_CONTROL_BROKER_TOKEN ??
      process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
      ""
    ).trim();
    if (!baseUrl || !token) {
      throw new PreviewEnvironmentDesiredStateError(
        "physical preview lifecycle broker is not configured",
      );
    }
    const requestTeardown = () =>
      this.fetchImpl(
        `${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(name)}/teardown`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Preview-Control-Broker-Token": token,
          },
          body: JSON.stringify({ guard }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 25 * 60_000),
        },
      );
    let response: Response;
    try {
      response = await requestTeardown();
    } catch (cause) {
      // The broker operation is idempotent and ownership-fenced. A long-running
      // cleanup can outlive Undici's response-header window even though it keeps
      // converging, so replay the exact command once and still require its receipt.
      if (!(cause instanceof TypeError)) throw cause;
      response = await requestTeardown();
    }
    const body = (await response.json().catch(() => null)) as unknown;
    const envelope = record(body);
    if (!response.ok) {
      throw new PreviewEnvironmentDesiredStateError(
        typeof envelope?.error === "string"
          ? envelope.error
          : `physical preview teardown failed (HTTP ${response.status})`,
      );
    }
    const preview = record(envelope?.preview);
    const receipt = record(envelope?.receipt);
    if (
      !preview ||
      preview.name !== name ||
      typeof preview.phase !== "string" ||
      !receipt ||
      receipt.name !== name ||
      receipt.desiredStateAbsent !== true ||
      canonical(receipt.guard) !== canonical(guard)
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview teardown returned a mismatched ownership receipt",
      );
    }
    return preview as unknown as VclusterPreviewRecord;
  }

  runtime(name: string) {
    return this.options.gateway.runtime(name);
  }

  async cleanup(name: string) {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ??
      env.PREVIEW_CONTROL_BROKER_TOKEN ??
      process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
      ""
    ).trim();
    if (!baseUrl || !token) {
      throw new PreviewEnvironmentDesiredStateError(
        "physical preview lifecycle broker is not configured",
      );
    }
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(name)}/cleanup`,
      {
        headers: { "X-Preview-Control-Broker-Token": token },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 25 * 60_000),
      },
    );
    const body = record(await response.json().catch(() => null));
    if (!response.ok) {
      throw new PreviewEnvironmentDesiredStateError(
        typeof body?.error === "string"
          ? body.error
          : `physical preview cleanup proof failed (HTTP ${response.status})`,
      );
    }
    const cleanup = record(body?.cleanup);
    const checks = record(cleanup?.checks);
    if (
      !cleanup ||
      cleanup.name !== name ||
      typeof cleanup.resourceName !== "string" ||
      typeof cleanup.complete !== "boolean" ||
      !["pending", "complete", "failed"].includes(String(cleanup.phase)) ||
      !checks ||
      Object.keys(checks).length !== CLEANUP_CHECK_NAMES.length ||
      CLEANUP_CHECK_NAMES.some((key) => typeof checks[key] !== "boolean") ||
      (cleanup.message !== null && typeof cleanup.message !== "string")
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview cleanup returned an invalid proof",
      );
    }
    return cleanup as unknown as Awaited<
      ReturnType<VclusterPreviewGatewayPort["cleanup"]>
    >;
  }

  touch(name: string) {
    return this.options.gateway.touch(name);
  }

  sleep(name: string) {
    return this.options.gateway.sleep(name);
  }
}
