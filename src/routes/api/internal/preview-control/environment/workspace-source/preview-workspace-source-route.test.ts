import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewWorkspaceGatewayError } from "$lib/server/application/ports";
import { PREVIEW_CONTROL_JSON_MAX_BYTES } from "../../../_shared/bounded-json-body";

const BUNDLE = new Uint8Array([1, 2, 3, 4]);
const IDENTITY = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};
const BODY = {
  ...IDENTITY,
  service: "workflow-builder",
};

const mocks = vi.hoisted(() => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
  requirePreviewControlCapability: vi.fn(),
  fetchExact: vi.fn(async () => ({
    repository: "PittampalliOrg/workflow-builder",
    sourceRevision: "b".repeat(40),
    bundle: new Uint8Array([1, 2, 3, 4]),
    bundleSha256: `sha256:${"d".repeat(64)}`,
    fileCount: 42,
  })),
}));

vi.mock("$env/dynamic/private", () => ({ env: mocks.env }));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewWorkspaceSourceBroker: { fetchExact: mocks.fetchExact },
  }),
}));

import { POST } from "./+server";

function event(body: unknown = BODY, headers: Record<string, string> = {}) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/environment/workspace-source",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("physical preview workspace source route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "true";
  });

  it("authorizes the exact tuple and returns only a bounded binary source receipt", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlCapability).toHaveBeenCalledWith(
      expect.any(Request),
      IDENTITY,
    );
    expect(mocks.fetchExact).toHaveBeenCalledWith({
      identity: IDENTITY,
      service: "workflow-builder",
    });
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.git.bundle",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-wfb-preview-source-repository")).toBe(
      "PittampalliOrg/workflow-builder",
    );
    expect(response.headers.get("x-wfb-preview-source-revision")).toBe(
      IDENTITY.environmentSourceRevision,
    );
    expect(response.headers.get("x-wfb-preview-source-sha256")).toBe(
      `sha256:${"d".repeat(64)}`,
    );
    expect(response.headers.get("x-wfb-preview-source-file-count")).toBe("42");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BUNDLE);
  });

  it("rejects caller-supplied source authority before authentication", async () => {
    const response = (await POST(
      event({
        ...BODY,
        repository: "attacker/repo",
        sourceRevision: "e".repeat(40),
        githubToken: "attacker-token",
      }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("unsupported broker fields"),
    });
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.fetchExact).not.toHaveBeenCalled();
  });

  it("rejects malformed identity or service before authentication", async () => {
    const response = (await POST(
      event({ ...BODY, service: "Workflow Builder" }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.fetchExact).not.toHaveBeenCalled();
  });

  it("rejects an oversized command before authentication", async () => {
    const request = new Request(
      "http://broker/api/internal/preview-control/environment/workspace-source",
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
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.fetchExact).not.toHaveBeenCalled();
  });

  it("maps typed source failures without leaking arbitrary provider output", async () => {
    mocks.fetchExact.mockRejectedValueOnce(
      new PreviewWorkspaceGatewayError(
        "source-rejected",
        413,
        "preview workspace source bundle exceeds its byte limit",
      ),
    );

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "source-rejected",
      error: "preview workspace source bundle exceeds its byte limit",
    });
  });

  it("is absent outside the physical broker deployment", async () => {
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "false";

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(404);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.fetchExact).not.toHaveBeenCalled();
  });
});
