import { afterEach, describe, expect, it, vi } from "vitest";

import { LegacyVclusterPreviewGateway } from "$lib/server/application/adapters/dev-previews";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";

const identity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
};

describe("LegacyVclusterPreviewGateway runtime identity boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("translates a physical tuple conflict into the application error", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "preview identity changed" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      new LegacyVclusterPreviewGateway().runtimeForIdentity(identity),
    ).rejects.toBeInstanceOf(PreviewRuntimeIdentityChangedError);
  });
});
