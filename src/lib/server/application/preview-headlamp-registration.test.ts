import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewHeadlampRegistrationService } from "$lib/server/application/preview-headlamp-registration";
import { PreviewHeadlampRegistrationError } from "$lib/server/application/ports";

const UID = "11111111-2222-3333-4444-555555555555";
const caData = Buffer.from(
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
).toString("base64");
const command = {
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

function receipt() {
  return {
    previewName: "feature-one",
    contextName: "preview-feature-one",
    environmentUid: UID,
    secretName: "headlamp-preview-feature-one",
    serviceName: "kube-feature-one-api-egress",
  };
}

describe("ApplicationPreviewHeadlampRegistrationService", () => {
  it("validates the exact credential command before delegating", async () => {
    const register = vi.fn(async () => receipt());
    const service = new ApplicationPreviewHeadlampRegistrationService({
      register,
    });

    await expect(service.register(command)).resolves.toEqual(receipt());
    expect(register).toHaveBeenCalledWith(command);
  });

  it.each([
    ["command", { ...command, extra: true }],
    [
      "token",
      {
        ...command,
        credential: { ...command.credential, bearerToken: "short" },
      },
    ],
    [
      "CA data",
      { ...command, credential: { ...command.credential, caData: "not-base64" } },
    ],
    [
      "server name",
      {
        ...command,
        credential: { ...command.credential, serverName: "attacker.example" },
      },
    ],
  ])("rejects malformed %s before the port", async (_label, invalid) => {
    const register = vi.fn();
    const service = new ApplicationPreviewHeadlampRegistrationService({
      register,
    });

    await expect(service.register(invalid)).rejects.toBeInstanceOf(
      PreviewHeadlampRegistrationError,
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects an adapter receipt that changes a derived name", async () => {
    const service = new ApplicationPreviewHeadlampRegistrationService({
      register: vi.fn(async () => ({
        ...receipt(),
        serviceName: "attacker-controlled",
      })),
    });

    await expect(service.register(command)).rejects.toMatchObject({
      code: "hub-unavailable",
    });
  });
});
