import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewTeardownService,
  PreviewTeardownRefusedError,
} from "$lib/server/application/preview-teardown";
import type {
  PreviewAccessPolicyPort,
  PreviewArchivePort,
  VclusterPreviewGatewayPort,
  VclusterPreviewRuntimeSnapshot,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

const NOW = "2026-07-11T12:00:00.000Z";
const SOURCE_REVISION = "b".repeat(40);

function record(
  overrides: Partial<VclusterPreviewRecord> = {},
): VclusterPreviewRecord {
  return {
    name: "failed-five",
    phase: "failed",
    ready: false,
    url: null,
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "retained",
    origin: { kind: "user" },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: "2026-07-11T15:51:11+00:00",
    lastActive: null,
    protected: false,
    bootSeconds: null,
    platformRevision: "a".repeat(40),
    sourceRevision: SOURCE_REVISION,
    profile: "app-live",
    lane: "application",
    mode: "live",
    owner: { kind: "user", id: "owner-1" },
    services: ["function-router", "workflow-builder"],
    provenance: {
      requestId: "request-exact",
      requestedAt: "2026-07-11T11:00:00.000Z",
    },
    trustedCode: true,
    allocation: { kind: "cold" },
    images: {},
    catalogDigest: `sha256:${"c".repeat(64)}`,
    ...overrides,
  };
}

function harness(
  overrides: Readonly<{
    preview?: VclusterPreviewRecord;
    archiveOnTeardownEnabled?: boolean;
    archiveResult?: {
      archived: boolean;
      preview: string;
      reason?: string;
      summaryFileId?: string;
    };
    runtime?: Awaited<ReturnType<VclusterPreviewGatewayPort["runtime"]>>;
  }> = {},
) {
  const authoritative = overrides.preview ?? record();
  const events: string[] = [];
  const access: PreviewAccessPolicyPort = {
    authorize: vi.fn(async () => ({
      preview: authoritative,
      ownerId: authoritative.owner?.id ?? "",
      actorIsOwner: true,
      actorIsPlatformAdmin: false,
    })),
  };
  const archive: PreviewArchivePort = {
    archivePreview: vi.fn(async () => {
      events.push("archive");
      return (
        overrides.archiveResult ?? {
          archived: true,
          preview: authoritative.name,
          summaryFileId: "summary-complete",
        }
      );
    }),
    quarantinePreview: vi.fn(async () => {
      events.push("quarantine");
      return {
        archived: false,
        quarantined: true,
        preview: authoritative.name,
        reason: "forced-quarantine",
        summaryFileId: "summary-quarantine",
      };
    }),
  };
  const runtime = overrides.runtime ?? {
    name: authoritative.name,
    resourceName: authoritative.name,
    reconciliationSucceeded: false,
    upJob:
      authoritative.phase === "provisioning"
        ? {
            name: `vcpreview-up-${authoritative.name}`,
            found: false,
            active: false,
            succeeded: false,
            failed: false,
          }
        : {
            name: `vcpreview-up-${authoritative.name}`,
            found: true,
            active: false,
            succeeded: false,
            failed: true,
          },
    services: (authoritative.services ?? []).map((service) => ({
      service,
      containers: [],
    })),
  };
  const previews = {
    listWithCounts: vi.fn(),
    get: vi.fn(),
    provision: vi.fn(),
    teardown: vi.fn(async (name: string) => {
      events.push("teardown");
      return record({ ...authoritative, name, phase: "terminating" });
    }),
    runtime: vi.fn(async () => {
      events.push("runtime");
      return runtime;
    }),
    cleanup: vi.fn(),
    touch: vi.fn(),
    sleep: vi.fn(),
  } as unknown as VclusterPreviewGatewayPort;
  return {
    access,
    archive,
    previews,
    events,
    service: new ApplicationPreviewTeardownService({
      access,
      archive,
      previews,
      archiveOnTeardownEnabled: overrides.archiveOnTeardownEnabled ?? false,
      now: () => new Date(NOW),
    }),
  };
}

describe("ApplicationPreviewTeardownService", () => {
  it("archives a normal mutable preview before exact guarded teardown", async () => {
    const h = harness({
      preview: record({ phase: "ready", ready: true, url: "https://preview" }),
    });

    await expect(
      h.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        projectId: "project-1",
      }),
    ).resolves.toMatchObject({
      archive: { archived: true, summaryFileId: "summary-complete" },
      preview: { phase: "terminating" },
    });

    expect(h.events).toEqual(["archive", "teardown"]);
    expect(h.archive.archivePreview).toHaveBeenCalledWith({
      name: "failed-five",
      userId: "owner-1",
      projectId: "project-1",
    });
    expect(h.previews.teardown).toHaveBeenCalledWith("failed-five", {
      mode: "owned",
      requestId: "request-exact",
      sourceRevision: SOURCE_REVISION,
      archiveConfirmed: true,
    });
  });

  it("refuses a normal mutable teardown when the archive is incomplete", async () => {
    const h = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "executions-unreachable",
      },
    });

    await expect(
      h.service.teardown({ name: "failed-five", actorUserId: "owner-1" }),
    ).rejects.toMatchObject({
      name: "PreviewTeardownRefusedError",
      code: "archive-required",
      status: 409,
    });
    expect(h.events).toEqual(["archive"]);
    expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
    expect(h.previews.teardown).not.toHaveBeenCalled();
  });

  it("persists explicit failed-launch loss accounting before forced teardown", async () => {
    const h = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "executions-unreachable",
      },
    });

    await expect(
      h.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        projectId: "project-1",
        forceFailed: true,
      }),
    ).resolves.toMatchObject({
      archive: { quarantined: true, summaryFileId: "summary-quarantine" },
    });

    expect(h.events).toEqual(["archive", "runtime", "quarantine", "teardown"]);
    expect(h.archive.quarantinePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          name: "failed-five",
          pool: null,
          url: null,
          expiresAt: "2026-07-11T15:51:11+00:00",
        }),
        userId: "owner-1",
        projectId: "project-1",
        forcedAt: NOW,
        graceExpiredAt: NOW,
        reason: expect.stringContaining(
          "archive incomplete; forced failed-launch cleanup: executions-unreachable",
        ),
        attemptedArchive: expect.objectContaining({ archived: false }),
      }),
    );
    expect(h.previews.teardown).toHaveBeenCalledWith("failed-five", {
      mode: "owned",
      requestId: "request-exact",
      sourceRevision: SOURCE_REVISION,
      archiveConfirmed: true,
      archiveQuarantine: {
        forcedAt: NOW,
        graceExpiredAt: NOW,
        reason:
          "archive incomplete; forced failed-launch cleanup: executions-unreachable",
        summaryFileId: "summary-quarantine",
      },
    });
  });

  it("allows explicit failed-launch quarantine when the archive call throws", async () => {
    const h = harness();
    vi.mocked(h.archive.archivePreview).mockImplementationOnce(async () => {
      h.events.push("archive");
      throw new Error("preview unreachable");
    });

    await expect(
      h.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).resolves.toMatchObject({ archive: { quarantined: true } });
    expect(h.events).toEqual(["archive", "runtime", "quarantine", "teardown"]);
    expect(h.archive.quarantinePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptedArchive: null,
        reason: expect.stringContaining(
          "archive incomplete; forced failed-launch cleanup",
        ),
      }),
    );
  });

  it.each([
    ["ready state", { ready: true }],
    ["nonfailed phase", { phase: "terminating" }],
    ["active boot receipt", { bootSeconds: 12 }],
    ["untrusted code", { trustedCode: false }],
    ["pool member", { pool: "warm-1" }],
    ["missing expiry", { expiresAt: null }],
    ["malformed expiry", { expiresAt: "not-an-instant" }],
  ] satisfies Array<[string, Partial<VclusterPreviewRecord>]>)(
    "rejects forced cleanup for an ineligible %s preview",
    async (_label, patch) => {
      const h = harness({
        preview: record(patch),
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-ineligible",
        status: 409,
      });
      expect(h.previews.runtime).not.toHaveBeenCalled();
      expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it("allows a stale provisioning receipt with a deterministic URL", async () => {
    const h = harness({
      preview: record({
        phase: "provisioning",
        url: "https://failed-five.example.test",
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-07-11T11:30:00.000Z",
        },
      }),
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
    });

    await expect(
      h.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).resolves.toMatchObject({ archive: { quarantined: true } });
    expect(h.events).toEqual(["archive", "runtime", "quarantine", "teardown"]);
  });

  it("rejects a fresh provisioning receipt", async () => {
    const h = harness({
      preview: record({
        phase: "provisioning",
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-07-11T11:30:00.001Z",
        },
      }),
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
    });

    await expect(
      h.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).rejects.toMatchObject({
      code: "failed-quarantine-ineligible",
      status: 409,
    });
    expect(h.previews.runtime).not.toHaveBeenCalled();
    expect(h.previews.teardown).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-an-instant"])(
    "rejects provisioning with missing or invalid requestedAt (%s)",
    async (requestedAt) => {
      const h = harness({
        preview: record({
          phase: "provisioning",
          provenance: {
            requestId: "request-exact",
            ...(requestedAt === undefined ? {} : { requestedAt }),
          },
        }),
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-ineligible",
        status: 409,
      });
      expect(h.previews.runtime).not.toHaveBeenCalled();
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing requestedAt", { provenance: { requestId: "request-exact" } }],
    [
      "impossible requestedAt date",
      {
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-02-30T11:00:00.000Z",
        },
      },
    ],
    [
      "offset requestedAt",
      {
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-07-11T11:00:00.000+00:00",
        },
      },
    ],
    [
      "future requestedAt",
      {
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-07-11T12:00:00.001Z",
        },
      },
    ],
    ["impossible expiry date", { expiresAt: "2026-02-30T15:51:11+00:00" }],
  ] satisfies Array<[string, Partial<VclusterPreviewRecord>]>)(
    "rejects forced cleanup for %s",
    async (_label, patch) => {
      const h = harness({
        preview: record(patch),
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-ineligible",
        status: 409,
      });
      expect(h.previews.runtime).not.toHaveBeenCalled();
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["reconciliation succeeded", { reconciliationSucceeded: true }],
    [
      "service set differs",
      { services: [{ service: "workflow-builder", containers: [] }] },
    ],
    [
      "duplicate runtime services",
      {
        services: [
          { service: "workflow-builder", containers: [] },
          { service: "workflow-builder", containers: [] },
        ],
      },
    ],
    ["name differs", { name: "another-preview" }],
    ["resource identity differs", { resourceName: "another-preview" }],
    [
      "up Job identity differs",
      {
        upJob: {
          name: "vcpreview-up-another-preview",
          found: true,
          active: false,
          succeeded: false,
          failed: true,
        },
      },
    ],
    [
      "a container is observed",
      {
        services: [
          {
            service: "function-router",
            containers: [
              { pod: "pod-1", image: "image", imageId: null, ready: false },
            ],
          },
          { service: "workflow-builder", containers: [] },
        ],
      },
    ],
  ] satisfies Array<[string, Partial<VclusterPreviewRuntimeSnapshot>]>)(
    "rejects forced cleanup when runtime proof %s",
    async (_label, patch) => {
      const baseRuntime: VclusterPreviewRuntimeSnapshot = {
        name: "failed-five",
        resourceName: "failed-five",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-failed-five",
          found: true,
          active: false,
          succeeded: false,
          failed: true,
        },
        services: [
          { service: "function-router", containers: [] },
          { service: "workflow-builder", containers: [] },
        ],
      };
      const h = harness({
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
        runtime: { ...baseRuntime, ...patch },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-runtime-mismatch",
        status: 409,
      });
      expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it("rejects missing runtime identity and runtime read failure", async () => {
    const missing = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
      runtime: {
        resourceName: "failed-five",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-failed-five",
          found: true,
          active: false,
          succeeded: false,
          failed: true,
        },
        services: [
          { service: "function-router", containers: [] },
          { service: "workflow-builder", containers: [] },
        ],
      } as never,
    });
    await expect(
      missing.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).rejects.toMatchObject({
      code: "failed-quarantine-runtime-mismatch",
      status: 409,
    });

    const unavailable = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
    });
    vi.mocked(unavailable.previews.runtime).mockRejectedValueOnce(
      new Error("SEA unavailable"),
    );
    await expect(
      unavailable.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).rejects.toMatchObject({
      code: "failed-quarantine-runtime-unavailable",
      status: 409,
    });
    expect(unavailable.archive.quarantinePreview).not.toHaveBeenCalled();
    expect(unavailable.previews.teardown).not.toHaveBeenCalled();
  });

  it.each([
    [
      "not found",
      { found: false, active: false, succeeded: false, failed: false },
    ],
    [
      "still active",
      { found: true, active: true, succeeded: false, failed: true },
    ],
    [
      "succeeded",
      { found: true, active: false, succeeded: true, failed: false },
    ],
    [
      "conflicting terminal state",
      { found: true, active: false, succeeded: true, failed: true },
    ],
    [
      "not failed",
      { found: true, active: false, succeeded: false, failed: false },
    ],
  ] as const)(
    "rejects failed phase when up Job is %s",
    async (_label, jobState) => {
      const h = harness({
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
        runtime: {
          name: "failed-five",
          resourceName: "failed-five",
          reconciliationSucceeded: false,
          upJob: { name: "vcpreview-up-failed-five", ...jobState },
          services: [
            { service: "function-router", containers: [] },
            { service: "workflow-builder", containers: [] },
          ],
        },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-runtime-mismatch",
        status: 409,
      });
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "present pending",
      { found: true, active: false, succeeded: false, failed: false },
    ],
    ["active", { found: true, active: true, succeeded: false, failed: false }],
    [
      "succeeded",
      { found: true, active: false, succeeded: true, failed: false },
    ],
    ["failed", { found: true, active: false, succeeded: false, failed: true }],
    [
      "absent conflict",
      { found: false, active: false, succeeded: false, failed: true },
    ],
  ] as const)(
    "rejects stale provisioning when up Job is %s",
    async (_label, jobState) => {
      const preview = record({
        phase: "provisioning",
        provenance: {
          requestId: "request-exact",
          requestedAt: "2026-07-11T11:30:00.000Z",
        },
      });
      const h = harness({
        preview,
        archiveResult: {
          archived: false,
          preview: "failed-five",
          reason: "incomplete",
        },
        runtime: {
          name: "failed-five",
          resourceName: "failed-five",
          reconciliationSucceeded: false,
          upJob: { name: "vcpreview-up-failed-five", ...jobState },
          services: [
            { service: "function-router", containers: [] },
            { service: "workflow-builder", containers: [] },
          ],
        },
      });

      await expect(
        h.service.teardown({
          name: "failed-five",
          actorUserId: "owner-1",
          forceFailed: true,
        }),
      ).rejects.toMatchObject({
        code: "failed-quarantine-runtime-mismatch",
        status: 409,
      });
      expect(h.previews.teardown).not.toHaveBeenCalled();
    },
  );

  it("fails closed when quarantine persistence throws or lacks durable proof", async () => {
    const thrown = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
    });
    vi.mocked(thrown.archive.quarantinePreview).mockRejectedValueOnce(
      new Error("files unavailable"),
    );
    await expect(
      thrown.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).rejects.toMatchObject({
      code: "failed-quarantine-persistence-failed",
      status: 409,
    });
    expect(thrown.previews.teardown).not.toHaveBeenCalled();

    const incomplete = harness({
      archiveResult: {
        archived: false,
        preview: "failed-five",
        reason: "incomplete",
      },
    });
    vi.mocked(incomplete.archive.quarantinePreview).mockResolvedValueOnce({
      archived: false,
      quarantined: true,
      preview: "failed-five",
    });
    await expect(
      incomplete.service.teardown({
        name: "failed-five",
        actorUserId: "owner-1",
        forceFailed: true,
      }),
    ).rejects.toBeInstanceOf(PreviewTeardownRefusedError);
    expect(incomplete.previews.teardown).not.toHaveBeenCalled();
  });

  it("rejects an incomplete ownership tuple before archive or teardown", async () => {
    const h = harness({
      preview: record({ provenance: { requestId: "" } }),
    });

    await expect(
      h.service.teardown({ name: "failed-five", actorUserId: "owner-1" }),
    ).rejects.toMatchObject({ code: "ownership-incomplete", status: 409 });
    expect(h.archive.archivePreview).not.toHaveBeenCalled();
    expect(h.previews.teardown).not.toHaveBeenCalled();
  });
});
