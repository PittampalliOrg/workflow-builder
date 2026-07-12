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
import { RetryableDevPreviewActivationError } from "$lib/server/application/ports/dev-preview-provisioner";
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
  devPreviewSandboxName,
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
  status?: string;
  sandboxState: Record<string, unknown> | null;
};

const DEV_PREVIEW_RESPONSE_PATH_SERVICES = new Set([
  "workflow-builder",
  "function-router",
]);

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

type DevPreviewInfrastructureOptions = Readonly<{
  stageAdoption?: true;
}>;

type DevPreviewActivationReceipt = Readonly<
  | {
      complete: false;
      pending: true;
      activationPhase: "scheduled" | "activating";
      batchId: string;
    }
  | {
      complete: true;
      pending: false;
      activationPhase: "active";
      batchId: string;
    }
>;

class DevPreviewActivationRejectedError extends Error {}

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
  if (params.mode === "preview-native" && params.adopt !== false) {
    const service = resolveDevPreviewDescriptor(params.service).service;
    if (DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service)) {
      throw new Error(
        `Preview-native adoption of ${service} requires provisionMany so activation can be observed`,
      );
    }
  }
  return provisionDevPreviewInternal(
    params,
    persistence,
    previewDatabases,
    credentialOptions,
  );
}

async function provisionDevPreviewInternal(
  params: ProvisionDevPreviewParams,
  persistence?: DevPreviewPersistence,
  previewDatabases?: PreviewDatabaseProvisioner,
  credentialOptions?: DevSyncCredentialResolverOptions,
  infrastructureOptions?: DevPreviewInfrastructureOptions,
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
  let previewDatabaseProvisioned = false;
  if (descriptor.functional && !previewNative) {
    if (!previewDatabases) {
      throw new Error("Preview database provisioner not configured");
    }
    const { databaseUrl, sourceUrl } = await previewDatabases.provision({
      executionId: params.executionId,
    });
    previewDatabaseProvisioned = true;
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
                ...(infrastructureOptions?.stageAdoption
                  ? { stageAdoption: true }
                  : {}),
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
  const expectedSandboxName = devPreviewSandboxName(
    params.executionId,
    descriptor.service,
  );
  let info: DevPreviewInfo;
  try {
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
    if (infrastructureOptions?.stageAdoption && body.staged !== true) {
      throw new Error(
        `sandbox-execution-api did not acknowledge staged adoption for ${descriptor.service}`,
      );
    }
    const sandboxName = String(body.sandboxName ?? "");
    if (sandboxName !== expectedSandboxName) {
      throw new Error(
        `sandbox-execution-api returned an invalid dev-preview identity for ${descriptor.service}`,
      );
    }
    info = {
      sandboxName,
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
    const teardownIntent = await readDevPreviewTeardownIntent({
      baseUrl,
      executionId: params.executionId,
      token,
    });
    if (teardownIntent) {
      throw new Error(
        `dev-preview teardown is already in progress for ${params.executionId}`,
      );
    }
  } catch (cause) {
    try {
      await compensateUnconfirmedDevPreviewProvision({
        baseUrl,
        token,
        executionId: params.executionId,
        service: descriptor.service,
        sandboxName: expectedSandboxName,
        persistence,
        previewDatabases,
        previewDatabaseProvisioned,
      });
    } catch (cleanupCause) {
      throw new Error(
        `${message(cause)}; unconfirmed provision cleanup was not proven: ${message(cleanupCause)}`,
      );
    }
    throw cause;
  }
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
 * separate dev-preview Sandbox keyed on (executionId, service) server-side. Ordinary
 * peers stage first, then response-path services; one exact batch activation starts
 * cutover only after every requested service is ready. Any partial failure is a
 * transaction failure: every observed or inventory-discovered Sandbox receives a
 * compensating teardown. Response-path services may acknowledge deferred cleanup so
 * the request can return through the services it is replacing.
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
  const selfCutover =
    shared.mode === "preview-native" && shared.adopt !== false;
  if (selfCutover) {
    let resumed: DevPreviewServiceResult[] | null;
    try {
      resumed = await persistedReadyDevPreviewBatch(
        { ...shared, executionId: params.executionId, services },
        persistence,
        credentialOptions,
      );
    } catch (cause) {
      if (!(cause instanceof DevPreviewActivationRejectedError)) throw cause;
      const failure = `persisted batch activation rejected: ${message(cause)}`;
      const rejected = services.map((service) => ({
        service,
        ok: false,
        error: failure,
      }));
      return {
        executionId: params.executionId,
        services: await compensateProvisionedPreviewBatch(
          params.executionId,
          rejected,
          persistence,
          failure,
        ),
        ok: false,
        complete: false,
        pending: false,
        activationPhase: "failed",
      };
    }
    if (resumed) {
      const baseUrl = sandboxExecutionApiUrl();
      if (!baseUrl) {
        throw new RetryableDevPreviewActivationError(
          "SANDBOX_EXECUTION_API_URL not configured",
        );
      }
      if (
        await readDevPreviewTeardownIntent({
          baseUrl,
          executionId: params.executionId,
          token: internalToken(),
        })
      ) {
        throw new DevPreviewActivationRejectedError(
          `dev-preview teardown is already in progress for ${params.executionId}`,
        );
      }
      return activateReadyDevPreviewBatch(
        params.executionId,
        resumed,
        persistence,
      );
    }
  }
  const settled: PromiseSettledResult<DevPreviewInfo>[] = new Array(
    services.length,
  );
  const provisionIndexes = async (
    indexes: readonly number[],
    infrastructureOptions?: DevPreviewInfrastructureOptions,
  ) => {
    const group = await Promise.allSettled(
      indexes.map((index) =>
        provisionDevPreviewInternal(
          { ...shared, service: services[index] },
          persistence,
          previewDatabases,
          credentialOptions,
          infrastructureOptions,
        ),
      ),
    );
    indexes.forEach((index, groupIndex) => {
      settled[index] = group[
        groupIndex
      ] as PromiseSettledResult<DevPreviewInfo>;
    });
  };
  if (selfCutover) {
    const peerIndexes = services
      .map((service, index) => ({ service, index }))
      .filter(({ service }) => !DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service))
      .map(({ index }) => index);
    const responsePathIndexes = services
      .map((service, index) => ({ service, index }))
      .filter(({ service }) => DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service))
      .map(({ index }) => index);
    await provisionIndexes(peerIndexes, { stageAdoption: true });
    const peerFailed = peerIndexes.some((index) => {
      const result = settled[index];
      return (
        !result ||
        result.status === "rejected" ||
        !fulfilledPreviewResult(services[index] as string, result.value).ok
      );
    });
    if (peerFailed) {
      for (const index of responsePathIndexes) {
        settled[index] = {
          status: "rejected",
          reason: new Error(
            `${services[index]} cutover skipped because a peer service failed readiness`,
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
        complete: false,
        pending: false,
        activationPhase: "failed",
      };
    }
    await provisionIndexes(responsePathIndexes, { stageAdoption: true });
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
      complete: false,
      pending: false,
      activationPhase: "failed",
    };
  }
  if (selfCutover) {
    return activateReadyDevPreviewBatch(
      params.executionId,
      results,
      persistence,
    );
  }
  return {
    executionId: params.executionId,
    services: results,
    ok: true,
    complete: true,
    pending: false,
    activationPhase: "not-required",
  };
}

async function activateReadyDevPreviewBatch(
  executionId: string,
  results: readonly DevPreviewServiceResult[],
  persistence?: DevPreviewPersistence,
): Promise<DevPreviewsResult> {
  const sandboxNames = results
    .map((result) => result.info?.sandboxName ?? "")
    .sort();
  try {
    const activation = await activateStagedDevPreviewBatch({
      executionId,
      sandboxNames,
    });
    return {
      executionId,
      services: [...results],
      ok: true,
      ...activation,
    };
  } catch (cause) {
    if (!(cause instanceof DevPreviewActivationRejectedError)) {
      throw cause;
    }
    const failure = `batch activation failed: ${message(cause)}`;
    return {
      executionId,
      services: await compensateProvisionedPreviewBatch(
        executionId,
        results,
        persistence,
        failure,
      ),
      ok: false,
      complete: false,
      pending: false,
      activationPhase: "failed",
    };
  }
}

async function compensateProvisionedPreviewBatch(
  executionId: string,
  results: readonly DevPreviewServiceResult[],
  persistence?: DevPreviewPersistence,
  failureContext?: string,
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
  const cleanup = new Map<
    string,
    | { disposition: "deleted" | "deferred"; error?: never }
    | { disposition?: never; error: string }
  >();
  const deferred = new Map<string, string>();
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

  const ordinaryCandidates = [...candidates].filter(
    ([service]) => !DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service),
  );
  const responsePathCandidates = [...candidates].filter(([service]) =>
    DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service),
  );
  const cleanupOrdinaryCandidate = async ([service, name]: [
    string,
    string,
  ]) => {
    try {
      if (!baseUrl) throw new Error("SANDBOX_EXECUTION_API_URL not configured");
      const disposition = await requestDevPreviewTeardown({
        baseUrl,
        token,
        name,
        executionId,
        service,
      });
      if (disposition !== "deleted") {
        throw new Error(
          "non-response-path compensating teardown was unexpectedly deferred",
        );
      }
      if (persistence) {
        const cleaned = await persistence
          .markWorkflowWorkspaceSessionCleaned({ workspaceRef: name })
          .catch(() => false);
        if (!cleaned) {
          throw new Error("workspace cleanup state was not persisted");
        }
      }
      cleanup.set(service, { disposition });
    } catch (cause) {
      cleanup.set(service, { error: message(cause) });
    }
  };

  // Ordinary services delete synchronously. Finish and prove those first so a
  // response-path deletion grace never runs while peer cleanup is still blocked.
  await Promise.all(ordinaryCandidates.map(cleanupOrdinaryCandidate));

  if (baseUrl && ordinaryCandidates.length > 0) {
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
      for (const [service] of ordinaryCandidates) {
        if (cleanup.get(service)?.disposition) {
          cleanup.set(service, { error });
        }
      }
    }
  }

  // This is the last infrastructure proof before response-path DELETEs. Their
  // exact SEA receipts are sufficient; no request-path polling follows them.
  if (baseUrl) {
    try {
      const remaining = await discoverProvisionedPreviewBatch({
        baseUrl,
        executionId,
        requestedServices,
        token,
      });
      const expectedResponsePath = new Map(responsePathCandidates);
      const unexpected = [...remaining].filter(
        ([service, name]) => expectedResponsePath.get(service) !== name,
      );
      if (unexpected.length > 0) {
        throw new Error(
          `Sandboxes still present: ${unexpected
            .map(([, name]) => name)
            .sort()
            .join(", ")}`,
        );
      }
    } catch (cause) {
      globalErrors.push(`final inventory failed: ${message(cause)}`);
    }
  }

  // Final external operations: cancel response-path cutovers and accept SEA-owned
  // delayed cleanup. Once any receipt is deferred, do no database or HTTP work.
  const responsePathCleanupAllowed =
    globalErrors.length === 0 &&
    ordinaryCandidates.every(
      ([service]) => cleanup.get(service)?.disposition === "deleted",
    );
  const responsePathReceipts = await Promise.all(
    (responsePathCleanupAllowed ? responsePathCandidates : []).map(
      async ([service, name]) => {
        try {
          if (!baseUrl)
            throw new Error("SANDBOX_EXECUTION_API_URL not configured");
          const disposition = await requestDevPreviewTeardown({
            baseUrl,
            token,
            name,
            executionId,
            service,
          });
          return { service, name, disposition } as const;
        } catch (cause) {
          return { service, name, error: message(cause) } as const;
        }
      },
    ),
  );
  for (const receipt of responsePathReceipts) {
    if (typeof receipt.error === "string") {
      cleanup.set(receipt.service, { error: receipt.error });
    } else {
      cleanup.set(receipt.service, { disposition: receipt.disposition });
      if (receipt.disposition === "deferred") {
        deferred.set(receipt.service, receipt.name);
      }
    }
  }
  if (deferred.size === 0 && persistence) {
    await Promise.all(
      responsePathReceipts.map(async (receipt) => {
        if (
          typeof receipt.error === "string" ||
          receipt.disposition !== "deleted"
        )
          return;
        const cleaned = await persistence
          .markWorkflowWorkspaceSessionCleaned({ workspaceRef: receipt.name })
          .catch(() => false);
        if (!cleaned) {
          cleanup.set(receipt.service, {
            error: "workspace cleanup state was not persisted",
          });
        }
      }),
    );
  }

  return results.map((result) => {
    const cleanupResult = cleanup.get(result.service);
    const cleanupError = cleanupResult?.error;
    const proofError = [
      ...globalErrors,
      ...(cleanupError ? [cleanupError] : []),
      ...(candidates.has(result.service) && !cleanupResult
        ? ["teardown request result missing"]
        : []),
    ].join("; ");
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
      error: proofError
        ? `${failureContext ?? "multi-service provision failed"}; compensating teardown failed: ${proofError}`
        : cleanupResult?.disposition === "deferred"
          ? `${failureContext ?? "multi-service provision failed"}; compensating teardown accepted`
          : `${failureContext ?? "multi-service provision failed"}; compensating teardown completed`,
    };
  });
}

