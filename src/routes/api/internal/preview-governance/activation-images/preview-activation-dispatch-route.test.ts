import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewGovernanceDispatch: vi.fn(),
  dispatch: vi.fn(async (input) => ({ ok: true, required: false, ...input })),
}));

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "false" },
}));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewGovernanceDispatch: mocks.requirePreviewGovernanceDispatch,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewActivationDispatch: { dispatch: mocks.dispatch },
  }),
}));

import { POST } from "./+server";

const pullRequest = {
  repository: "PittampalliOrg/workflow-builder",
  number: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

function event(body: unknown) {
  return {
    request: new Request(
      "http://bff/api/internal/preview-governance/activation-images",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("normal-BFF activation dispatch route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates and forwards only the exact pull request tuple", async () => {
    const response = (await POST(event({ pullRequest }) as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewGovernanceDispatch).toHaveBeenCalledWith(
      expect.any(Request),
    );
    expect(mocks.dispatch).toHaveBeenCalledWith({ pullRequest });
  });

  it.each(["requestId", "catalogDigest", "artifacts", "changedPaths", "context"])(
    "rejects caller-selected activation authority %s",
    async (field) => {
      const response = (await POST(
        event({ pullRequest, [field]: "attacker-selected" }) as never,
      )) as Response;
      expect(response.status).toBe(400);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects authority nested inside the PR tuple", async () => {
    const response = (await POST(
      event({ pullRequest: { ...pullRequest, paths: ["services/dev-sync-sidecar"] } }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
