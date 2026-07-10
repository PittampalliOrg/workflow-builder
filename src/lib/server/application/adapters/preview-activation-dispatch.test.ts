import { describe, expect, it, vi } from "vitest";
import { HttpPreviewActivationBrokerAdapter } from "$lib/server/application/adapters/preview-activation-dispatch";

const input = {
  requestId: `webhook:42:${"b".repeat(40)}`,
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
  pullRequest: {
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    baseSha: "a".repeat(40) as never,
    headSha: "b".repeat(40) as never,
  },
};

describe("HttpPreviewActivationBrokerAdapter", () => {
  it("sends only the server-derived activation command with broker auth", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ok: true,
        required: false,
        pullRequest: input.pullRequest,
        catalogDigest: input.catalogDigest,
      }),
    );
    const adapter = new HttpPreviewActivationBrokerAdapter({
      baseUrl: () => "https://preview-control.example/",
      token: () => "broker-token",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(adapter.dispatch(input)).resolves.toMatchObject({
      required: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://preview-control.example/api/internal/preview-control/activation-images",
    );
    expect(init.headers).toMatchObject({
      "X-Preview-Control-Broker-Token": "broker-token",
    });
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("fails closed when the broker credential is absent", async () => {
    const adapter = new HttpPreviewActivationBrokerAdapter({
      baseUrl: () => "https://preview-control.example",
      token: () => null,
      fetch: vi.fn() as typeof fetch,
    });
    await expect(adapter.dispatch(input)).rejects.toThrow(
      "PREVIEW_CONTROL_BROKER_TOKEN is not configured",
    );
  });

  it("rejects a broker response for a different exact tuple", async () => {
    const adapter = new HttpPreviewActivationBrokerAdapter({
      baseUrl: () => "https://preview-control.example",
      token: () => "broker-token",
      fetch: vi.fn(async () =>
        Response.json({
          ok: true,
          required: false,
          pullRequest: { ...input.pullRequest, headSha: "d".repeat(40) },
          catalogDigest: input.catalogDigest,
        }),
      ) as typeof fetch,
    });
    await expect(adapter.dispatch(input)).rejects.toThrow("invalid result");
  });
});