async function compensateUnconfirmedDevPreviewProvision(input: {
  baseUrl: string;
  token: string;
  executionId: string;
  service: string;
  sandboxName: string;
  persistence?: DevPreviewPersistence;
  previewDatabases?: PreviewDatabaseProvisioner;
  previewDatabaseProvisioned: boolean;
}): Promise<void> {
  const disposition = await requestDevPreviewTeardown({
    baseUrl: input.baseUrl,
    token: input.token,
    name: input.sandboxName,
    executionId: input.executionId,
    service: input.service,
  });
  if (disposition !== "deleted") {
    throw new Error("deterministic provision cleanup was deferred");
  }

  const cleanupErrors: string[] = [];
  if (input.persistence) {
    try {
      await input.persistence.markWorkflowWorkspaceSessionCleaned({
        workspaceRef: input.sandboxName,
      });
    } catch (cause) {
      cleanupErrors.push(`workspace cleanup state failed: ${message(cause)}`);
    }
  }
  if (input.previewDatabaseProvisioned && input.previewDatabases) {
    try {
      await input.previewDatabases.drop({ executionId: input.executionId });
    } catch (cause) {
      cleanupErrors.push(`preview database cleanup failed: ${message(cause)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join("; "));
  }
}

async function activateStagedDevPreviewBatch(input: {
  executionId: string;
  sandboxNames: readonly string[];
}): Promise<DevPreviewActivationReceipt> {
  const baseUrl = sandboxExecutionApiUrl();
  if (!baseUrl) {
    throw new RetryableDevPreviewActivationError(
      "SANDBOX_EXECUTION_API_URL not configured",
    );
  }
  if (
    input.sandboxNames.length === 0 ||
    new Set(input.sandboxNames).size !== input.sandboxNames.length ||
    input.sandboxNames.some(
      (name) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name),
    )
  ) {
    throw new DevPreviewActivationRejectedError(
      "staged dev-preview batch has invalid Sandbox identities",
    );
  }
  const token = internalToken();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/internal/dev-previews/activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new RetryableDevPreviewActivationError(
      `batch activation response was not observed: ${message(cause)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const receivedNames = Array.isArray(body?.sandboxNames)
    ? body.sandboxNames
    : [];
  const batchId = typeof body?.batchId === "string" ? body.batchId : "";
  const phase = body?.activationPhase;
  const exactIdentity =
    body?.executionId === input.executionId &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId) &&
    receivedNames.length === input.sandboxNames.length &&
    receivedNames.every((name, index) => name === input.sandboxNames[index]);
  const pending =
    body?.accepted === true &&
    body?.complete === false &&
    body?.pending === true &&
    body?.activated === false &&
    (phase === "scheduled" || phase === "activating");
  const active =
    body?.accepted === true &&
    body?.complete === true &&
    body?.pending === false &&
    body?.activated === true &&
    phase === "active";
  const explicitlyRejected =
    exactIdentity &&
    body?.accepted === false &&
    body.complete === false &&
    body.pending === false &&
    body.activated === false &&
    phase === "failed";
  const detail =
    typeof body?.detail === "string" || typeof body?.error === "string"
      ? String(body.detail ?? body.error)
      : `batch activation was not accepted (HTTP ${response.status})`;

  if (
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429
  ) {
    throw new RetryableDevPreviewActivationError(detail);
  }
  if (response.status >= 400 && response.status < 500) {
    throw new DevPreviewActivationRejectedError(detail);
  }
  if (explicitlyRejected) {
    throw new DevPreviewActivationRejectedError(detail);
  }
  if (
    !response.ok ||
    !exactIdentity ||
    (!pending && !active) ||
    (pending && response.status !== 202) ||
    (active && response.status !== 200)
  ) {
    throw new RetryableDevPreviewActivationError(detail);
  }
  return active
    ? {
        complete: true,
        pending: false,
        activationPhase: "active",
        batchId,
      }
    : {
        complete: false,
        pending: true,
        activationPhase: phase as "scheduled" | "activating",
        batchId,
      };
}

async function requestDevPreviewTeardown(input: {
  baseUrl: string;
  token: string;
  name: string;
  executionId: string;
  service: string;
}): Promise<"deleted" | "deferred"> {
  const query = new URLSearchParams({
    executionId: input.executionId,
    service: input.service,
  });
  const url = `${input.baseUrl}/internal/dev-preview/${encodeURIComponent(input.name)}?${query}`;
  let uncertainty = "teardown receipt was not observed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      uncertainty = `teardown response was not observed: ${message(cause)}`;
      continue;
    }

    let body: Record<string, unknown>;
    try {
      const value = (await response.json()) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("receipt body was not an object");
      }
      body = value as Record<string, unknown>;
    } catch (cause) {
      uncertainty = `teardown receipt was not observed: ${message(cause)}`;
      continue;
    }

    const deleted =
      body.accepted === true &&
      body.deleted === true &&
      body.deferred === false;
    const deferred =
      body.accepted === true &&
      body.deleted === false &&
      body.deferred === true;
    if (!response.ok || body.accepted === false) {
      throw new Error(
        typeof body.detail === "string"
          ? body.detail
          : `teardown was not accepted (HTTP ${response.status})`,
      );
    }
    if (
      typeof body.sandboxName === "string" &&
      body.sandboxName !== input.name
    ) {
      throw new Error(
        "teardown receipt returned an unexpected Sandbox identity",
      );
    }
    if (
      body.sandboxName === input.name &&
      ((response.status === 200 && deleted) ||
        (response.status === 202 && deferred))
    ) {
      return deferred ? "deferred" : "deleted";
    }
    uncertainty = `teardown receipt was incomplete (HTTP ${response.status})`;
  }
  throw new Error(`${uncertainty} after 3 attempts`);
}

