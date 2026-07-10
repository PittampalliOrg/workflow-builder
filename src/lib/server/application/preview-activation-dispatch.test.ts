import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewActivationDispatchService } from "$lib/server/application/preview-activation-dispatch";

const BASE = "a".repeat(40) as never;
const HEAD = "b".repeat(40) as never;
const CATALOG = `sha256:${"c".repeat(64)}` as const;
const pullRequest = {
  repository: "PittampalliOrg/workflow-builder",
  number: 42,
  baseSha: BASE,
  headSha: HEAD,
};

describe("ApplicationPreviewActivationDispatchService", () => {
  it("derives request and catalog identity before forwarding the exact tuple", async () => {
    const broker = {
      dispatch: vi.fn(async (input) => ({
        ok: true as const,
        required: false as const,
        pullRequest: input.pullRequest,
        catalogDigest: input.catalogDigest,
      })),
    };
    const service = new ApplicationPreviewActivationDispatchService({
      broker,
      catalog: {
        currentDigest: () => CATALOG,
        deriveChangedServices: vi.fn(),
      },
      sourceRepository: pullRequest.repository,
    });

    await expect(service.dispatch({ pullRequest })).resolves.toMatchObject({
      ok: true,
      required: false,
    });
    expect(broker.dispatch).toHaveBeenCalledWith({
      requestId: `webhook:42:${HEAD}`,
      catalogDigest: CATALOG,
      pullRequest,
    });
  });

  it("rejects any tuple outside the configured source repository", async () => {
    const broker = { dispatch: vi.fn() };
    const service = new ApplicationPreviewActivationDispatchService({
      broker,
      catalog: {
        currentDigest: () => CATALOG,
        deriveChangedServices: vi.fn(),
      },
      sourceRepository: pullRequest.repository,
    });
    await expect(
      service.dispatch({
        pullRequest: { ...pullRequest, repository: "attacker/repository" },
      }),
    ).rejects.toThrow("tuple is invalid");
    expect(broker.dispatch).not.toHaveBeenCalled();
  });
});
