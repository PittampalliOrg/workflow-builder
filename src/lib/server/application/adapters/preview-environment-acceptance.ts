import type {
  ImmutableGitSha,
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentImageBuildPort,
  PreviewEnvironmentInventoryPort,
  PreviewEnvironmentOwner,
  PreviewEnvironmentReadinessPort,
  PreviewEnvironmentRuntimeInspectionPort,
  PreviewEnvironmentTeardownPort,
  PreviewEnvironmentVerificationPort,
  PreviewEnvironmentVerificationResult,
  PreviewControlCapabilityMintPort,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import { createHash } from "node:crypto";
import {
  assertCanonicalTektonPipelineRun,
  createTektonPipelineRun,
  getTektonPipelineRun,
  listTektonTaskRunsForPipelineRun,
  requireTektonPipelineRunUid,
  tektonPipelineRunResults,
  tektonSucceededCondition,
  tektonTaskRunOwnedByPipelineRun,
  tektonTaskRunResults,
  type TektonPipelineRun,
  type TektonTaskRun,
} from "$lib/server/kube/tekton";
import {
  DEV_PREVIEW_CATALOG_DIGEST,
  resolvePreviewAcceptanceBuild,
  resolveRequestedPreviewAcceptanceServiceSet,
} from "$lib/server/workflows/dev-preview-registry";
import { previewApiBaseUrl } from "$lib/server/application/adapters/preview-read-proxy";

type Sleep = (milliseconds: number) => Promise<void>;

type TektonAcceptanceClient = Readonly<{
  create: typeof createTektonPipelineRun;
  get: typeof getTektonPipelineRun;
  listTasks: typeof listTektonTaskRunsForPipelineRun;
}>;

export type TektonPreviewEnvironmentImageBuildOptions = Readonly<{
  namespace?: string;
  dockerConfigSecret?: string;
  serviceAccount?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: Sleep;
  client?: TektonAcceptanceClient;
}>;

export class TektonPreviewEnvironmentImageBuildAdapter implements PreviewEnvironmentImageBuildPort {
  private readonly namespace: string;
  private readonly sleep: Sleep;
  private readonly client: TektonAcceptanceClient;

  constructor(
    private readonly options: TektonPreviewEnvironmentImageBuildOptions = {},
  ) {
    this.namespace = options.namespace ?? "tekton-pipelines";
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.client = options.client ?? {
      create: createTektonPipelineRun,
      get: getTektonPipelineRun,
      listTasks: listTektonTaskRunsForPipelineRun,
    };
  }

  async build(input: Parameters<PreviewEnvironmentImageBuildPort["build"]>[0]) {
    const resolved = resolveRequestedPreviewAcceptanceServiceSet(
      input.services,
    );
    if (
      resolved.rejected.length > 0 ||
      resolved.services.length !== input.services.length
    ) {
      throw new Error(
        "selective build received an unsupported preview-native service set",
      );
    }
    return Promise.all(
      resolved.services.map((service) => this.buildOne(input, service)),
    );
  }

  private async buildOne(
    input: Parameters<PreviewEnvironmentImageBuildPort["build"]>[0],
    service: string,
  ) {
    const build = resolvePreviewAcceptanceBuild(service);
    const imageName = build.image.split("/").at(-1) ?? "";
    if (!imageName) throw new Error(`catalog image is invalid for ${service}`);
    const runName = acceptancePipelineRunName(
      service,
      input.sourceRevision,
      input.requestId,
    );
    const manifest = acceptancePipelineRunManifest({
      name: runName,
      namespace: this.namespace,
      requestId: input.requestId,
      sourceRevision: input.sourceRevision,
      service,
      imageName,
      dockerfile: build.dockerfile,
      context: build.context,
      dockerConfigSecret:
        this.options.dockerConfigSecret ?? "ghcr-push-credentials",
      serviceAccount:
        this.options.serviceAccount ?? "preview-acceptance-build-executor",
    });
    const submission = await this.client.create(this.namespace, manifest, {
      targetCluster: "hub-preview-acceptance",
    });
    const pipelineRunUid = submission.created
      ? requireTektonPipelineRunUid(submission.pipelineRun, {
          namespace: this.namespace,
          name: runName,
        })
      : assertCanonicalTektonPipelineRun(
          this.namespace,
          manifest,
          submission.pipelineRun,
        );
    const completed = await this.waitForPipeline(runName, pipelineRunUid);
    const condition = tektonSucceededCondition(completed);
    if (condition?.status !== "True") {
      throw new Error(
        `acceptance image build ${runName} failed: ${condition?.message ?? condition?.reason ?? "unknown"}`,
      );
    }
    const pipelineResults = tektonPipelineRunResults(completed);
    const taskRuns = await this.client.listTasks(this.namespace, runName, {
      targetCluster: "hub-preview-acceptance",
    });
    const results = mergeBuildResults(pipelineResults, taskRuns, completed);
    const expectedRef = `${build.image}:git-${input.sourceRevision}`;
    if (results.image_ref !== expectedRef) {
      throw new Error(
        `acceptance build ${runName} returned unexpected image_ref`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(results.image_digest ?? "")) {
      throw new Error(
        `acceptance build ${runName} returned no immutable digest`,
      );
    }
    const digest = results.image_digest as `sha256:${string}`;
    return {
      service,
      sourceRevision: input.sourceRevision,
      buildId: runName,
      imageRef: expectedRef,
      digest,
      immutableRef: `${build.image}@${digest}`,
    };
  }

  private async waitForPipeline(
    name: string,
    expectedUid: string,
  ): Promise<TektonPipelineRun> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      const run = await this.client.get(this.namespace, name, {
        targetCluster: "hub-preview-acceptance",
      });
      if (run) {
        const observedUid = requireTektonPipelineRunUid(run, {
          namespace: this.namespace,
          name,
        });
        if (observedUid !== expectedUid) {
          throw new Error(
            `acceptance image build ${name} changed Kubernetes ownership`,
          );
        }
      }
      const condition = tektonSucceededCondition(run);
      if (run && condition?.status && condition.status !== "Unknown")
        return run;
      await this.sleep(this.options.pollMs ?? 5_000);
    }
    throw new Error(`acceptance image build ${name} timed out`);
  }
}