async function requestDevPreviewTeardownIntent(input: {
  baseUrl: string;
  executionId: string;
  token: string;
}): Promise<void> {
  const response = await fetch(
    `${input.baseUrl}/internal/dev-previews/teardown-intent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({ executionId: input.executionId }),
    },
  );
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !response.ok ||
    body?.accepted !== true ||
    body.executionId !== input.executionId
  ) {
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `dev-preview teardown intent was not accepted (HTTP ${response.status})`,
    );
  }
}

async function readDevPreviewTeardownIntent(input: {
  baseUrl: string;
  executionId: string;
  token: string;
}): Promise<boolean> {
  const response = await fetch(
    `${input.baseUrl}/internal/dev-previews/teardown-intent?executionId=${encodeURIComponent(input.executionId)}`,
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
    typeof body.teardownIntent !== "boolean" ||
    JSON.stringify(Object.keys(body).sort()) !==
      JSON.stringify(["executionId", "teardownIntent"])
  ) {
    throw new Error(
      `dev-preview teardown intent confirmation was not proven (HTTP ${response.status})`,
    );
  }
  return body.teardownIntent;
}

async function listProvisionedPreviewBatch(input: {
  baseUrl: string;
  executionId: string;
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
    let knownService = false;
    try {
      knownService = resolveDevPreviewDescriptor(service).service === service;
    } catch {
      knownService = false;
    }
    if (
      !knownService ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ||
      name !== devPreviewSandboxName(input.executionId, service) ||
      discovered.has(service)
    ) {
      throw new Error("dev-preview inventory returned an invalid batch member");
    }
    discovered.set(service, name);
  }
  return discovered;
}

async function discoverProvisionedPreviewBatch(input: {
  baseUrl: string;
  executionId: string;
  requestedServices: ReadonlySet<string>;
  token: string;
}): Promise<ReadonlyMap<string, string>> {
  const discovered = await listProvisionedPreviewBatch(input);
  if (
    [...discovered.keys()].some(
      (service) => !input.requestedServices.has(service),
    )
  ) {
    throw new Error(
      "dev-preview inventory returned an unexpected batch member",
    );
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
  const responsePathService = serviceIds.find((service) =>
    DEV_PREVIEW_RESPONSE_PATH_SERVICES.has(service),
  );
  if (params.adopt !== false && responsePathService) {
    throw new Error(
      `adopted ${responsePathService} image replacement would terminate the control request; use a fresh acceptance preview`,
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
      complete: true,
      pending: false,
      activationPhase: "not-required",
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
    complete: false,
    pending: false,
    activationPhase: "failed",
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
 * Reconstruct an already-staged batch from durable application data before any
 * infrastructure write. Durable workflow replay can arrive while SEA is still
 * activating the first exact batch; issuing the five provision requests again
 * would race that worker and can turn a valid pending receipt into compensation.
 */
async function persistedReadyDevPreviewBatch(
  params: ProvisionDevPreviewsParams,
  persistence?: DevPreviewPersistence,
  credentialOptions?: DevSyncCredentialResolverOptions,
): Promise<DevPreviewServiceResult[] | null> {
  if (!persistence) return null;

  let rows: DevPreviewWorkspaceSessionRecord[];
  try {
    rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
      executionId: params.executionId,
      limit: 50,
    });
  } catch (cause) {
    throw new RetryableDevPreviewActivationError(
      `persisted dev-preview batch could not be read: ${message(cause)}`,
    );
  }

  const candidates = rows
    .filter((row) => row.status == null || row.status === "active")
    .map((row) => ({
      row,
      details: asRecord(asRecord(row.sandboxState)?.details),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        row: DevPreviewWorkspaceSessionRecord;
        details: Record<string, unknown>;
      } =>
        candidate.details?.kind === "dev-preview" &&
        candidate.details.executionId === params.executionId,
    );
  if (candidates.length === 0) return null;

  const expectedServices = [...params.services].sort();
  const receivedServices = candidates
    .map(({ details }) =>
      typeof details.service === "string" ? details.service : "",
    )
    .sort();
  if (
    new Set(receivedServices).size !== receivedServices.length ||
    receivedServices.some((service) => !expectedServices.includes(service))
  ) {
    throw new DevPreviewActivationRejectedError(
      "persisted dev-preview batch does not match the exact requested service set",
    );
  }
  if (JSON.stringify(receivedServices) !== JSON.stringify(expectedServices)) {
    throw new RetryableDevPreviewActivationError(
      "persisted dev-preview batch is still being staged",
    );
  }

  const byService = new Map(
    candidates.map((candidate) => [
      String(candidate.details.service),
      candidate,
    ]),
  );
  const results: DevPreviewServiceResult[] = [];
  for (const service of params.services) {
    const candidate = byService.get(service);
    if (!candidate) {
      throw new RetryableDevPreviewActivationError(
        `persisted dev-preview batch is missing ${service}`,
      );
    }
    const { row, details } = candidate;
    const descriptor = resolveDevPreviewDescriptor(service, {
      ...process.env,
      ...env,
    });
    const sandboxName = devPreviewSandboxName(params.executionId, service);
    let image: string | null = null;
    if (typeof details.image === "string") {
      try {
        image = assertDevPreviewImage(descriptor, details.image);
      } catch (cause) {
        throw new DevPreviewActivationRejectedError(
          `persisted dev-preview image is invalid for ${service}: ${message(cause)}`,
        );
      }
    }
    const podIP = typeof details.podIP === "string" ? details.podIP.trim() : "";
    const port =
      typeof details.port === "number" && Number.isInteger(details.port)
        ? details.port
        : null;
    const syncPort =
      typeof details.syncPort === "number" && Number.isInteger(details.syncPort)
        ? details.syncPort
        : null;
    const syncUrl =
      typeof details.syncUrl === "string" ? details.syncUrl : null;
    const expectedBrowseUrl = params.origin ?? devPreviewBrowseUrl(descriptor);
    const browseUrl =
      typeof details.browseUrl === "string"
        ? details.browseUrl
        : details.browseUrl === null
          ? null
          : expectedBrowseUrl;
    const expectedDaprAppId =
      descriptor.capabilities.previewNative?.daprAppId ?? null;
    const daprAppId =
      typeof details.daprAppId === "string" ? details.daprAppId : null;
    if (
      row.workspaceRef !== sandboxName ||
      details.sandboxName !== sandboxName ||
      details.service !== service ||
      details.executionId !== params.executionId ||
      details.catalogDigest !== DEV_PREVIEW_CATALOG_DIGEST ||
      details.ready !== true ||
      !image ||
      !podIP ||
      port !== descriptor.port ||
      syncPort !== descriptor.syncPort ||
      syncUrl !== `http://${podIP}:${syncPort}/__sync` ||
      (typeof details.url === "string" &&
        details.url !== `http://${podIP}:${port}`) ||
      browseUrl !== expectedBrowseUrl ||
      details.needsDapr !== Boolean(descriptor.needsDapr) ||
      daprAppId !== expectedDaprAppId ||
      (params.image != null && params.image !== image)
    ) {
      throw new DevPreviewActivationRejectedError(
        `persisted dev-preview identity is invalid for ${service}`,
      );
    }
    // Replay can restore all services at once. Keep broker-backed credential
    // validation sequential so one receipt poll cannot overload its authority.
    const { agentActionToken: syncCapability } =
      await resolveDevSyncCredentials(
        { executionId: params.executionId, service },
        credentialOptions,
      );
    const info: DevPreviewInfo = {
      sandboxName,
      executionId: params.executionId,
      service,
      image,
      podIP,
      port,
      syncPort,
      url: typeof details.url === "string" ? details.url : null,
      syncUrl,
      syncCapability,
      browseUrl,
      repoUrl: descriptor.repoUrl,
      repoSubdir: descriptor.repoSubdir,
      syncPaths: devPreviewSyncPaths(descriptor),
      extraSync: descriptor.extraSync ?? [],
      captureOnly: devPreviewCaptureOnly(descriptor),
      ready: true,
      status: typeof details.status === "string" ? details.status : "running",
      needsDapr: Boolean(descriptor.needsDapr),
      daprAppId,
    };
    results.push({ service, ok: true, info });
  }
  return results;
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
    status: info.status,
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
    // The public teardown path uses this row as its project-scoped idempotency
    // tombstone. A live pod without the row cannot be reported as provisioned.
    console.error(
      `[dev-preview] failed to persist workspace session row (execId=${info.executionId}, ref=${info.sandboxName}):`,
      err instanceof Error ? err.message : err,
    );
    throw err;
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

