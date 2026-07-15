export interface CompletedDevEnvironmentTeardown {
  ok: true;
  complete: true;
  pending: false;
}

interface PendingDevEnvironmentTeardown {
  ok: true;
  complete: false;
  pending: true;
}

interface FailedDevEnvironmentTeardown {
  ok: false;
  complete: false;
  pending: boolean;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

export interface DevEnvironmentTeardownOptions {
  fetcher?: Fetcher;
  sleep?: Sleeper;
  now?: () => number;
  timeoutMs?: number;
  retryIntervalMs?: number;
  discardUncaptured?: boolean;
}

export class DevEnvironmentTeardownBlockedError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "DevEnvironmentTeardownBlockedError";
  }
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;

function isReceipt(
  value: unknown,
  expected:
    | CompletedDevEnvironmentTeardown
    | PendingDevEnvironmentTeardown
    | FailedDevEnvironmentTeardown,
  executionId: string,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.executionId === executionId &&
    receipt.ok === expected.ok &&
    receipt.complete === expected.complete &&
    receipt.pending === expected.pending
  );
}

function timeoutError(): Error {
  return new Error(
    "Teardown timed out while waiting for response-path cleanup",
  );
}

function receiptError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.error === "string" && receipt.error.trim()) {
    return receipt.error;
  }
  if (typeof receipt.message === "string" && receipt.message.trim()) {
    return receipt.message;
  }
  return null;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Replays the idempotent product teardown command until the server proves that
 * asynchronous response-path cleanup has converged.
 */
export async function teardownDevEnvironmentUntilComplete(
  executionId: string,
  options: DevEnvironmentTeardownOptions = {},
): Promise<CompletedDevEnvironmentTeardown> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Teardown timeout must be greater than zero");
  }
  if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0) {
    throw new Error("Teardown retry interval must be greater than zero");
  }

  const deadline = now() + timeoutMs;
  const endpoint = `/api/dev-environments/${encodeURIComponent(executionId)}`;
  const url = options.discardUncaptured
    ? `${endpoint}?discardUncaptured=true`
    : endpoint;
  const retry = async (): Promise<void> => {
    const waitMs = Math.min(retryIntervalMs, deadline - now());
    if (waitMs <= 0) throw timeoutError();
    await sleep(waitMs);
  };

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw timeoutError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "DELETE",
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw timeoutError();
      await retry();
      continue;
    }

    let receipt: unknown;
    try {
      receipt = await response.json();
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) throw timeoutError();
      // The exact DELETE may have completed even when its 200/202 receipt body
      // was truncated. Replay it just like a gateway loss; the operation is
      // idempotent and the execution-bound receipt remains mandatory.
      if ([200, 202, 502, 503, 504].includes(response.status)) {
        await retry();
        continue;
      }
      throw new Error(
        `Teardown returned an invalid receipt (${response.status})`,
      );
    }
    clearTimeout(timeout);

    if (response.status === 409) {
      throw new DevEnvironmentTeardownBlockedError(
        receiptError(receipt) ??
          "Teardown was blocked because the latest live-sync changes could not be captured",
      );
    }

    if (response.status === 403) {
      throw new Error(
        receiptError(receipt) ??
          "Platform administrator access is required for preview teardown",
      );
    }

    if (
      response.status === 503 &&
      (isReceipt(
        receipt,
        { ok: false, complete: false, pending: false },
        executionId,
      ) ||
        isReceipt(
          receipt,
          { ok: false, complete: false, pending: true },
          executionId,
        ))
    ) {
      throw new Error("Teardown failed (503)");
    }

    if ([502, 503, 504].includes(response.status)) {
      await retry();
      continue;
    }

    if (
      response.status === 200 &&
      isReceipt(
        receipt,
        { ok: true, complete: true, pending: false },
        executionId,
      )
    ) {
      return { ok: true, complete: true, pending: false };
    }

    if (
      response.status !== 202 ||
      !isReceipt(
        receipt,
        { ok: true, complete: false, pending: true },
        executionId,
      )
    ) {
      throw new Error(
        `Teardown returned an invalid receipt (${response.status})`,
      );
    }

    await retry();
  }
}
