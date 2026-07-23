import { createHash } from "node:crypto";
import type {
  DevPreviewSidecarRunOutput,
  DevPreviewSidecarSyncOutput,
  PreviewControlIdentity,
  PreviewDeploymentScopePort,
  PreviewLocalControlIdentityPort,
  PreviewWorkspaceAuthority,
  PreviewWorkspaceCatalogPort,
  PreviewWorkspaceGatewayPort,
  WorkflowExecutionRecord,
} from "$lib/server/application/ports";

const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_DIFF_SCOPE = 128;
const MAX_CHANGED_PATHS = 3_000;
const PREVIEW_WORKSPACE_COMMAND_TIMEOUT_MS = 15 * 60_000;

type SidecarStatus = {
  service: string;
  status:
    | { ok: true; data: { ok: boolean; frozen: boolean; prepared: boolean } }
    | { ok: false; reason: string; message?: string };
  allowedCommands: string[];
};

type SidecarSync = {
  service: string;
  result:
    | { ok: true; data: DevPreviewSidecarSyncOutput }
    | { ok: false; reason: string; message?: string };
};

type SidecarRun = {
  service: string;
  cmd: string;
  result:
    | { ok: true; data: DevPreviewSidecarRunOutput }
    | { ok: false; reason: string; message?: string };
};

export type PreviewWorkspaceServiceDeps = Readonly<{
  getExecution(executionId: string): Promise<WorkflowExecutionRecord | null>;
  isPlatformAdmin(userId: string): Promise<boolean>;
  identity: PreviewLocalControlIdentityPort;
  scope: PreviewDeploymentScopePort;
  catalog: PreviewWorkspaceCatalogPort;
  workspace: PreviewWorkspaceGatewayPort;
  sidecar: {
    status(input: {
      executionId: string;
      service: string;
      projectId: string;
    }): Promise<SidecarStatus | null>;
    sync(input: {
      executionId: string;
      service: string;
      projectId: string;
      archive: Uint8Array;
      contentType?: string | null;
      generation?: string;
      mode?: "merge" | "replace";
    }): Promise<SidecarSync | null>;
    run(input: {
      executionId: string;
      service: string;
      projectId: string;
      cmd: string;
      timeoutMs?: number;
    }): Promise<SidecarRun | null>;
    allowedCommands(service: string): string[];
  };
}>;

export class PreviewWorkspaceContractError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PreviewWorkspaceContractError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSafeRelativePath(value: string): boolean {
  const parts = value.split("/");
  return (
    Buffer.byteLength(value, "utf8") <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/\p{Cc}/u.test(value) &&
    parts.length > 0 &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sameIdentity(
  target: Record<string, unknown>,
  local: PreviewControlIdentity,
): boolean {
  return (
    target.previewName === local.previewName &&
    target.environmentRequestId === local.environmentRequestId &&
    target.platformRevision === local.environmentPlatformRevision &&
    target.sourceRevision === local.environmentSourceRevision &&
    target.catalogDigest === local.catalogDigest
  );
}

function canonicalDiffScope(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_DIFF_SCOPE
  ) {
    throw new PreviewWorkspaceContractError(
      409,
      "preview workspace diff scope is invalid",
    );
  }
  const scope: string[] = [];
  for (const item of value) {
    const normalized = typeof item === "string" ? item.replace(/\/+$/, "") : "";
    if (
      typeof item !== "string" ||
      item !== item.trim() ||
      !isSafeRelativePath(normalized)
    ) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace diff scope is invalid",
      );
    }
    scope.push(normalized);
  }
  return Object.freeze([...new Set(scope)].sort());
}

