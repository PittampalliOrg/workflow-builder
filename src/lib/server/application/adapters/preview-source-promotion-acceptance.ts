import { Agent as UndiciAgent, Pool } from "undici";
import { env } from "$env/dynamic/private";
import type {
  PreviewAcceptanceBrokerRequest,
  PreviewAcceptanceResponseCatalogPort,
  PreviewSourcePromotionAcceptancePort,
  PreviewSourcePromotionAcceptanceRequest,
} from "$lib/server/application/ports";
import { validateAcceptanceBrokerResult } from "$lib/server/application/adapters/preview-control";
import {
  localPreviewControlCapability,
  localPreviewControlIdentity,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

const FULL_SHA = /^[0-9a-f]{40}$/;

type Options = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  identity?: (expectedName?: string) => PreviewControlIdentity;
  catalog: PreviewAcceptanceResponseCatalogPort;
}>;

const dispatcher = new UndiciAgent({
  factory: (origin, options) =>
    new Pool(origin, { ...options, headersTimeout: 0, bodyTimeout: 0 }),
});
const longFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, dispatcher } as RequestInit);

/** Preview-local adapter; only an opaque broker-issued receipt crosses it. */
export class HttpPreviewSourcePromotionAcceptanceAdapter
  implements PreviewSourcePromotionAcceptancePort
{
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetch ?? longFetch;
  }

  async replay(input: PreviewSourcePromotionAcceptanceRequest) {
    const identity = (this.options.identity ?? localPreviewControlIdentity)(
      input.previewName,
    );
    if (
      input.environmentRequestId !== identity.environmentRequestId ||
      input.environmentPlatformRevision !==
        identity.environmentPlatformRevision ||
      input.environmentSourceRevision !== identity.environmentSourceRevision ||
      input.catalogDigest !== identity.catalogDigest
    ) {
      throw new Error("preview promotion acceptance identity changed");
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
      this.options.token?.() ?? localPreviewControlCapability()
    ).trim();
    if (!baseUrl) throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    if (!token) throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");

    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/promotion-acceptance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": token,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 45 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (
      response.headers.get("x-preview-promotion-receipt") !== input.receiptId
    ) {
      throw new Error(
        "preview promotion acceptance response is not bound to its receipt",
      );
    }
    if (!response.ok && response.status !== 409 && response.status !== 422) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview promotion acceptance failed (HTTP ${response.status})`,
      );
    }
    if (response.status === 409) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : "preview promotion receipt is not available",
      );
    }
    const pullRequest = record(body.pullRequest);
    if (
      !pullRequest ||
      typeof pullRequest.repository !== "string" ||
      typeof pullRequest.number !== "number" ||
      !Number.isSafeInteger(pullRequest.number) ||
      typeof pullRequest.baseSha !== "string" ||
      !FULL_SHA.test(pullRequest.baseSha) ||
      typeof pullRequest.headSha !== "string" ||
      !FULL_SHA.test(pullRequest.headSha)
    ) {
      throw new Error("preview promotion acceptance returned invalid PR proof");
    }
    const expected: PreviewAcceptanceBrokerRequest = {
      requestId: input.requestId,
      previewName: input.previewName,
      pullRequest: {
        repository: pullRequest.repository,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha as never,
        headSha: pullRequest.headSha as never,
      },
    };
    return validateAcceptanceBrokerResult(
      body,
      expected,
      this.options.catalog,
      response.status,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