function acceptancePipelineRunName(
  service: string,
  revision: string,
  requestId: string,
): string {
  const requestHash = createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 8);
  return `preview-accept-${service}-${revision.slice(0, 10)}-${requestHash}`.slice(
    0,
    63,
  );
}

function acceptancePipelineRunManifest(input: {
  name: string;
  namespace: string;
  requestId: string;
  sourceRevision: ImmutableGitSha;
  service: string;
  imageName: string;
  dockerfile: string;
  context: string;
  dockerConfigSecret: string;
  serviceAccount: string;
}): TektonPipelineRun {
  return {
    apiVersion: "tekton.dev/v1",
    kind: "PipelineRun",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/part-of": "workflow-builder",
        "stacks.io/build-loop": "preview-acceptance",
        "stacks.io/image-name": input.service,
        "preview.stacks.io/source-revision": input.sourceRevision,
      },
      annotations: {
        "preview.stacks.io/request-id": input.requestId,
        "preview.stacks.io/catalog-digest": DEV_PREVIEW_CATALOG_DIGEST,
      },
    },
    spec: {
      pipelineRef: { name: "preview-acceptance-build" },
      timeouts: { pipeline: "1h0m0s" },
      params: [
        { name: "source_revision", value: input.sourceRevision },
        { name: "image_name", value: input.imageName },
        { name: "dockerfile", value: input.dockerfile },
        { name: "context", value: input.context },
      ],
      workspaces: [
        { name: "shared-workspace", emptyDir: {} },
        {
          name: "dockerconfig",
          secret: { secretName: input.dockerConfigSecret },
        },
      ],
      taskRunTemplate: {
        serviceAccountName: input.serviceAccount,
        podTemplate: {
          hostUsers: false,
          nodeSelector: { "stacks.io/build-pool": "hub" },
          tolerations: [
            {
              key: "stacks.io/build-pool",
              operator: "Equal",
              value: "hub",
              effect: "NoSchedule",
            },
          ],
          securityContext: { fsGroup: 65532 },
        },
      },
    },
  };
}

function mergeBuildResults(
  pipeline: Record<string, string>,
  tasks: TektonTaskRun[],
  pipelineRun: TektonPipelineRun,
): Record<string, string> {
  const taskResults: Record<string, string> = {};
  for (const task of tasks) {
    if (!tektonTaskRunOwnedByPipelineRun(task, pipelineRun)) continue;
    Object.assign(taskResults, tektonTaskRunResults(task));
  }
  return { ...taskResults, ...pipeline };
}

