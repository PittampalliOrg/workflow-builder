import { env } from "$env/dynamic/private";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type {
  DevPreviewInfo,
  DevPreviewServiceResult,
  DevPreviewsResult,
  ProvisionDevPreviewParams,
  ProvisionDevPreviewsParams,
  PreviewDatabaseProvisioner,
  ReplaceDevPreviewImagesParams,
  ReplaceDevPreviewImagesResult,
  TeardownDevPreviewParams,
  TeardownDevPreviewResult,
} from "$lib/server/application/ports";
export type {
  DevPreviewInfo,
  DevPreviewServiceResult,
  DevPreviewsResult,
  ProvisionDevPreviewParams,
  ProvisionDevPreviewsParams,
  ReplaceDevPreviewImagesParams,
  ReplaceDevPreviewImagesResult,
  TeardownDevPreviewParams,
  TeardownDevPreviewResult,
} from "$lib/server/application/ports";
import {
  assertDevPreviewImage,
  devPreviewCommands,
  devPreviewBrowseUrl,
  devPreviewCaptureMappings,
  devPreviewCaptureOnly,
  devPreviewSyncPaths,
  DEV_PREVIEW_CATALOG_DIGEST,
  resolveDevPreviewDescriptor,
  resolveDevPreviewImage,
  resolveRequestedDevPreviewServiceSet,
  type DevPreviewCaptureMapping,
} from "$lib/server/workflows/dev-preview-registry";
import { touchVclusterPreview } from "$lib/server/workflows/vcluster-preview";
import {
  resolveDevSyncCredentials,
  type DevSyncCredentialResolverOptions,
} from "$lib/server/workflows/dev-sync-credentials";

/**
 * Per-run ephemeral dev-server preview (P2).
 *
 * A workflow run provisions its OWN throwaway `vite dev` Sandbox via the
 * privileged `sandbox-execution-api` (`/internal/dev-preview`), so the
 * unprivileged agent never needs kube creds. The agent then `/__sync`-pushes its
 * edited source to the returned pod IP and the Playwright critic inspects the
 * same pod IP — devspace's image-replace + dev-server model, realized
 * cluster-natively. Torn down on run end (explicit teardown + the Sandbox's own
 * `shutdownTime` backstop + the sandbox-gc CronJob).
 */

type DevPreviewWorkspaceSessionRecord = {
  workspaceRef: string;
  sandboxState: Record<string, unknown> | null;
};

type DevPreviewPersistSourceBundleInput = {
  executionId: string;
  userId: string;
  projectId?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
  fileName?: string;
  bytes: Buffer;
  contentType?: string;
  meta?: {
    base?: string | null;
    head?: string | null;
    tier?: string | null;
    clonePath?: string | null;
    fileCount?: number | null;
    repoUrl?: string | null;
    repoSubdir?: string | null;
    syncPaths?: string[] | null;
    iteration?: number | null;
    manifestVersion?: number | null;
    captureId?: string | null;
    capturedAt?: string | null;
    serviceCount?: number | null;
    services?: string[] | null;
    captureProtocol?: string | null;
    acceptanceEligible?: boolean | null;
    generation?: string | null;
    overlayDigests?: Record<string, string> | null;
    catalogDigest?: string | null;
    sourceRevision?: string | null;
    platformRevision?: string | null;
  };
};