function pathInScope(path: string, scope: readonly string[]): boolean {
  return scope.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function deterministicGeneration(
  executionId: string,
  service: string,
  operationId: string,
): string {
  return `pws-${createHash("sha256")
    .update(
      `preview-workspace-sync/v1\0${executionId}\0${service}\0${operationId}`,
    )
    .digest("hex")}`;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function curatedSyncReceipt(input: {
  service: string;
  generation: string;
  archiveSha256: string;
  workspaceChangedPaths: readonly string[];
  fileCount: number;
  output: DevPreviewSidecarSyncOutput;
}) {
  const body = bodyRecord(input.output.body);
  const contentSha256 =
    typeof body.contentSha256 === "string" && SHA256.test(body.contentSha256)
      ? body.contentSha256
      : input.archiveSha256;
  const changedPaths = Array.isArray(body.changedPaths)
    ? body.changedPaths
        .filter(
          (path): path is string =>
            typeof path === "string" && isSafeRelativePath(path),
        )
        .slice(0, MAX_CHANGED_PATHS)
    : [];
  const timings = record(body.timingsMs);
  return Object.freeze({
    ok: true as const,
    receiptMode: "credentialless" as const,
    service: input.service,
    generation:
      typeof body.generation === "string" &&
      body.generation === input.generation
        ? body.generation
        : input.generation,
    contentSha256,
    bytes: input.output.bytes,
    fileCount: input.fileCount,
    workspaceChangedPaths: Object.freeze([...input.workspaceChangedPaths]),
    changedPathCount:
      typeof body.changedPathCount === "number"
        ? body.changedPathCount
        : changedPaths.length,
    changedPaths: Object.freeze(changedPaths),
    changedPathsTruncated: body.changedPathsTruncated === true,
    timingsMs: timings
      ? Object.freeze({
          validation:
            typeof timings.validation === "number" ? timings.validation : null,
          staging: typeof timings.staging === "number" ? timings.staging : null,
          planning:
            typeof timings.planning === "number" ? timings.planning : null,
          commit: typeof timings.commit === "number" ? timings.commit : null,
          total: typeof timings.total === "number" ? timings.total : null,
        })
      : null,
  });
}

/**
 * Credentialless preview-workspace use case. The function router supplies only
 * its trusted execution context; every privileged coordinate is reconstructed
 * from persisted execution state, local preview identity, and the source catalog.
 */
export class ApplicationPreviewWorkspaceService {
  constructor(private readonly deps: PreviewWorkspaceServiceDeps) {}

  private async authorize(
    executionId: string,
    requestedService: unknown,
  ): Promise<PreviewWorkspaceAuthority> {
    if (!executionId.trim()) {
      throw new PreviewWorkspaceContractError(400, "execution id is required");
    }
    const execution = await this.deps.getExecution(executionId);
    if (!execution) {
      throw new PreviewWorkspaceContractError(
        404,
        "workflow execution not found",
      );
    }
    if (execution.status !== "pending" && execution.status !== "running") {
      throw new PreviewWorkspaceContractError(
        409,
        "workflow execution is not active",
      );
    }
    if (!execution.executionIrVersion?.startsWith("dynamic-script")) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace actions require a dynamic-script execution",
      );
    }
    if (!execution.projectId) {
      throw new PreviewWorkspaceContractError(
        409,
        "workflow execution is not project-bound",
      );
    }
    if (!(await this.deps.isPlatformAdmin(execution.userId))) {
      throw new PreviewWorkspaceContractError(
        403,
        "platform admin approval is required for preview workspace actions",
      );
    }
    const executionIr = record(execution.executionIr);
    const authority = record(executionIr?.authority);
    const binding = record(authority?.previewWorkspace);
    const target = record(binding?.target);
    if (binding?.version !== 1 || !target) {
      throw new PreviewWorkspaceContractError(
        409,
        "workflow execution has no immutable preview workspace authority",
      );
    }
    const deployment = this.deps.scope.current();
    if (
      deployment.kind !== "preview" ||
      deployment.preview.profile !== "app-live"
    ) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace actions require an app-live preview deployment",
      );
    }
    const local = this.deps.identity.current(deployment.preview.name);
    if (
      !sameIdentity(target, local) ||
      !FULL_SHA.test(local.environmentSourceRevision) ||
      deployment.preview.name !== local.previewName ||
      deployment.preview.sourceRevision !==
        local.environmentSourceRevision ||
      deployment.preview.platformRevision !==
        local.environmentPlatformRevision
    ) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace generation does not match the local environment",
      );
    }
    const input = record(execution.input);
    const service =
      typeof requestedService === "string" ? requestedService.trim() : "";
    if (!SAFE_SERVICE.test(service)) {
      throw new PreviewWorkspaceContractError(400, "service is invalid");
    }
    const services = Array.isArray(input?.services) ? input.services : [];
    if (!services.includes(service)) {
      throw new PreviewWorkspaceContractError(
        409,
        "service is not bound to this preview development execution",
      );
    }
    const source = this.deps.catalog.resolve(service);
    if (source.service !== service) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace catalog returned a mismatched service",
      );
    }
    const current = await this.deps.sidecar.status({
      executionId: execution.id,
      service,
      projectId: execution.projectId,
    });
    if (
      !current ||
      current.service !== service ||
      !current.status.ok ||
      current.status.data.ok !== true ||
      current.status.data.frozen ||
      current.status.data.prepared
    ) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview service is not an active writable environment",
      );
    }
    const diffScope = canonicalDiffScope(input?.diffScope);
    if (!diffScope) {
      throw new PreviewWorkspaceContractError(
        409,
        "preview workspace actions require a persisted diff scope",
      );
    }
    return Object.freeze({
      executionId: execution.id,
      userId: execution.userId,
      projectId: execution.projectId,
      identity: local,
      service,
      workspaceKey: `ws_script_${execution.id}`,
      sourceRevision: local.environmentSourceRevision,
      source,
      diffScope,
    });
  }

  async seed(input: {
    executionId: string;
    service: unknown;
    operationId: string;
  }) {
    if (!SAFE_OPERATION.test(input.operationId)) {
      throw new PreviewWorkspaceContractError(400, "operation id is invalid");
    }
    const authority = await this.authorize(input.executionId, input.service);
    const result = await this.deps.workspace.seed({
      executionId: authority.executionId,
      workspaceKey: authority.workspaceKey,
      repository: authority.source.repository,
      sourceRevision: authority.sourceRevision,
      repoSubdir: authority.source.repoSubdir,
    });
    return Object.freeze({
      ok: true as const,
      receiptMode: "credentialless" as const,
      service: authority.service,
      sourceRevision: authority.sourceRevision,
      reused: result.reused,
      fileCount: result.fileCount,
      workspace: "ready" as const,
    });
  }

  async sync(input: {
    executionId: string;
    service: unknown;
    operationId: string;
  }) {
    if (!SAFE_OPERATION.test(input.operationId)) {
      throw new PreviewWorkspaceContractError(400, "operation id is invalid");
    }
    const authority = await this.authorize(input.executionId, input.service);
    const captured = await this.deps.workspace.capture({
      executionId: authority.executionId,
      workspaceKey: authority.workspaceKey,
      sourceRevision: authority.sourceRevision,
      repoSubdir: authority.source.repoSubdir,
      syncPaths: authority.source.syncPaths,
      stageMappings: authority.source.stageMappings,
      diffScope: authority.diffScope,
    });
    if (
      authority.diffScope &&
      captured.changedPaths.some(
        (path) => !pathInScope(path, authority.diffScope!),
      )
    ) {
      throw new PreviewWorkspaceContractError(
        409,
        "workspace contains changes outside the execution diff scope",
      );
    }
    const generation = deterministicGeneration(
      authority.executionId,
      authority.service,
      input.operationId,
    );
    const synced = await this.deps.sidecar.sync({
      executionId: authority.executionId,
      service: authority.service,
      projectId: authority.projectId,
      archive: captured.archive,
      contentType: "application/gzip",
      generation,
      mode: "replace",
    });
    if (!synced || synced.service !== authority.service || !synced.result.ok) {
      throw new PreviewWorkspaceContractError(
        502,
        synced?.result.ok === false
          ? (synced.result.message ?? synced.result.reason)
          : "preview sync receiver is unavailable",
      );
    }
    return curatedSyncReceipt({
      service: authority.service,
      generation,
      archiveSha256: captured.archiveSha256,
      workspaceChangedPaths: captured.changedPaths,
      fileCount: captured.fileCount,
      output: synced.result.data,
    });
  }

  async run(input: {
    executionId: string;
    service: unknown;
    command: unknown;
    operationId: string;
  }) {
    if (!SAFE_OPERATION.test(input.operationId)) {
      throw new PreviewWorkspaceContractError(400, "operation id is invalid");
    }
    const authority = await this.authorize(input.executionId, input.service);
    const command =
      typeof input.command === "string" ? input.command.trim() : "";
    if (
      !command ||
      !authority.source.allowedCommands.includes(command) ||
      !this.deps.sidecar.allowedCommands(authority.service).includes(command)
    ) {
      throw new PreviewWorkspaceContractError(
        400,
        "sidecar command is not allowlisted",
      );
    }
    const ran = await this.deps.sidecar.run({
      executionId: authority.executionId,
      service: authority.service,
      projectId: authority.projectId,
      cmd: command,
      timeoutMs: PREVIEW_WORKSPACE_COMMAND_TIMEOUT_MS,
    });
    if (!ran || ran.service !== authority.service || !ran.result.ok) {
      throw new PreviewWorkspaceContractError(
        502,
        ran?.result.ok === false
          ? (ran.result.message ?? ran.result.reason)
          : "preview sidecar is unavailable",
      );
    }
    const data = ran.result.data;
    return Object.freeze({
      ok: data.ok && data.exitCode === 0,
      receiptMode: "credentialless" as const,
      service: authority.service,
      command,
      exitCode: data.exitCode,
      durationMs: data.durationMs,
      executedIn: data.executedIn,
      truncated: data.truncated,
      output: data.output.slice(0, 16_000),
    });
  }
}
