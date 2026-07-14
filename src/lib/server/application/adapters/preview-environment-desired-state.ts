import { env } from "$env/dynamic/private";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { kubeApiFetchFromKubeconfig } from "$lib/server/kube/client";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";
import {
  PreviewEnvironmentDesiredStateConflictError,
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
  PreviewRuntimeIdentityChangedError,
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
  PreviewControlIdentity,
  PreviewEnvironmentObservationReaderPort,
  PreviewEnvironmentTeardownCommandPort,
  PreviewEnvironmentTeardownStatusPort,
  TupleBoundVclusterPreviewRuntimeSnapshot,
  ValidatedPreviewEnvironmentLaunchSpec,
  VclusterPreviewGatewayPort,
  VclusterPreviewLaunchInput,
} from "$lib/server/application/ports";
import type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewRecord,
  VclusterPreviewTeardownAcceptance,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";
import {
  localPreviewControlCapability,
  localPreviewControlIdentity,
} from "$lib/server/preview-control-capability";

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
const HMAC_KEY = /^[0-9a-f]{64}$/;
const KUBERNETES_UID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNNER_GENERATION = /^op:[0-9a-f]{32}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 30_000;
const MIN_OBSERVATION_TIMEOUT_MS = 5_000;
const MAX_OBSERVATION_TIMEOUT_MS = 60_000;

function teardownTicketRoot(): string {
  const root = (
    env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    ""
  ).trim();
  if (!HMAC_KEY.test(root)) {
    throw new PreviewEnvironmentDesiredStateError(
      "preview teardown ticket authority is not configured",
    );
  }
  return root;
}

