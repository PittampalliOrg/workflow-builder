import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { posix as pathPosix } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { env } from "$env/dynamic/private";
import type {
  PreviewGitHubInstallationTokenPort,
  PreviewWorkspaceCaptureCommand,
  PreviewWorkspaceCaptureResult,
  PreviewWorkspaceGatewayPort,
  PreviewWorkspaceGitBundlePort,
  PreviewWorkspaceSeedCommand,
  PreviewWorkspaceSeedResult,
  PreviewWorkspaceSourceBundlePort,
  PreviewWorkspaceSourceBundleRequest,
} from "$lib/server/application/ports";
import { PreviewWorkspaceGatewayError } from "$lib/server/application/ports";
import { SandboxExecutionApiSessionSandboxDestroyer } from "$lib/server/application/adapters/session-sandbox-destroyer";
import {
  maybeProvisionAgentWorkflowHost,
  sessionHostAppId,
} from "$lib/server/sessions/agent-workflow-host";
import { localPreviewControlCapability } from "$lib/server/preview-control-capability";
import type { AgentConfig } from "$lib/types/agents";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_MEMBERS = 20_000;
const MAX_RESPONSE_BYTES = 4 + MAX_METADATA_BYTES + MAX_ARCHIVE_BYTES;
const SOURCE_BUNDLE_CONTENT_TYPE = "application/vnd.git.bundle";
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REVISION = /^[0-9a-f]{40}$/;
// SEA enforces a 40s absolute deadline for authoritative host deletion.
export const PREVIEW_WORKSPACE_HELPER_CLEANUP_TIMEOUT_MS = 45_000;

type HelperRequest = Readonly<{
  executionId: string;
  workspaceKey: string | null;
  purpose: "seed" | "sync" | "source";
  secretEnv: Record<string, string> | null;
}>;

type HelperSessionRunner = <T>(
  request: HelperRequest,
  use: (baseUrl: string) => Promise<T>,
) => Promise<T>;

type HelperLifecycle = Readonly<{
  provision: typeof maybeProvisionAgentWorkflowHost;
  destroy(
    sandboxName: string,
  ): ReturnType<
    SandboxExecutionApiSessionSandboxDestroyer["deleteRuntimeSandbox"]
  >;
}>;

function defaultHelperLifecycle(): HelperLifecycle {
  const destroyer = new SandboxExecutionApiSessionSandboxDestroyer();
  return {
    provision: maybeProvisionAgentWorkflowHost,
    destroy: (sandboxName) =>
      destroyer.deleteRuntimeSandbox(sandboxName, {
        timeoutMs: PREVIEW_WORKSPACE_HELPER_CLEANUP_TIMEOUT_MS,
      }),
  };
}

function internalToken(): string {
  return (
    env.INTERNAL_API_TOKEN ??
    process.env.INTERNAL_API_TOKEN ??
    ""
  ).trim();
}

function assertRelativePath(
  value: string,
  field: string,
  options: { dot?: boolean } = {},
): string {
  if (options.dot && value === ".") return value;
  if (!isSafeRelativePath(value)) {
    throw new Error(`${field} is not a safe repository-relative path`);
  }
  return value;
}

