import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replay: vi.fn(async () => ({
    ok: true,
    name: "accept-pr42-bbbbbbbbbbbb",
    previewName: "feature-one",
    pullRequest: {},
    services: ["workflow-builder"],
  })),
  requirePreviewActionInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewLocalControlIdentity: {
      current: () => ({ previewName: "feature-one" }),
    },
    previewAcceptanceBroker: { replay: mocks.replay },
  }),
}));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));

import { POST } from "./+server";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function event(body: unknown) {
  return {
    params: { executionId: "run-1" },
    request: new Request("http://localhost/internal/acceptance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

describe("workflow dev-preview acceptance broker proxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards only PR identity and preview name to the physical broker", async () => {
    const body = {
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    };
    const response = (await POST(event(body) as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledOnce();
    expect(mocks.replay).toHaveBeenCalledWith({
      requestId: expect.any(String),
      previewName: "feature-one",
      pullRequest: body.pullRequest,
    });
  });

  it("rejects fields that could assert build or cluster authority", async () => {
    await expect(
      POST(
        event({
          pullRequest: {},
          platformRevision: BASE_SHA,
          services: ["workflow-builder"],
          retainOnSuccess: true,
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it("rejects extra or incomplete fields inside the PR tuple", async () => {
    await expect(
      POST(
        event({
          pullRequest: {
            repository: "PittampalliOrg/workflow-builder",
            number: 42,
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
            services: ["workflow-builder"],
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      POST(
        event({
          pullRequest: {
            repository: "PittampalliOrg/workflow-builder",
            number: 42,
            headSha: HEAD_SHA,
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.replay).not.toHaveBeenCalled();
  });
});
