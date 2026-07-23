import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn(),
  resolveCanonicalExecutionId: vi.fn(async () => "exec-1"),
	verifyBrowserEvidence: vi.fn(async () => ({
    status: "ok" as const,
    body: {
      ok: true as const,
      executionId: "exec-1",
      evidence: [
        {
          storageRef: "workflow-browser-artifacts/exec-1/bwf_1/screenshot.png",
          width: 1440,
          height: 1000,
          artifactId: "bwf_1",
          contentType: "image/png" as const,
          sizeBytes: 1024,
        },
      ],
    },
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: {
      resolveCanonicalExecutionId: mocks.resolveCanonicalExecutionId,
    },
		workflowBrowserEvidence: {
			verify: mocks.verifyBrowserEvidence,
    },
  }),
}));

import { POST } from "./+server";

const storageRef = "workflow-browser-artifacts/exec-1/bwf_1/screenshot.png";

function request(body: unknown): Request {
  return new Request(
    "http://workflow-builder/api/internal/workflows/executions/exec-1/dev-preview/browser-evidence",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-preview-action-token": "action-token",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("internal dev-preview browser evidence route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires preview-action authority and verifies through the application service", async () => {
    const req = request({
      evidence: [{ storageRef, width: 1440, height: 1000 }],
    });
    const response = (await POST({
      params: { executionId: "exec-1" },
      request: req,
    } as never)) as Response;

    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledWith(req);
    expect(mocks.resolveCanonicalExecutionId).toHaveBeenCalledWith({
      executionId: "exec-1",
    });
		expect(mocks.verifyBrowserEvidence).toHaveBeenCalledWith({
      executionId: "exec-1",
      evidence: [{ storageRef, width: 1440, height: 1000 }],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      executionId: "exec-1",
    });
  });

  it("rejects extra caller-controlled fields before application dispatch", async () => {
    const response = (await POST({
      params: { executionId: "exec-1" },
      request: request({
        evidence: [
          { storageRef, width: 1440, height: 1000, executionId: "other" },
        ],
      }),
    } as never)) as Response;

    expect(response.status).toBe(400);
		expect(mocks.verifyBrowserEvidence).not.toHaveBeenCalled();
  });

  it("preserves deterministic verification failures", async () => {
		mocks.verifyBrowserEvidence.mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "Screenshot evidence dimensions do not match the claim",
    });
    const response = (await POST({
      params: { executionId: "exec-1" },
      request: request({
        evidence: [{ storageRef, width: 390, height: 844 }],
      }),
    } as never)) as Response;

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      executionId: "exec-1",
      error: "Screenshot evidence dimensions do not match the claim",
    });
  });
});
