import { sql } from "drizzle-orm";
import type {
  PreviewRuntimeBudgetDenialReason,
  PreviewRuntimeBudgetLimits,
  PreviewRuntimeBudgetReservation,
  PreviewRuntimeBudgetCleanupPort,
  PreviewRuntimeBudgetReservationPort,
} from "$lib/server/application/ports";
import { db as defaultDb } from "$lib/server/db";

type Database = Pick<typeof defaultDb, "execute">;

type BudgetRow = Readonly<{
  minute_requests: number;
  minute_reserved_tokens: number;
  total_requests: number;
  total_reserved_tokens: number;
}>;

type CurrentBudgetRow = BudgetRow &
  Readonly<{
    identity_closed: boolean;
    minute_expired: boolean;
  }>;

/** Postgres atomic reservation authority shared by every broker replica. */
export class PostgresPreviewRuntimeBudgetReservationAdapter implements PreviewRuntimeBudgetReservationPort {
  constructor(private readonly database: Database = defaultDb) {}

  async reserve(
    input: Parameters<PreviewRuntimeBudgetReservationPort["reserve"]>[0],
  ): Promise<PreviewRuntimeBudgetReservation> {
    validateReservation(input.reservedTokens, input.limits);
    const impossible = initialDenial(input.reservedTokens, input.limits);
    if (impossible) return Object.freeze({ ok: false, reason: impossible });

    const { identity, limits, reservedTokens } = input;
    const rows = await this.database.execute<BudgetRow>(sql`
      INSERT INTO preview_runtime_budgets (
        preview_name,
        environment_request_id,
        platform_revision,
        source_revision,
        catalog_digest,
        minute_started_at,
        minute_requests,
        minute_reserved_tokens,
        total_requests,
        total_reserved_tokens,
        closed_at,
        delete_after,
        updated_at
      ) VALUES (
        ${identity.previewName},
        ${identity.environmentRequestId},
        ${identity.environmentPlatformRevision},
        ${identity.environmentSourceRevision},
        ${identity.catalogDigest},
        date_trunc('minute', now()),
        1,
        ${reservedTokens},
        1,
        ${reservedTokens},
        NULL,
        NULL,
        now()
      )
      ON CONFLICT (
        preview_name,
        environment_request_id,
        platform_revision,
        source_revision,
        catalog_digest
      ) DO UPDATE SET
        minute_started_at = CASE
          WHEN preview_runtime_budgets.minute_started_at < date_trunc('minute', now())
            THEN date_trunc('minute', now())
          ELSE preview_runtime_budgets.minute_started_at
        END,
        minute_requests = CASE
          WHEN preview_runtime_budgets.minute_started_at < date_trunc('minute', now())
            THEN 1
          ELSE preview_runtime_budgets.minute_requests + 1
        END,
        minute_reserved_tokens = CASE
          WHEN preview_runtime_budgets.minute_started_at < date_trunc('minute', now())
            THEN excluded.minute_reserved_tokens
          ELSE preview_runtime_budgets.minute_reserved_tokens + excluded.minute_reserved_tokens
        END,
        total_requests = preview_runtime_budgets.total_requests + 1,
        total_reserved_tokens =
          preview_runtime_budgets.total_reserved_tokens + excluded.total_reserved_tokens,
        updated_at = now()
      WHERE
        preview_runtime_budgets.closed_at IS NULL
        AND
        preview_runtime_budgets.total_requests + 1 <= ${limits.totalRequests}
        AND preview_runtime_budgets.total_reserved_tokens + excluded.total_reserved_tokens
          <= ${limits.totalReservedTokens}
        AND (
          preview_runtime_budgets.minute_started_at < date_trunc('minute', now())
          OR preview_runtime_budgets.minute_requests + 1 <= ${limits.requestsPerMinute}
        )
        AND (
          preview_runtime_budgets.minute_started_at < date_trunc('minute', now())
          OR preview_runtime_budgets.minute_reserved_tokens + excluded.minute_reserved_tokens
            <= ${limits.reservedTokensPerMinute}
        )
      RETURNING
        minute_requests,
        minute_reserved_tokens,
        total_requests,
        total_reserved_tokens
    `);
    const reserved = rows[0];
    if (reserved) return successfulReservation(reserved);

    // The conditional upsert is the authorization decision. This second read
    // only reports which already-enforced bound denied the reservation.
    const currentRows = await this.database.execute<CurrentBudgetRow>(sql`
      SELECT
        minute_requests,
        minute_reserved_tokens,
        total_requests,
        total_reserved_tokens,
        closed_at IS NOT NULL AS identity_closed,
        minute_started_at < date_trunc('minute', now()) AS minute_expired
      FROM preview_runtime_budgets
      WHERE preview_name = ${identity.previewName}
        AND environment_request_id = ${identity.environmentRequestId}
        AND platform_revision = ${identity.environmentPlatformRevision}
        AND source_revision = ${identity.environmentSourceRevision}
        AND catalog_digest = ${identity.catalogDigest}
      LIMIT 1
    `);
    const current = currentRows[0];
    if (!current) {
      throw new Error("preview runtime budget reservation was not observable");
    }
    return Object.freeze({
      ok: false,
      reason: denialReason(current, reservedTokens, limits),
    });
  }
}

