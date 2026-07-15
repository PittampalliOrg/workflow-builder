export interface CompletedDevEnvironmentTeardown {
  ok: true;
  complete: true;
  pending: false;
}

export type DevEnvironmentTeardownProgress =
  | "submitting"
  | "reconciling"
  | "pending"
  | "complete";

interface PendingDevEnvironmentTeardown {
  ok: true;
  complete: false;
  pending: true;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

export interface DevEnvironmentTeardownStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingDevEnvironmentTeardownOperation = Readonly<{
  executionId: string;
  discardUncaptured: boolean;
  startedAt: number;
}>;

export interface DevEnvironmentTeardownOptions {
  fetcher?: Fetcher;
  sleep?: Sleeper;
  now?: () => number;
  timeoutMs?: number;
  retryIntervalMs?: number;
  discardUncaptured?: boolean;
  onProgress?: (progress: DevEnvironmentTeardownProgress) => void;
  storage?: DevEnvironmentTeardownStorage | null;
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
const PENDING_STORAGE_KEY = "workflow-builder:pending-dev-environment-teardowns:v1";
const PENDING_TTL_MS = 24 * 60 * 60_000;
const MAX_PENDING_OPERATIONS = 20;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function retryableResponseStatus(status: number): boolean {
  return [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
}

function browserStorage(): DevEnvironmentTeardownStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function validPendingOperation(
  value: unknown,
  now: number,
): value is PendingDevEnvironmentTeardownOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.executionId === "string" &&
    EXECUTION_ID.test(item.executionId) &&
    typeof item.discardUncaptured === "boolean" &&
    typeof item.startedAt === "number" &&
    Number.isFinite(item.startedAt) &&
    item.startedAt >= 0 &&
    item.startedAt <= now + 5 * 60_000 &&
    now - item.startedAt <= PENDING_TTL_MS
  );
}

function readPendingOperations(
  storage: DevEnvironmentTeardownStorage,
  now: number,
): PendingDevEnvironmentTeardownOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(PENDING_STORAGE_KEY) ?? "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  const unique = new Map<string, PendingDevEnvironmentTeardownOperation>();
  for (const value of parsed) {
    if (validPendingOperation(value, now)) unique.set(value.executionId, value);
  }
  return [...unique.values()]
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(-MAX_PENDING_OPERATIONS);
}

function writePendingOperations(
  storage: DevEnvironmentTeardownStorage,
  operations: readonly PendingDevEnvironmentTeardownOperation[],
): void {
  try {
    if (operations.length === 0) storage.removeItem(PENDING_STORAGE_KEY);
    else storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(operations));
  } catch {
    // Browser storage is a recovery hint, never operation authority.
  }
}

function rememberPendingOperation(
  storage: DevEnvironmentTeardownStorage | null,
  executionId: string,
  discardUncaptured: boolean,
  now: number,
): void {
  if (!storage) return;
  const operations = readPendingOperations(storage, now);
  const previous = operations.find((item) => item.executionId === executionId);
  writePendingOperations(storage, [
    ...operations.filter((item) => item.executionId !== executionId),
    {
      executionId,
      discardUncaptured,
      startedAt: previous?.startedAt ?? now,
    },
  ]);
}

function forgetPendingOperation(
  storage: DevEnvironmentTeardownStorage | null,
  executionId: string,
  now: number,
): void {
  if (!storage) return;
  writePendingOperations(
    storage,
    readPendingOperations(storage, now).filter(
      (item) => item.executionId !== executionId,
    ),
  );
}

export function pendingDevEnvironmentTeardowns(
  options: Readonly<{
    storage?: DevEnvironmentTeardownStorage | null;
    now?: () => number;
  }> = {},
): PendingDevEnvironmentTeardownOperation[] {
  const storage = options.storage ?? browserStorage();
  if (!storage) return [];
  const now = (options.now ?? Date.now)();
  const operations = readPendingOperations(storage, now);
  writePendingOperations(storage, operations);
  return operations;
}

function isReceipt(
  value: unknown,
  expected: CompletedDevEnvironmentTeardown | PendingDevEnvironmentTeardown,
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
    "Teardown could not yet be confirmed. Retry to continue the same checkpoint-preserving operation.",
  );
}

function report(
  callback: DevEnvironmentTeardownOptions["onProgress"],
  progress: DevEnvironmentTeardownProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // UI observers cannot change the teardown outcome.
  }
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
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let outcomeUncertain = false;
  const endpoint = `/api/dev-environments/${encodeURIComponent(executionId)}`;
  const url = options.discardUncaptured
    ? `${endpoint}?discardUncaptured=true`
    : endpoint;
  const retry = async (): Promise<void> => {
    const waitMs = Math.min(retryIntervalMs, deadline - now());
    if (waitMs <= 0) throw timeoutError();
    await sleep(waitMs);
  };

  rememberPendingOperation(
    storage,
    executionId,
    options.discardUncaptured === true,
    now(),
  );
  report(options.onProgress, "submitting");

  try {
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
        outcomeUncertain = true;
        report(options.onProgress, "reconciling");
        if (controller.signal.aborted) throw timeoutError();
        await retry();
        continue;
      }

      let receipt: unknown;
      try {
        receipt = await response.json();
      } catch {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          outcomeUncertain = true;
          report(options.onProgress, "reconciling");
          throw timeoutError();
        }
        // The exact DELETE may have completed even when its 200/202 receipt body
        // was truncated. Replay it just like a gateway loss; the operation is
        // idempotent and the execution-bound receipt remains mandatory.
        if (
          response.status === 200 ||
          response.status === 202 ||
          retryableResponseStatus(response.status)
        ) {
          outcomeUncertain = true;
          report(options.onProgress, "reconciling");
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

      if (retryableResponseStatus(response.status)) {
        outcomeUncertain = true;
        report(options.onProgress, "reconciling");
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
        forgetPendingOperation(storage, executionId, now());
        report(options.onProgress, "complete");
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
        if (response.status === 200 || response.status === 202) {
          outcomeUncertain = true;
          report(options.onProgress, "reconciling");
          await retry();
          continue;
        }
        throw new Error(
          `Teardown returned an invalid receipt (${response.status})`,
        );
      }

      outcomeUncertain = true;
      report(options.onProgress, "pending");
      await retry();
    }
  } catch (error) {
    if (!outcomeUncertain) forgetPendingOperation(storage, executionId, now());
    throw error;
  }
}
