import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

type JournalEntry = {
	idx: number;
	when: number;
	tag: string;
	breakpoints?: boolean;
	version?: string;
};

function getMigrationsRoot(): string {
	// scripts/ -> repo root
	return path.resolve(process.cwd(), "drizzle");
}

function readJournalEntries(): JournalEntry[] {
	const root = getMigrationsRoot();
	const journalPath = path.join(root, "meta", "_journal.json");
	const raw = fs.readFileSync(journalPath, "utf8");
	const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
	if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
		throw new Error("drizzle/meta/_journal.json has no entries");
	}
	return parsed.entries;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export async function baselineDrizzleMigrations(): Promise<{
	baselined: boolean;
	latestTag: string;
	latestWhen: number;
}> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}

	const entries = readJournalEntries();
	const migrationsRoot = getMigrationsRoot();
	const latest = entries.reduce((acc, cur) =>
		cur.when > acc.when ? cur : acc,
	);

	const sql = postgres(databaseUrl, { max: 1 });
	try {
		// Ensure schema/table exist (mirrors drizzle-orm migrator defaults for Postgres).
		await sql`create schema if not exists drizzle`;
		await sql`
			create table if not exists drizzle.__drizzle_migrations (
				id serial primary key,
				hash text not null,
				created_at numeric
			)
		`;

		const [{ count }] = await sql<{ count: string }[]>`
			select count(*)::text as count from drizzle.__drizzle_migrations
		`;

		if (Number.parseInt(count, 10) > 0) {
			return {
				baselined: false,
				latestTag: latest.tag,
				latestWhen: latest.when,
			};
		}

		// drizzle-kit migrate records one row per applied migration file (keyed by hash).
		// If we only insert the latest row, drizzle-kit will try to replay earlier
		// migrations and fail with "relation already exists".
		const rows = entries.map((entry) => {
			const sqlPath = path.join(migrationsRoot, `${entry.tag}.sql`);
			const sqlText = fs.readFileSync(sqlPath, "utf8");
			return { hash: sha256Hex(sqlText), created_at: entry.when };
		});

		await sql.begin(async (tx) => {
			for (const row of rows) {
				await tx`
					insert into drizzle.__drizzle_migrations (hash, created_at)
					values (${row.hash}, ${row.created_at})
				`;
			}
		});

		return { baselined: true, latestTag: latest.tag, latestWhen: latest.when };
	} finally {
		await sql.end({ timeout: 5 });
	}
}

async function main() {
	const result = await baselineDrizzleMigrations();
	if (result.baselined) {
		// eslint-disable-next-line no-console
		console.log(
			`Baselined drizzle migrations at ${result.latestTag} (${result.latestWhen}).`,
		);
	} else {
		// eslint-disable-next-line no-console
		console.log("Drizzle migrations already baselined (no-op).");
	}
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err);
	process.exit(1);
});