function isSafeRelativePath(value: string): boolean {
  const parts = value.split("/");
  return (
    Buffer.byteLength(value, "utf8") <= 512 &&
    !pathPosix.isAbsolute(value) &&
    !value.includes("\\") &&
    !/\p{Cc}/u.test(value) &&
    parts.length > 0 &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function assertCaptureCommand(input: PreviewWorkspaceCaptureCommand): void {
  if (!SAFE_REVISION.test(input.sourceRevision)) {
    throw new Error("preview workspace source revision is invalid");
  }
  const repoSubdir = assertRelativePath(input.repoSubdir, "repoSubdir", {
    dot: true,
  });
  if (input.syncPaths.length < 1 || input.syncPaths.length > 128) {
    throw new Error("preview workspace sync roots are invalid");
  }
  for (const path of input.syncPaths) {
    assertRelativePath(path, "sync path");
  }
  if (input.stageMappings.length > 128) {
    throw new Error("preview workspace stage mappings are invalid");
  }
  for (const mapping of input.stageMappings) {
    if (
      typeof mapping.from !== "string" ||
      !mapping.from ||
      Buffer.byteLength(mapping.from, "utf8") > 512 ||
      /\p{Cc}/u.test(mapping.from) ||
      mapping.from.includes("\\") ||
      pathPosix.isAbsolute(mapping.from)
    ) {
      throw new Error("preview workspace stage source is invalid");
    }
    const resolved = pathPosix.normalize(
      pathPosix.join(repoSubdir, mapping.from),
    );
    if (
      resolved === ".." ||
      resolved.startsWith("../") ||
      pathPosix.isAbsolute(resolved) ||
      !isSafeRelativePath(resolved)
    ) {
      throw new Error("preview workspace stage source escapes the repository");
    }
    assertRelativePath(mapping.to, "stage destination");
  }
  for (const prefix of input.diffScope ?? []) {
    assertRelativePath(prefix, "diff scope");
  }
}

async function requestBytes(input: {
  baseUrl: string;
  path: string;
  body: unknown | Uint8Array;
  contentType?: string;
  headers?: Readonly<Record<string, string>>;
  maxBytes: number;
}): Promise<{
  status: number;
  contentType: string;
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
}> {
  const body = input.body;
  const binary = body instanceof Uint8Array;
  const payload = binary
    ? Buffer.from(body)
    : Buffer.from(JSON.stringify(body), "utf8");
  const url = new URL(input.path, input.baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type":
            input.contentType ??
            (binary ? "application/octet-stream" : "application/json"),
          "content-length": String(payload.byteLength),
          ...(internalToken() ? { "x-internal-token": internalToken() } : {}),
          ...input.headers,
        },
      },
      (response) => {
        const declared = Number(response.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > input.maxBytes) {
          response.destroy();
          reject(
            new Error(
              "preview workspace helper response exceeds its byte limit",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > input.maxBytes) {
            response.destroy();
            reject(
              new Error(
                "preview workspace helper response exceeds its byte limit",
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            contentType: String(response.headers["content-type"] ?? ""),
            bytes: Buffer.concat(chunks),
            headers: response.headers,
          }),
        );
      },
    );
    request.setTimeout(660_000, () => {
      request.destroy(new Error("preview workspace helper request timed out"));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function helperError(
  response: { status: number; bytes: Buffer },
  fallback: string,
): PreviewWorkspaceGatewayError {
  let detail = "";
  try {
    const parsed = JSON.parse(response.bytes.toString("utf8")) as {
      detail?: unknown;
    };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // Fixed fallback below; never surface arbitrary helper bytes.
  }
  const status =
    response.status === 409
      ? 409
      : response.status === 413
        ? 413
        : response.status === 503
          ? 503
          : 502;
  return new PreviewWorkspaceGatewayError(
    status === 409 || status === 413 ? "helper-rejected" : "helper-unavailable",
    status,
    detail === "workspace contains changes outside the execution diff scope"
      ? detail
      : fallback,
  );
}

export async function runOneShotPreviewWorkspaceHelper<T>(
  input: HelperRequest,
  use: (baseUrl: string) => Promise<T>,
  lifecycle: HelperLifecycle = defaultHelperLifecycle(),
): Promise<T> {
  const suffix = createHash("sha256")
    .update(
      `${input.executionId}\0${input.workspaceKey ?? ""}\0${input.purpose}\0${randomUUID()}`,
    )
    .digest("hex")
    .slice(0, 24);
  const sessionId = `${input.executionId}__preview_workspace_${suffix}`;
  const provisioningStartedAt = new Date();
  const expectedAppId = sessionHostAppId(sessionId, provisioningStartedAt);
  const expectedSandboxName = `agent-host-${expectedAppId}`;
  let result: T | undefined;
  let failure: unknown;
  try {
    const provisioned = await lifecycle.provision({
      sessionId,
      agentConfig: {
        runtime: "claude-code-cli",
        runtimeIsolation: "dedicated",
      } as AgentConfig,
      workflowExecutionId:
        input.purpose === "source" ? null : input.executionId,
      benchmarkRunId: null,
      benchmarkInstanceId: null,
      timeoutMinutes: 20,
      sessionSecretEnv: input.secretEnv,
      sharedWorkspaceKey: input.workspaceKey,
      provisioningStartedAt,
    });
    if (
      !provisioned ||
      provisioned.agentAppId !== expectedAppId ||
      provisioned.sandboxName !== expectedSandboxName
    ) {
      throw new Error(
        "preview workspace helper returned a mismatched identity",
      );
    }
    if (provisioned.status !== "ready" || !provisioned.baseUrl) {
      throw new PreviewWorkspaceGatewayError(
        "helper-unavailable",
        503,
        "preview workspace helper did not return a ready target",
      );
    }
    result = await use(provisioned.baseUrl);
  } catch (cause) {
    failure = cause;
  }
  let cleanup: Awaited<ReturnType<HelperLifecycle["destroy"]>>;
  try {
    cleanup = await lifecycle.destroy(expectedSandboxName);
  } catch (cause) {
    throw new Error("preview workspace one-shot helper cleanup failed", {
      cause: failure ?? cause,
    });
  }
  if (cleanup.status === "error") {
    throw new Error(
      `preview workspace one-shot helper cleanup failed: ${cleanup.error ?? "unknown error"}`,
      { cause: failure },
    );
  }
  if (failure) throw failure;
  return result!;
}

export async function validatePreviewWorkspaceArchive(
  archive: Uint8Array,
): Promise<{ fileCount: number; memberCount: number; expandedBytes: number }> {
  if (archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      "preview workspace archive exceeds its compressed byte limit",
    );
  }
  let unpacked: Buffer;
  try {
    unpacked = gunzipSync(archive, {
      maxOutputLength: MAX_EXPANDED_BYTES + 1,
    });
  } catch (cause) {
    throw new Error("preview workspace archive is not a bounded gzip stream", {
      cause,
    });
  }
  if (unpacked.byteLength > MAX_EXPANDED_BYTES) {
    throw new Error(
      "preview workspace archive exceeds its expanded byte limit",
    );
  }
  const extract = tar.extract();
  let fileCount = 0;
  let memberCount = 0;
  let totalBytes = 0;
  const names = new Set<string>();
  const complete = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const normalized = header.name.replace(/^\.\//, "").replace(/\/$/, "");
      const size = header.size ?? 0;
      memberCount += 1;
      if (
        !isSafeRelativePath(normalized) ||
        (header.type !== "file" && header.type !== "directory") ||
        Boolean(header.linkname) ||
        names.has(normalized) ||
        memberCount > MAX_MEMBERS ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        stream.resume();
        reject(new Error("preview workspace archive contains an unsafe entry"));
        return;
      }
      names.add(normalized);
      if (header.type === "file") {
        fileCount += 1;
        totalBytes += size;
      }
      if (totalBytes > MAX_EXPANDED_BYTES) {
        stream.resume();
        reject(
          new Error("preview workspace archive exceeds its content limits"),
        );
        return;
      }
      stream.on("end", next);
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  Readable.from(unpacked).pipe(extract);
  await complete;
  return { fileCount, memberCount, expandedBytes: totalBytes };
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : (value ?? "")).trim();
}

function validateSourceBundleReceipt(input: {
  bytes: Uint8Array;
  contentType: string;
  repository: string;
  sourceRevision: string;
  bundleSha256: string;
  fileCount: string;
  returnedRepository: string;
  returnedSourceRevision: string;
}) {
  const digest = `sha256:${createHash("sha256")
    .update(input.bytes)
    .digest("hex")}` as const;
  const fileCount = Number(input.fileCount);
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > MAX_SOURCE_BUNDLE_BYTES ||
    !input.contentType.startsWith(SOURCE_BUNDLE_CONTENT_TYPE) ||
    input.returnedRepository !== input.repository ||
    input.returnedSourceRevision !== input.sourceRevision ||
    input.bundleSha256 !== digest ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 1 ||
    fileCount > MAX_MEMBERS
  ) {
    throw new PreviewWorkspaceGatewayError(
      "helper-invalid-receipt",
      502,
      "preview workspace source bundle receipt is invalid",
    );
  }
  return Object.freeze({
    repository: input.repository,
    sourceRevision: input.sourceRevision,
    bundle: new Uint8Array(input.bytes),
    bundleSha256: digest,
    fileCount,
  });
}

async function readFetchBytesBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PreviewWorkspaceGatewayError(
      "source-rejected",
      413,
      "preview workspace source bundle exceeds its byte limit",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        413,
        "preview workspace source bundle exceeds its byte limit",
      );
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function runGatewayHelper<T>(
  runner: HelperSessionRunner,
  request: HelperRequest,
  use: (baseUrl: string) => Promise<T>,
  fallback: string,
): Promise<T> {
  try {
    return await runner(request, use);
  } catch (cause) {
    if (cause instanceof PreviewWorkspaceGatewayError) throw cause;
    const cleanupFailure =
      cause instanceof Error && cause.message.includes("helper cleanup failed");
    throw new PreviewWorkspaceGatewayError(
      cleanupFailure ? "helper-cleanup-failed" : "helper-unavailable",
      502,
      cleanupFailure ? "preview workspace helper cleanup failed" : fallback,
      { cause },
    );
  }
}

export class OneShotPreviewWorkspaceGitBundleGateway implements PreviewWorkspaceGitBundlePort {
  constructor(
    private readonly credentials: PreviewGitHubInstallationTokenPort,
    private readonly runHelper: HelperSessionRunner = runOneShotPreviewWorkspaceHelper,
  ) {}

  async fetchExact(command: { repository: string; sourceRevision: string }) {
    if (
      !SAFE_REPOSITORY.test(command.repository) ||
      !SAFE_REVISION.test(command.sourceRevision)
    ) {
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        409,
        "preview workspace source coordinates are invalid",
      );
    }
    let token: string;
    try {
      token = (await this.credentials.token()).trim();
    } catch (cause) {
      throw new PreviewWorkspaceGatewayError(
        "source-unavailable",
        503,
        "preview workspace source credential is unavailable",
        { cause },
      );
    }
    if (!token) {
      throw new PreviewWorkspaceGatewayError(
        "source-unavailable",
        503,
        "preview workspace source credential is unavailable",
      );
    }
    const coordinate = createHash("sha256")
      .update(`${command.repository}\0${command.sourceRevision}`)
      .digest("hex")
      .slice(0, 32);
    return await runGatewayHelper(
      this.runHelper,
      {
        executionId: `preview-source-${coordinate}`,
        workspaceKey: null,
        purpose: "source",
        secretEnv: { GITHUB_TOKEN: token },
      },
      async (baseUrl) => {
        const seeded = await requestBytes({
          baseUrl,
          path: "/internal/preview-workspace/seed",
          body: {
            repository: command.repository,
            sourceRevision: command.sourceRevision,
            repoSubdir: ".",
          },
          maxBytes: 64 * 1024,
        });
        if (seeded.status < 200 || seeded.status >= 300) {
          throw helperError(
            seeded,
            "preview workspace physical source checkout failed",
          );
        }
        const response = await requestBytes({
          baseUrl,
          path: "/internal/preview-workspace/source-bundle",
          body: {
            repository: command.repository,
            sourceRevision: command.sourceRevision,
          },
          maxBytes: MAX_SOURCE_BUNDLE_BYTES,
        });
        if (response.status < 200 || response.status >= 300) {
          throw helperError(
            response,
            "preview workspace source bundle creation failed",
          );
        }
        return validateSourceBundleReceipt({
          bytes: response.bytes,
          contentType: response.contentType,
          repository: command.repository,
          sourceRevision: command.sourceRevision,
          bundleSha256: headerValue(
            response.headers,
            "x-wfb-preview-source-sha256",
          ),
          fileCount: headerValue(
            response.headers,
            "x-wfb-preview-source-file-count",
          ),
          returnedRepository: headerValue(
            response.headers,
            "x-wfb-preview-source-repository",
          ),
          returnedSourceRevision: headerValue(
            response.headers,
            "x-wfb-preview-source-revision",
          ),
        });
      },
      "preview workspace physical source helper failed",
    );
  }
}

export type HttpPreviewWorkspaceSourceBundleOptions = Readonly<{
  baseUrl?: () => string;
  token?: () => string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

/** Preview-local, tuple-bound client for the physical source broker. */
export class HttpPreviewWorkspaceSourceBundleAdapter implements PreviewWorkspaceSourceBundlePort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: HttpPreviewWorkspaceSourceBundleOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async fetchExact(input: PreviewWorkspaceSourceBundleRequest) {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ?? localPreviewControlCapability()
    ).trim();
    if (!baseUrl) {
      throw new PreviewWorkspaceGatewayError(
        "source-unavailable",
        503,
        "preview workspace source broker is unavailable",
      );
    }
    if (!token) {
      throw new PreviewWorkspaceGatewayError(
        "source-unavailable",
        503,
        "preview workspace source capability is unavailable",
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl}/api/internal/preview-control/environment/workspace-source`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Preview-Control-Capability": token,
          },
          body: JSON.stringify({ ...input.identity, service: input.service }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 12 * 60_000),
        },
      );
    } catch (cause) {
      throw new PreviewWorkspaceGatewayError(
        "source-unavailable",
        503,
        "preview workspace source broker is unavailable",
        { cause },
      );
    }
    if (!response.ok) {
      const status = ([400, 403, 404, 409, 413, 502, 503] as const).includes(
        response.status as never,
      )
        ? (response.status as 400 | 403 | 404 | 409 | 413 | 502 | 503)
        : 502;
      throw new PreviewWorkspaceGatewayError(
        status === 413 ? "source-rejected" : "source-unavailable",
        status,
        "preview workspace source broker rejected the exact source request",
      );
    }
    const bytes = await readFetchBytesBounded(
      response,
      MAX_SOURCE_BUNDLE_BYTES,
    );
    return validateSourceBundleReceipt({
      bytes,
      contentType: response.headers.get("content-type") ?? "",
      repository: response.headers.get("x-wfb-preview-source-repository") ?? "",
      sourceRevision: input.identity.environmentSourceRevision,
      bundleSha256: response.headers.get("x-wfb-preview-source-sha256") ?? "",
      fileCount: response.headers.get("x-wfb-preview-source-file-count") ?? "",
      returnedRepository:
        response.headers.get("x-wfb-preview-source-repository") ?? "",
      returnedSourceRevision:
        response.headers.get("x-wfb-preview-source-revision") ?? "",
    });
  }
}

export class OneShotPreviewWorkspaceGateway implements PreviewWorkspaceGatewayPort {
  constructor(
    private readonly runHelper: HelperSessionRunner = runOneShotPreviewWorkspaceHelper,
  ) {}

  async seed(
    command: PreviewWorkspaceSeedCommand,
  ): Promise<PreviewWorkspaceSeedResult> {
    if (
      !SAFE_REPOSITORY.test(command.repository) ||
      !SAFE_REVISION.test(command.sourceRevision)
    ) {
      throw new Error("preview workspace seed coordinates are invalid");
    }
    assertRelativePath(command.repoSubdir, "repoSubdir", { dot: true });
    const computedBundleSha256 = `sha256:${createHash("sha256")
      .update(command.sourceBundle)
      .digest("hex")}`;
    if (
      command.sourceBundle.byteLength < 1 ||
      command.sourceBundle.byteLength > MAX_SOURCE_BUNDLE_BYTES ||
      command.sourceBundleSha256 !== computedBundleSha256 ||
      !Number.isSafeInteger(command.sourceFileCount) ||
      command.sourceFileCount < 1 ||
      command.sourceFileCount > MAX_MEMBERS
    ) {
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        409,
        "preview workspace source bundle is invalid",
      );
    }
    return await runGatewayHelper(
      this.runHelper,
      {
        executionId: command.executionId,
        workspaceKey: command.workspaceKey,
        purpose: "seed",
        secretEnv: null,
      },
      async (baseUrl) => {
        const response = await requestBytes({
          baseUrl,
          path: "/internal/preview-workspace/import",
          body: command.sourceBundle,
          contentType: SOURCE_BUNDLE_CONTENT_TYPE,
          headers: {
            "x-wfb-preview-source-repository": command.repository,
            "x-wfb-preview-source-revision": command.sourceRevision,
            "x-wfb-preview-source-repo-subdir": command.repoSubdir,
            "x-wfb-preview-source-sha256": command.sourceBundleSha256,
            "x-wfb-preview-source-file-count": String(command.sourceFileCount),
          },
          maxBytes: 64 * 1024,
        });
        if (response.status < 200 || response.status >= 300) {
          throw helperError(
            response,
            "preview workspace exact-revision seed failed",
          );
        }
        let receipt: Record<string, unknown>;
        try {
          receipt = JSON.parse(response.bytes.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          throw new Error("preview workspace seed returned an invalid receipt");
        }
        if (
          typeof receipt.reused !== "boolean" ||
          typeof receipt.fileCount !== "number" ||
          !Number.isSafeInteger(receipt.fileCount) ||
          receipt.fileCount < 1 ||
          receipt.fileCount > MAX_MEMBERS ||
          receipt.fileCount !== command.sourceFileCount
        ) {
          throw new Error("preview workspace seed returned an invalid receipt");
        }
        return {
          reused: receipt.reused,
          fileCount: receipt.fileCount,
        };
      },
      "preview workspace exact-revision seed failed",
    );
  }

  async capture(
    command: PreviewWorkspaceCaptureCommand,
  ): Promise<PreviewWorkspaceCaptureResult> {
    assertCaptureCommand(command);
    return await runGatewayHelper(
      this.runHelper,
      {
        executionId: command.executionId,
        workspaceKey: command.workspaceKey,
        purpose: "sync",
        secretEnv: null,
      },
      async (baseUrl) => {
        const response = await requestBytes({
          baseUrl,
          path: "/internal/preview-workspace/capture",
          body: {
            sourceRevision: command.sourceRevision,
            repoSubdir: command.repoSubdir,
            syncPaths: [...command.syncPaths],
            stageMappings: command.stageMappings.map((mapping) => ({
              ...mapping,
            })),
            diffScope: command.diffScope ? [...command.diffScope] : null,
          },
          maxBytes: MAX_RESPONSE_BYTES,
        });
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !response.contentType.startsWith(
            "application/vnd.wfb.preview-workspace",
          )
        ) {
          throw helperError(
            response,
            "preview workspace archive preparation failed",
          );
        }
        if (response.bytes.byteLength < 5) {
          throw new Error("preview workspace capture envelope is truncated");
        }
        const metadataLength = response.bytes.readUInt32BE(0);
        if (
          metadataLength < 2 ||
          metadataLength > MAX_METADATA_BYTES ||
          4 + metadataLength >= response.bytes.byteLength
        ) {
          throw new Error("preview workspace capture metadata is invalid");
        }
        let metadata: Record<string, unknown>;
        try {
          metadata = JSON.parse(
            response.bytes.subarray(4, 4 + metadataLength).toString("utf8"),
          ) as Record<string, unknown>;
        } catch {
          throw new Error("preview workspace capture metadata is invalid");
        }
        const archive = response.bytes.subarray(4 + metadataLength);
        const validated = await validatePreviewWorkspaceArchive(archive);
        const archiveSha256 = `sha256:${createHash("sha256")
          .update(archive)
          .digest("hex")}` as const;
        const changedPaths = Array.isArray(metadata.changedPaths)
          ? metadata.changedPaths.filter(
              (path): path is string =>
                typeof path === "string" && isSafeRelativePath(path),
            )
          : [];
        if (
          changedPaths.length !==
            (Array.isArray(metadata.changedPaths)
              ? metadata.changedPaths.length
              : -1) ||
          changedPaths.length > 3_000 ||
          metadata.fileCount !== validated.fileCount ||
          metadata.memberCount !== validated.memberCount ||
          metadata.expandedBytes !== validated.expandedBytes ||
          metadata.archiveSha256 !== archiveSha256
        ) {
          throw new Error("preview workspace capture metadata is invalid");
        }
        return {
          archive,
          archiveSha256,
          changedPaths: Object.freeze(changedPaths),
          fileCount: validated.fileCount,
        };
      },
      "preview workspace archive preparation failed",
    );
  }
}