type DevPreviewSandboxTarget = { name: string; service: string };

function devPreviewResponsePathRank(target: DevPreviewSandboxTarget): number {
  const service =
    target.service ??
    [...DEV_PREVIEW_RESPONSE_PATH_SERVICES].find((candidate) =>
      target.name.includes(candidate),
    ) ??
    null;
  if (service === "workflow-builder") return 2;
  if (service === "function-router") return 1;
  return 0;
}

/** Every distinct dev-preview Sandbox persisted for an execution (one per service). */
async function listDevPreviewSandboxTargets(
  executionId: string,
  persistence?: DevPreviewPersistence,
): Promise<DevPreviewSandboxTarget[]> {
  if (!persistence) return [];
  const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
    executionId,
    limit: 50,
  });
  const targets = new Map<string, string>();
  for (const row of rows) {
    const details = asRecord(asRecord(row.sandboxState)?.details);
    if (
      details?.kind !== "dev-preview" ||
      details.executionId !== executionId ||
      typeof details.service !== "string" ||
      typeof details.sandboxName !== "string"
    ) {
      continue;
    }
    let service: string;
    try {
      service = resolveDevPreviewDescriptor(details.service).service;
    } catch {
      continue;
    }
    if (service !== details.service) continue;
    const expectedName = devPreviewSandboxName(executionId, service);
    if (
      details.sandboxName !== expectedName ||
      row.workspaceRef !== expectedName
    ) {
      continue;
    }
    targets.set(expectedName, service);
  }
  return [...targets.entries()]
    .sort(
      ([leftName, leftService], [rightName, rightService]) =>
        devPreviewResponsePathRank({ name: leftName, service: leftService }) -
          devPreviewResponsePathRank({
            name: rightName,
            service: rightService,
          }) || leftName.localeCompare(rightName),
    )
    .map(([name, service]) => ({ name, service }));
}

