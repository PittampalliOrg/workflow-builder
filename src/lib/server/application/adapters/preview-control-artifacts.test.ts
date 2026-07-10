import { describe, expect, it, vi } from "vitest";
import { PostgresPreviewControlArtifactStore } from "$lib/server/application/adapters/preview-control-artifacts";
import type { PreviewArtifactTransferEnvelope } from "$lib/server/application/ports";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;

function envelope(
  fileDigest = `sha256:${"d".repeat(64)}` as const,
  overrides: Partial<PreviewArtifactTransferEnvelope["identity"]> = {},
) {
  return {
    identity: {
      previewName: "preview-one",
      environmentRequestId: "launch-1",
      environmentPlatformRevision: PLATFORM_SHA,
      environmentSourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
      ...overrides,
    },
    executionId: "execution-1",
    artifactId: "artifact-1",
    fileDigest,
    artifact: {
      id: "artifact-1",
      executionId: "execution-1",
      kind: "source-bundle",
      fileId: "preview-file-1",
      inlinePayload: {
        captureId: "capture-1",
        generation: "generation-1",
      },
      metadata: null,
    },
  } satisfies PreviewArtifactTransferEnvelope;
}

function databaseHarness() {
  let row: Record<string, unknown> | null = null;
  const database = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (row) return [];
            row = { ...values, createdAt: new Date("2026-07-09T20:00:00Z") };
            return [{ id: values.id }];
          },
        }),
      }),
    })),
  };
  return { database, row: () => row };
}

function putInput(
  transferEnvelope = envelope(),
  bytes = Buffer.from("original"),
) {
  return {
    envelope: transferEnvelope,
    bytes,
    ownerId: "admin-1",
    captureId: "capture-1",
    generation: "generation-1",
    services: ["workflow-builder"],
  };
}

describe("PostgresPreviewControlArtifactStore", () => {
  it("keeps the immutable original and creates no blob for a tampered replay", async () => {
    const db = databaseHarness();
    const files = {
      createWorkflowFile: vi.fn(async () => ({
        file: { id: "central-file-1" },
        deduplicated: false,
      })),
      getWorkflowFileContent: vi.fn(),
      deleteWorkflowFile: vi.fn(
        async (_input: { id: string; userId: string }) => true,
      ),
    };
    const store = new PostgresPreviewControlArtifactStore(
      () => files as never,
      db.database as never,
    );
    const original = putInput();

    const stored = await store.put(original);
    const originalRow = structuredClone(db.row());
    await expect(
      store.put(
        putInput(envelope(`sha256:${"e".repeat(64)}`), Buffer.from("tampered")),
      ),
    ).rejects.toThrow("replayed with different content");

    expect(stored.fileDigest).toBe(original.envelope.fileDigest);
    expect(files.createWorkflowFile).toHaveBeenCalledOnce();
    expect(files.deleteWorkflowFile).not.toHaveBeenCalled();
    expect(db.row()).toEqual(originalRow);
  });

  it("rejects cross-preview and cross-request artifact-id reuse before blob read", async () => {
    const db = databaseHarness();
    const files = {
      createWorkflowFile: vi.fn(async () => ({
        file: { id: "central-file-1" },
        deduplicated: false,
      })),
      getWorkflowFileContent: vi.fn(async () => ({
        summary: { id: "central-file-1" },
        bytes: Buffer.from("original"),
      })),
      deleteWorkflowFile: vi.fn(
        async (_input: { id: string; userId: string }) => true,
      ),
    };
    const store = new PostgresPreviewControlArtifactStore(
      () => files as never,
      db.database as never,
    );
    const stored = await store.put(putInput());
    const lookup = { artifactId: stored.id, identity: stored.importIdentity };

    await expect(
      store.get({
        ...lookup,
        identity: { ...lookup.identity, previewName: "preview-two" },
      }),
    ).resolves.toBeNull();
    await expect(
      store.fileDigest({
        ...lookup,
        identity: { ...lookup.identity, requestId: "launch-2" },
        fileId: stored.fileId,
      }),
    ).resolves.toBeNull();
    expect(files.getWorkflowFileContent).not.toHaveBeenCalled();

    await expect(
      store.fileDigest({ ...lookup, fileId: stored.fileId }),
    ).resolves.toBe(
      "sha256:0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
    );
    expect(files.getWorkflowFileContent).toHaveBeenCalledOnce();
  });

  it("compensates the losing blob when conflicting imports race", async () => {
    const db = databaseHarness();
    let createdCount = 0;
    let releaseBoth!: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const files = {
      createWorkflowFile: vi.fn(async () => {
        createdCount += 1;
        const id = `central-file-${createdCount}`;
        if (createdCount === 2) releaseBoth();
        await bothCreated;
        return { file: { id }, deduplicated: false };
      }),
      getWorkflowFileContent: vi.fn(),
      deleteWorkflowFile: vi.fn(
        async (_input: { id: string; userId: string }) => true,
      ),
    };
    const store = new PostgresPreviewControlArtifactStore(
      () => files as never,
      db.database as never,
    );

    const results = await Promise.allSettled([
      store.put(
        putInput(envelope(`sha256:${"1".repeat(64)}`), Buffer.from("one")),
      ),
      store.put(
        putInput(envelope(`sha256:${"2".repeat(64)}`), Buffer.from("two")),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(files.deleteWorkflowFile).toHaveBeenCalledOnce();
    const deletedId = files.deleteWorkflowFile.mock.calls[0]![0].id;
    expect(deletedId).not.toBe(db.row()?.fileId);
  });
});
