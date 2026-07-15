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
});
