/**
 * Postgres-backed `ctx.store` adapter for the deterministic /execute path.
 *
 * Upstream AP's `ctx.store` (engine storage.service.ts) is backed by the AP
 * server's store-entries API with keys prefixed per StoreScope:
 *   PROJECT ('COLLECTION') → project-wide key
 *   FLOW (default)         → `flow_<flowId>/<key>`
 *
 * Ours is keyed by a `scope` column in the `piece_store` table
 * (PK (scope, key), BFF drizzle migration 0080):
 *   PROJECT → `<workflow_id>`                                  (survives runs)
 *   FLOW    → `<workflow_id>:<db_execution_id ?? execution_id>` (per execution,
 *             survives a DELAY/WEBHOOK pause + RESUME re-invocation)
 *
 * Only wired when /execute runs with a DATABASE_URL; the MCP path keeps the
 * no-op store.
 */

import { StoreScope, type Store } from "@activepieces/pieces-framework";
import type pg from "pg";

export type PgStoreOptions = {
	workflowId: string;
	executionId: string;
	dbExecutionId?: string | null;
};

function scopeValue(scope: StoreScope, opts: PgStoreOptions): string {
	if (scope === StoreScope.PROJECT) {
		return opts.workflowId;
	}
	// StoreScope.FLOW (upstream default)
	return `${opts.workflowId}:${opts.dbExecutionId ?? opts.executionId}`;
}

export function createPgStore(pool: pg.Pool, opts: PgStoreOptions): Store {
	return {
		async put<T>(key: string, value: T, scope = StoreScope.FLOW): Promise<T> {
			const serialized = value === undefined ? null : JSON.stringify(value);
			await pool.query(
				`INSERT INTO piece_store (scope, key, value, updated_at)
				 VALUES ($1, $2, $3::jsonb, now())
				 ON CONFLICT (scope, key)
				 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
				[scopeValue(scope, opts), key, serialized],
			);
			return value;
		},

		async get<T>(key: string, scope = StoreScope.FLOW): Promise<T | null> {
			const result = await pool.query<{ value: unknown }>(
				`SELECT value FROM piece_store WHERE scope = $1 AND key = $2`,
				[scopeValue(scope, opts), key],
			);
			if (result.rows.length === 0) return null;
			return (result.rows[0].value ?? null) as T | null;
		},

		async delete(key: string, scope = StoreScope.FLOW): Promise<void> {
			await pool.query(
				`DELETE FROM piece_store WHERE scope = $1 AND key = $2`,
				[scopeValue(scope, opts), key],
			);
		},
	};
}
