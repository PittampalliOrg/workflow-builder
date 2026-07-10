import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireBroker: vi.fn(),
  buildAndFinalize: vi.fn(async (input) => ({ ok: true, ...input })),
}));

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requireBroker,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewActivationGate: { buildAndFinalize: mocks.buildAndFinalize },
  }),
}));

import { POST } from "./+server";

const body = {
  requestId: "request-1",
  catalogDigest: `sha256:${"c".repeat(64)}`,
  pullRequest: {
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  },
};

function event(value: unknown) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/activation-images",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      },
    ),
  };
}

describe("physical activation-image route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates and forwards only the exact PR command", async () => {
    const response = (await POST(event(body) as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requireBroker).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.buildAndFinalize).toHaveBeenCalledWith(body);
  });

  it("rejects caller-selected artifacts or status authority", async () => {
    const response = (await POST(
      event({
        ...body,
        artifacts: ["attacker-image"],
        context: "preview/gate",
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.buildAndFinalize).not.toHaveBeenCalled();
  });

  it("rejects extra authority inside the PR tuple", async () => {
    const response = (await POST(
      event({
        ...body,
        pullRequest: { ...body.pullRequest, changedPaths: ["src"] },
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.buildAndFinalize).not.toHaveBeenCalled();
  });

  it("returns a server-derived skip when the exact PR needs no activation image", async () => {
    const { PreviewActivationGateInputError } = await import(
      "$lib/server/application/preview-activation-gate"
    );
    mocks.buildAndFinalize.mockRejectedValueOnce(
      new PreviewActivationGateInputError(
        "pull request does not require activation-image evidence",
      ),
    );
    const response = (await POST(event(body) as never)) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      required: false,
      pullRequest: body.pullRequest,
      catalogDigest: body.catalogDigest,
    });
  });
});
