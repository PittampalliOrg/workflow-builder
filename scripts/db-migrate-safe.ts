import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { baselineDrizzleMigrations } from "./db-baseline-drizzle";

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, { stdio: "inherit" });
	if (result.error) {
		throw result.error;
	}
	return result.status ?? 1;
}

async function shouldBaseline(): Promise<boolean> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}

	const sql = postgres(databaseUrl, { max: 1 });
	try {
		await sql`create schema if not exists drizzle`;
		await sql`
			create table if not exists drizzle.__drizzle_migrations (
				id serial primary key,
				hash text not null,
				created_at numeric
			)
		`;

		const [{ count: migrationCount }] = await sql<{ count: string }[]>`
			select count(*)::text as count from drizzle.__drizzle_migrations
		`;

		if (Number.parseInt(migrationCount, 10) > 0) {
			return false;
		}

		// Heuristic: if core tables exist but migrations are empty, the DB schema was
		// created outside of drizzle-kit (e.g. Atlas/GitOps). Baseline to avoid
		// re-applying CREATE TABLE migrations that will fail with "already exists".
		const [{ tables }] = await sql<{ tables: string }[]>`
			select count(*)::text as tables
			from pg_tables
			where schemaname = 'public'
		`;

		return Number.parseInt(tables, 10) > 0;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

async function main() {
	if (await shouldBaseline()) {
		const res = await baselineDrizzleMigrations();
		// eslint-disable-next-line no-console
		console.log(
			res.baselined
				? `Baselined drizzle migrations (${res.latestTag}).`
				: "Drizzle migrations already baselined.",
		);
		return;
	}

	const status = run("pnpm", ["db:migrate:drizzle"]);
	process.exit(status);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err);
	process.exit(1);
});