export interface DevPreviewPersistence {
  upsertWorkflowWorkspaceSession(input: {
    workspaceRef: string;
    workflowExecutionId?: string | null;
    durableInstanceId?: string | null;
    name: string;
    rootPath: string;
    clonePath?: string | null;
    backend: "openshell" | "juicefs";
    enabledTools?: string[];
    status?: "active" | "cleaned" | "error";
    sandboxState?: Record<string, unknown> | null;
  }): Promise<{ workspaceRef: string }>;
  listWorkflowWorkspaceSessionsByExecutionId(input: {
    executionId: string;
    limit?: number;
  }): Promise<DevPreviewWorkspaceSessionRecord[]>;
  markWorkflowWorkspaceSessionCleaned(input: {
    workspaceRef: string;
  }): Promise<boolean>;
  getExecutionById(id: string): Promise<{
    id: string;
    userId: string;
    projectId: string | null;
  } | null>;
  persistSourceBundleArtifact(
    input: DevPreviewPersistSourceBundleInput,
  ): Promise<{ id: string; fileId: string; bytes: number }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function sandboxExecutionApiUrl(): string | null {
  const raw = (
    env.SANDBOX_EXECUTION_API_URL ??
    env.HOST_EXECUTION_API_URL ??
    process.env.SANDBOX_EXECUTION_API_URL ??
    process.env.HOST_EXECUTION_API_URL ??
    ""
  ).trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function internalToken(): string {
  return (
    env.SANDBOX_EXECUTION_API_TOKEN ??
    process.env.SANDBOX_EXECUTION_API_TOKEN ??
    ""
  );
}

export async function provisionDevPreview(
  params: ProvisionDevPreviewParams,
  persistence?: DevPreviewPersistence,
  previewDatabases?: PreviewDatabaseProvisioner,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<DevPreviewInfo> {
  const baseUrl = sandboxExecutionApiUrl();
  if (!baseUrl) {
    throw new Error("SANDBOX_EXECUTION_API_URL not configured");
  }
  const descriptor = resolveDevPreviewDescriptor(params.service, {
    ...process.env,
    ...env,
  });
  // Run stability: a previously persisted image for this (executionId, service)
  // WINS over a fresh resolution, so a mid-run re-provision (e.g. a GAN re-entry)
  // never picks up a newer pin than the one this run started on. An explicit
  // params.image (deliberate caller override) still takes precedence.
  const persistedImage = await persistedDevPreviewImage(
    params.executionId,
    descriptor.service,
    persistence,
  );
  const selectedImage =
    params.image ||
    persistedImage ||
    resolveDevPreviewImage(descriptor, { ...process.env, ...env });
  const image = assertDevPreviewImage(descriptor, selectedImage);
  const token = internalToken();
  const { receiverToken, agentActionToken: syncCapability } =
    await resolveDevSyncCredentials(
      {
        executionId: params.executionId,
        service: descriptor.service,
      },
      credentialOptions,
    );

  const previewNative = params.mode === "preview-native";
  const previewNativeAdoption = descriptor.capabilities.previewNative;
  if (previewNative && !previewNativeAdoption) {
    throw new Error(
      `Dev-preview service ${descriptor.service} does not support preview-native adoption`,
    );
  }
  // Functional preview: provision the per-preview database first; its DATABASE_URL
  // is delivered to the pod via a per-preview Secret (serviceSecretEnv), and the
  // app self-migrates the empty DB on boot. Preview-native adopt SKIPS this — the
  // vcluster preview already has its OWN isolated, migrated DB, and the dev pod
  // reuses it via the preview's `workflow-builder-secrets` (envFrom).
  const previewEnv: Record<string, string> = {
    ...(descriptor.extraEnv ?? {}),
  };
  const browseUrl =
    previewNative && params.origin
      ? params.origin
      : devPreviewBrowseUrl(descriptor);
  // ORIGIN is deployment identity, not catalog data. Derive it from this
  // environment's physical browse endpoint or the vCluster origin.
  if (params.origin) previewEnv.ORIGIN = params.origin;
  else if (descriptor.functional && browseUrl) previewEnv.ORIGIN = browseUrl;
  const serviceSecretEnv: Record<string, string> = {};
  if (descriptor.functional && !previewNative) {
    if (!previewDatabases) {
      throw new Error("Preview database provisioner not configured");
    }
    const { databaseUrl, sourceUrl } = await previewDatabases.provision({
      executionId: params.executionId,
    });
    serviceSecretEnv.DATABASE_URL = databaseUrl;
    // Source for the db-clone init container (pg_dump --schema-only | psql).
    if (sourceUrl) serviceSecretEnv.PREVIEW_SOURCE_DATABASE_URL = sourceUrl;
  }
  if (descriptor.pubsubName && !previewNative)
    previewEnv.PUBSUB_NAME = descriptor.pubsubName;

  // Named-command allowlist for the sidecar's POST /__run (deps + test lanes).
  // Forwarded server-side into the pod's DEV_SYNC_COMMANDS_JSON. Empty → no /__run.
  const devSyncCommands = devPreviewCommands(descriptor);
  const devSyncAllowedRoots = [
    ...new Set(
      devPreviewCaptureMappings(descriptor).map((mapping) => mapping.from),
    ),
  ].sort();
  const envFrom = [
    ...(descriptor.envFrom ?? []),
    ...(previewNative ? (descriptor.previewNativeEnvFrom ?? []) : []),
  ];
  const requestBody: Record<string, unknown> = {
    executionId: params.executionId,
    executionClass: params.executionClass ?? "dev-preview",
    service: descriptor.service,
    image,
    port: descriptor.port,
    healthPath: descriptor.healthPath,
    workdir: descriptor.workdir,
    syncMode: descriptor.syncMode,
    syncPort: descriptor.syncPort,
    devSyncAllowedRoots,
    ...(Object.keys(devSyncCommands).length ? { devSyncCommands } : {}),
    ...(descriptor.needsDapr ? { needsDapr: true } : {}),
    // Dapr-shadow env (PUBSUB_NAME=pubsub-dev / DAPR_CONFIG_STORE=disabled-dev) is a
    // HOST-only isolation hack. A preview-native pod runs REAL app-ids inside the
    // vcluster against its own `pubsub` component, so the shadow defaults would
    // point it at a non-existent `pubsub-dev` component → silently dead
    // subscriptions. Send false whenever preview-native (SEA also forces this
    // server-side); only the BFF descriptor opts out explicitly today, so the
    // orchestrator/coordinator would otherwise inherit the SEA default (true).
    ...(previewNative || descriptor.applyDaprShadowDefaults === false
      ? { applyDaprShadowDefaults: false }
      : {}),
    // Preview-native: always reuse the preview's own DB/secrets (skip throwaway).
    // ADOPT (replace the prod Deployment + take its Service + claim its app-id) is
    // opt-out: ON for a human interactive session (preview URL serves edits), OFF
    // for an orchestrated workflow (the cutover would disrupt the orchestrator's
    // own BFF calls) — there the dev pod just serves HMR on its pod IP.
    ...(previewNative
      ? {
          previewNative: true,
          ...(params.adopt !== false
            ? {
                adoptService: previewNativeAdoption!.service,
                adoptDeployment: previewNativeAdoption!.deployment,
                ...(previewNativeAdoption!.daprAppId
                  ? {
                      daprAppId: previewNativeAdoption!.daprAppId,
                    }
                  : {}),
              }
            : {}),
        }
      : {}),
    ...(envFrom.length ? { envFrom } : {}),
    ...(Object.keys(serviceSecretEnv).length ? { serviceSecretEnv } : {}),
    ...(Object.keys(previewEnv).length ? { env: previewEnv } : {}),
    syncToken: receiverToken,
    syncAgentToken: syncCapability,
    ...(params.timeoutSeconds == null
      ? {}
      : { timeoutSeconds: params.timeoutSeconds }),
    ...(params.waitReadySeconds == null
      ? {}
      : { waitReadySeconds: params.waitReadySeconds }),
  };
  const response = await fetch(`${baseUrl}/internal/dev-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(requestBody),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : `dev-preview provision failed (HTTP ${response.status})`;
    throw new Error(detail);
  }
  const info: DevPreviewInfo = {
    sandboxName: String(body.sandboxName ?? ""),
    executionId: params.executionId,
    service: descriptor.service,
    image,
    podIP: typeof body.podIP === "string" ? body.podIP : null,
    port: typeof body.port === "number" ? body.port : descriptor.port,
    syncPort:
      typeof body.syncPort === "number" ? body.syncPort : descriptor.syncPort,
    url: typeof body.url === "string" ? body.url : null,
    syncUrl: typeof body.syncUrl === "string" ? body.syncUrl : null,
    syncCapability,
    browseUrl,
    repoUrl: descriptor.repoUrl,
    repoSubdir: descriptor.repoSubdir,
    syncPaths: devPreviewSyncPaths(descriptor),
    extraSync: descriptor.extraSync ?? [],
    captureOnly: devPreviewCaptureOnly(descriptor),
    ready: body.ready === true,
    status: typeof body.status === "string" ? body.status : "queued",
    needsDapr: body.needsDapr === true,
    daprAppId: typeof body.daprAppId === "string" ? body.daprAppId : null,
  };
  await persistDevPreviewSession(info, persistence);
  // A4: provisioning a dev pod INSIDE a vcluster preview is activity on that preview —
  // ping its last-active clock (and wake it if slept) so the lifecycle reaper never
  // sleeps a preview under an active dev session. The vcluster identity travels as the
  // canonical origin (https://wfb-<name>.<tailnet>); best-effort — a touch failure
  // never fails the provision.
  if (previewNative) {
    const alias = /^https:\/\/wfb-([a-z0-9][a-z0-9-]*)\./.exec(
      params.origin ?? "",
    )?.[1];
    if (alias) await touchVclusterPreview(alias).catch(() => undefined);
  }
  return info;
}

/**
 * Provision N services into ONE execution (multi-service adopt). Each service is a
 * separate dev-preview Sandbox keyed on (executionId, service) server-side. Peers
 * fan out first; an adopted workflow-builder goes last so its delayed cutover cannot
 * kill the BFF while it is still awaiting a slower peer. Any partial failure is a
 * transaction failure: every observed or inventory-discovered Sandbox is synchronously
 * torn down, then the execution inventory is re-read before control returns.
 */
export async function provisionDevPreviews(
  params: ProvisionDevPreviewsParams,
  persistence?: DevPreviewPersistence,
  previewDatabases?: PreviewDatabaseProvisioner,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<DevPreviewsResult> {
  const { services: requested, ...shared } = params;
  const services = requested.length ? requested : ["workflow-builder"];
  if (new Set(services).size !== services.length) {
    throw new Error("Dev-preview service ids must be unique");
  }
  const settled: PromiseSettledResult<DevPreviewInfo>[] = new Array(
    services.length,
  );
  const provisionIndexes = async (indexes: readonly number[]) => {
    const group = await Promise.allSettled(
      indexes.map((index) =>
        provisionDevPreview(
          { ...shared, service: services[index] },
          persistence,
          previewDatabases,
          credentialOptions,
        ),
      ),
    );
    indexes.forEach((index, groupIndex) => {
      settled[index] = group[
        groupIndex
      ] as PromiseSettledResult<DevPreviewInfo>;
    });
  };
  const selfCutover =
    shared.mode === "preview-native" && shared.adopt !== false;
  if (selfCutover) {
    const peerIndexes = services
      .map((service, index) => ({ service, index }))
      .filter(({ service }) => service !== "workflow-builder")
      .map(({ index }) => index);
    const bffIndexes = services
      .map((service, index) => ({ service, index }))
      .filter(({ service }) => service === "workflow-builder")
      .map(({ index }) => index);
    await provisionIndexes(peerIndexes);
    const peerFailed = peerIndexes.some((index) => {
      const result = settled[index];
      return (
        !result ||
        result.status === "rejected" ||
        !fulfilledPreviewResult(services[index] as string, result.value).ok
      );
    });
    if (peerFailed) {
      for (const index of bffIndexes) {
        settled[index] = {
          status: "rejected",
          reason: new Error(
            "workflow-builder cutover skipped because a peer service failed readiness",
          ),
        };
      }
      const failed = settledPreviewResults(services, settled);
      return {
        executionId: params.executionId,
        services: await compensateProvisionedPreviewBatch(
          params.executionId,
          failed,
          persistence,
        ),
        ok: false,
      };
    }
    await provisionIndexes(bffIndexes);
  } else {
    await provisionIndexes(services.map((_service, index) => index));
  }
  const results = settledPreviewResults(services, settled);
  if (results.some((result) => !result.ok)) {
    return {
      executionId: params.executionId,
      services: await compensateProvisionedPreviewBatch(
        params.executionId,
        results,
        persistence,
      ),
      ok: false,
    };
  }
  return {
    executionId: params.executionId,
    services: results,
    ok: true,
  };
}

async function compensateProvisionedPreviewBatch(
  executionId: string,
  results: readonly DevPreviewServiceResult[],
  persistence?: DevPreviewPersistence,
): Promise<DevPreviewServiceResult[]> {
  const baseUrl = sandboxExecutionApiUrl();
  const token = internalToken();
  const requestedServices = new Set(results.map((result) => result.service));
  const candidates = new Map<string, string>();
  for (const result of results) {
    if (result.info?.sandboxName) {
      candidates.set(result.service, result.info.sandboxName);
    }
  }
  const cleanup = new Map<string, string | null>();
  const globalErrors: string[] = [];

  if (!baseUrl) {
    globalErrors.push("SANDBOX_EXECUTION_API_URL not configured");
  } else {
    try {
      const discovered = await discoverProvisionedPreviewBatch({
        baseUrl,
        executionId,
        requestedServices,
        token,
      });
      for (const [service, name] of discovered) candidates.set(service, name);
    } catch (cause) {
      globalErrors.push(`initial inventory failed: ${message(cause)}`);
    }
  }

  await Promise.all(
    [...candidates].map(async ([service, name]) => {
      try {
        if (!baseUrl)
          throw new Error("SANDBOX_EXECUTION_API_URL not configured");
        const response = await fetch(
          `${baseUrl}/internal/dev-preview/${encodeURIComponent(name)}`,
          {
            method: "DELETE",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (
          !response.ok ||
          body.sandboxName !== name ||
          body.accepted !== true ||
          body.deleted !== true ||
          body.deferred !== false
        ) {
          throw new Error(
            typeof body.detail === "string"
              ? body.detail
              : `teardown was not proven (HTTP ${response.status})`,
          );
        }
        cleanup.set(service, null);
        await persistence
          ?.markWorkflowWorkspaceSessionCleaned({ workspaceRef: name })
          .catch(() => false);
      } catch (cause) {
        cleanup.set(service, message(cause));
      }
    }),
  );

  if (baseUrl && candidates.size > 0) {
    try {
      const response = await fetch(
        `${baseUrl}/internal/dev-preview/restore-orphans`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (
        !response.ok ||
        !body ||
        body.skipped !== undefined ||
        !Array.isArray(body.restored) ||
        !Array.isArray(body.releasedLeases)
      ) {
        throw new Error(
          typeof body?.skipped === "string"
            ? `restore-orphans was skipped: ${body.skipped}`
            : `restore-orphans failed (HTTP ${response.status})`,
        );
      }
    } catch (cause) {
      const error = message(cause);
      for (const service of candidates.keys()) {
        if (cleanup.get(service) === null) {
          cleanup.set(service, error);
        }
      }
    }
  }

  if (baseUrl) {
    try {
      const remaining = await discoverProvisionedPreviewBatch({
        baseUrl,
        executionId,
        requestedServices,
        token,
      });
      if (remaining.size > 0) {
        throw new Error(
          `Sandboxes still present: ${[...remaining.values()].sort().join(", ")}`,
        );
      }
    } catch (cause) {
      globalErrors.push(`final inventory failed: ${message(cause)}`);
    }
  }

  return results.map((result) => {
    const error = cleanup.get(result.service);
    const proofError = [...globalErrors, ...(error ? [error] : [])].join("; ");
    if (!result.info?.sandboxName && !candidates.has(result.service)) {
      return proofError
        ? {
            ...result,
            ok: false,
            error: `${result.error ?? "multi-service provision failed"}; compensating teardown was not proven: ${proofError}`,
          }
        : result;
    }
    return {
      ...result,
      ok: false,
      error: !proofError
        ? "multi-service provision failed; compensating teardown completed"
        : `multi-service provision failed; compensating teardown failed: ${proofError}`,
    };
  });
}

async function discoverProvisionedPreviewBatch(input: {
  baseUrl: string;
  executionId: string;
  requestedServices: ReadonlySet<string>;
  token: string;
}): Promise<ReadonlyMap<string, string>> {
  const response = await fetch(
    `${input.baseUrl}/internal/dev-previews?executionId=${encodeURIComponent(input.executionId)}`,
    {
      headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
    },
  );
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !response.ok ||
    !body ||
    body.executionId !== input.executionId ||
    body.complete !== true ||
    !Array.isArray(body.services)
  ) {
    throw new Error(
      `dev-preview inventory was not proven (HTTP ${response.status})`,
    );
  }
  const discovered = new Map<string, string>();
  for (const value of body.services) {
    const record = asRecord(value);
    const service = typeof record?.service === "string" ? record.service : "";
    const name =
      typeof record?.sandboxName === "string" ? record.sandboxName : "";
    if (
      !input.requestedServices.has(service) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ||
      discovered.has(service)
    ) {
      throw new Error("dev-preview inventory returned an invalid batch member");
    }
    discovered.set(service, name);
  }
  return discovered;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Replace one coherent service set. Every service must already have a persisted
 * immutable image, which becomes the rollback point if any replacement fails.
 */
export async function replaceDevPreviewImages(
  params: ReplaceDevPreviewImagesParams,
  persistence?: DevPreviewPersistence,
  previewDatabases?: PreviewDatabaseProvisioner,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<ReplaceDevPreviewImagesResult> {
  if (!persistence) {
    throw new Error(
      "Preview persistence is required for atomic image replacement",
    );
  }
  if (params.services.length === 0) {
    throw new Error("At least one service image is required for replacement");
  }
  const serviceIds = params.services.map(({ service }) => service);
  if (new Set(serviceIds).size !== serviceIds.length) {
    throw new Error("Replacement service ids must be unique");
  }
  if (params.adopt !== false && serviceIds.includes("workflow-builder")) {
    throw new Error(
      "adopted workflow-builder image replacement would terminate the calling BFF; use a fresh acceptance preview",
    );
  }
  const previous = new Map<string, string>();
  for (const service of serviceIds) {
    const image = await persistedDevPreviewImage(
      params.executionId,
      service,
      persistence,
    );
    if (!image) {
      throw new Error(
        `Cannot replace ${service}: no persisted prior image is available for rollback`,
      );
    }
    previous.set(service, image);
  }
  const { services, ...shared } = params;
  const replacements = await Promise.allSettled(
    services.map(({ service, image }) =>
      provisionDevPreview(
        { ...shared, service, image },
        persistence,
        previewDatabases,
        credentialOptions,
      ),
    ),
  );
  const results = settledPreviewResults(serviceIds, replacements);
  if (results.every((result) => result.ok)) {
    return {
      executionId: params.executionId,
      services: results,
      ok: true,
      rollback: null,
    };
  }

  const restored = await Promise.allSettled(
    serviceIds.map((service) =>
      provisionDevPreview(
        {
          ...shared,
          service,
          image: previous.get(service) as string,
        },
        persistence,
        previewDatabases,
        credentialOptions,
      ),
    ),
  );
  const rollbackServices = settledPreviewResults(serviceIds, restored);
  return {
    executionId: params.executionId,
    services: results,
    ok: false,
    rollback: {
      attempted: true,
      ok: rollbackServices.every((result) => result.ok),
      services: rollbackServices,
    },
  };
}

function settledPreviewResults(
  services: readonly string[],
  settled: readonly PromiseSettledResult<DevPreviewInfo>[],
): DevPreviewServiceResult[] {
  return settled.map((result, index) => {
    const service = services[index] as string;
    if (result.status === "fulfilled") {
      return fulfilledPreviewResult(service, result.value);
    }
    return {
      service,
      ok: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });
}

function fulfilledPreviewResult(
  service: string,
  info: DevPreviewInfo,
): DevPreviewServiceResult {
  if (info.ready && info.podIP && info.syncUrl) {
    return { service, ok: true, info };
  }
  return {
    service,
    ok: false,
    info,
    error: `${service} did not become ready (status=${info.status || "unknown"})`,
  };
}

/**
 * The image a prior provision of this (executionId, service) was pinned to, read
 * back from the persisted workspace-session row's `sandboxState.details.image`.
 * Null when no persistence, no matching row, or no stored image — the caller then
 * falls through to the fresh resolver. Best-effort: a read failure never blocks a
 * provision (it just forgoes the run-stability guard).
 */
async function persistedDevPreviewImage(
  executionId: string,
  service: string,
  persistence?: DevPreviewPersistence,
): Promise<string | null> {
  if (!persistence) return null;
  try {
    const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
      executionId,
      limit: 8,
    });
    for (const row of rows) {
      const details = asRecord(asRecord(row.sandboxState)?.details);
      if (
        details?.service === service &&
        typeof details.image === "string" &&
        details.image.trim()
      ) {
        return details.image.trim();
      }
    }
  } catch (err) {
    console.error(
      `[dev-preview] failed reading persisted image (execId=${executionId}, service=${service}):`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

async function persistDevPreviewSession(
  info: DevPreviewInfo,
  persistence?: DevPreviewPersistence,
): Promise<void> {
  if (!persistence || !info.sandboxName) return;
  const details = {
    kind: "dev-preview",
    sandboxName: info.sandboxName,
    name: info.sandboxName,
    service: info.service,
    // Per-run image pin: read back on re-entry so re-provision reuses it (see
    // persistedDevPreviewImage) rather than resolving a possibly-newer pin.
    image: info.image,
    podIP: info.podIP,
    port: info.port,
    syncPort: info.syncPort,
    url: info.url,
    syncUrl: info.syncUrl,
    browseUrl: info.browseUrl,
    needsDapr: info.needsDapr,
    daprAppId: info.daprAppId,
    ready: info.ready,
    executionId: info.executionId,
    provider: "agent-sandbox-dev-preview",
    previewEnvironmentId:
      env.PREVIEW_ENVIRONMENT_ID ?? process.env.PREVIEW_ENVIRONMENT_ID ?? null,
    platformRevision:
      env.PREVIEW_PLATFORM_REVISION ??
      process.env.PREVIEW_PLATFORM_REVISION ??
      null,
    sourceRevision:
      env.PREVIEW_SOURCE_REVISION ??
      process.env.PREVIEW_SOURCE_REVISION ??
      null,
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
  };
  try {
    await persistence.upsertWorkflowWorkspaceSession({
      workspaceRef: info.sandboxName,
      workflowExecutionId: info.executionId,
      name: "dev-preview",
      rootPath: "/app",
      backend: "juicefs",
      enabledTools: [],
      status: "active",
      sandboxState: { details },
    });
  } catch (err) {
    // Best-effort: provisioning succeeded; persistence is for discovery/reaping.
    // Log at ERROR with the offending id — the common cause is a non-canonical
    // `workflowExecutionId` (a Dapr instance id) violating the FK to
    // workflow_executions.id, which otherwise leaves the run with a live pod but
    // no session row (capture/teardown then can't find it).
    console.error(
      `[dev-preview] failed to persist workspace session row (execId=${info.executionId}, ref=${info.sandboxName}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolve the dev-preview Sandbox name for an execution (from the persisted row
 * if present, else the deterministic name the service uses).
 */
async function resolveDevPreviewSandboxName(
  executionId: string,
  explicit?: string | null,
  persistence?: DevPreviewPersistence,
): Promise<string | null> {
  if (explicit) return explicit;
  if (persistence) {
    const [row] = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
      executionId,
      limit: 1,
    });
    if (row?.workspaceRef) return row.workspaceRef;
    const details = asRecord(asRecord(row?.sandboxState)?.details);
    if (typeof details?.sandboxName === "string") return details.sandboxName;
  }
  return null;
}

/** Every distinct dev-preview Sandbox name persisted for an execution (one per service). */
async function listDevPreviewSandboxNames(
  executionId: string,
  persistence?: DevPreviewPersistence,
): Promise<string[]> {
  if (!persistence) return [];
  const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
    executionId,
    limit: 8,
  });
  const targets = new Map<string, string | null>();
  for (const row of rows) {
    const details = asRecord(asRecord(row.sandboxState)?.details);
    const name =
      (typeof details?.sandboxName === "string" && details.sandboxName) ||
      row.workspaceRef;
    const service =
      typeof details?.service === "string" ? details.service : null;
    if (name) targets.set(name, service);
  }
  return [...targets.entries()]
    .sort(([leftName, leftService], [rightName, rightService]) => {
      const leftIsBff =
        leftService === "workflow-builder" ||
        leftName.includes("workflow-builder");
      const rightIsBff =
        rightService === "workflow-builder" ||
        rightName.includes("workflow-builder");
      return Number(leftIsBff) - Number(rightIsBff);
    })
    .map(([name]) => name);
}

type DevPreviewDetails = {
  sandboxName: string | null;
  service: string | null;
  podIP: string | null;
  syncPort: number | null;
  platformRevision: string | null;
  sourceRevision: string | null;
  catalogDigest: string | null;
};

/** Pull the persisted dev-preview details (pod IP/port/service) for an execution.
 * With `service` set, restricts to that service's rows (multi-service capture). */
async function resolveDevPreviewDetails(
  executionId: string,
  persistence?: DevPreviewPersistence,
  service?: string | null,
): Promise<DevPreviewDetails | null> {
  if (!persistence) return null;
  type DevDetails = {
    sandboxName?: string;
    service?: string;
    podIP?: string | null;
    syncPort?: number | null;
    platformRevision?: string | null;
    sourceRevision?: string | null;
    catalogDigest?: string | null;
  };
  // A run can legitimately have MORE THAN ONE workspace_session row (e.g. an
  // early ensure that captured a null podIP plus the ready-pod row). Pick the
  // newest row that actually carries a podIP+syncPort, falling back to the
  // newest overall — newest-only would otherwise resolve to a stale podIP-null
  // row and make capture/teardown skip `no_dev_pod`.
  const allRows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
    executionId,
  });
  const detailsOf = (
    r: DevPreviewWorkspaceSessionRecord,
  ): DevDetails | undefined =>
    asRecord(r.sandboxState)?.details as DevDetails | undefined;
  const rows = service
    ? allRows.filter((r) => detailsOf(r)?.service === service)
    : allRows;
  if (rows.length === 0) return null;
  const chosen =
    rows.find((r) => {
      const d = detailsOf(r);
      return !!d?.podIP && typeof d.syncPort === "number";
    }) ?? rows[0];
  const details = detailsOf(chosen);
  return {
    sandboxName: details?.sandboxName ?? chosen.workspaceRef ?? null,
    service: details?.service ?? null,
    podIP: details?.podIP ?? null,
    syncPort: typeof details?.syncPort === "number" ? details.syncPort : null,
    platformRevision:
      typeof details?.platformRevision === "string"
        ? details.platformRevision
        : null,
    sourceRevision:
      typeof details?.sourceRevision === "string"
        ? details.sourceRevision
        : null,
    catalogDigest:
      typeof details?.catalogDigest === "string" ? details.catalogDigest : null,
  };
}

