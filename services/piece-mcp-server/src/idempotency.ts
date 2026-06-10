/**
 * Idempotency gate for the deterministic /execute path.
 *
 * Contract (docs/activepieces-integration-architecture.md §2.4):
 * the orchestrator mints a stable `idempotency_key`
 * (`workflowId:dbExecutionId:taskName`) that survives both activity
 * retries and workflow replay. The gate guarantees completed-result
 * dedupe (a retried `send-email` produces exactly one side effect);
 * mid-flight crashes remain at-least-once by design.
 *
 * Gate algorithm:
 *   INSERT … ON CONFLICT (idempotency_key)
 *     DO UPDATE SET attempt = attempt + 1, updated_at = now()
 *   RETURNING status, result, error, error_class
 *
 *   - status='completed'                      → return cached result (deduped)
 *   - status='failed' + error_class permanent → return cached failure (deduped)
 *   - 'running' | 'paused' | retryable failed → proceed (re-execute)
 *
 * Never used on the MCP path.
 */

import type pg from "pg";

export type PieceExecutionStatus = "running" | "paused" | "completed" | "failed";

export type IdempotencyClaim = {
	status: PieceExecutionStatus | string;
	attempt: number;
	result: unknown;
	error: string | null;
	errorClass: string | null;
};

export type PieceExecutionIdentity = {
	idempotencyKey: string;
	workflowId: string;
	executionId: string;
	dbExecutionId?: string | null;
	nodeId: string;
	pieceName: string;
	actionName: string;
	pieceVersion?: string | null;
	connectionExternalId?: string | null;
};

/**
 * Claim (or re-claim) the idempotency slot. The RETURNING row reflects the
 * pre-existing status on conflict (the update only bumps attempt/updated_at),
 * so a fresh insert comes back as status='running', attempt=1.
 */
export async function claimIdempotency(
	pool: pg.Pool,
	identity: PieceExecutionIdentity,
): Promise<IdempotencyClaim> {
	const result = await pool.query<{
		status: string;
		attempt: number;
		result: unknown;
		error: string | null;
		error_class: string | null;
	}>(
		`INSERT INTO piece_execution (
			idempotency_key, workflow_id, execution_id, db_execution_id, node_id,
			piece_name, action_name, piece_version, connection_external_id,
			status, attempt, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', 1, now(), now())
		ON CONFLICT (idempotency_key)
		DO UPDATE SET attempt = piece_execution.attempt + 1, updated_at = now()
		RETURNING status, attempt, result, error, error_class`,
		[
			identity.idempotencyKey,
			identity.workflowId,
			identity.executionId,
			identity.dbExecutionId ?? null,
			identity.nodeId,
			identity.pieceName,
			identity.actionName,
			identity.pieceVersion ?? null,
			identity.connectionExternalId ?? null,
		],
	);

	const row = result.rows[0];
	return {
		status: row.status,
		attempt: row.attempt,
		result: row.result,
		error: row.error,
		errorClass: row.error_class,
	};
}

export type IdempotencyOutcome = {
	status: Exclude<PieceExecutionStatus, "running">;
	/** Full action output — stored as jsonb (offload reads it back). */
	result?: unknown;
	error?: string | null;
	errorClass?: string | null;
};

/**
 * Persist the execution outcome. UPSERT (not bare UPDATE) so the row also
 * lands when the gate claim was skipped via `skip_idempotency_gate` — the
 * table doubles as the per-execution piece audit trail and the offload
 * backing store.
 *
 * Note `status='paused'`: a paused attempt is deliberately NOT a cacheable
 * terminal state — a later RESUME re-invocation passes the gate and
 * re-executes the action with `executionType: "RESUME"`.
 */
export async function finalizeIdempotency(
	pool: pg.Pool,
	identity: PieceExecutionIdentity,
	outcome: IdempotencyOutcome,
): Promise<void> {
	const serializedResult =
		outcome.result === undefined ? null : JSON.stringify(outcome.result);
	await pool.query(
		`INSERT INTO piece_execution (
			idempotency_key, workflow_id, execution_id, db_execution_id, node_id,
			piece_name, action_name, piece_version, connection_external_id,
			status, attempt, result, error, error_class, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11::jsonb, $12, $13, now(), now())
		ON CONFLICT (idempotency_key)
		DO UPDATE SET
			status = EXCLUDED.status,
			result = EXCLUDED.result,
			error = EXCLUDED.error,
			error_class = EXCLUDED.error_class,
			updated_at = now()`,
		[
			identity.idempotencyKey,
			identity.workflowId,
			identity.executionId,
			identity.dbExecutionId ?? null,
			identity.nodeId,
			identity.pieceName,
			identity.actionName,
			identity.pieceVersion ?? null,
			identity.connectionExternalId ?? null,
			outcome.status,
			serializedResult,
			outcome.error ?? null,
			outcome.errorClass ?? null,
		],
	);
}