function teardownTicketSignature(
  ticket: Omit<VclusterPreviewTeardownTicket, "signature">,
): string {
  return createHmac("sha256", Buffer.from(teardownTicketRoot(), "hex"))
    .update(
      [
        "preview-teardown:v1",
        ticket.name,
        ticket.environmentUid,
        ticket.requestId,
        ticket.sourceRevision,
        "",
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

function verifyTeardownTicket(ticket: VclusterPreviewTeardownTicket): boolean {
  if (!HMAC_KEY.test(ticket.signature)) return false;
  const expected = teardownTicketSignature({
    name: ticket.name,
    environmentUid: ticket.environmentUid,
    requestId: ticket.requestId,
    sourceRevision: ticket.sourceRevision,
  });
  return timingSafeEqual(
    Buffer.from(ticket.signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function retryableTransportFailure(cause: unknown): boolean {
  return (
    cause instanceof TypeError ||
    (cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError"))
  );
}
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

export function boundedObservationTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_OBSERVATION_TIMEOUT_MS;
  }
  return Math.max(
    MIN_OBSERVATION_TIMEOUT_MS,
    Math.min(MAX_OBSERVATION_TIMEOUT_MS, Math.trunc(value)),
  );
}

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

function samePreviewIdentity(
  left: PreviewControlIdentity,
  right: PreviewControlIdentity,
): boolean {
  return canonical(left) === canonical(right);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizePreviewRecord(
  value: unknown,
  identity: PreviewControlIdentity,
): VclusterPreviewRecord {
  const input = record(value);
  const provenance = record(input?.provenance);
  const owner = record(input?.owner);
  const origin = record(input?.origin);
  const allocation = record(input?.allocation);
  const images = record(input?.images);
  const state = input?.state;
  const lifecycle = input?.lifecycle;
  const legacyOrigin = input?.legacyOrigin;
  const profile = input?.profile;
  const lane = input?.lane;
  const mode = input?.mode;
  if (
    !input ||
    input.name !== identity.previewName ||
    typeof input.phase !== "string" ||
    typeof input.ready !== "boolean" ||
    !nullableString(input.url) ||
    typeof input.targetCluster !== "string" ||
    !nullableString(input.pool) ||
    (state !== null && state !== "hot" && state !== "slept") ||
    (lifecycle !== null && lifecycle !== "ephemeral" && lifecycle !== "retained") ||
    !nullableString(input.expiresAt) ||
    !nullableString(input.lastActive) ||
    typeof input.protected !== "boolean" ||
    (input.bootSeconds !== null && typeof input.bootSeconds !== "number") ||
    input.platformRevision !== identity.environmentPlatformRevision ||
    input.sourceRevision !== identity.environmentSourceRevision ||
    (profile !== null &&
      profile !== "app-live" &&
      profile !== "manifest-candidate" &&
      profile !== "host-candidate") ||
    (lane !== null && lane !== "application" && lane !== "management") ||
    (mode !== null && mode !== "live" && mode !== "reconciled") ||
    (legacyOrigin !== null && legacyOrigin !== "user" && legacyOrigin !== "pr") ||
    (input.prNumber !== null && typeof input.prNumber !== "number") ||
    input.catalogDigest !== identity.catalogDigest ||
    !provenance ||
    provenance.requestId !== identity.environmentRequestId ||
    (input.trustedCode !== null && typeof input.trustedCode !== "boolean") ||
    (input.services !== null &&
      (!Array.isArray(input.services) ||
        input.services.some((service) => typeof service !== "string"))) ||
    (owner !== null &&
      (!owner ||
        !["user", "workflow", "session", "automation"].includes(
          String(owner.kind),
        ) ||
        typeof owner.id !== "string")) ||
    (origin !== null &&
      (!origin ||
        ![
          "user",
          "pull-request",
          "workflow",
          "interactive-session",
          "automation",
        ].includes(String(origin.kind)) ||
        (origin.reference !== undefined &&
          typeof origin.reference !== "string"))) ||
    (allocation !== null && (!allocation || allocation.kind !== "cold")) ||
    (images !== null &&
      (!images || Object.values(images).some((image) => typeof image !== "string")))
  ) {
    throw new PreviewRuntimeIdentityChangedError(
      "physical preview observation returned an invalid record",
    );
  }

  const normalizedProvenance: Record<string, unknown> = {
    requestId: provenance.requestId,
  };
  for (const key of [
    "requestedAt",
    "platformRepository",
    "sourceRepository",
    "parentEnvironmentId",
  ] as const) {
    const candidate = provenance[key];
    if (candidate === null || typeof candidate === "string") {
      normalizedProvenance[key] = candidate;
    }
  }
  return {
    name: input.name as string,
    phase: input.phase,
    ready: input.ready,
    url: input.url,
    targetCluster: input.targetCluster,
    pool: input.pool,
    state: state as VclusterPreviewRecord["state"],
    lifecycle: lifecycle as VclusterPreviewRecord["lifecycle"],
    origin: origin
      ? {
          kind: origin.kind as NonNullable<VclusterPreviewRecord["origin"]>["kind"],
          ...(typeof origin.reference === "string"
            ? { reference: origin.reference }
            : {}),
        }
      : null,
    legacyOrigin: legacyOrigin as VclusterPreviewRecord["legacyOrigin"],
    prNumber: input.prNumber as number | null,
    expiresAt: input.expiresAt,
    lastActive: input.lastActive,
    protected: input.protected,
    bootSeconds: input.bootSeconds as number | null,
    platformRevision: input.platformRevision,
    sourceRevision: input.sourceRevision,
    profile: profile as VclusterPreviewRecord["profile"],
    lane: lane as VclusterPreviewRecord["lane"],
    mode: mode as VclusterPreviewRecord["mode"],
    owner: owner
      ? {
          kind: owner.kind as NonNullable<VclusterPreviewRecord["owner"]>["kind"],
          id: owner.id as string,
        }
      : null,
    services: input.services as string[] | null,
    provenance: normalizedProvenance,
    trustedCode: input.trustedCode as boolean | null,
    allocation: allocation ? { kind: "cold" } : null,
    images: images ? (images as Record<string, string>) : null,
    catalogDigest: input.catalogDigest,
  };
}

function normalizeRuntimeObservation(
  value: unknown,
  identity: PreviewControlIdentity,
): TupleBoundVclusterPreviewRuntimeSnapshot {
  const input = record(value);
  const observedIdentity = record(input?.identity);
  const upJob = record(input?.upJob);
  if (
    !input ||
    input.name !== identity.previewName ||
    typeof input.resourceName !== "string" ||
    typeof input.reconciliationSucceeded !== "boolean" ||
    !observedIdentity ||
    !samePreviewIdentity(
      observedIdentity as unknown as PreviewControlIdentity,
      identity,
    ) ||
    !upJob ||
    typeof upJob.name !== "string" ||
    ["found", "active", "succeeded", "failed"].some(
      (key) => typeof upJob[key] !== "boolean",
    ) ||
    !Array.isArray(input.services)
  ) {
    throw new PreviewRuntimeIdentityChangedError(
      "physical preview observation returned an invalid runtime receipt",
    );
  }
  const services = input.services.map((rawService) => {
    const service = record(rawService);
    if (
      !service ||
      typeof service.service !== "string" ||
      !Array.isArray(service.containers)
    ) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview observation returned invalid runtime services",
      );
    }
    return {
      service: service.service,
      containers: service.containers.map((rawContainer) => {
        const container = record(rawContainer);
        if (
          !container ||
          typeof container.pod !== "string" ||
          typeof container.image !== "string" ||
          !nullableString(container.imageId) ||
          typeof container.ready !== "boolean"
        ) {
          throw new PreviewRuntimeIdentityChangedError(
            "physical preview observation returned invalid runtime containers",
          );
        }
        return {
          pod: container.pod,
          image: container.image,
          imageId: container.imageId,
          ready: container.ready,
        };
      }),
    };
  });
  return {
    name: input.name,
    resourceName: input.resourceName,
    reconciliationSucceeded: input.reconciliationSucceeded,
    upJob: {
      name: upJob.name,
      found: upJob.found as boolean,
      active: upJob.active as boolean,
      succeeded: upJob.succeeded as boolean,
      failed: upJob.failed as boolean,
    },
    services,
    identity: { ...identity },
  };
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
    const receipt = await this.requestDelete(input);
    if (receipt.state === "absent") return;
    const deadline = this.now() + input.timeoutMs;
    while (this.now() <= deadline) {
      const current = await this.readForDeletion(input.name);
      if (!current) return;
      const observed = deletionIdentity(current, input.name, input.guard);
      if (observed.uid !== receipt.environmentUid) {
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

  async requestDelete(
    input: Readonly<{
      name: string;
      guard: PreviewEnvironmentDesiredStateDeleteGuard;
    }>,
  ) {
    if (!input.guard) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "PreviewEnvironment deletion requires an ownership guard",
      );
    }
    const initial = await this.readForDeletion(input.name);
    if (!initial) {
      return {
        name: input.name,
        environmentUid: null,
        state: "absent" as const,
      };
    }
    const identity = deletionIdentity(initial, input.name, input.guard);
    const response = await this.fetchImpl(resourcePath(input.name), {
      method: "DELETE",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Background",
        preconditions: { uid: identity.uid },
      }),
      retries: 0,
    });
    if (response.status !== 404 && !response.ok) {
      throw await responseFailure(response, "PreviewEnvironment delete");
    }
    if (response.status === 404) {
      return {
        name: input.name,
        environmentUid: null,
        state: "absent" as const,
      };
    }
    return {
      name: input.name,
      environmentUid: identity.uid,
      state: "deletion-requested" as const,
    };
  }

  async observeDelete(
    input: Readonly<{
      name: string;
      environmentUid: string;
      guard: Extract<PreviewEnvironmentDesiredStateDeleteGuard, { mode: "owned" }>;
    }>,
  ): Promise<"pending" | "complete"> {
    const current = await this.readForDeletion(input.name);
    if (!current) return "complete";
    // Kubernetes cannot reuse a namespaced object name until the prior UID and
    // its finalizers are gone. A different current UID therefore proves this
    // signed ticket's generation completed without inspecting the replacement.
    if (assertResourceEnvelope(current, input.name).uid !== input.environmentUid) {
      return "complete";
    }
    const identity = deletionIdentity(current, input.name, input.guard);
    const metadata = record(current.metadata);
    if (typeof metadata?.deletionTimestamp !== "string") {
      throw new PreviewEnvironmentDesiredStateError(
        `PreviewEnvironment ${input.name} is no longer terminating`,
      );
    }
    return "pending";
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
  gateway: VclusterPreviewGatewayPort & PreviewEnvironmentObservationReaderPort;
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
export class DesiredStateVclusterPreviewGateway
  implements
    VclusterPreviewGatewayPort,
    PreviewEnvironmentObservationReaderPort,
    PreviewEnvironmentTeardownCommandPort,
    PreviewEnvironmentTeardownStatusPort
{
  constructor(
    private readonly options: DesiredStateVclusterPreviewGatewayOptions,
  ) {}

  listWithCounts() {
    return this.options.gateway.listWithCounts();
  }

  get(name: string) {
    return this.options.gateway.get(name);
  }

  inspect(
    identity: Parameters<PreviewEnvironmentObservationReaderPort["inspect"]>[0],
  ) {
    return this.options.gateway.inspect(identity);
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
    return this.teardownRecord(name, guard, "absent");
  }

  async request(
    name: string,
    guard: Extract<
      NonNullable<Parameters<VclusterPreviewGatewayPort["teardown"]>[1]>,
      { mode: "owned" }
    >,
  ): Promise<VclusterPreviewTeardownAcceptance> {
    if (!guard) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview teardown requires an ownership guard",
      );
    }
    const deletion = await this.options.desiredState.requestDelete({ name, guard });
    return {
      preview: this.teardownRecord(
        name,
        guard,
        deletion.state === "absent" ? "absent" : "terminating",
      ),
      ticket:
        deletion.state === "absent"
          ? null
          : (() => {
              const ticket = {
                name,
                environmentUid: deletion.environmentUid,
                requestId: guard.requestId,
                sourceRevision: guard.sourceRevision,
              };
              return {
                ...ticket,
                signature: teardownTicketSignature(ticket),
              };
            })(),
    };
  }

  async status(
    ticket: VclusterPreviewTeardownTicket,
  ): Promise<VclusterPreviewCleanupSnapshot> {
    if (!verifyTeardownTicket(ticket)) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "preview teardown ticket is invalid",
      );
    }
    const deletion = await this.options.desiredState.observeDelete({
      name: ticket.name,
      environmentUid: ticket.environmentUid,
      guard: {
        mode: "owned",
        requestId: ticket.requestId,
        sourceRevision: ticket.sourceRevision,
      },
    });
    if (deletion === "complete") return this.completedCleanup(ticket.name);
    return this.withDesiredState(
      await this.options.gateway.cleanup(ticket.name),
      false,
    );
  }

  private teardownRecord(
    name: string,
    guard: NonNullable<Parameters<VclusterPreviewGatewayPort["teardown"]>[1]>,
    phase: "terminating" | "absent",
  ): VclusterPreviewRecord {
    return {
      name,
      phase,
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

  runtimeForIdentity(
    identity: Parameters<VclusterPreviewGatewayPort["runtimeForIdentity"]>[0],
  ) {
    return this.options.gateway.runtimeForIdentity(identity);
  }

  observeRuntime(
    identity: Parameters<PreviewEnvironmentObservationReaderPort["observeRuntime"]>[0],
  ) {
    return this.options.gateway.observeRuntime(identity);
  }

  async cleanup(name: string) {
    const cleanup = await this.options.gateway.cleanup(name);
    return this.withDesiredState(
      cleanup,
      await this.options.desiredState.absent(name),
    );
  }

  private withDesiredState(
    cleanup: VclusterPreviewCleanupSnapshot,
    desiredStateAbsent: boolean,
  ): VclusterPreviewCleanupSnapshot {
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
      phase: complete
        ? ("complete" as const)
        : cleanup.phase === "failed"
          ? ("failed" as const)
          : ("pending" as const),
      checks,
      message: complete ? null : cleanup.message,
    };
  }

  private completedCleanup(name: string): VclusterPreviewCleanupSnapshot {
    return {
      name,
      resourceName: name,
      complete: true,
      phase: "complete",
      checks: {
        runnerSucceeded: true,
        previewEnvironmentAbsent: true,
        applicationAbsent: true,
        agentRegistrationAbsent: true,
        agentNamespacesAbsent: true,
        databaseAbsent: true,
        natsStreamAbsent: true,
        headlampRegistrationAbsent: true,
        tailnetEgressAbsent: true,
        hostNamespaceAbsent: true,
        storageScopeAbsent: true,
        runnerIdentityAbsent: true,
      },
      message: null,
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
  gateway: VclusterPreviewGatewayPort & PreviewEnvironmentObservationReaderPort;
  baseUrl?: () => string | null;
  token?: () => string | null;
  observationMode?: "local" | "tuple-leaf";
  observationCredential?: (
    name: string,
  ) => Readonly<{
    identity: PreviewControlIdentity;
    capability: string;
  }>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  observationTimeoutMs?: number;
}>;

/**
 * Non-broker gateway. Persistent dev keeps physical SEA reads; composition
 * selects tuple-leaf observation for a preview-deployed BFF. Destructive
 * commands continue to cross the authenticated physical-broker boundary.
 */
export class BrokeredVclusterPreviewGateway
  implements
    VclusterPreviewGatewayPort,
    PreviewEnvironmentObservationReaderPort,
    PreviewEnvironmentTeardownCommandPort,
    PreviewEnvironmentTeardownStatusPort
{
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly observationTimeoutMs: number;

  constructor(private readonly options: BrokeredVclusterPreviewGatewayOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.observationTimeoutMs = boundedObservationTimeoutMs(
      options.observationTimeoutMs ??
        Number(
          env.PREVIEW_OBSERVATION_TIMEOUT_MS ??
            process.env.PREVIEW_OBSERVATION_TIMEOUT_MS ??
            "",
        ),
    );
  }

  listWithCounts() {
    return this.options.gateway.listWithCounts();
  }

  async get(name: string) {
    if (this.options.observationMode !== "tuple-leaf") {
      return this.options.gateway.get(name);
    }
    const credential = this.observationCredential(name);
    return (await this.recordObservation(credential)).preview;
  }

  async inspect(identity: PreviewControlIdentity) {
    if (this.options.observationMode !== "tuple-leaf") {
      return this.options.gateway.inspect(identity);
    }
    const credential = this.observationCredential(identity.previewName);
    if (!samePreviewIdentity(credential.identity, identity)) {
      throw new PreviewRuntimeIdentityChangedError(
        "local preview identity does not match the requested record generation",
      );
    }
    return this.recordObservation(credential);
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
      envelope?.ok !== true ||
      response.status !== 200 ||
      !preview ||
      preview.name !== name ||
      preview.phase !== "absent" ||
      !receipt ||
      canonical(Object.keys(receipt).sort()) !==
        canonical(["desiredStateAbsent", "guard", "name"].sort()) ||
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

  async request(
    name: string,
    guard: Extract<
      NonNullable<Parameters<VclusterPreviewGatewayPort["teardown"]>[1]>,
      { mode: "owned" }
    >,
  ): Promise<VclusterPreviewTeardownAcceptance> {
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
    const submit = () =>
      this.fetchImpl(
        `${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(name)}/teardown?wait=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Preview-Control-Broker-Token": token,
          },
          body: JSON.stringify({ guard }),
          signal: AbortSignal.timeout(this.observationTimeoutMs),
        },
      );
    let response: Response;
    try {
      response = await submit();
    } catch (cause) {
      // The command is UID-preconditioned and tuple-fenced, so replaying the
      // exact request once is safe when the response is lost in transport.
      if (!retryableTransportFailure(cause)) throw cause;
      response = await submit();
    }
    const envelope = record(await response.json().catch(() => null));
    if (!response.ok) {
      const ErrorType =
        response.status === 409
          ? PreviewEnvironmentDesiredStateOwnershipError
          : PreviewEnvironmentDesiredStateError;
      throw new ErrorType(
        typeof envelope?.error === "string"
          ? envelope.error
          : `physical preview teardown request failed (HTTP ${response.status})`,
      );
    }
    const preview = record(envelope?.preview);
    const ticket = envelope?.ticket === null ? null : record(envelope?.ticket);
    const receipt = record(envelope?.receipt);
    if (
      envelope?.ok !== true ||
      !preview ||
      preview.name !== name ||
      !["terminating", "absent"].includes(String(preview.phase)) ||
      !(
        (response.status === 202 && preview.phase === "terminating") ||
        (response.status === 200 && preview.phase === "absent")
      ) ||
      !receipt ||
      canonical(Object.keys(receipt).sort()) !==
        canonical(
          ["desiredStateDeletionAccepted", "guard", "name", "ticket"].sort(),
        ) ||
      receipt.name !== name ||
      receipt.desiredStateDeletionAccepted !== true ||
      canonical(receipt.guard) !== canonical(guard) ||
      canonical(receipt.ticket) !== canonical(ticket) ||
      (preview.phase === "terminating" &&
        (!ticket ||
          ticket.name !== name ||
          typeof ticket.environmentUid !== "string" ||
          !ticket.environmentUid ||
          ticket.requestId !== guard.requestId ||
          ticket.sourceRevision !== guard.sourceRevision ||
          typeof ticket.signature !== "string" ||
          !HMAC_KEY.test(ticket.signature) ||
          canonical(Object.keys(ticket).sort()) !==
            canonical(
              [
                "environmentUid",
                "name",
                "requestId",
                "signature",
                "sourceRevision",
              ].sort(),
            ))) ||
      (preview.phase === "absent" && ticket !== null)
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview teardown request returned a mismatched ownership receipt",
      );
    }
    return {
      preview: preview as unknown as VclusterPreviewRecord,
      ticket: ticket as VclusterPreviewTeardownTicket | null,
    };
  }

  async status(
    ticket: VclusterPreviewTeardownTicket,
  ): Promise<VclusterPreviewCleanupSnapshot> {
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
      `${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(ticket.name)}/teardown/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Broker-Token": token,
        },
        body: JSON.stringify({ ticket }),
        signal: AbortSignal.timeout(this.observationTimeoutMs),
      },
    );
    const body = record(await response.json().catch(() => null));
    if (!response.ok) {
      const ErrorType = response.status === 409
        ? PreviewEnvironmentDesiredStateOwnershipError
        : PreviewEnvironmentDesiredStateError;
      throw new ErrorType(
        typeof body?.error === "string"
          ? body.error
          : `physical preview teardown status failed (HTTP ${response.status})`,
      );
    }
    const receipt = record(body?.receipt);
    if (
      body?.ok !== true ||
      !receipt ||
      canonical(Object.keys(receipt).sort()) !== canonical(["ticket"].sort()) ||
      canonical(receipt.ticket) !== canonical(ticket)
    ) {
      throw new PreviewEnvironmentDesiredStateOwnershipError(
        "physical preview teardown status returned a mismatched ownership receipt",
      );
    }
    return this.cleanupFromEnvelope(body, ticket.name);
  }

  async runtime(name: string) {
    if (this.options.observationMode !== "tuple-leaf") {
      return this.options.gateway.runtime(name);
    }
    const credential = this.observationCredential(name);
    return (await this.runtimeObservation(credential)).runtime;
  }

  async runtimeForIdentity(
    identity: Parameters<VclusterPreviewGatewayPort["runtimeForIdentity"]>[0],
  ) {
    if (this.options.observationMode !== "tuple-leaf") {
      return this.options.gateway.runtimeForIdentity(identity);
    }
    const credential = this.observationCredential(identity.previewName);
    if (!samePreviewIdentity(credential.identity, identity)) {
      throw new PreviewRuntimeIdentityChangedError(
        "local preview identity does not match the requested runtime generation",
      );
    }
    return (await this.runtimeObservation(credential)).runtime;
  }

  async observeRuntime(identity: PreviewControlIdentity) {
    if (this.options.observationMode !== "tuple-leaf") {
      return this.options.gateway.observeRuntime(identity);
    }
    const credential = this.observationCredential(identity.previewName);
    if (!samePreviewIdentity(credential.identity, identity)) {
      throw new PreviewRuntimeIdentityChangedError(
        "local preview identity does not match the requested runtime generation",
      );
    }
    return this.runtimeObservation(credential);
  }

  private observationCredential(name: string) {
    if (this.options.observationCredential) {
      const credential = this.options.observationCredential(name);
      if (credential.identity.previewName !== name) {
        throw new PreviewRuntimeIdentityChangedError(
          "local preview identity does not match the requested preview",
        );
      }
      return credential;
    }
    return {
      identity: localPreviewControlIdentity(name),
      capability: localPreviewControlCapability(),
    };
  }

  private async recordObservation(
    credential: Readonly<{
      identity: PreviewControlIdentity;
      capability: string;
    }>,
  ) {
    const body = await this.requestObservation("record", credential);
    return {
      preview: normalizePreviewRecord(body.preview, credential.identity),
      identity: credential.identity,
    };
  }

  private async runtimeObservation(
    credential: Readonly<{
      identity: PreviewControlIdentity;
      capability: string;
    }>,
  ) {
    const body = await this.requestObservation("runtime", credential);
    return {
      preview: normalizePreviewRecord(body.preview, credential.identity),
      runtime: normalizeRuntimeObservation(body.runtime, credential.identity),
      identity: credential.identity,
    };
  }

  private async requestObservation(
    view: "record" | "runtime",
    credential: Readonly<{
      identity: PreviewControlIdentity;
      capability: string;
    }>,
  ): Promise<Record<string, unknown>> {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    if (!baseUrl) {
      throw new PreviewEnvironmentDesiredStateError(
        "physical preview observation broker is not configured",
      );
    }
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/environment/observe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": credential.capability,
        },
        body: JSON.stringify({ identity: credential.identity, view }),
        signal: AbortSignal.timeout(this.observationTimeoutMs),
      },
    );
    const body = record(await response.json().catch(() => null));
    if (response.status === 409) {
      throw new PreviewRuntimeIdentityChangedError(
        typeof body?.error === "string"
          ? body.error
          : "physical preview generation changed",
      );
    }
    if (!response.ok) {
      throw new PreviewEnvironmentDesiredStateError(
        typeof body?.error === "string"
          ? body.error
          : `physical preview observation failed (HTTP ${response.status})`,
      );
    }
    const expectedKeys =
      view === "record"
        ? ["identity", "ok", "preview", "view"]
        : ["identity", "ok", "preview", "runtime", "view"];
    if (
      !body ||
      body.ok !== true ||
      body.view !== view ||
      canonical(record(body.identity)) !== canonical(credential.identity) ||
      canonical(Object.keys(body).sort()) !== canonical(expectedKeys.sort())
    ) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview observation returned an invalid receipt",
      );
    }
    return body;
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
        signal: AbortSignal.timeout(this.observationTimeoutMs),
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
    return this.cleanupFromEnvelope(body, name);
  }

  private cleanupFromEnvelope(
    body: Record<string, unknown> | null,
    name: string,
  ): VclusterPreviewCleanupSnapshot {
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
    return cleanup as unknown as VclusterPreviewCleanupSnapshot;
  }

  touch(name: string) {
    return this.options.gateway.touch(name);
  }

  sleep(name: string) {
    return this.options.gateway.sleep(name);
  }
}
