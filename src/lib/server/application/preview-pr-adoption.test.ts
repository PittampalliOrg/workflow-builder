import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewPrAdoptionService } from "$lib/server/application/preview-pr-adoption";

describe("ApplicationPreviewPrAdoptionService", () => {
  it("uses the installed bounded dev-preview execution class", async () => {
    const provisionMany = vi.fn(async () => ({ ok: true, services: [] }));
    const service = new ApplicationPreviewPrAdoptionService({
      provisioner: { provisionMany } as never,
      catalog: {
        currentDigest: () => `sha256:${"a".repeat(64)}`,
        assertPreviewNativeServices: (services: readonly string[]) => [
          ...services,
        ],
      } as never,
    });

    await service.adopt({
      previewName: "pr-42",
      environmentRequestId: "request-42",
      environmentPlatformRevision: "b".repeat(40),
      environmentSourceRevision: "c".repeat(40),
      catalogDigest: `sha256:${"a".repeat(64)}`,
      services: ["workflow-builder", "function-router"],
      origin: "https://wfb-pr-42.tail286401.ts.net/",
      waitReadySeconds: 300,
    });

    expect(provisionMany).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "pr-adopt-request-42",
        executionClass: "dev-preview",
        mode: "preview-native",
        adopt: true,
      }),
    );
  });
});
