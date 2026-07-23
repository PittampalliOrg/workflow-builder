import { describe, expect, it, vi } from "vitest";
import { PreviewWorkspaceGatewayError } from "./ports";
import type { AuthorizedPreviewControlSource } from "./ports";
import { ApplicationPreviewWorkspaceSourceBrokerService } from "./preview-workspace-source-broker";

const SOURCE_REVISION = "b".repeat(40);
const IDENTITY = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: SOURCE_REVISION,
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
};
const SOURCE_PLAN = {
  service: "workflow-builder",
  repository: "PittampalliOrg/workflow-builder",
  repoSubdir: ".",
  syncPaths: ["src", "package.json"],
  stageMappings: [],
  allowedCommands: ["check"],
};
const AUTHORIZED: AuthorizedPreviewControlSource = {
  previewName: IDENTITY.previewName,
  requestId: IDENTITY.environmentRequestId,
  owner: "admin-1",
  platformRevision:
    IDENTITY.environmentPlatformRevision as AuthorizedPreviewControlSource["platformRevision"],
  sourceRevision:
    IDENTITY.environmentSourceRevision as AuthorizedPreviewControlSource["sourceRevision"],
  catalogDigest: IDENTITY.catalogDigest,
  services: ["workflow-builder"],
};
const BUNDLE = new Uint8Array([1, 2, 3, 4]);

function harness() {
  const authorizeRuntime = vi.fn(async () => AUTHORIZED);
  const resolve = vi.fn(() => SOURCE_PLAN);
  const fetchExact = vi.fn(async () => ({
    repository: SOURCE_PLAN.repository,
    sourceRevision: SOURCE_REVISION,
    bundle: BUNDLE,
    bundleSha256: `sha256:${"d".repeat(64)}` as const,
    fileCount: 42,
  }));
  const service = new ApplicationPreviewWorkspaceSourceBrokerService({
    authority: { authorizeRuntime },
    catalog: { resolve },
    git: { fetchExact },
  });
  return { service, authorizeRuntime, resolve, fetchExact };
}

describe("ApplicationPreviewWorkspaceSourceBrokerService", () => {
  it("authorizes the complete tuple and derives repository authority from the catalog", async () => {
    const h = harness();

    await expect(
      h.service.fetchExact({
        identity: IDENTITY,
        service: "workflow-builder",
      }),
    ).resolves.toEqual({
      repository: SOURCE_PLAN.repository,
      sourceRevision: SOURCE_REVISION,
      bundle: BUNDLE,
      bundleSha256: `sha256:${"d".repeat(64)}`,
      fileCount: 42,
    });

    expect(h.authorizeRuntime).toHaveBeenCalledWith({
      ...IDENTITY,
      requiredServices: ["workflow-builder"],
    });
    expect(h.resolve).toHaveBeenCalledWith("workflow-builder");
    expect(h.fetchExact).toHaveBeenCalledWith({
      repository: SOURCE_PLAN.repository,
      sourceRevision: SOURCE_REVISION,
    });
  });

  it("rejects an invalid service before consulting physical authority", async () => {
    const h = harness();

    await expect(
      h.service.fetchExact({
        identity: IDENTITY,
        service: "Workflow-Builder",
      }),
    ).rejects.toMatchObject({
      code: "source-rejected",
      status: 409,
    });
    expect(h.authorizeRuntime).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.fetchExact).not.toHaveBeenCalled();
  });

  it.each([
    ["previewName", "replacement"],
    ["requestId", "request-2"],
    ["platformRevision", "e".repeat(40)],
    ["sourceRevision", "f".repeat(40)],
    ["catalogDigest", `sha256:${"9".repeat(64)}`],
    ["services", ["workflow-builder", "sandbox-execution-api"]],
  ] as const)(
    "fails closed when source authority changes %s",
    async (field, replacement) => {
      const h = harness();
      h.authorizeRuntime.mockResolvedValueOnce({
        ...AUTHORIZED,
        [field]: replacement,
      });

      await expect(
        h.service.fetchExact({
          identity: IDENTITY,
          service: "workflow-builder",
        }),
      ).rejects.toMatchObject({
        code: "source-rejected",
        status: 409,
      });
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.fetchExact).not.toHaveBeenCalled();
    },
  );

  it("rejects a catalog that resolves a different service", async () => {
    const h = harness();
    h.resolve.mockReturnValueOnce({
      ...SOURCE_PLAN,
      service: "sandbox-execution-api",
    });

    await expect(
      h.service.fetchExact({
        identity: IDENTITY,
        service: "workflow-builder",
      }),
    ).rejects.toMatchObject({
      code: "source-rejected",
      status: 409,
    });
    expect(h.fetchExact).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "repository",
      receipt: { repository: "attacker/repo" },
    },
    {
      label: "revision",
      receipt: { sourceRevision: "e".repeat(40) },
    },
    {
      label: "empty bundle",
      receipt: { bundle: new Uint8Array() },
    },
    {
      label: "digest",
      receipt: { bundleSha256: "sha256:not-a-digest" },
    },
    {
      label: "file count",
      receipt: { fileCount: 20_001 },
    },
  ])("rejects an invalid physical $label receipt", async ({ receipt }) => {
    const h = harness();
    h.fetchExact.mockResolvedValueOnce({
      repository: SOURCE_PLAN.repository,
      sourceRevision: SOURCE_REVISION,
      bundle: BUNDLE,
      bundleSha256: `sha256:${"d".repeat(64)}`,
      fileCount: 42,
      ...receipt,
    } as never);

    await expect(
      h.service.fetchExact({
        identity: IDENTITY,
        service: "workflow-builder",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PreviewWorkspaceGatewayError>>({
        code: "helper-invalid-receipt",
        status: 502,
      }),
    );
  });
});
