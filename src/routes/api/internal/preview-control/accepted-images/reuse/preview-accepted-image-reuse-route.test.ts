import { beforeEach, describe, expect, it, vi } from "vitest";

const privateEnv = vi.hoisted(() => ({
  PREVIEW_CONTROL_BROKER_MODE: "true",
}));
const mocks = vi.hoisted(() => ({
  requireReuse: vi.fn(),
  resolve: vi.fn(async (input) => ({
    ok: false,
    disposition: "build",
    reason: "receipt-absent",
    input,
  })),
}));

vi.mock("$env/dynamic/private", () => ({ env: privateEnv }));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewAcceptedImageReuse: mocks.requireReuse,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewAcceptedImageReuse: { resolve: mocks.resolve },
  }),
}));

import { POST } from "./+server";
import { PREVIEW_CONTROL_JSON_MAX_BYTES } from "../../../_shared/bounded-json-body";

const body = {
  repository: "PittampalliOrg/workflow-builder",
  mergeSha: "c".repeat(40),
  context: "preview/immutable-acceptance",
  subject: "workflow-builder",
};

function event(payload: Record<string, unknown> = body) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/accepted-images/reuse",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  };
}

describe("physical accepted-image reuse route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    privateEnv.PREVIEW_CONTROL_BROKER_MODE = "true";
  });

  it("authenticates and delegates only the bounded merge preflight", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requireReuse).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.resolve).toHaveBeenCalledWith(body);
    await expect(response.json()).resolves.toMatchObject({
      disposition: "build",
      reason: "receipt-absent",
    });
  });

  it("rejects caller-selected receipt, image, PR, or GitOps authority", async () => {
    const response = (await POST(
      event({
        ...body,
        receiptDigest: `sha256:${"1".repeat(64)}`,
        imageRef: "attacker/image:latest",
        pullRequestNumber: 42,
        releasePin: true,
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("rejects oversized input before resolving evidence", async () => {
    const request = new Request(
      "http://broker/api/internal/preview-control/accepted-images/reuse",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(PREVIEW_CONTROL_JSON_MAX_BYTES + 1),
        },
        body: "{}",
      },
    );
    const response = (await POST({ request } as never)) as Response;
    expect(response.status).toBe(413);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("does not expose the command outside physical broker mode", async () => {
    privateEnv.PREVIEW_CONTROL_BROKER_MODE = "false";
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(404);
    expect(mocks.requireReuse).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