export class VclusterPreviewReadinessAdapter implements PreviewEnvironmentReadinessPort {
  constructor(
    private readonly gateway: VclusterPreviewGatewayPort,
    private readonly sleep: Sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly pollMs = 5_000,
  ) {}

  async waitReady(
    input: Parameters<PreviewEnvironmentReadinessPort["waitReady"]>[0],
  ) {
    const deadline = Date.now() + input.timeoutMs;
    let last = await this.gateway.get(input.name);
    while (!last.ready && Date.now() < deadline) {
      if (/fail|error|degrad|terminat/i.test(last.phase)) break;
      await this.sleep(this.pollMs);
      last = await this.gateway.get(input.name);
    }
    const mismatch = previewContractMismatch(last, input);
    if (last.ready && mismatch.length > 0) {
      return {
        ready: false,
        phase: `contract-mismatch:${mismatch.join(",")}`,
        url: last.url,
      };
    }
    return { ready: last.ready, phase: last.phase, url: last.url };
  }
}

function previewContractMismatch(
  preview: Awaited<ReturnType<VclusterPreviewGatewayPort["get"]>>,
  expected: Omit<
    Parameters<PreviewEnvironmentReadinessPort["waitReady"]>[0],
    "name" | "timeoutMs"
  >,
): string[] {
  const mismatches: string[] = [];
  if (preview.platformRevision !== expected.platformRevision)
    mismatches.push("platformRevision");
  if (preview.sourceRevision !== expected.sourceRevision)
    mismatches.push("sourceRevision");
  if (preview.profile !== expected.profile) mismatches.push("profile");
  if (preview.lane !== expected.lane) mismatches.push("lane");
  if (preview.mode !== expected.mode) mismatches.push("mode");
  const actualServices = JSON.stringify([...(preview.services ?? [])].sort());
  const expectedServices = JSON.stringify([...expected.services].sort());
  if (actualServices !== expectedServices) mismatches.push("services");
  if (
    preview.owner?.kind !== expected.owner.kind ||
    preview.owner?.id !== expected.owner.id
  )
    mismatches.push("owner");
  if (preview.lifecycle !== expected.lifecycle) mismatches.push("lifecycle");
  if (
    preview.origin?.kind !== expected.origin.kind ||
    (preview.origin?.reference ?? null) !== (expected.origin.reference ?? null)
  )
    mismatches.push("origin");
  if (
    JSON.stringify(preview.allocation) !== JSON.stringify(expected.allocation)
  )
    mismatches.push("allocation");
  if (!sameProvenance(preview.provenance, expected.provenance))
    mismatches.push("provenance");
  if (preview.trustedCode !== true) mismatches.push("trustedCode");
  if (preview.catalogDigest !== expected.catalogDigest)
    mismatches.push("catalogDigest");
  const actualImages = JSON.stringify(
    Object.entries(preview.images ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const expectedImages = JSON.stringify(
    Object.entries(expected.images).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  if (actualImages !== expectedImages) mismatches.push("images");
  return mismatches;
}

function sameProvenance(
  actual: Readonly<Record<string, unknown>> | null,
  expected: Readonly<{
    requestId: string;
    requestedAt: string;
    platformRepository: string;
    sourceRepository: string;
    parentEnvironmentId?: string | null;
  }>,
): boolean {
  if (!actual) return false;
  return (
    actual.requestId === expected.requestId &&
    actual.requestedAt === expected.requestedAt &&
    actual.platformRepository === expected.platformRepository &&
    actual.sourceRepository === expected.sourceRepository &&
    (actual.parentEnvironmentId ?? null) ===
      (expected.parentEnvironmentId ?? null)
  );
}

export class VclusterPreviewInventoryAdapter implements PreviewEnvironmentInventoryPort {
  constructor(private readonly gateway: VclusterPreviewGatewayPort) {}

  async inspect(name: string) {
    const preview = await this.gateway.get(name);
    return {
      exists: preview.phase !== "absent",
      phase: preview.phase,
    };
  }
}

export class VclusterPreviewRuntimeInspectionAdapter implements PreviewEnvironmentRuntimeInspectionPort {
  constructor(
    private readonly gateway: VclusterPreviewGatewayPort,
    private readonly sleep: Sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly pollMs = 5_000,
  ) {}

  async waitForImages(input: {
    name: string;
    images: Readonly<Record<string, string>>;
    timeoutMs: number;
  }) {
    const deadline = Date.now() + input.timeoutMs;
    let checks = runtimeImageChecks(
      await this.gateway.runtime(input.name),
      input.images,
    );
    while (!checks.every((check) => check.ok) && Date.now() < deadline) {
      await this.sleep(this.pollMs);
      checks = runtimeImageChecks(
        await this.gateway.runtime(input.name),
        input.images,
      );
    }
    return { ok: checks.every((check) => check.ok), checks };
  }
}

function runtimeImageChecks(
  snapshot: Awaited<ReturnType<VclusterPreviewGatewayPort["runtime"]>>,
  expected: Readonly<Record<string, string>>,
) {
  const services = new Map(
    snapshot.services.map((service) => [service.service, service]),
  );
  return Object.entries(expected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, expectedImage]) => {
      const containers = services.get(service)?.containers ?? [];
      const observedImages = [
        ...new Set(containers.map((item) => item.image)),
      ].sort();
      const digest = expectedImage.split("@").at(-1) ?? "";
      const ok =
        snapshot.reconciliationSucceeded &&
        containers.length > 0 &&
        containers.every(
          (container) =>
            container.ready &&
            container.image === expectedImage &&
            !!container.imageId &&
            container.imageId.endsWith(digest),
        );
      return {
        service,
        ok,
        expectedImage,
        observedImages,
        ...(ok
          ? {}
          : {
              detail: !snapshot.reconciliationSucceeded
                ? "preview reconciliation has not completed"
                : containers.length === 0
                  ? "no service container was observed"
                  : "not every service container is Ready at the expected immutable digest",
            }),
      };
    });
}

export class VclusterPreviewTeardownAdapter implements PreviewEnvironmentTeardownPort {
  constructor(
    private readonly gateway: VclusterPreviewGatewayPort,
    private readonly sleep: Sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly pollMs = 5_000,
  ) {}

  async teardown(
    input: Parameters<PreviewEnvironmentTeardownPort["teardown"]>[0],
  ): Promise<PreviewEnvironmentCleanupProof> {
    if (!input.guard)
      throw new Error("preview teardown requires an ownership guard");
    const receipt = await this.gateway.teardown(input.name, input.guard);
    const resourceName = receipt.name || input.name;
    const deadline = Date.now() + input.timeoutMs;
    let latest = await this.gateway.cleanup(resourceName);
    while (
      !latest.complete &&
      latest.phase === "pending" &&
      Date.now() < deadline
    ) {
      await this.sleep(this.pollMs);
      latest = await this.gateway.cleanup(resourceName);
    }
    const checks = cleanupChecks(latest.checks);
    const allChecks = Object.values(checks).every(Boolean);
    const complete = latest.complete && allChecks;
    return {
      name: input.name,
      resourceName,
      complete,
      phase: complete
        ? "complete"
        : latest.phase === "failed"
          ? "failed"
          : "timeout",
      checks,
      message: complete
        ? null
        : (latest.message ??
          (latest.phase === "failed"
            ? "preview cleanup runner failed"
            : "preview cleanup timed out before every resource was absent")),
    };
  }
}

function cleanupChecks(
  checks: Awaited<ReturnType<VclusterPreviewGatewayPort["cleanup"]>>["checks"],
): PreviewEnvironmentCleanupProof["checks"] {
  return {
    "runner-succeeded": checks.runnerSucceeded,
    "preview-environment-absent": checks.previewEnvironmentAbsent,
    "application-absent": checks.applicationAbsent,
    "agent-registration-absent": checks.agentRegistrationAbsent,
    "agent-namespaces-absent": checks.agentNamespacesAbsent,
    "database-absent": checks.databaseAbsent,
    "nats-stream-absent": checks.natsStreamAbsent,
    "headlamp-registration-absent": checks.headlampRegistrationAbsent,
    "tailnet-egress-absent": checks.tailnetEgressAbsent,
    "host-namespace-absent": checks.hostNamespaceAbsent,
    "storage-scope-absent": checks.storageScopeAbsent,
    "runner-identity-absent": checks.runnerIdentityAbsent,
  };
}

export type HttpPreviewEnvironmentVerifierOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  capabilities: PreviewControlCapabilityMintPort;
  sleep?: Sleep;
  pollMs?: number;
  timeoutMs?: number;
  runAgentSmoke?: boolean;
}>;

