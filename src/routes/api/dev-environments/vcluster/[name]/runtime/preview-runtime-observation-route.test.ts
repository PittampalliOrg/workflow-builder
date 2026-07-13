import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/vcluster-previews";
import { GET } from "./+server";

const mocks = vi.hoisted(() => ({
  allowsPreviewName: vi.fn(),
  observeRuntime: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDeploymentScope: {
      allowsPreviewName: mocks.allowsPreviewName,
    },
    vclusterPreviews: {
      observeRuntime: mocks.observeRuntime,
    },
  }),
}));

const event = (userId: string | null = "user-1") =>
  ({
    params: { name: "feature-one" },
    locals: { session: userId ? { userId } : null },
  }) as never;

describe("preview runtime observation route", () => {
  beforeEach(() => {
    mocks.allowsPreviewName.mockReset();
    mocks.allowsPreviewName.mockReturnValue(true);
    mocks.observeRuntime.mockReset();
    mocks.observeRuntime.mockResolvedValue({
      name: "feature-one",
      reconciliationSucceeded: true,
      provision: {
        found: true,
        active: false,
        succeeded: true,
        failed: false,
      },
      services: [],
    });
  });

  it("rejects an unauthenticated request", async () => {
    await expect(GET(event(null))).rejects.toMatchObject({ status: 401 });
    expect(mocks.observeRuntime).not.toHaveBeenCalled();
  });

  it("rejects a cross-preview read before physical observation", async () => {
    mocks.allowsPreviewName.mockReturnValueOnce(false);

    await expect(GET(event())).rejects.toMatchObject({ status: 403 });

    expect(mocks.allowsPreviewName).toHaveBeenCalledWith("feature-one");
    expect(mocks.observeRuntime).not.toHaveBeenCalled();
  });

  it("delegates authorization and tuple-bound observation to one application use case", async () => {
    const response = (await GET(event())) as Response;

    expect(mocks.observeRuntime).toHaveBeenCalledWith({
      name: "feature-one",
      actorUserId: "user-1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtime: { name: "feature-one", reconciliationSucceeded: true },
    });
  });

  it("maps owner-policy refusal to 403", async () => {
    mocks.observeRuntime.mockRejectedValueOnce(new PreviewAccessDeniedError());

    await expect(GET(event())).rejects.toMatchObject({ status: 403 });
  });

  it("maps a runtime identity race to 409", async () => {
    mocks.observeRuntime.mockRejectedValueOnce(
      new PreviewRuntimeIdentityChangedError(),
    );

    await expect(GET(event())).rejects.toMatchObject({ status: 409 });
  });
});
