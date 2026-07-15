import { createHash } from "node:crypto";
import postgres from "postgres";
import { env } from "$env/dynamic/private";
import type {
  PreviewSourcePromotionExclusivityPort,
  PreviewSourcePromotionReceiptScope,
} from "$lib/server/application/ports";
import { PreviewSourcePromotionExclusivityBusyError } from "$lib/server/application/ports";

type PostgresClient = ReturnType<typeof postgres>;

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 200;
const LOCK_POOL_SIZE = 2;
const SIGNED_64_MAX = (1n << 63n) - 1n;
const UNSIGNED_64_RANGE = 1n << 64n;

export type PreviewSourcePromotionExclusivityOptions = Readonly<{
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

type LockAttempt<T> =
  | Readonly<{ status: "acquired"; value: T }>
  | Readonly<{ status: "busy" | "timed-out" }>;

let sharedLockClient: PostgresClient | null = null;

/** Physical adapter: a dedicated pool and transaction lock isolate application DB work. */
export class PostgresPreviewSourcePromotionExclusivityAdapter
  implements PreviewSourcePromotionExclusivityPort
{
  constructor(
    private readonly client: PostgresClient | null = null,
    private readonly options: PreviewSourcePromotionExclusivityOptions = {},
  ) {}

  async runExclusive<T>(
    scope: PreviewSourcePromotionReceiptScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = previewSourcePromotionAdvisoryKey(scope);
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? delay;
    const timeoutMs = Math.max(25, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollMs = Math.max(25, this.options.pollMs ?? DEFAULT_POLL_MS);
    const deadline = now() + timeoutMs;
    const client = this.client ?? defaultLockClient();

    for (;;) {
      const attempt = await client.begin<LockAttempt<T>>(async (transaction) => {
        if (now() >= deadline) return { status: "timed-out" };
        const rows = await transaction.unsafe<Array<{ acquired: boolean }>>(
          "select pg_try_advisory_xact_lock($1::bigint) as acquired",
          [key],
        );
        if (rows[0]?.acquired !== true) return { status: "busy" };
        return { status: "acquired", value: await operation() };
      });
      if (attempt.status === "acquired") return attempt.value;
      if (attempt.status === "timed-out") {
        throw new PreviewSourcePromotionExclusivityBusyError();
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new PreviewSourcePromotionExclusivityBusyError();
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }
}

function defaultLockClient(): PostgresClient {
  if (sharedLockClient) return sharedLockClient;
  const connectionString = (
    env.DATABASE_URL ??
    process.env.DATABASE_URL ??
    ""
  ).trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required for preview source promotion locking",
    );
  }
  sharedLockClient = postgres(connectionString, {
    max: LOCK_POOL_SIZE,
    idle_timeout: 60,
  });
  return sharedLockClient;
}

export function previewSourcePromotionAdvisoryKey(
  scope: PreviewSourcePromotionReceiptScope,
): string {
  const framed = [
    "preview-source-promotion:v1",
    scope.previewName,
    scope.requestId,
    scope.executionId,
    scope.platformRevision,
    scope.sourceRevision,
    scope.catalogDigest,
    scope.repository,
    scope.baseBranch,
    "",
  ].join("\n");
  const unsigned = BigInt(
    `0x${createHash("sha256").update(framed).digest("hex").slice(0, 16)}`,
  );
  return (unsigned > SIGNED_64_MAX
    ? unsigned - UNSIGNED_64_RANGE
    : unsigned
  ).toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
