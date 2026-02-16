/**
 * Tests for ETag-based optimistic concurrency retry utility.
 */
import { describe, it, expect, vi } from "vitest";
import { withEtagRetry } from "../src/state/etag-retry.js";

describe("withEtagRetry", () => {
  it("should succeed on first attempt", async () => {
    const operation = vi.fn().mockResolvedValue(undefined);
    await withEtagRetry(operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETag mismatch"))
      .mockRejectedValueOnce(new Error("ETag mismatch"))
      .mockResolvedValue(undefined);

    await withEtagRetry(operation, 5);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should throw after max attempts exhausted", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new Error("ETag mismatch"));

    await expect(withEtagRetry(operation, 3)).rejects.toThrow(
      "ETag mismatch",
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should respect max attempts parameter", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(new Error("conflict"));

    await expect(withEtagRetry(operation, 2)).rejects.toThrow("conflict");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("should apply jittered backoff between retries", async () => {
    const start = Date.now();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValue(undefined);

    await withEtagRetry(operation, 3);
    const elapsed = Date.now() - start;
    // First retry delay is ~0.25s * (1 + random*0.25) = 0.25-0.3125s
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
