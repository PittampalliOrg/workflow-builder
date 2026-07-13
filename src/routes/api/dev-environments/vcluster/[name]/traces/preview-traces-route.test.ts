import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  allows: vi.fn(() => true),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewTraces: { list: mocks.list },
    previewDeploymentScope: { allowsPreviewName: mocks.allows },
  }),
}));

import { GET } from "./+server";

function event(userId: string | null = "user-1") {
  return {
    params: { name: "feature-one" },
    locals: { session: userId ? { userId } : null },
    url: new URL(
      "http://app/api/dev-environments/vcluster/feature-one/traces?range=15m&limit=12",
    ),
  };
}

describe("preview trace UI route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allows.mockReturnValue(true);
    mocks.list.mockResolvedValue({
      identity: {},
      traces: [],
      services: [],
      observedAt: "2026-07-13T12:00:00.000Z",
    });
  });

  it("requires a user session", async () => {
    await expect(GET(event(null) as never)).rejects.toMatchObject({
      status: 401,
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("delegates actor authorization and strips the tuple receipt from the browser DTO", async () => {
    const response = (await GET(event() as never)) as Response;

    expect(mocks.list).toHaveBeenCalledWith({
      name: "feature-one",
      actorUserId: "user-1",
      query: {
        range: "15m",
        status: undefined,
        service: undefined,
        search: undefined,
        limit: 12,
      },
    });
    await expect(response.json()).resolves.toEqual({
      traces: [],
      services: [],
      observedAt: "2026-07-13T12:00:00.000Z",
    });
  });

  it("maps owner/admin policy refusal to 403", async () => {
    mocks.list.mockRejectedValueOnce(new PreviewAccessDeniedError());
    await expect(GET(event() as never)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects cross-preview reads before application work", async () => {
    mocks.allows.mockReturnValueOnce(false);
    await expect(GET(event() as never)).rejects.toMatchObject({ status: 403 });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
