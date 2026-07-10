import { env } from "$env/dynamic/private";
import type {
  PreviewActivationBrokerPort,
  PreviewActivationDispatchResult,
  PreviewActivationGateRequest,
} from "$lib/server/application/ports";

export type HttpPreviewActivationBrokerOptions = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

/** Normal-BFF adapter; privileged build and GitHub status authority stay physical. */
export class HttpPreviewActivationBrokerAdapter implements PreviewActivationBrokerPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpPreviewActivationBrokerOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async dispatch(
    input: PreviewActivationGateRequest,
  ): Promise<PreviewActivationDispatchResult> {
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
    if (!baseUrl) throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    if (!token) throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");

    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/activation-images`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Broker-Token": token,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview activation dispatch failed (HTTP ${response.status})`,
      );
    }
    const pullRequest = body.pullRequest as Record<string, unknown> | undefined;
    if (
      body.ok !== true ||
      typeof body.required !== "boolean" ||
      !pullRequest ||
      pullRequest.repository !== input.pullRequest.repository ||
      pullRequest.number !== input.pullRequest.number ||
      pullRequest.baseSha !== input.pullRequest.baseSha ||
      pullRequest.headSha !== input.pullRequest.headSha ||
      body.catalogDigest !== input.catalogDigest ||
      (body.required === true &&
        (typeof body.evidenceReceiptDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(body.evidenceReceiptDigest) ||
          !Array.isArray(body.images)))
    ) {
      throw new Error("preview activation broker returned an invalid result");
    }
    return body as PreviewActivationDispatchResult;
  }
}
