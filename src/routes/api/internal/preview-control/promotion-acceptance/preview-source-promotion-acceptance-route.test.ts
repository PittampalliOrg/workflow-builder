import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewControlCapability: vi.fn(),
  replay: vi.fn(async (input) => ({
    ok: true,
    name: `accept-pr42-${"c".repeat(12)}`,
    previewName: input.previewName,
    pullRequest: {
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    services: ["workflow-builder"],
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewSourcePromotionAcceptance: { replay: mocks.replay },
  }),
}));

import { POST } from "./+server";

const identity = {
  previewName: "app-live",
  environmentRequestId: "environment-request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}`,
};
const receiptId = `pspr_${"e".repeat(64)}`;

function event(extra: Record<string, unknown> = {}) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/promotion-acceptance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "acceptance-request-1",
          ...identity,
          executionId: "execution-1",
          receiptId,
          ...extra,
        }),
      },
    ),
  };
}

describe("preview source promotion acceptance physical route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PREVIEW_CONTROL_BROKER_MODE", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("authenticates the current preview identity and forwards only the opaque receipt", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlCapability).toHaveBeenCalledWith(
      expect.any(Request),
      identity,
    );
    expect(mocks.replay).toHaveBeenCalledWith({
      requestId: "acceptance-request-1",
      ...identity,
      executionId: "execution-1",
      receiptId,
    });
    expect(response.headers.get("x-preview-promotion-receipt")).toBe(receiptId);
  });

  it("rejects caller-supplied pull-request provenance", async () => {
    const response = (await POST(
      event({ pullRequest: { repository: "attacker/repo", number: 1 } }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it("is absent outside the physical broker deployment", async () => {
    vi.stubEnv("PREVIEW_CONTROL_BROKER_MODE", "false");
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(404);
  });
});