type DevPreviewExportOverlay = {
  service: string;
  repoUrl: string;
  base: string;
  repoSubdir: string;
  syncPaths: string[];
  captureMappings: DevPreviewCaptureMapping[];
  tarGzip: Buffer;
  generation: string | null;
  contentSha256: string;
  reportedService: string | null;
};

type DevPreviewExportResult =
  | { ok: true; overlay: DevPreviewExportOverlay }
  | { ok: false; skipped: string; fatal: boolean };

type TarOverlaySetManifest = {
  version: 1 | 2;
  tier: "tar-overlay-set";
  captureProtocol: "legacy" | "atomic-generation-v2";
  acceptanceEligible: boolean;
  captureId: string;
  capturedAt: string;
  generation: string | null;
  catalogDigest: string | null;
  sourceRevision: string | null;
  platformRevision: string | null;
  repoUrl: string;
  base: string;
  services: Array<{
    service: string;
    repoSubdir: string;
    syncPaths: string[];
    captureMappings: DevPreviewCaptureMapping[];
    contentSha256: string;
    tarGzipBase64: string;
  }>;
};

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SYNC_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchDevPreviewExport(
  executionId: string,
  service: string | null | undefined,
  persistence: DevPreviewPersistence,
  label: string,
  requireAtomicMetadata = false,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<DevPreviewExportResult> {
  try {
    let details = await resolveDevPreviewDetails(
      executionId,
      persistence,
      service,
    );
    for (let i = 0; i < 8 && (!details?.podIP || !details.syncPort); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      details = await resolveDevPreviewDetails(
        executionId,
        persistence,
        service,
      );
    }
    if (!details?.podIP || !details.syncPort) {
      console.warn(
        `${label} skip: no_dev_pod (podIP/syncPort unresolved after retries)`,
      );
      return { ok: false, skipped: "no_dev_pod", fatal: false };
    }

    const descriptor = resolveDevPreviewDescriptor(details.service);
    if (service && descriptor.service !== service) {
      return {
        ok: false,
        skipped: "resolved_service_mismatch",
        fatal: true,
      };
    }
    const syncPaths = devPreviewSyncPaths(descriptor);
    const captureMappings = devPreviewCaptureMappings(descriptor);
    const exportPaths = [
      ...new Set(captureMappings.map((mapping) => mapping.from)),
    ];
    let token: string;
    try {
      token = (
        await resolveDevSyncCredentials(
          {
            executionId,
            service: descriptor.service,
          },
          credentialOptions,
        )
      ).receiverToken;
    } catch (cause) {
      console.warn(
        `${label} skip: sync_credential_unavailable (${cause instanceof Error ? cause.message : String(cause)})`,
      );
      return {
        ok: false,
        skipped: "sync_credential_unavailable",
        fatal: true,
      };
    }
    const exportUrl = `http://${details.podIP}:${details.syncPort}/__export?paths=${encodeURIComponent(
      exportPaths.join(","),
    )}`;
    const resp = await fetch(exportUrl, {
      headers: { "x-sync-token": token },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.warn(`${label} skip: export_http_${resp.status} (${exportUrl})`);
      return {
        ok: false,
        skipped: `export_http_${resp.status}`,
        fatal: false,
      };
    }
    const tarGzip = Buffer.from(await resp.arrayBuffer());
    if (tarGzip.byteLength === 0) {
      console.warn(`${label} skip: empty export`);
      return { ok: false, skipped: "empty", fatal: false };
    }
    if (tarGzip.byteLength > 25 * 1024 * 1024) {
      console.warn(`${label} skip: too_large (${tarGzip.byteLength}B)`);
      return { ok: false, skipped: "too_large", fatal: false };
    }
    if (tarGzip[0] !== 0x1f || tarGzip[1] !== 0x8b) {
      const ctype = resp.headers.get("content-type") ?? "?";
      console.warn(
        `${label} skip: export_not_gzip (ctype=${ctype}, first2=${tarGzip[0]?.toString(16)},${tarGzip[1]?.toString(16)}, ${tarGzip.byteLength}B) — dev image likely predates /__export`,
      );
      return { ok: false, skipped: "export_not_gzip", fatal: false };
    }
    const generation = (resp.headers.get("x-sync-generation") ?? "").trim();
    const reportedService = (resp.headers.get("x-sync-service") ?? "").trim();
    const declaredContentSha256 = (
      resp.headers.get("x-content-sha256") ?? ""
    ).trim();
    const declaredRootsHeader = (resp.headers.get("x-sync-roots") ?? "").trim();
    let declaredRoots: string[] | null = null;
    if (declaredRootsHeader) {
      try {
        const value = JSON.parse(declaredRootsHeader) as unknown;
        if (
          !Array.isArray(value) ||
          !value.every((root) => typeof root === "string")
        ) {
          throw new Error("invalid roots");
        }
        declaredRoots = [...new Set(value)].sort();
      } catch {
        return {
          ok: false,
          skipped: "export_root_contract_mismatch",
          fatal: true,
        };
      }
      if (
        JSON.stringify(declaredRoots) !==
        JSON.stringify([...exportPaths].sort())
      ) {
        return {
          ok: false,
          skipped: "export_root_contract_mismatch",
          fatal: true,
        };
      }
    }
    const contentSha256 = sha256(tarGzip);
    if (
      declaredContentSha256 &&
      (!SHA256_DIGEST_PATTERN.test(declaredContentSha256) ||
        declaredContentSha256 !== contentSha256)
    ) {
      return {
        ok: false,
        skipped: "content_digest_mismatch",
        fatal: true,
      };
    }
    if (reportedService && reportedService !== descriptor.service) {
      return {
        ok: false,
        skipped: "export_service_mismatch",
        fatal: true,
      };
    }
    if (requireAtomicMetadata) {
      if (!declaredRoots) {
        return {
          ok: false,
          skipped: "missing_export_root_contract",
          fatal: true,
        };
      }
      if (!SYNC_GENERATION_PATTERN.test(generation)) {
        return {
          ok: false,
          skipped: "missing_sync_generation",
          fatal: true,
        };
      }
      if (reportedService !== descriptor.service) {
        return {
          ok: false,
          skipped: "missing_export_service",
          fatal: true,
        };
      }
      if (declaredContentSha256 !== contentSha256) {
        return {
          ok: false,
          skipped: "missing_content_digest",
          fatal: true,
        };
      }
    }
    return {
      ok: true,
      overlay: {
        service: descriptor.service,
        repoUrl: descriptor.repoUrl,
        base: descriptor.baseBranch ?? "main",
        repoSubdir: descriptor.repoSubdir,
        syncPaths,
        captureMappings,
        tarGzip,
        generation: generation || null,
        contentSha256,
        reportedService: reportedService || null,
      },
    };
  } catch (err) {
    console.warn(`${label} failed:`, err instanceof Error ? err.message : err);
    return { ok: false, skipped: "error", fatal: true };
  }
}

/** Persist one service's existing tar-overlay bundle (backward compatible). */
export async function captureDevPreviewSource(
  executionId: string,
  opts: {
    nodeId?: string | null;
    iteration?: number | null;
    sandboxName?: string | null;
    service?: string | null;
  } = {},
  persistence?: DevPreviewPersistence,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<{
  ok: boolean;
  artifactId?: string;
  bytes?: number;
  skipped?: string;
}> {
  if (!persistence) return { ok: false, skipped: "no_persistence" };
  const label = `[dev-preview] capture exec=${executionId} svc=${opts.service ?? "*"} node=${opts.nodeId ?? "?"} iter=${opts.iteration ?? "?"}`;
  const exported = await fetchDevPreviewExport(
    executionId,
    opts.service,
    persistence,
    label,
    false,
    credentialOptions,
  );
  if (!exported.ok) {
    return { ok: exported.fatal ? false : true, skipped: exported.skipped };
  }
  try {
    const exec = await persistence.getExecutionById(executionId);
    if (!exec) return { ok: true, skipped: "no_execution" };
    const overlay = exported.overlay;
    const result = await persistence.persistSourceBundleArtifact({
      executionId,
      userId: exec.userId,
      projectId: exec.projectId ?? null,
      nodeId: opts.nodeId ?? "dev-preview",
      iteration: opts.iteration ?? null,
      fileName: `source-${executionId}-${opts.iteration ?? "final"}.tar.gz`,
      contentType: "application/gzip",
      bytes: overlay.tarGzip,
      meta: {
        tier: "tar-overlay",
        base: overlay.base,
        repoUrl: overlay.repoUrl,
        repoSubdir: overlay.repoSubdir,
        syncPaths: overlay.syncPaths,
        iteration: opts.iteration ?? null,
      },
    });
    console.info(`${label} captured ${result.bytes}B → artifact ${result.id}`);
    return { ok: true, artifactId: result.id, bytes: result.bytes };
  } catch (err) {
    console.warn(`${label} failed:`, err instanceof Error ? err.message : err);
    return { ok: false, skipped: "error" };
  }
}

/** Distinct service ids from every persisted dev-preview row for an execution. */
async function listDevPreviewServices(
  executionId: string,
  persistence?: DevPreviewPersistence,
): Promise<string[]> {
  if (!persistence) return [];
  const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
    executionId,
  });
  const services = new Set<string>();
  for (const row of rows) {
    const svc = asRecord(asRecord(row.sandboxState)?.details)?.service;
    if (typeof svc === "string" && svc.trim()) services.add(svc.trim());
  }
  return [...services];
}

type DevPreviewCaptureOptions = {
  nodeId?: string | null;
  iteration?: number | null;
  /** Strict acceptance capture requires this requested set explicitly. */
  expectedServices?: readonly string[] | null;
  requireImmutableProvenance?: boolean;
  platformRevision?: string | null;
  sourceRevision?: string | null;
  catalogDigest?: string | null;
};

async function persistedCaptureProvenance(
  executionId: string,
  persistence: DevPreviewPersistence,
): Promise<{
  platformRevision: string | null;
  sourceRevision: string | null;
  catalogDigest: string | null;
  conflict: boolean;
}> {
  const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
    executionId,
  });
  const collect = (field: string) => {
    const values = new Set<string>();
    for (const row of rows) {
      const details = asRecord(asRecord(row.sandboxState)?.details);
      const value = details?.[field];
      if (typeof value === "string" && value.trim()) values.add(value.trim());
    }
    return values;
  };
  const platformRevisions = collect("platformRevision");
  const sourceRevisions = collect("sourceRevision");
  const catalogDigests = collect("catalogDigest");
  return {
    platformRevision:
      platformRevisions.size === 1 ? [...platformRevisions][0] : null,
    sourceRevision: sourceRevisions.size === 1 ? [...sourceRevisions][0] : null,
    catalogDigest: catalogDigests.size === 1 ? [...catalogDigests][0] : null,
    conflict:
      platformRevisions.size > 1 ||
      sourceRevisions.size > 1 ||
      catalogDigests.size > 1,
  };
}