/** Verify the immutable replay through public product APIs, not Kubernetes internals. */
export class HttpPreviewEnvironmentVerifier implements PreviewEnvironmentVerificationPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: Sleep;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPreviewEnvironmentVerifierOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollMs = options.pollMs ?? 3_000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async verify(
    input: Parameters<PreviewEnvironmentVerificationPort["verify"]>[0],
  ) {
    const baseUrl = previewApiBaseUrl({
      name: input.environment.name,
      url: input.environment.runtime.url,
      pool: null,
    });
    if (!baseUrl) {
      return failure("bff-health", "preview URL is not resolvable");
    }
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    const health = await this.waitForBffHealth(baseUrl);
    checks.push(health);
    if (!health.ok) return { ok: false, checks };

    let capability: string;
    try {
      capability = this.options.capabilities.mintControl({
        previewName: input.environment.name,
        environmentRequestId: input.environment.provenance.requestId,
        environmentPlatformRevision: input.environment.platformRevision,
        environmentSourceRevision: input.environment.sourceRevision,
        catalogDigest: input.environment.catalogDigest,
      });
    } catch (cause) {
      checks.push({
        name: "preview-read-capability",
        ok: false,
        detail:
          cause instanceof Error
            ? cause.message
            : "preview read capability mint failed",
      });
      return { ok: false, checks };
    }

    checks.push(
      await this.runWorkflowSmoke(
        baseUrl,
        input.environment.id,
        "preview-data-plane-smoke",
        "wfb_data_smoke_",
        capability,
      ),
    );
    if (this.options.runAgentSmoke !== false) {
      checks.push(
        await this.runWorkflowSmoke(
          baseUrl,
          input.environment.id,
          "preview-agent-smoke",
          "wfb_smoke_",
          capability,
        ),
      );
    }
    return { ok: checks.every((check) => check.ok), checks };
  }

  private async waitForBffHealth(
    baseUrl: string,
  ): Promise<{ name: string; ok: boolean; detail?: string }> {
    const deadline = Date.now() + this.timeoutMs;
    let detail = "HTTP unreachable";

    do {
      const requestTimeoutMs = Math.max(
        1,
        Math.min(15_000, deadline - Date.now()),
      );
      const health = await this.fetchImpl(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      }).catch(() => null);
      if (health?.ok) return { name: "bff-health", ok: true };

      detail = `HTTP ${health?.status ?? "unreachable"}`;
      if (Date.now() >= deadline) break;
      await this.sleep(Math.min(this.pollMs, deadline - Date.now()));
    } while (Date.now() < deadline);

    return { name: "bff-health", ok: false, detail };
  }

  private async runWorkflowSmoke(
    baseUrl: string,
    environmentId: string,
    workflowId: string,
    keyPrefix: string,
    capability: string,
  ): Promise<{ name: string; ok: boolean; detail?: string }> {
    const key = `${keyPrefix}${environmentId.replace(/[^a-z0-9]/g, "")}`;
    const started = await this.fetchImpl(
      `${baseUrl}/api/workflows/${workflowId}/webhook`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "preview-acceptance" }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch(() => null);
    const body = (await started?.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const executionId =
      typeof body.executionId === "string" ? body.executionId : null;
    if (!started?.ok || !executionId) {
      return {
        name: workflowId,
        ok: false,
        detail: `start HTTP ${started?.status ?? "unreachable"}`,
      };
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.fetchImpl(
        `${baseUrl}/api/internal/agent/workflows/executions/${encodeURIComponent(executionId)}/status`,
        {
          headers: { "X-Preview-Control-Capability": capability },
          signal: AbortSignal.timeout(15_000),
        },
      ).catch(() => null);
      const statusBody = (await response?.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const status =
        typeof statusBody.status === "string" ? statusBody.status : "";
      if (status === "success") return { name: workflowId, ok: true };
      if (["error", "cancelled"].includes(status)) {
        return {
          name: workflowId,
          ok: false,
          detail:
            typeof statusBody.error === "string" ? statusBody.error : status,
        };
      }
      await this.sleep(this.pollMs);
    }
    return { name: workflowId, ok: false, detail: "timed out" };
  }
}

function failure(
  name: string,
  detail: string,
): PreviewEnvironmentVerificationResult {
  return { ok: false, checks: [{ name, ok: false, detail }] };
}
