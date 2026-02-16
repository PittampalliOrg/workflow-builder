/**
 * Workflow retry policy.
 * Mirrors Python WorkflowRetryPolicy.
 */
export interface WorkflowRetryPolicy {
  /** Maximum number of retry attempts. Default: 1. */
  maxAttempts?: number;
  /** Initial backoff interval in seconds. Default: 5. */
  initialBackoffSeconds?: number;
  /** Maximum backoff interval in seconds. Default: 30. */
  maxBackoffSeconds?: number;
  /** Multiplier for exponential backoff. Default: 1.5. */
  backoffMultiplier?: number;
  /** Optional total timeout for all retries in seconds. */
  retryTimeout?: number;
}