/** Fetch every EXPECTED service before persisting anything. The result is one
 * gzip overlay-set, so a logical generation is either complete or absent. */
export async function captureAllDevPreviewSources(
  executionId: string,
  opts: DevPreviewCaptureOptions = {},
  persistence?: DevPreviewPersistence,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<{
  ok: boolean;
  artifactId?: string;
  bytes?: number;
  skipped?: string;
  captureId?: string;
  generation?: string | null;
  services: Array<{ service: string | null; ok: boolean; skipped?: string }>;
}> {
  if (!persistence) return { ok: false, services: [] };
  const strict = opts.requireImmutableProvenance === true;
  let services: string[];
  try {
    if (strict && !opts.expectedServices?.length) {
      return {
        ok: false,
        skipped: "missing_expected_services",
        services: [],
      };
    }
    const requested = opts.expectedServices
      ? [...opts.expectedServices]
      : await listDevPreviewServices(executionId, persistence);
    const resolution = resolveRequestedDevPreviewServiceSet(
      requested,
      "acceptance-build",
    );
    if (resolution.rejected.length > 0) {
      return {
        ok: false,
        skipped: "invalid_expected_services",
        services: resolution.rejected.map((entry) => ({
          service: entry.service,
          ok: false,
          skipped: entry.reason,
        })),
      };
    }
    services = resolution.services;
    if (strict) {
      const persistedServices = await listDevPreviewServices(
        executionId,
        persistence,
      );
      if (
        JSON.stringify([...persistedServices].sort()) !==
        JSON.stringify([...services].sort())
      ) {
        return {
          ok: false,
          skipped: "persisted_service_set_mismatch",
          services: [...new Set([...services, ...persistedServices])]
            .sort()
            .map((service) => ({
              service,
              ok: false,
              skipped: "persisted_service_set_mismatch",
            })),
        };
      }
    }
    if (services.length === 0) {
      return {
        ok: false,
        skipped: "missing_expected_services",
        services: [],
      };
    }
  } catch (err) {
    console.warn(
      `[dev-preview] capture-set exec=${executionId} service discovery failed:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, skipped: "service_discovery_error", services: [] };
  }

  const exports = await Promise.all(
    services.map((service) =>
      fetchDevPreviewExport(
        executionId,
        service,
        persistence,
        `[dev-preview] capture-set exec=${executionId} svc=${service} node=${opts.nodeId ?? "?"} iter=${opts.iteration ?? "?"}`,
        strict,
        credentialOptions,
      ),
    ),
  );
  const serviceResults = exports.map((result, index) => ({
    service: services[index] ?? null,
    ok: result.ok,
    ...(result.ok ? {} : { skipped: result.skipped }),
  }));
  if (exports.some((result) => !result.ok)) {
    return {
      ok: false,
      skipped: "incomplete_export_set",
      services: serviceResults,
    };
  }
  const overlays = exports.map((result) => {
    if (!result.ok) throw new Error("unreachable incomplete export set");
    return result.overlay;
  });
  const nonemptyGenerations = new Set(
    overlays
      .map((overlay) => overlay.generation)
      .filter((value): value is string => Boolean(value)),
  );
  if (nonemptyGenerations.size > 1) {
    return {
      ok: false,
      skipped: "generation_mismatch",
      services: serviceResults,
    };
  }
  const generation =
    nonemptyGenerations.size === 1 &&
    overlays.every((overlay) => overlay.generation != null)
      ? [...nonemptyGenerations][0]
      : null;
  if (strict && !generation) {
    return {
      ok: false,
      skipped: "missing_sync_generation",
      services: serviceResults,
    };
  }
  const repoUrls = new Set(overlays.map((overlay) => overlay.repoUrl));
  const bases = new Set(overlays.map((overlay) => overlay.base));
  if (repoUrls.size !== 1 || bases.size !== 1) {
    return {
      ok: false,
      skipped: "mixed_repository_set",
      services: serviceResults,
    };
  }

  try {
    const exec = await persistence.getExecutionById(executionId);
    if (!exec)
      return {
        ok: false,
        skipped: "no_execution",
        services: serviceResults,
      };
    const persisted = await persistedCaptureProvenance(
      executionId,
      persistence,
    );
    if (strict && persisted.conflict) {
      return {
        ok: false,
        skipped: "conflicting_persisted_provenance",
        services: serviceResults,
      };
    }
    if (
      strict &&
      ((opts.platformRevision &&
        persisted.platformRevision &&
        opts.platformRevision !== persisted.platformRevision) ||
        (opts.sourceRevision &&
          persisted.sourceRevision &&
          opts.sourceRevision !== persisted.sourceRevision) ||
        (opts.catalogDigest &&
          persisted.catalogDigest &&
          opts.catalogDigest !== persisted.catalogDigest))
    ) {
      return {
        ok: false,
        skipped: "persisted_provenance_mismatch",
        services: serviceResults,
      };
    }
    const platformRevision =
      opts.platformRevision ??
      persisted.platformRevision ??
      env.PREVIEW_PLATFORM_REVISION ??
      process.env.PREVIEW_PLATFORM_REVISION ??
      null;
    const sourceRevision =
      opts.sourceRevision ??
      persisted.sourceRevision ??
      env.PREVIEW_SOURCE_REVISION ??
      env.SOURCE_REVISION ??
      env.GIT_SHA ??
      process.env.PREVIEW_SOURCE_REVISION ??
      process.env.SOURCE_REVISION ??
      process.env.GIT_SHA ??
      null;
    const catalogDigest =
      opts.catalogDigest ??
      persisted.catalogDigest ??
      env.DEV_PREVIEW_CATALOG_DIGEST ??
      process.env.DEV_PREVIEW_CATALOG_DIGEST ??
      DEV_PREVIEW_CATALOG_DIGEST;
    if (
      strict &&
      (!platformRevision || !FULL_GIT_SHA_PATTERN.test(platformRevision))
    ) {
      return {
        ok: false,
        skipped: "missing_platform_revision",
        services: serviceResults,
      };
    }
    if (
      strict &&
      (!sourceRevision || !FULL_GIT_SHA_PATTERN.test(sourceRevision))
    ) {
      return {
        ok: false,
        skipped: "missing_source_revision",
        services: serviceResults,
      };
    }
    if (
      strict &&
      (!SHA256_DIGEST_PATTERN.test(catalogDigest) ||
        catalogDigest !== DEV_PREVIEW_CATALOG_DIGEST)
    ) {
      return {
        ok: false,
        skipped: "catalog_digest_mismatch",
        services: serviceResults,
      };
    }

    const captureId = randomUUID();
    const capturedAt = new Date().toISOString();
    const manifest: TarOverlaySetManifest = {
      version: strict ? 2 : 1,
      tier: "tar-overlay-set",
      captureProtocol: strict ? "atomic-generation-v2" : "legacy",
      acceptanceEligible: strict,
      captureId,
      capturedAt,
      generation,
      catalogDigest: SHA256_DIGEST_PATTERN.test(catalogDigest)
        ? catalogDigest
        : null,
      sourceRevision:
        sourceRevision && FULL_GIT_SHA_PATTERN.test(sourceRevision)
          ? sourceRevision
          : null,
      platformRevision:
        platformRevision && FULL_GIT_SHA_PATTERN.test(platformRevision)
          ? platformRevision
          : null,
      repoUrl: overlays[0].repoUrl,
      base: overlays[0].base,
      services: overlays.map((overlay) => ({
        service: overlay.service,
        repoSubdir: overlay.repoSubdir,
        syncPaths: overlay.syncPaths,
        captureMappings: overlay.captureMappings,
        contentSha256: overlay.contentSha256,
        tarGzipBase64: overlay.tarGzip.toString("base64"),
      })),
    };
    const bytes = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), {
      level: 9,
    });
    const overlayDigests = Object.fromEntries(
      manifest.services.map((overlay) => [
        overlay.service,
        overlay.contentSha256,
      ]),
    );
    const result = await persistence.persistSourceBundleArtifact({
      executionId,
      userId: exec.userId,
      projectId: exec.projectId ?? null,
      nodeId: opts.nodeId ?? "dev-preview",
      iteration: opts.iteration ?? null,
      fileName: `source-${executionId}-${opts.iteration ?? "final"}-${captureId}-overlay-set.json.gz`,
      contentType: "application/gzip",
      bytes,
      meta: {
        tier: "tar-overlay-set",
        base: manifest.base,
        repoUrl: manifest.repoUrl,
        iteration: opts.iteration ?? null,
        manifestVersion: manifest.version,
        captureId,
        capturedAt,
        serviceCount: manifest.services.length,
        services: manifest.services.map((overlay) => overlay.service),
        captureProtocol: manifest.captureProtocol,
        acceptanceEligible: manifest.acceptanceEligible,
        generation: manifest.generation,
        overlayDigests,
        catalogDigest: manifest.catalogDigest,
        sourceRevision: manifest.sourceRevision,
        platformRevision: manifest.platformRevision,
      },
    });
    console.info(
      `[dev-preview] capture-set exec=${executionId} captured ${manifest.services.length} services generation=${generation ?? "legacy"} ${result.bytes}B → artifact ${result.id}`,
    );
    return {
      ok: true,
      artifactId: result.id,
      bytes: result.bytes,
      captureId,
      generation,
      services: serviceResults,
    };
  } catch (err) {
    console.warn(
      `[dev-preview] capture-set exec=${executionId} assembly/persist failed:`,
      err instanceof Error ? err.message : err,
    );
    return {
      ok: false,
      skipped: "persist_error",
      services: serviceResults,
    };
  }
}

export async function teardownDevPreview(
  params: TeardownDevPreviewParams,
  persistence?: DevPreviewPersistence,
  previewDatabases?: PreviewDatabaseProvisioner,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<TeardownDevPreviewResult> {
  // Capture a durable, promotable version of the produced code BEFORE the dev pods
  // are deleted (dev-pod-as-source code lives only behind /__export). Loops all
  // services. Best-effort.
  await captureAllDevPreviewSources(
    params.executionId,
    {
      nodeId: "dev-preview",
      iteration: null,
    },
    persistence,
    credentialOptions,
  );
  const baseUrl = sandboxExecutionApiUrl();
  const token = internalToken();
  // Multi-service: tear down EVERY dev-preview Sandbox for this execution (one per
  // service). An explicit sandboxName tears down just that one (single-service
  // back-compat). Each adopted prod Deployment is restored server-side from the
  // CR's stashed original-replicas annotation, so an un-looped teardown would leave
  // sibling prods stuck at 0 replicas.
  const names = params.sandboxName
    ? [params.sandboxName]
    : await listDevPreviewSandboxNames(params.executionId, persistence);
  for (const name of names) {
    if (baseUrl) {
      try {
        await fetch(
          `${baseUrl}/internal/dev-preview/${encodeURIComponent(name)}`,
          {
            method: "DELETE",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        );
      } catch (err) {
        console.warn(
          `[dev-preview] teardown request failed for ${name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (persistence) {
      try {
        await persistence.markWorkflowWorkspaceSessionCleaned({
          workspaceRef: name,
        });
      } catch {
        /* best-effort */
      }
    }
  }
  // B5: restore-all sweep. The per-Sandbox DELETE restores ITS adopted prod
  // Deployment from the CR annotation, but a Deployment can be orphaned at 0
  // replicas with no Sandbox CR left to name it (SEA restarted mid-provision,
  // CR reaped out-of-band). Ask SEA to restore any Deployment still carrying
  // wfb-dev-preview/original-replicas that no live Sandbox claims. Runs even
  // when no session rows were found — that IS the orphan case. Best-effort.
  if (baseUrl) {
    try {
      await fetch(`${baseUrl}/internal/dev-preview/restore-orphans`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (err) {
      console.warn(
        "[dev-preview] restore-orphans sweep failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (names.length === 0) return { ok: true, sandboxName: null };
  // Drop the per-preview database (functional previews). Best-effort — IF NOT
  // EXISTS-safe, so harmless for UI-only previews that never created one.
  if (previewDatabases) {
    try {
      await previewDatabases.drop({ executionId: params.executionId });
    } catch (err) {
      console.warn(
        "[dev-preview] preview DB drop failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { ok: true, sandboxName: names[0] ?? null };
}
