import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { posix as pathPosix } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { env } from "$env/dynamic/private";
import type {
  PreviewWorkspaceCaptureCommand,
  PreviewWorkspaceCaptureResult,
  PreviewWorkspaceGatewayPort,
  PreviewWorkspaceSeedCommand,
  PreviewWorkspaceSeedResult,
} from "$lib/server/application/ports";
import { SandboxExecutionApiSessionSandboxDestroyer } from "$lib/server/application/adapters/session-sandbox-destroyer";
import {
  maybeProvisionAgentWorkflowHost,
  sessionHostAppId,
  waitForAgentWorkflowHostAppReady,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveWorkflowGithubToken } from "$lib/server/workflows/github-token";
import type { AgentConfig } from "$lib/types/agents";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_MEMBERS = 20_000;
const MAX_RESPONSE_BYTES = 4 + MAX_METADATA_BYTES + MAX_ARCHIVE_BYTES;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REVISION = /^[0-9a-f]{40}$/;

type HelperRequest = Readonly<{
  executionId: string;
  workspaceKey: string;
  secretEnv: Record<string, string> | null;
}>;

type HelperSessionRunner = <T>(
  request: HelperRequest,
  use: (baseUrl: string) => Promise<T>,
) => Promise<T>;

type HelperLifecycle = Readonly<{
  provision: typeof maybeProvisionAgentWorkflowHost;
  wait: typeof waitForAgentWorkflowHostAppReady;
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
    wait: waitForAgentWorkflowHostAppReady,
    destroy: (sandboxName) => destroyer.deleteRuntimeSandbox(sandboxName),
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
  body: unknown;
  maxBytes: number;
}): Promise<{ status: number; contentType: string; bytes: Buffer }> {
  const payload = Buffer.from(JSON.stringify(input.body), "utf8");
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
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          ...(internalToken() ? { "x-internal-token": internalToken() } : {}),
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
): Error {
  let detail = "";
  try {
    const parsed = JSON.parse(response.bytes.toString("utf8")) as {
      detail?: unknown;
    };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // Fixed fallback below; never surface arbitrary helper bytes.
  }
  return new Error(
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
      `${input.executionId}\0${input.workspaceKey}\0${input.secretEnv ? "seed" : "sync"}\0${randomUUID()}`,
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
      workflowExecutionId: input.executionId,
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
    const ready = await lifecycle.wait({
      agentAppId: expectedAppId,
    });
    result = await use(ready.baseUrl);
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
    const githubToken = await resolveWorkflowGithubToken();
    if (!githubToken) throw new Error("GitHub credential is unavailable");
    return await this.runHelper(
      {
        executionId: command.executionId,
        workspaceKey: command.workspaceKey,
        secretEnv: { GITHUB_TOKEN: githubToken },
      },
      async (baseUrl) => {
        const response = await requestBytes({
          baseUrl,
          path: "/internal/preview-workspace/seed",
          body: {
            repository: command.repository,
            sourceRevision: command.sourceRevision,
            repoSubdir: command.repoSubdir,
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
          receipt.fileCount > MAX_MEMBERS
        ) {
          throw new Error("preview workspace seed returned an invalid receipt");
        }
        return {
          reused: receipt.reused,
          fileCount: receipt.fileCount,
        };
      },
    );
  }

  async capture(
    command: PreviewWorkspaceCaptureCommand,
  ): Promise<PreviewWorkspaceCaptureResult> {
    assertCaptureCommand(command);
    return await this.runHelper(
      {
        executionId: command.executionId,
        workspaceKey: command.workspaceKey,
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
    );
  }
}
