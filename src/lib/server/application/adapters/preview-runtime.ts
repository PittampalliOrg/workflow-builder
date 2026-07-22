import { timingSafeEqual } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
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
export const MAX_PREVIEW_RUNTIME_UPSTREAM_TIMEOUT_MS = 1_800_000;
const MAX_NORMALIZED_ERROR_BYTES = 65_536;
const IPV4_UPSTREAM_DISPATCHER = new Agent({ connect: { family: 4 } });

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
  url?: () => string;
  token?: () => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/** Fixed credential-injecting adapter for the trusted OpenAI-compatible upstream. */
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
        ? Math.max(
            5_000,
            Math.min(MAX_PREVIEW_RUNTIME_UPSTREAM_TIMEOUT_MS, configuredTimeout),
          )
        : DEFAULT_TIMEOUT_MS;
    let response: Response;
    try {
      const fetchImpl =
        this.options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "accept-language": "en-US,en",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "workflow-builder-preview-runtime/1.0",
          "x-preview-environment-request-id":
            input.identity.environmentRequestId,
        },
        body: JSON.stringify(input.payload),
        signal: AbortSignal.timeout(timeoutMs),
        ...(!this.options.fetchImpl
          ? { dispatcher: IPV4_UPSTREAM_DISPATCHER }
          : {}),
      } as RequestInit);
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

    let contentType = response.headers.get("content-type") ?? "";
    let body = response.body;
    if (
      !contentType.toLowerCase().startsWith("application/json") &&
      !contentType.toLowerCase().startsWith("text/event-stream")
    ) {
      if (response.ok) {
        await body?.cancel().catch(() => undefined);
        throw new PreviewRuntimeUpstreamError(
          "unavailable",
          "preview runtime upstream returned an unsupported content type",
        );
      }
      body = await normalizeUpstreamErrorBody(response.status, body);
      contentType = "application/json";
    }
    return Object.freeze({
      status: response.status,
      contentType,
      retryAfter: response.headers.get("retry-after"),
      requestId:
        response.headers.get("x-request-id") ??
        response.headers.get("request-id"),
      body,
    });
  }

  private targetUrl(): string {
    const raw = (
      this.options.url?.() ??
      env.PREVIEW_RUNTIME_UPSTREAM_URL ??
      process.env.PREVIEW_RUNTIME_UPSTREAM_URL ??
      ""
    ).trim();
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw new PreviewRuntimeUpstreamError(
        "configuration",
        "preview runtime upstream URL is not configured",
      );
    }
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !target.pathname.endsWith("/chat/completions")
    ) {
      throw new PreviewRuntimeUpstreamError(
        "configuration",
        "preview runtime upstream must be a fixed HTTP(S) chat-completions URL",
      );
    }
    return target.toString();
  }
}

async function normalizeUpstreamErrorBody(
  status: number,
  body: Response["body"],
): Promise<Response["body"]> {
  const bytes = await readBoundedBody(body, MAX_NORMALIZED_ERROR_BYTES);
  if (bytes) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("upstream error body must be a JSON object");
      }
      return new Response(text).body;
    } catch {
      // Fall through to a bounded OpenAI-compatible error without reflecting
      // arbitrary intermediary content into the preview runtime.
    }
  }
  return new Response(
    JSON.stringify({
      error: {
        message: `preview runtime upstream returned HTTP ${status}`,
        type: "upstream_error",
        code: `upstream_http_${status}`,
      },
    }),
  ).body;
}

async function readBoundedBody(
  body: Response["body"],
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
