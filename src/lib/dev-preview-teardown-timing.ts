/**
 * SEA proves an ordinary preview deletion synchronously. Its two longest
 * bounded waits are restored Service endpoints (30s) and Sandbox CR removal
 * (30s), so one BFF attempt must outlive both plus control-plane overhead.
 */
export const DEV_PREVIEW_DELETE_ATTEMPT_TIMEOUT_MS = 75_000;
export const DEV_PREVIEW_DELETE_MAX_ATTEMPTS = 3;

/**
 * The browser owns the end-to-end retry loop. Keep its default deadline beyond
 * a complete BFF receipt-retry window, with one attempt-sized convergence
 * margin for the checkpoint and asynchronous response-path cleanup.
 */
export const DEV_ENVIRONMENT_TEARDOWN_TIMEOUT_MS =
  (DEV_PREVIEW_DELETE_MAX_ATTEMPTS + 1) *
  DEV_PREVIEW_DELETE_ATTEMPT_TIMEOUT_MS;
