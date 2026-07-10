import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewControlBroker: vi.fn(),
  reconcile: vi.fn(async () => ({
    scanned: 1,
    acknowledged: 1,
    pending: 0,
    failed: 0,
    prunedReceipts: 0,
    pruneFailed: 0,
    prunedRuntimeBudgets: 0,
    runtimeBudgetPruneFailed: 0,
    items: [],
  })),
}));

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requirePreviewControlBroker,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewEnvironmentDeletionReconciler: { reconcile: mocks.reconcile },
  }),
}));

import { POST } from "./+server";

describe("preview deletion-intent reconcile route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is broker-authenticated and invokes the continuously retryable consumer", async () => {
    const request = new Request("http://broker/reconcile", { method: "POST" });
    const response = (await POST({ request } as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it("returns retryable failure when any intent did not converge", async () => {
    mocks.reconcile.mockResolvedValueOnce({
      scanned: 1,
      acknowledged: 0,
      pending: 0,
      failed: 1,
      prunedReceipts: 0,
      pruneFailed: 0,
      prunedRuntimeBudgets: 0,
      runtimeBudgetPruneFailed: 0,
      items: [
        { name: "feature-one", state: "failed", message: "SEA unavailable" },
      ],
    } as never);
    const response = (await POST({
      request: new Request("http://broker/reconcile", { method: "POST" }),
    } as never)) as Response;
    expect(response.status).toBe(503);
  });
});