function unionDevPreviewSandboxTargets(
  persisted: readonly DevPreviewSandboxTarget[],
  inventory: ReadonlyMap<string, string>,
): DevPreviewSandboxTarget[] {
  const byName = new Map<string, string>();
  for (const target of persisted) byName.set(target.name, target.service);
  for (const [service, name] of inventory) {
    const existingService = byName.get(name);
    if (existingService && existingService !== service) {
      throw new Error(
        `dev-preview target identity conflict for ${name}: ${existingService} != ${service}`,
      );
    }
    byName.set(name, service);
  }
  return [...byName.entries()]
    .map(([name, service]) => ({ name, service }))
    .sort(
      (left, right) =>
        devPreviewResponsePathRank(left) - devPreviewResponsePathRank(right) ||
        left.name.localeCompare(right.name),
    );
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
  const baseUrl = sandboxExecutionApiUrl();
  const token = internalToken();
  // Multi-service: tear down EVERY dev-preview Sandbox for this execution (one per
  // service). An explicit sandboxName tears down just that one (single-service
  // back-compat). Each adopted prod Deployment is restored server-side from the
  // CR's stashed original-replicas annotation, so an un-looped teardown would leave
  // sibling prods stuck at 0 replicas.
  let targets: DevPreviewSandboxTarget[];
  let persistedTargets: DevPreviewSandboxTarget[] = [];
  let initialInventory: ReadonlyMap<string, string> = new Map();
  if (!params.sandboxName) {
    if (!baseUrl) {
      return {
        ok: false,
        complete: false,
        pending: false,
        sandboxName: null,
      };
    }
    try {
      await requestDevPreviewTeardownIntent({
        baseUrl,
        executionId: params.executionId,
        token,
      });
    } catch (cause) {
      console.warn(
        "[dev-preview] teardown intent failed before inventory:",
        message(cause),
      );
      return {
        ok: false,
        complete: false,
        pending: false,
        sandboxName: null,
      };
    }
  }
  // Fence new execution-wide provisioning before reading or exporting the live
  // workspace. An explicit single-Sandbox cleanup remains the narrow back-compat
  // path and does not acquire the execution-wide fence.
  await captureAllDevPreviewSources(
    params.executionId,
    {
      nodeId: "dev-preview",
      iteration: null,
    },
    persistence,
    credentialOptions,
  );
  try {
    persistedTargets = await listDevPreviewSandboxTargets(
      params.executionId,
      persistence,
    );
  } catch (cause) {
    console.warn(
      "[dev-preview] persistence inventory failed before teardown:",
      message(cause),
    );
    return {
      ok: false,
      complete: false,
      pending: false,
      sandboxName: params.sandboxName ?? null,
    };
  }
  const persistedNames = new Set(persistedTargets.map(({ name }) => name));
  if (params.sandboxName) {
    const persistedTarget = persistedTargets.find(
      ({ name }) => name === params.sandboxName,
    );
    if (!persistedTarget) {
      return {
        ok: false,
        complete: false,
        pending: false,
        sandboxName: params.sandboxName,
      };
    }
    targets = [persistedTarget];
  } else {
    try {
      initialInventory = await listProvisionedPreviewBatch({
        baseUrl: baseUrl as string,
        executionId: params.executionId,
        token,
      });
      targets = unionDevPreviewSandboxTargets(
        persistedTargets,
        initialInventory,
      );
    } catch (cause) {
      console.warn(
        "[dev-preview] execution inventory failed before teardown:",
        message(cause),
      );
      return {
        ok: false,
        complete: false,
        pending: false,
        sandboxName: persistedTargets[0]?.name ?? null,
      };
    }
  }
  const names = targets.map(({ name }) => name);
  const deferred = new Set<string>();
  const teardownErrors: string[] = [];
  const ordinaryTargets = targets.filter(
    (target) => devPreviewResponsePathRank(target) === 0,
  );
  const responsePathTargets = targets.filter(
    (target) => devPreviewResponsePathRank(target) > 0,
  );
  for (const { name, service } of ordinaryTargets) {
    try {
      if (!baseUrl) throw new Error("SANDBOX_EXECUTION_API_URL not configured");
      const disposition = await requestDevPreviewTeardown({
        baseUrl,
        token,
        name,
        executionId: params.executionId,
        service,
      });
      if (disposition !== "deleted") {
        throw new Error("non-response-path teardown was unexpectedly deferred");
      }
      if (persistence && persistedNames.has(name)) {
        const cleaned = await persistence
          .markWorkflowWorkspaceSessionCleaned({ workspaceRef: name })
          .catch(() => false);
        if (!cleaned) {
          throw new Error("workspace cleanup state was not persisted");
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      teardownErrors.push(`${name}: ${detail}`);
      console.warn(
        `[dev-preview] teardown request failed for ${name}:`,
        detail,
      );
    }
  }
  // Prove that every ordinary member from the exact initial inventory is gone
  // before touching the response path. This is the last inventory I/O before a
  // deferred response-path DELETE receipt.
  if (!params.sandboxName && baseUrl && teardownErrors.length === 0) {
    try {
      const remaining = await listProvisionedPreviewBatch({
        baseUrl,
        executionId: params.executionId,
        token,
      });
      const expected = new Map(
        responsePathTargets.flatMap((target) =>
          target.service && initialInventory.get(target.service) === target.name
            ? [[target.service, target.name] as const]
            : [],
        ),
      );
      const unexpected = [...remaining].filter(
        ([service, name]) => expected.get(service) !== name,
      );
      if (unexpected.length > 0 || remaining.size !== expected.size) {
        throw new Error(
          `dev-preview members remain outside the response path: ${
            unexpected
              .map(([, name]) => name)
              .sort()
              .join(", ") || "identity mismatch"
          }`,
        );
      }
    } catch (cause) {
      teardownErrors.push(`final inventory: ${message(cause)}`);
    }
  }
  const responsePathReceipts = await Promise.all(
    (teardownErrors.length === 0 ? responsePathTargets : []).map(
      async ({ name, service }) => {
        try {
          if (!baseUrl)
            throw new Error("SANDBOX_EXECUTION_API_URL not configured");
          const disposition = await requestDevPreviewTeardown({
            baseUrl,
            token,
            name,
            executionId: params.executionId,
            service,
          });
          return { name, disposition } as const;
        } catch (err) {
          return {
            name,
            error: err instanceof Error ? err.message : String(err),
          } as const;
        }
      },
    ),
  );
  for (const receipt of responsePathReceipts) {
    if ("error" in receipt) {
      teardownErrors.push(`${receipt.name}: ${receipt.error}`);
      console.warn(
        `[dev-preview] teardown request failed for ${receipt.name}:`,
        receipt.error,
      );
    } else if (receipt.disposition === "deferred") {
      deferred.add(receipt.name);
    }
  }
  // If any response-path deletion is deferred, return its accepted receipt
  // immediately. A later idempotent call persists completion after SEA restores prod.
  if (deferred.size === 0 && persistence) {
    await Promise.all(
      responsePathReceipts.map(async (receipt) => {
        if ("error" in receipt || receipt.disposition !== "deleted") return;
        if (!persistedNames.has(receipt.name)) return;
        const cleaned = await persistence
          .markWorkflowWorkspaceSessionCleaned({ workspaceRef: receipt.name })
          .catch(() => false);
        if (!cleaned) {
          teardownErrors.push(
            `${receipt.name}: workspace cleanup state was not persisted`,
          );
        }
      }),
    );
  }
  // B5: restore-all sweep. The per-Sandbox DELETE restores ITS adopted prod
  // Deployment from the CR annotation, but a Deployment can be orphaned at 0
  // replicas with no Sandbox CR left to name it (SEA restarted mid-provision,
  // CR reaped out-of-band). Ask SEA to restore any Deployment still carrying
  // wfb-dev-preview/original-replicas that no live Sandbox claims. Runs even
  // when no session rows were found — that IS the orphan case. Best-effort.
  if (baseUrl && deferred.size === 0 && teardownErrors.length === 0) {
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
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      teardownErrors.push(`restore-orphans: ${detail}`);
      console.warn("[dev-preview] restore-orphans sweep failed:", detail);
    }
  }
  let ok = teardownErrors.length === 0;
  const pending = deferred.size > 0;
  let complete = ok && !pending;
  // The database is execution-wide shared state. Drop it only after a complete
  // execution-wide teardown; a narrowed single-Sandbox delete must preserve it.
  if (previewDatabases && complete && !params.sandboxName) {
    try {
      await previewDatabases.drop({ executionId: params.executionId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ok = false;
      complete = false;
      console.warn("[dev-preview] preview DB drop failed:", detail);
    }
  }
  if (names.length === 0) {
    return { ok, complete, pending, sandboxName: null };
  }
  return { ok, complete, pending, sandboxName: names[0] ?? null };
}
