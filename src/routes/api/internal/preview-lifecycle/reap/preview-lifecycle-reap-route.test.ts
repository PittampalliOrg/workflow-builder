import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn(),
  reapExpired: vi.fn(async () => ({
    expired: 0,
    processed: 0,
    teardownStarted: 0,
    archiveRefused: 0,
    items: [],
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewLifecycleReaper: { reapExpired: mocks.reapExpired },
  }),
}));

import { POST } from "./+server";

describe("preview lifecycle reap route", () => {
  it("requires the dedicated host action credential", async () => {
    const request = new Request(
      "http://workflow-builder/api/internal/preview-lifecycle/reap",
      {
        method: "POST",
        headers: { "x-preview-action-token": "action-token" },
      },
    );
    const response = (await POST({ request } as never)) as Response;
    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledWith(request);
    expect(mocks.reapExpired).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });
});
