import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewRuntimeBudgetLimits } from "$lib/server/application/ports";
import {
  PostgresPreviewRuntimeBudgetCleanupAdapter,
  PostgresPreviewRuntimeBudgetReservationAdapter,
} from "$lib/server/application/adapters/preview-runtime-budget";
import { ApplicationPreviewRuntimeBrokerService } from "$lib/server/application/preview-runtime-broker";
import { createPgliteDb } from "$lib/server/db/pglite-compat";

const identity = Object.freeze({
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
});

const generous: PreviewRuntimeBudgetLimits = Object.freeze({
  requestsPerMinute: 100,
  reservedTokensPerMinute: 100_000,
  totalRequests: 1_000,
  totalReservedTokens: 1_000_000,
});

type TestDb = ReturnType<typeof createPgliteDb>["db"];

async function freshDb(): Promise<TestDb> {
  const { db } = createPgliteDb();
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0103_preview_runtime_budgets.sql"),
    "utf8",
  );
  await db.execute(sql.raw(migration));
  return db;
}

describe("Postgres preview runtime budget reservation", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("atomically denies one of two replicas at the minute request cap", async () => {
    const limits = { ...generous, requestsPerMinute: 1 };
    const replicaA = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const replicaB = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const results = await Promise.all([
      replicaA.reserve({ identity, reservedTokens: 100, limits }),
      replicaB.reserve({ identity, reservedTokens: 100, limits }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const denied = results.find((result) => !result.ok);
    expect(denied).toMatchObject({
      ok: false,
      reason: "minute-request-limit",
      retryAfterSeconds: expect.any(Number),
    });
    expect(denied?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("enforces minute and lifetime reserved-token caps", async () => {
    const adapter = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const minuteLimits = { ...generous, reservedTokensPerMinute: 500 };
    await expect(
      adapter.reserve({ identity, reservedTokens: 400, limits: minuteLimits }),
    ).resolves.toMatchObject({ ok: true });
    const minuteDenied = await adapter.reserve({
      identity,
      reservedTokens: 101,
      limits: minuteLimits,
    });
    expect(minuteDenied).toMatchObject({
      ok: false,
      reason: "minute-token-limit",
      retryAfterSeconds: expect.any(Number),
    });
    if (minuteDenied.ok) throw new Error("expected minute budget denial");
    expect(minuteDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(minuteDenied.retryAfterSeconds).toBeLessThanOrEqual(60);

    const totalIdentity = {
      ...identity,
      environmentRequestId: "request-total",
    };
    const totalLimits = {
      ...generous,
      reservedTokensPerMinute: 1_000,
      totalReservedTokens: 500,
    };
    await adapter.reserve({
      identity: totalIdentity,
      reservedTokens: 400,
      limits: totalLimits,
    });
    await db.execute(sql`
      UPDATE preview_runtime_budgets
      SET minute_started_at = now() - interval '2 minutes'
      WHERE environment_request_id = ${totalIdentity.environmentRequestId}
    `);
    await expect(
      adapter.reserve({
        identity: totalIdentity,
        reservedTokens: 101,
        limits: totalLimits,
      }),
    ).resolves.toEqual({ ok: false, reason: "total-token-limit" });
  });

  it("enforces lifetime request caps even after the minute resets", async () => {
    const adapter = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const limits = { ...generous, totalRequests: 1 };
    await adapter.reserve({ identity, reservedTokens: 100, limits });
    await db.execute(sql`
      UPDATE preview_runtime_budgets
      SET minute_started_at = now() - interval '2 minutes'
      WHERE environment_request_id = ${identity.environmentRequestId}
    `);
    await expect(
      adapter.reserve({ identity, reservedTokens: 100, limits }),
    ).resolves.toEqual({ ok: false, reason: "total-request-limit" });
  });

  it("keys budgets by every field of the exact preview identity", async () => {
    const adapter = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const limits = { ...generous, requestsPerMinute: 1 };
    await expect(
      adapter.reserve({ identity, reservedTokens: 100, limits }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      adapter.reserve({
        identity: {
          ...identity,
          environmentSourceRevision: "d".repeat(40),
        },
        reservedTokens: 100,
        limits,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("idempotently closes an exact identity and blocks late reservations", async () => {
    const reservations = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const cleanup = new PostgresPreviewRuntimeBudgetCleanupAdapter(db);
    await reservations.reserve({
      identity,
      reservedTokens: 100,
      limits: generous,
    });
    const closeInput = { identity, retentionHours: 192 };
    await cleanup.close(closeInput);
    await cleanup.close(closeInput);
    await expect(
      reservations.reserve({
        identity,
        reservedTokens: 100,
        limits: generous,
      }),
    ).resolves.toEqual({ ok: false, reason: "identity-closed" });

    await expect(
      reservations.reserve({
        identity: { ...identity, environmentRequestId: "request-2" },
        reservedTokens: 100,
        limits: generous,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("creates a tombstone for an unused identity and prunes expiry in bounded batches", async () => {
    const reservations = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const cleanup = new PostgresPreviewRuntimeBudgetCleanupAdapter(db);
    const second = { ...identity, environmentRequestId: "request-2" };
    await cleanup.close({ identity, retentionHours: 192 });
    await cleanup.close({ identity: second, retentionHours: 192 });
    await expect(
      reservations.reserve({ identity, reservedTokens: 100, limits: generous }),
    ).resolves.toEqual({ ok: false, reason: "identity-closed" });

    await db.execute(sql`
      UPDATE preview_runtime_budgets
      SET closed_at = now() - interval '2 hours',
          delete_after = now() - interval '1 hour'
      WHERE closed_at IS NOT NULL
    `);
    await expect(cleanup.pruneExpired(1)).resolves.toBe(1);
    await expect(cleanup.pruneExpired(1)).resolves.toBe(1);
    await expect(cleanup.pruneExpired(1)).resolves.toBe(0);
  });

  it("leaves the identity closed when teardown races a final reservation", async () => {
    const reservations = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const cleanup = new PostgresPreviewRuntimeBudgetCleanupAdapter(db);
    await Promise.all([
      reservations.reserve({
        identity,
        reservedTokens: 100,
        limits: generous,
      }),
      cleanup.close({ identity, retentionHours: 192 }),
    ]);
    await expect(
      reservations.reserve({ identity, reservedTokens: 100, limits: generous }),
    ).resolves.toEqual({ ok: false, reason: "identity-closed" });
  });

  it("charges a conservative input bound so a huge valid prompt consumes the shared budget", async () => {
    const adapter = new PostgresPreviewRuntimeBudgetReservationAdapter(db);
    const upstream = {
      complete: vi.fn(async () => ({
        status: 200,
        contentType: "application/json",
        requestId: null,
        body: null,
      })),
    };
    const service = new ApplicationPreviewRuntimeBrokerService({
      authority: {
        authorizeRuntimeTuple: vi.fn(async () => ({
          previewName: identity.previewName,
          requestId: identity.environmentRequestId,
          owner: "admin-1",
          platformRevision: identity.environmentPlatformRevision as never,
          sourceRevision: identity.environmentSourceRevision as never,
          catalogDigest: identity.catalogDigest,
          services: ["workflow-builder"],
        })),
      },
      capabilities: { verify: () => true },
      upstream,
      budget: adapter,
      budgetLimits: {
        requestsPerMinute: 10,
        reservedTokensPerMinute: 7_000,
        totalRequests: 10,
        totalReservedTokens: 20_000,
      },
      requestLimits: {
        maxPayloadBytes: 8_000,
        maxMessages: 4,
        maxContentBytes: 6_000,
        maxTools: 2,
        maxToolBytes: 2_000,
        maxCompletionTokens: 128,
        defaultCompletionTokens: 128,
      },
      allowedModels: ["deepseek-v4-pro"],
      maxConcurrency: 2,
    });
    const huge = {
      identity,
      capability: "d".repeat(64),
      payload: {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "x".repeat(4_000) }],
      },
    };
    await expect(service.complete(huge)).resolves.toMatchObject({
      status: 200,
    });
    await expect(service.complete(huge)).rejects.toMatchObject({
      code: "budget-exhausted",
      budgetReason: "minute-token-limit",
    });
    expect(upstream.complete).toHaveBeenCalledOnce();
  });
});
