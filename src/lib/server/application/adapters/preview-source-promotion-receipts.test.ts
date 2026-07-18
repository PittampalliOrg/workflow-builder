import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresPreviewSourcePromotionReceiptStore } from "$lib/server/application/adapters/preview-source-promotion-receipts";
import type {
  ImmutableGitSha,
  PreviewSourcePromotionReceiptInput,
  PreviewSourcePromotionReceiptScope,
} from "$lib/server/application/ports";

const PLATFORM = "a".repeat(40) as ImmutableGitSha;
const SOURCE = "b".repeat(40) as ImmutableGitSha;
const HEAD = "c".repeat(40) as ImmutableGitSha;
const LIVE_BASE = "f".repeat(40) as ImmutableGitSha;
const CATALOG = `sha256:${"d".repeat(64)}` as const;

let client: PGlite;
let store: PostgresPreviewSourcePromotionReceiptStore;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE preview_control_artifacts (
      id text PRIMARY KEY,
      preview_name text NOT NULL,
      environment_request_id text NOT NULL,
      execution_id text NOT NULL,
      platform_revision text NOT NULL,
      source_revision text NOT NULL,
      catalog_digest text NOT NULL,
      services jsonb NOT NULL
    );
  `);
  await client.exec(
    readFileSync(
      resolve(process.cwd(), "drizzle/0108_preview_source_promotion_receipts.sql"),
      "utf8",
    ),
  );
  await client.query(
    `INSERT INTO preview_control_artifacts (
      id, preview_name, environment_request_id, execution_id,
      platform_revision, source_revision, catalog_digest, services
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      "central-artifact-1",
      "preview-one",
      "request-1",
      "execution-1",
      PLATFORM,
      SOURCE,
      CATALOG,
      JSON.stringify(["workflow-builder"]),
    ],
  );
  store = new PostgresPreviewSourcePromotionReceiptStore(
    drizzle(client) as never,
  );
});

afterEach(async () => {
  await client.close();
});

function input(
  overrides: Partial<PreviewSourcePromotionReceiptInput> = {},
): PreviewSourcePromotionReceiptInput {
  return {
    artifactId: "central-artifact-1",
    previewName: "preview-one",
    requestId: "request-1",
    executionId: "execution-1",
    platformRevision: PLATFORM,
    sourceRevision: SOURCE,
    catalogDigest: CATALOG,
    repository: "PittampalliOrg/workflow-builder",
    baseBranch: "main",
    baseSha: SOURCE,
    branch: `preview-feature-${"e".repeat(32)}`,
    commitSha: HEAD,
    prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
    pullRequestNumber: 42,
    draft: true,
    services: ["workflow-builder"],
    changedPaths: ["src/routes/feature.ts"],
    ...overrides,
  };
}

function scope(
  overrides: Partial<PreviewSourcePromotionReceiptScope> = {},
): PreviewSourcePromotionReceiptScope {
  return {
    previewName: "preview-one",
    requestId: "request-1",
    executionId: "execution-1",
    platformRevision: PLATFORM,
    sourceRevision: SOURCE,
    catalogDigest: CATALOG,
    repository: "PittampalliOrg/workflow-builder",
    baseBranch: "main",
    ...overrides,
  };
}

