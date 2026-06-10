/**
 * Shared Postgres pool for the piece-runtime's durability surfaces
 * (idempotency gate, result offload storage, ctx.store adapter).
 *
 * Lazy singleton: created on first use, only when DATABASE_URL is set.
 * The MCP path never touches it — durability is /execute-only.
 */

import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) return null;
	if (!pool) {
		pool = new pg.Pool({
			connectionString: databaseUrl,
			max: 5,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
		});
		pool.on("error", (err) => {
			console.error("[piece-runtime] pg pool background error:", err.message);
		});
	}
	return pool;
}

/** Test-only: drop the singleton so a fresh pool picks up new env. */
export function resetPoolForTests(): void {
	pool = null;
}
