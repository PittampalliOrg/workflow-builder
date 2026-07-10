import { timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";
import type {
  PreviewRuntimeCapabilityVerificationPort,
  PreviewRuntimeUpstreamPort,
} from "$lib/server/application/ports";
import { PreviewRuntimeUpstreamError } from "$lib/server/application/preview-runtime-broker";
import {
  derivePreviewControlCapability,
  PREVIEW_CAPABILITY_PURPOSES,
} from "$lib/server/preview-control-capability";

const TOKEN = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 120_000;

export class HmacPreviewRuntimeCapabilityAdapter implements PreviewRuntimeCapabilityVerificationPort {
  constructor(
    private readonly root: () => string = () =>
      (
        env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
        ""
      ).trim(),
  ) {}

  verify(input: {
    identity: Parameters<
      PreviewRuntimeCapabilityVerificationPort["verify"]
    >[0]["identity"];
    capability: string;
  }): boolean {
    const root = this.root();
    const supplied = input.capability.trim();
    if (!TOKEN.test(root) || !TOKEN.test(supplied)) return false;
    try {
      const expected = derivePreviewControlCapability(
        root,
        input.identity,
        PREVIEW_CAPABILITY_PURPOSES.runtimeToken,
      );
      return timingSafeEqual(
        Buffer.from(supplied, "hex"),
        Buffer.from(expected, "hex"),
      );
    } catch {
      return false;
    }
  }
}

export type HttpPreviewRuntimeUpstreamOptions = Readonly<{
  baseUrl?: () => string;
  token?: () => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/** Fixed credential-injecting adapter for the central OpenAI-compatible gateway. */
export class HttpPreviewRuntimeUpstreamAdapter implements PreviewRuntimeUpstreamPort {
  constructor(
    private readonly options: HttpPreviewRuntimeUpstreamOptions = {},
  ) {}

  async complete(input: Parameters<PreviewRuntimeUpstreamPort["complete"]>[0]) {
    const url = this.targetUrl();
    const token = (
      this.options.token?.() ??
      env.PREVIEW_RUNTIME_UPSTREAM_TOKEN ??
      process.env.PREVIEW_RUNTIME_UPSTREAM_TOKEN ??
      ""
    ).trim();
    if (!token) {
      throw new PreviewRuntimeUpstreamError(
        "configuration",
        "preview runtime upstream credential is not configured",
      );
    }
    const configuredTimeout =
      this.options.timeoutMs ??
      Number(env.PREVIEW_RUNTIME_UPSTREAM_TIMEOUT_MS ?? "");
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.max(5_000, Math.min(600_000, configuredTimeout))
        : DEFAULT_TIMEOUT_MS;
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-preview-environment-request-id":
            input.identity.environmentRequestId,
        },
        body: JSON.stringify(input.payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new PreviewRuntimeUpstreamError(
        timedOut ? "timeout" : "unavailable",
        timedOut
          ? "preview runtime upstream timed out"
          : "preview runtime upstream is unavailable",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.toLowerCase().startsWith("application/json") &&
      !contentType.toLowerCase().startsWith("text/event-stream")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new PreviewRuntimeUpstreamError(
        "unavailable",
        "preview runtime upstream returned an unsupported content type",
      );
    }
    return Object.freeze({
      status: response.status,
      contentType,
      requestId:
        response.headers.get("x-request-id") ??
        response.headers.get("request-id"),
      body: response.body,
    });
  }

  private targetUrl(): string {
    const raw = (
      this.options.baseUrl?.() ??
      env.PREVIEW_RUNTIME_UPSTREAM_URL ??
      process.env.PREVIEW_RUNTIME_UPSTREAM_URL ??
      ""
    ).trim();
    let base: URL;
    try {
      base = new URL(raw);
    } catch {
      throw new PreviewRuntimeUpstreamError(
        "configuration",
        "preview runtime upstream URL is not configured",
      );
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname.replace(/\/+$/, "") !== "/v1"
    ) {
      throw new PreviewRuntimeUpstreamError(
        "configuration",
        "preview runtime upstream must be a fixed HTTP(S) /v1 base URL",
      );
    }
    base.pathname = "/v1/chat/completions";
    return base.toString();
  }
}
