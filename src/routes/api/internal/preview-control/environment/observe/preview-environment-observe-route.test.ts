import { beforeEach, describe, expect, it, vi } from "vitest";
import { error as httpError } from "@sveltejs/kit";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import { PreviewControlSourceAuthorityError } from "$lib/server/application/preview-control-source-authority";

const mocks = vi.hoisted(() => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
  requirePreviewControlCapability: vi.fn(),
  inspect: vi.fn(async () => ({ name: "feature-one", phase: "ready" })),
  observeRuntime: vi.fn(async () => ({
    name: "feature-one",
    identity: {
      previewName: "feature-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "a".repeat(40),
      environmentSourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"d".repeat(64)}`,
    },
  })),
}));

vi.mock("$env/dynamic/private", () => ({ env: mocks.env }));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewEnvironmentObservationBroker: {
      inspect: mocks.inspect,
      observeRuntime: mocks.observeRuntime,
    },
  }),
}));

import { POST } from "./+server";

const identity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}`,
};

function event(
  body: unknown = { identity, view: "record" },
  headers: Record<string, string> = {},
) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/environment/observe",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("physical preview environment observation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "true";
  });

  it("requires the exact tuple capability before delegating a record read", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlCapability).toHaveBeenCalledWith(
      expect.any(Request),
      identity,
    );
    expect(mocks.inspect).toHaveBeenCalledWith(identity);
    expect(mocks.observeRuntime).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      view: "record",
      identity,
      preview: { name: "feature-one" },
    });
  });

  it("delegates runtime as the other operation on the same driving port", async () => {
    const response = (await POST(
      event({ identity, view: "runtime" }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.observeRuntime).toHaveBeenCalledWith(identity);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("rejects extra fields before capability or application work", async () => {
    const response = (await POST(
      event({ identity, view: "record", kubeconfig: "attacker" }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("rejects malformed and extended tuple identities before authorization", async () => {
    const response = (await POST(
      event({
        view: "record",
        identity: { ...identity, namespace: "vcluster-feature-one" },
      }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
  });

  it("fails closed on a missing or mismatched tuple leaf before application work", async () => {
    mocks.requirePreviewControlCapability.mockImplementationOnce(() => {
      throw httpError(401, "invalid or mismatched preview control capability");
    });

    await expect(POST(event() as never)).rejects.toMatchObject({ status: 401 });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.observeRuntime).not.toHaveBeenCalled();
  });

  it("is absent outside the physical broker deployment", async () => {
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "false";

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(404);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
  });

  it.each([
    [
      404,
      new PreviewControlSourceAuthorityError("not-found", "preview missing"),
    ],
    [
      403,
      new PreviewControlSourceAuthorityError(
        "owner-not-admin",
        "owner is not admin",
      ),
    ],
    [
      409,
      new PreviewControlSourceAuthorityError("not-ready", "preview not ready"),
    ],
    [409, new PreviewRuntimeIdentityChangedError("generation replaced")],
  ])("maps application observation failures to HTTP %i", async (status, cause) => {
    mocks.inspect.mockRejectedValueOnce(cause);

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(status);
  });
});