/** Exact teardown close plus bounded tombstone retention/pruning. */
export class PostgresPreviewRuntimeBudgetCleanupAdapter implements PreviewRuntimeBudgetCleanupPort {
  constructor(private readonly database: Database = defaultDb) {}

  async close(
    input: Parameters<PreviewRuntimeBudgetCleanupPort["close"]>[0],
  ): Promise<void> {
    if (
      !Number.isSafeInteger(input.retentionHours) ||
      input.retentionHours < 1
    ) {
      throw new Error("preview runtime budget retentionHours must be positive");
    }
    const { identity } = input;
    await this.database.execute(sql`
      INSERT INTO preview_runtime_budgets (
        preview_name,
        environment_request_id,
        platform_revision,
        source_revision,
        catalog_digest,
        minute_started_at,
        minute_requests,
        minute_reserved_tokens,
        total_requests,
        total_reserved_tokens,
        closed_at,
        delete_after,
        updated_at
      ) VALUES (
        ${identity.previewName},
        ${identity.environmentRequestId},
        ${identity.environmentPlatformRevision},
        ${identity.environmentSourceRevision},
        ${identity.catalogDigest},
        date_trunc('minute', now()),
        0,
        0,
        0,
        0,
        now(),
        now() + (${input.retentionHours} * interval '1 hour'),
        now()
      )
      ON CONFLICT (
        preview_name,
        environment_request_id,
        platform_revision,
        source_revision,
        catalog_digest
      ) DO UPDATE SET
        closed_at = coalesce(preview_runtime_budgets.closed_at, now()),
        delete_after = greatest(
          coalesce(preview_runtime_budgets.delete_after, now()),
          now() + (${input.retentionHours} * interval '1 hour')
        ),
        updated_at = now()
    `);
  }

  async pruneExpired(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("preview runtime budget prune limit is invalid");
    }
    const rows = await this.database.execute<{ removed: number }>(sql`
      WITH expired AS (
        SELECT
          preview_name,
          environment_request_id,
          platform_revision,
          source_revision,
          catalog_digest
        FROM preview_runtime_budgets
        WHERE closed_at IS NOT NULL AND delete_after <= now()
        ORDER BY delete_after
        LIMIT ${limit}
      )
      DELETE FROM preview_runtime_budgets AS budget
      USING expired
      WHERE budget.preview_name = expired.preview_name
        AND budget.environment_request_id = expired.environment_request_id
        AND budget.platform_revision = expired.platform_revision
        AND budget.source_revision = expired.source_revision
        AND budget.catalog_digest = expired.catalog_digest
      RETURNING 1 AS removed
    `);
    return rows.length;
  }
}

function successfulReservation(
  row: BudgetRow,
): PreviewRuntimeBudgetReservation {
  return Object.freeze({
    ok: true,
    minuteRequests: Number(row.minute_requests),
    minuteReservedTokens: Number(row.minute_reserved_tokens),
    totalRequests: Number(row.total_requests),
    totalReservedTokens: Number(row.total_reserved_tokens),
  });
}

function denialReason(
  row: CurrentBudgetRow,
  reservedTokens: number,
  limits: PreviewRuntimeBudgetLimits,
): PreviewRuntimeBudgetDenialReason {
  if (row.identity_closed) return "identity-closed";
  const totalRequests = Number(row.total_requests);
  const totalTokens = Number(row.total_reserved_tokens);
  if (totalRequests + 1 > limits.totalRequests) return "total-request-limit";
  if (totalTokens + reservedTokens > limits.totalReservedTokens) {
    return "total-token-limit";
  }
  if (!row.minute_expired) {
    if (Number(row.minute_requests) + 1 > limits.requestsPerMinute) {
      return "minute-request-limit";
    }
    if (
      Number(row.minute_reserved_tokens) + reservedTokens >
      limits.reservedTokensPerMinute
    ) {
      return "minute-token-limit";
    }
  }
  throw new Error(
    "preview runtime budget denial did not match a configured limit",
  );
}

function initialDenial(
  reservedTokens: number,
  limits: PreviewRuntimeBudgetLimits,
): PreviewRuntimeBudgetDenialReason | null {
  if (limits.totalRequests < 1) return "total-request-limit";
  if (reservedTokens > limits.totalReservedTokens) return "total-token-limit";
  if (limits.requestsPerMinute < 1) return "minute-request-limit";
  if (reservedTokens > limits.reservedTokensPerMinute) {
    return "minute-token-limit";
  }
  return null;
}

function validateReservation(
  reservedTokens: number,
  limits: PreviewRuntimeBudgetLimits,
): void {
  for (const [name, value] of Object.entries({ reservedTokens, ...limits })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `preview runtime budget ${name} must be a positive integer`,
      );
    }
  }
}