describe("PostgresPreviewSourcePromotionReceiptStore", () => {
  it("persists one immutable receipt and scopes opaque lookups to the exact preview", async () => {
    const first = await store.put(input());
    const retry = await store.put(
      input({
        services: ["workflow-builder"],
        changedPaths: ["src/routes/feature.ts"],
      }),
    );

    expect(retry).toEqual(first);
    expect(first.receiptId).toMatch(/^pspr_[0-9a-f]{64}$/);
    await expect(
      store.getScoped({ ...scope(), receiptId: first.receiptId }),
    ).resolves.toEqual(first);
    await expect(
      store.getScoped({
        ...scope({ requestId: "request-other" }),
        receiptId: first.receiptId,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a different GitHub proof replayed for the same artifact", async () => {
    await store.put(input());

    await expect(
      store.put(input({ commitSha: "f".repeat(40) as ImmutableGitSha })),
    ).rejects.toThrow("replayed with different proof");
  });

  it("stores the captured source revision independently from the live PR base", async () => {
    const receipt = await store.put(input({ baseSha: LIVE_BASE }));

    expect(receipt).toMatchObject({
      sourceRevision: SOURCE,
      baseSha: LIVE_BASE,
      commitSha: HEAD,
    });
  });

  it("rejects a receipt whose affected service is outside the imported artifact", async () => {
    await expect(
      store.put(input({ services: ["workflow-orchestrator"] })),
    ).rejects.toThrow("does not match its imported artifact");
  });

  describe("listRecentByPreview", () => {
    /** Seed one artifact + receipt pair directly (listing needs several previews/timestamps). */
    async function seedReceipt(seed: {
      id: string;
      previewName: string;
      executionId: string;
      pullRequestNumber: number;
      createdAt: string;
    }): Promise<void> {
      await client.query(
        `INSERT INTO preview_control_artifacts (
          id, preview_name, environment_request_id, execution_id,
          platform_revision, source_revision, catalog_digest, services
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          `artifact-${seed.id}`,
          seed.previewName,
          "request-1",
          seed.executionId,
          PLATFORM,
          SOURCE,
          CATALOG,
          JSON.stringify(["workflow-builder"]),
        ],
      );
      await client.query(
        `INSERT INTO preview_source_promotion_receipts (
          receipt_id, artifact_id, preview_name, environment_request_id,
          execution_id, platform_revision, source_revision, catalog_digest,
          repository, base_branch, base_sha, branch, commit_sha, pr_url,
          pull_request_number, draft, services, changed_paths, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, true, $16::jsonb, $17::jsonb, $18
        )`,
        [
          `receipt-${seed.id}`,
          `artifact-${seed.id}`,
          seed.previewName,
          "request-1",
          seed.executionId,
          PLATFORM,
          SOURCE,
          CATALOG,
          "PittampalliOrg/workflow-builder",
          "main",
          SOURCE,
          `preview-feature-${seed.id}`,
          HEAD,
          `https://github.com/PittampalliOrg/workflow-builder/pull/${seed.pullRequestNumber}`,
          seed.pullRequestNumber,
          JSON.stringify(["workflow-builder"]),
          JSON.stringify(["src/routes/feature.ts"]),
          seed.createdAt,
        ],
      );
    }

    it("returns newest-first ISO rows scoped to the requested previews", async () => {
      await seedReceipt({
        id: "1",
        previewName: "preview-one",
        executionId: "execution-1",
        pullRequestNumber: 41,
        createdAt: "2026-07-15T10:00:00Z",
      });
      await seedReceipt({
        id: "2",
        previewName: "preview-one",
        executionId: "execution-2",
        pullRequestNumber: 42,
        createdAt: "2026-07-16T10:00:00Z",
      });
      await seedReceipt({
        id: "3",
        previewName: "preview-other",
        executionId: "execution-3",
        pullRequestNumber: 43,
        createdAt: "2026-07-17T10:00:00Z",
      });

      const rows = await store.listRecentByPreview({
        previewNames: ["preview-one", "preview-one", ""],
        limitPerPreview: 10,
      });

      expect(rows.map((row) => row.pullRequestNumber)).toEqual([42, 41]);
      expect(rows[0]).toMatchObject({
        previewName: "preview-one",
        executionId: "execution-2",
        pullRequestNumber: 42,
        prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
        commitSha: HEAD,
      });
      // ISO-8601 strings, newest first (exact instant is timezone-dependent
      // because the column is a naive `timestamp`).
      for (const row of rows) {
        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      }
      expect(Date.parse(rows[0].createdAt)).toBeGreaterThan(
        Date.parse(rows[1].createdAt),
      );
    });

    it("bounds the read and answers an empty name set without a query", async () => {
      await seedReceipt({
        id: "1",
        previewName: "preview-one",
        executionId: "execution-1",
        pullRequestNumber: 41,
        createdAt: "2026-07-15T10:00:00Z",
      });
      await seedReceipt({
        id: "2",
        previewName: "preview-one",
        executionId: "execution-2",
        pullRequestNumber: 42,
        createdAt: "2026-07-16T10:00:00Z",
      });

      await expect(
        store.listRecentByPreview({
          previewNames: ["preview-one"],
          limitPerPreview: 1,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        store.listRecentByPreview({ previewNames: [""], limitPerPreview: 10 }),
      ).resolves.toEqual([]);
    });
  });
});
