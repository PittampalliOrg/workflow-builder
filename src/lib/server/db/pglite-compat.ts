import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import type postgres from "postgres";

/**
 * Embedded-Postgres (PGlite / WASM) driver for the `lite` profile.
 *
 * The whole persistence layer (~60 `Postgres*` repositories) flows through the
 * `db`/`sql` pair exported by `$lib/server/db`. Swapping that pair for PGlite
 * runs the UNCHANGED Postgres adapter against an in-process database — no
 * cluster, no server. Three real divergences from the postgres-js driver are
 * shimmed here; nothing else in the app changes.
 *
 *   1. `db.execute()` / `tx.execute()` result shape. postgres-js returns an
 *      array-like `RowList` (Array + `.count`/`.columns`); the drizzle PGlite
 *      driver returns the raw PGlite `Results` object `{ rows, affectedRows,
 *      fields }`. `toRowList()` re-shapes it so the array-style call sites
 *      (`.map`, `[0]`, destructuring, `for..of`) keep working.
 *   2. Multi-statement raw SQL. PGlite's extended-protocol `.query()` (what the
 *      drizzle driver uses) rejects multiple statements in one call, which the
 *      boot migration runner (`startup.ts` -> `tx.execute(sql.raw(file))`)
 *      needs. Parameterless executes are routed through PGlite `.exec()`
 *      (simple protocol) which runs multi-statement DDL as one unit.
 *   3. The raw `sql` client. postgres-js is a tagged-template function with
 *      `.listen`/`.unsafe`; PGlite exposes `.sql`/`.listen`/`.exec`. The compat
 *      object below maps between them (and normalises `.listen`'s return to the
 *      `{ unlisten }` shape callers expect).
 *
 * Constraint: PGlite is single-connection and serialises transactions — fine
 * for one agent's dev loop, documented as a lite-profile limitation.
 */

type PgliteResults = {
	rows?: unknown[];
	affectedRows?: number;
	fields?: unknown[];
};

/**
 * Re-shape a PGlite `Results` into the array-like `RowList` that
 * drizzle-postgres-js `.execute()` returns, so consumers that read the result
 * array-style (or via `.count`/`.columns`) are unaffected by the driver swap.
 */
function toRowList(result: PgliteResults | undefined): unknown[] {
	const rows = result?.rows ?? [];
	return Object.assign(rows, {
		count: result?.affectedRows ?? rows.length,
		columns: result?.fields ?? [],
	});
}

type ExecFn = (queryString: string) => Promise<PgliteResults[]>;
type FallbackExecute = (query: SQL) => Promise<PgliteResults>;

/**
 * Shared `.execute()` implementation for both the top-level db and a
 * transaction. Parameterless queries (raw DDL, migration files, plain SELECTs)
 * go through PGlite `.exec()` — the only path that handles multi-statement SQL.
 * Parameterised single statements keep the drizzle extended-protocol path
 * (proper bind/type handling), then get re-shaped.
 */
async function compatExecute(
	query: SQL,
	sqlToQuery: (query: SQL) => { sql: string; params: unknown[] },
	exec: ExecFn,
	fallback: FallbackExecute,
): Promise<unknown[]> {
	const rendered = sqlToQuery(query);
	if (rendered.params.length === 0) {
		const results = await exec(rendered.sql);
		const last = results.length > 0 ? results[results.length - 1] : undefined;
		return toRowList(last);
	}
	return toRowList(await fallback(query));
}

/**
 * Reach the underlying PGlite `Transaction` from a drizzle transaction object.
 * Inside `client.transaction()` the connection mutex is held, so multi-statement
 * SQL must run through the transaction's own `.exec()` — calling the top-level
 * `client.exec()` here would deadlock the single connection.
 */
function txExec(tx: unknown): ExecFn {
	const client = (tx as { session?: { client?: { exec?: ExecFn } } }).session?.client;
	if (!client?.exec) {
		throw new Error("[pglite] could not resolve transaction client for multi-statement exec");
	}
	return (queryString) => client.exec!(queryString);
}

type PostgresSqlClient = ReturnType<typeof postgres>;

/**
 * postgres-js-shaped raw `sql` client backed by PGlite. Covers the three uses
 * of the shared `sql` export: tagged-template queries
 * (`execution-read-model-support.ts`), `.listen()` on `session_events` /
 * `gitops_activity_events` (postgres.ts, gitops-activity-events.ts), and
 * `.unsafe()` (only used by a locally-constructed client elsewhere; provided
 * for parity).
 */
type SqlCompat = {
	(strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]>;
	listen: (channel: string, cb: (payload: string) => void) => Promise<{ unlisten: () => Promise<void> }>;
	unsafe: (queryString: string) => Promise<PgliteResults[]>;
	end: () => Promise<void>;
};

function createSqlCompat(client: PGlite): PostgresSqlClient {
	const sqlFn = ((strings: TemplateStringsArray, ...params: unknown[]) =>
		client.sql(strings, ...params).then((result) => toRowList(result as PgliteResults))) as unknown as SqlCompat;

	sqlFn.listen = async (channel, cb) => {
		const unsubscribe = await client.listen(channel, cb);
		return { unlisten: () => unsubscribe() };
	};
	sqlFn.unsafe = (queryString) => client.exec(queryString);
	sqlFn.end = () => client.close();

	// Cast to the postgres-js Sql type: db/index.ts exports this as the `sql`
	// pair so `type PostgresSqlClient = typeof defaultSql` in adapters stays put.
	return sqlFn as unknown as PostgresSqlClient;
}

export type PgliteDbPair = {
	db: ReturnType<typeof drizzlePostgresJs>;
	sql: PostgresSqlClient;
};

/**
 * Build the `{ db, sql }` pair for the lite profile. `dataDir` undefined =
 * ephemeral in-memory database; a path = persistent on-disk data directory.
 *
 * The returned `db` is a drizzle PGlite instance with `.execute`/`.transaction`
 * wrapped for postgres-js parity; it is cast to the postgres-js drizzle type so
 * `type Database = typeof defaultDb` in `adapters/postgres.ts` — and every
 * repository built on it — stays byte-identical.
 */
export function createPgliteDb(dataDir?: string): PgliteDbPair {
	const client = new PGlite(dataDir);
	const db = drizzlePglite(client);
	const sqlToQuery = (query: SQL) =>
		(db as unknown as { dialect: { sqlToQuery: (q: SQL) => { sql: string; params: unknown[] } } }).dialect.sqlToQuery(
			query,
		);

	const rawExecute = db.execute.bind(db) as unknown as FallbackExecute;
	(db as { execute: unknown }).execute = (query: SQL) =>
		compatExecute(query, sqlToQuery, (q) => client.exec(q), rawExecute);

	const rawTransaction = db.transaction.bind(db);
	(db as { transaction: unknown }).transaction = (
		callback: (tx: unknown) => Promise<unknown>,
		config?: unknown,
	) =>
		rawTransaction(async (tx: unknown) => {
			const exec = txExec(tx);
			const rawTxExecute = (tx as { execute: FallbackExecute }).execute.bind(tx) as FallbackExecute;
			(tx as { execute: unknown }).execute = (query: SQL) =>
				compatExecute(query, sqlToQuery, exec, rawTxExecute);
			return callback(tx);
		}, config as never);

	return {
		db: db as unknown as ReturnType<typeof drizzlePostgresJs>,
		sql: createSqlCompat(client),
	};
}
