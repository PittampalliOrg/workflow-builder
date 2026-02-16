/**
 * ETag-based optimistic concurrency retry utility.
 * Mirrors Python components.py:260-288 retry pattern.
 */

/**
 * Execute a state mutation with optimistic concurrency.
 * On ETag mismatch, retries with jittered exponential backoff.
 *
 * @param operation - Async function that performs load-modify-save with ETag
 * @param maxAttempts - Maximum retry attempts (default: 10)
 */
export async function withEtagRetry(
  operation: () => Promise<void>,
  maxAttempts: number = 10,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error(
          `[etag-retry] Failed after ${maxAttempts} attempts:`,
          err,
        );
        throw err;
      }
      const delay =
        Math.min(0.25 * attempt, 1.0) * (1 + Math.random() * 0.25);
      console.warn(
        `[etag-retry] Conflict on attempt ${attempt}/${maxAttempts}, retrying in ${delay.toFixed(2)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
}
