import { describe, expect, it, vi } from "vitest";
import {
  HmacPreviewAcceptedImageReceiptAttestationAdapter,
  PostgresPreviewAcceptedImageReceiptStore,
} from "$lib/server/application/adapters/preview-accepted-images";
import type {
  PreviewAcceptedImageReceiptInput,
  PreviewAcceptedImageSubject,
} from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;
const ATTESTATION_ROOT = "1".repeat(64);

function subject(
  name: string,
  digestCharacter: string,
): PreviewAcceptedImageSubject {
  const digest = `sha256:${digestCharacter.repeat(64)}` as const;
  return {
    subject: name,
    sourceRevision: HEAD_SHA as never,
    buildRun: `preview-accept-${name}`,
    imageRef: `ghcr.io/pittampalliorg/${name}:git-${HEAD_SHA}`,
    digest,
    immutableRef: `ghcr.io/pittampalliorg/${name}@${digest}`,
  };
}

function input(
  subjects: readonly PreviewAcceptedImageSubject[] = [
    subject("workflow-orchestrator", "d"),
    subject("workflow-builder", "e"),
  ],
): PreviewAcceptedImageReceiptInput {
  return {
    repository: "PittampalliOrg/workflow-builder",
    pullRequestNumber: 42,
    baseSha: BASE_SHA as never,
    headSha: HEAD_SHA as never,
    catalogDigest: CATALOG_DIGEST,
    context: "preview/immutable-acceptance",
    subjects,
  };
}

function databaseHarness() {
  let row: Record<string, unknown> | null = null;
  const database = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [row] : []) }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (row) return [];
            row = { ...values, createdAt: new Date("2026-07-10T12:00:00Z") };
            return [{ receiptDigest: values.receiptDigest }];
          },
        }),
      }),
    })),
  };
  return {
    database,
    row: () => row,
    tamper: (changes: Record<string, unknown>) => {
      if (!row) throw new Error("no receipt row to tamper");
      row = { ...row, ...changes };
    },
  };
}

function receiptStore(
  database: ReturnType<typeof databaseHarness>["database"],
) {
  return new PostgresPreviewAcceptedImageReceiptStore(
    database as never,
    new HmacPreviewAcceptedImageReceiptAttestationAdapter(
      () => ATTESTATION_ROOT,
    ),
  );
}

describe("PostgresPreviewAcceptedImageReceiptStore", () => {
  it("stores canonical broker-attested evidence and accepts reordered retries", async () => {
    const db = databaseHarness();
    const store = receiptStore(db.database);
    const first = await store.put(input());
    const second = await store.put(input([...input().subjects].reverse()));

    expect(first).toEqual(second);
    expect(first.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.attestation).toMatch(/^v1\.[0-9a-f]{64}$/);
    expect(first.createdAt).toBe("2026-07-10T12:00:00.000Z");
    expect(first.subjects.map(({ subject }) => subject)).toEqual([
      "workflow-builder",
      "workflow-orchestrator",
    ]);
    expect(db.database.insert).toHaveBeenCalledOnce();
  });

  it("rejects different evidence for the same exact tuple and context", async () => {
    const db = databaseHarness();
    const store = receiptStore(db.database);
    await store.put(input());

    await expect(
      store.put(
        input([
          subject("workflow-orchestrator", "d"),
          subject("workflow-builder", "f"),
        ]),
      ),
    ).rejects.toThrow("replayed with different content");
    expect(db.database.insert).toHaveBeenCalledOnce();
  });

  it("fails closed on duplicate, stale-head, mutable, or inconsistent subjects", async () => {
    const db = databaseHarness();
    const store = receiptStore(db.database);
    const valid = subject("workflow-builder", "d");

    await expect(store.put(input([valid, valid]))).rejects.toThrow(
      "repeats subject",
    );
    await expect(
      store.put(input([{ ...valid, sourceRevision: BASE_SHA as never }])),
    ).rejects.toThrow("subject identity");
    await expect(
      store.put(
        input([
          {
            ...valid,
            imageRef: "ghcr.io/pittampalliorg/workflow-builder:latest",
          },
        ]),
      ),
    ).rejects.toThrow("exact PR head");
    await expect(
      store.put(
        input([
          {
            ...valid,
            immutableRef: `ghcr.io/pittampalliorg/other@${valid.digest}`,
          },
        ]),
      ),
    ).rejects.toThrow("inconsistent immutable metadata");
    expect(db.database.insert).not.toHaveBeenCalled();
  });

  it("rejects forged database evidence without the broker HMAC", async () => {
    const db = databaseHarness();
    const store = receiptStore(db.database);
    await store.put(input());
    db.tamper({ attestation: `v1.${"0".repeat(64)}` });

    await expect(
      store.getByRepoPrHeadContext({
        repository: "PittampalliOrg/workflow-builder",
        pullRequestNumber: 42,
        baseSha: BASE_SHA as never,
        headSha: HEAD_SHA as never,
        context: "preview/immutable-acceptance",
      }),
    ).rejects.toThrow("attestation is invalid");
  });
});
