import { beforeEach, describe, expect, it, vi } from "vitest";
import { error as httpError } from "@sveltejs/kit";
import { PreviewHeadlampRegistrationError } from "$lib/server/application/ports";

const UID = "11111111-2222-3333-4444-555555555555";
const caData = Buffer.from(
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
).toString("base64");
const body = {
  identity: {
    previewName: "feature-one",
    environmentRequestId: "request-1",
    environmentPlatformRevision: "a".repeat(40),
    environmentSourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"c".repeat(64)}` as const,
  },
  credential: {
    bearerToken: `eyJ.${"a".repeat(32)}.signature`,
    caData,
    serverName: "feature-one.vcluster-feature-one",
  },
};
const registration = {
  previewName: "feature-one",
  contextName: "preview-feature-one",
  environmentUid: UID,
  secretName: "headlamp-preview-feature-one",
  serviceName: "kube-feature-one-api-egress",
};

const mocks = vi.hoisted(() => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
  requireCapability: vi.fn(),
  register: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: mocks.env }));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requireCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewHeadlampRegistration: { register: mocks.register },
  }),
}));

import { POST } from "./+server";

function event(
  input: unknown = body,
  name = "feature-one",
  headers: Record<string, string> = {},
) {
  return {
    params: { name },
    request: new Request(
      `http://broker/api/internal/preview-control/environment/${name}/headlamp`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(input),
      },
    ),
  };
}

describe("preview Headlamp registration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "true";
    mocks.register.mockResolvedValue(registration);
  });

  it("authorizes the exact tuple and returns a credential-free receipt", async () => {
    const response = (await POST(
      event(body, "feature-one", {
        "x-preview-control-capability": "tuple-leaf",
      }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requireCapability).toHaveBeenCalledWith(
      expect.any(Request),
      body.identity,
    );
    expect(mocks.register).toHaveBeenCalledWith(body);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      registration,
    });
  });

  it.each([
    [{ ...body, server: "https://attacker.example" }, "feature-one"],
    [
      {
        ...body,
        credential: { ...body.credential, serverName: "attacker.example" },
      },
      "feature-one",
    ],
    [body, "other-preview"],
    [
      {
        ...body,
        identity: { ...body.identity, namespace: "vcluster-feature-one" },
      },
      "feature-one",
    ],
  ])("rejects malformed or path-mismatched input before auth", async (input, name) => {
    const response = (await POST(event(input, name) as never)) as Response;

    expect(response.status).toBe(400);
    expect(mocks.requireCapability).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("fails closed when the tuple capability is rejected", async () => {
    mocks.requireCapability.mockImplementationOnce(() => {
      throw httpError(401, "invalid or mismatched preview control capability");
    });

    await expect(POST(event() as never)).rejects.toMatchObject({ status: 401 });
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it.each([
    ["generation-mismatch", 409],
    ["resource-ownership", 409],
    ["environment-not-found", 409],
    ["hub-unavailable", 503],
  ] as const)("maps %s to HTTP %i", async (code, status) => {
    mocks.register.mockRejectedValueOnce(
      new PreviewHeadlampRegistrationError(code, "registration failed"),
    );

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code });
  });

  it("is absent outside the physical broker", async () => {
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "false";

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(404);
    expect(mocks.requireCapability).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
