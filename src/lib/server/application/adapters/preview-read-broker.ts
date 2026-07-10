import { env } from "$env/dynamic/private";
import type {
  PreviewCapabilityReadTransportPort,
  PreviewControlCapabilityMintPort,
  PreviewReadBrokerCommand,
  PreviewReadBrokerResult,
  PreviewReadFailure,
  PreviewReadProxyPort,
  PreviewReadResult,
  PreviewRunTarget,
} from "$lib/server/application/ports";
import { HttpPreviewReadProxy } from "$lib/server/application/adapters/preview-read-proxy";
import {
  derivePreviewControlCapability,
  PREVIEW_CAPABILITY_PURPOSES,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

const DEFAULT_BROKER_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function failure(
  reason: PreviewReadFailure["reason"],
  message?: string,
): PreviewReadFailure {
  return { ok: false, reason, ...(message ? { message } : {}) };
}

export class HmacPreviewControlCapabilityMintAdapter implements PreviewControlCapabilityMintPort {
  constructor(
    private readonly root: () => string = () =>
      (
        env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        ""
      ).trim(),
  ) {}

  mintControl(identity: PreviewControlIdentity): string {
    return derivePreviewControlCapability(
      this.root(),
      identity,
      PREVIEW_CAPABILITY_PURPOSES.controlToken,
    );
  }
}

/** Physical broker transport to the preview-local read-only route set. */
export class HttpPreviewCapabilityReadTransportAdapter implements PreviewCapabilityReadTransportPort {
  async execute(input: {
    target: PreviewRunTarget;
    capability: string;
    command: PreviewReadBrokerCommand;
  }): Promise<PreviewReadBrokerResult> {
    const proxy = new HttpPreviewReadProxy({
      token: input.capability,
      authHeader: "x-preview-control-capability",
    });
    switch (input.command.kind) {
      case "list-executions":
        return {
          kind: input.command.kind,
          result: await proxy.listExecutions({
            target: input.target,
            limit: input.command.limit,
            status: input.command.status,
          }),
        };
      case "get-execution":
        return {
          kind: input.command.kind,
          result: await proxy.getExecution({
            target: input.target,
            executionId: input.command.executionId,
          }),
        };
      case "list-artifacts":
        return {
          kind: input.command.kind,
          result: await proxy.listExecutionArtifacts({
            target: input.target,
            executionId: input.command.executionId,
            kind: input.command.artifactKind,
          }),
        };
      case "fetch-file":
        return {
          kind: input.command.kind,
          result: await proxy.fetchFileContent({
            target: input.target,
            fileId: input.command.fileId,
            maxBytes: input.command.maxBytes,
          }),
        };
    }
  }
}

export type HttpPreviewReadBrokerOptions = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

/** Normal-BFF adapter. Every read goes through the physical tuple broker. */
export class HttpPreviewReadBrokerAdapter implements PreviewReadProxyPort {
  constructor(private readonly options: HttpPreviewReadBrokerOptions = {}) {}

  async listExecutions(
    input: Parameters<PreviewReadProxyPort["listExecutions"]>[0],
  ) {
    const target = this.authorizedTarget(input.target);
    if (!target.ok) return target;
    return this.requestJson(
      {
        ...target.data,
        command: {
          kind: "list-executions",
          limit: Math.max(1, Math.min(input.limit ?? 25, 500)),
          status: input.status?.trim() || null,
        },
      },
      "list-executions",
    );
  }

  async getExecution(
    input: Parameters<PreviewReadProxyPort["getExecution"]>[0],
  ) {
    const target = this.authorizedTarget(input.target);
    if (!target.ok) return target;
    return this.requestJson(
      {
        ...target.data,
        command: { kind: "get-execution", executionId: input.executionId },
      },
      "get-execution",
    );
  }

  async listExecutionArtifacts(
    input: Parameters<PreviewReadProxyPort["listExecutionArtifacts"]>[0],
  ) {
    const target = this.authorizedTarget(input.target);
    if (!target.ok) return target;
    return this.requestJson(
      {
        ...target.data,
        command: {
          kind: "list-artifacts",
          executionId: input.executionId,
          artifactKind: input.kind?.trim() || null,
        },
      },
      "list-artifacts",
    );
  }

  async fetchFileContent(
    input: Parameters<PreviewReadProxyPort["fetchFileContent"]>[0],
  ) {
    const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
    const target = this.authorizedTarget(input.target);
    if (!target.ok) return target;
    const response = await this.request({
      ...target.data,
      command: { kind: "fetch-file", fileId: input.fileId, maxBytes },
    });
    if (!(response instanceof Response)) return response;
    if (response.headers.get("x-preview-read-ok") !== "true") {
      return this.readFailure(response);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return failure("bad-response", "broker file response is oversized");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return failure("bad-response", "broker file response is oversized");
    }
    return {
      ok: true as const,
      data: { bytes, contentType: response.headers.get("content-type") },
    };
  }

  private async requestJson(
    body: Readonly<{
      previewName: string;
      identity: NonNullable<PreviewRunTarget["identity"]>;
      command: PreviewReadBrokerCommand;
    }>,
    kind: Exclude<PreviewReadBrokerCommand["kind"], "fetch-file">,
  ): Promise<PreviewReadResult<never>> {
    const response = await this.request(body);
    if (!(response instanceof Response)) return response as never;
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
      return failure(
        "bad-response",
        "broker JSON response is oversized",
      ) as never;
    }
    try {
      const parsed = JSON.parse(text) as PreviewReadBrokerResult;
      if (parsed.kind !== kind || !("result" in parsed)) {
        return failure(
          "bad-response",
          "broker returned the wrong read operation",
        ) as never;
      }
      return parsed.result as never;
    } catch {
      return failure("bad-response", "broker returned invalid JSON") as never;
    }
  }

  private async request(
    body: Readonly<{
      previewName: string;
      identity: NonNullable<PreviewRunTarget["identity"]>;
      command: PreviewReadBrokerCommand;
    }>,
  ): Promise<Response | PreviewReadFailure> {
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
      return failure("unauthorized", "preview read broker is not configured");
    }
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${baseUrl}/api/internal/preview-control/read`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-preview-control-broker-token": token,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            this.options.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS,
          ),
        },
      );
    } catch (cause) {
      return failure(
        "unreachable",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (response.status === 401 || response.status === 403) {
      return failure("unauthorized", `broker returned HTTP ${response.status}`);
    }
    if (response.status === 404)
      return failure("not-found", "preview not found");
    if (!response.ok) {
      return failure("bad-response", `broker returned HTTP ${response.status}`);
    }
    return response;
  }

  private async readFailure(response: Response): Promise<PreviewReadFailure> {
    try {
      const body = (await response.json()) as PreviewReadBrokerResult;
      return body.kind === "fetch-file" && !body.result.ok
        ? body.result
        : failure("bad-response", "broker returned an invalid file failure");
    } catch {
      return failure("bad-response", "broker returned an invalid file failure");
    }
  }

  private authorizedTarget(
    target: PreviewRunTarget,
  ): PreviewReadResult<{
    previewName: string;
    identity: NonNullable<PreviewRunTarget["identity"]>;
  }> {
    if (!target.identity || target.identity.previewName !== target.name) {
      return failure(
        "unauthorized",
        "preview read target has no exact generation authority",
      );
    }
    return {
      ok: true,
      data: { previewName: target.name, identity: target.identity },
    };
  }
}
