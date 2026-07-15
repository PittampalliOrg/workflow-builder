import { describe, expect, it, vi } from "vitest";
import {
  PostgresPreviewSourcePromotionExclusivityAdapter,
  previewSourcePromotionAdvisoryKey,
} from "$lib/server/application/adapters/preview-source-promotion-exclusivity";
import type {
  ImmutableGitSha,
  PreviewSourcePromotionReceiptScope,
} from "$lib/server/application/ports";
import { PreviewSourcePromotionExclusivityBusyError } from "$lib/server/application/ports";

const scope: PreviewSourcePromotionReceiptScope = {
  previewName: "preview-one",
  requestId: "request-1",
  executionId: "execution-1",
  platformRevision: "a".repeat(40) as ImmutableGitSha,
  sourceRevision: "b".repeat(40) as ImmutableGitSha,
  catalogDigest: `sha256:${"c".repeat(64)}`,
  repository: "PittampalliOrg/workflow-builder",
  baseBranch: "main",
};

function client(acquisitions: boolean[]) {
  const unsafe = vi.fn(async (query: string) => {
    if (query.includes("pg_try_advisory_xact_lock")) {
      return [{ acquired: acquisitions.shift() ?? false }];
    }
    return [];
  });
  const begin = vi.fn(
    async <T>(
      operation: (transaction: { unsafe: typeof unsafe }) => Promise<T>,
    ) => operation({ unsafe }),
  );
  return { begin, unsafe };
}

describe("PostgresPreviewSourcePromotionExclusivityAdapter", () => {
  it("polls with transaction-scoped locks and runs inside the acquired transaction", async () => {
    const lockClient = client([false, true]);
    const sleep = vi.fn(async () => undefined);
    const adapter = new PostgresPreviewSourcePromotionExclusivityAdapter(
      lockClient as never,
      { sleep, pollMs: 25 },
    );
    const operation = vi.fn(async () => "done");

    await expect(adapter.runExclusive(scope, operation)).resolves.toBe("done");
    expect(lockClient.begin).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(lockClient.unsafe).toHaveBeenCalledWith(
      "select pg_try_advisory_xact_lock($1::bigint) as acquired",
      [previewSourcePromotionAdvisoryKey(scope)],
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(
      lockClient.unsafe.mock.calls.some(([query]) =>
        String(query).includes("pg_advisory_unlock"),
      ),
    ).toBe(false);
  });

  it("lets transaction rollback release the lock when the operation fails", async () => {
    const lockClient = client([true]);
    const adapter = new PostgresPreviewSourcePromotionExclusivityAdapter(
      lockClient as never,
    );

    await expect(
      adapter.runExclusive(scope, async () => {
        throw new Error("materialization failed");
      }),
    ).rejects.toThrow("materialization failed");
    expect(lockClient.begin).toHaveBeenCalledOnce();
    expect(lockClient.unsafe).toHaveBeenCalledOnce();
  });

  it("returns a typed retryable error when the lock stays busy", async () => {
    const lockClient = client([false]);
    const now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(25);
    const adapter = new PostgresPreviewSourcePromotionExclusivityAdapter(
      lockClient as never,
      { now, timeoutMs: 25, pollMs: 25 },
    );

    await expect(
      adapter.runExclusive(scope, async () => "unreachable"),
    ).rejects.toBeInstanceOf(PreviewSourcePromotionExclusivityBusyError);
  });

  it("uses a stable signed 64-bit key for the complete PR scope", () => {
    const first = previewSourcePromotionAdvisoryKey(scope);
    expect(first).toMatch(/^-?[0-9]+$/);
    expect(BigInt(first)).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(BigInt(first)).toBeLessThan(1n << 63n);
    expect(previewSourcePromotionAdvisoryKey({ ...scope })).toBe(first);
    expect(
      previewSourcePromotionAdvisoryKey({
        ...scope,
        executionId: "execution-2",
      }),
    ).not.toBe(first);
  });
});
