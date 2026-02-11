import postgres from "postgres";
import { z } from "zod";

export const DatabaseQueryInputSchema = z.object({
	dbQuery: z.string().min(1),
	dbSchema: z.string().optional(),
});

export type DatabaseQueryInput = z.infer<typeof DatabaseQueryInputSchema>;

let cachedUrl: string | null = null;
let cachedSql: ReturnType<typeof postgres> | null = null;

function getSql(databaseUrl: string) {
	if (cachedSql && cachedUrl === databaseUrl) {
		return cachedSql;
	}

	cachedUrl = databaseUrl;
	cachedSql = postgres(databaseUrl, {
		max: 1,
		idle_timeout: 20,
		connect_timeout: 10,
	});

	return cachedSql;
}

export async function databaseQueryStep(
	input: DatabaseQueryInput,
	credentials?: Record<string, string>,
): Promise<
	| { success: true; data: { rows: unknown[]; count: number } }
	| { success: false; error: string }
> {
	const databaseUrl = credentials?.DATABASE_URL || process.env.DATABASE_URL;
	if (!databaseUrl) {
		return {
			success: false,
			error:
				"Missing DATABASE_URL. Create a Database connection and attach it to this step.",
		};
	}

	const sql = getSql(databaseUrl);

	try {
		const rows = await sql.unsafe(input.dbQuery);
		return {
			success: true,
			data: { rows: rows as unknown[], count: rows.length },
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
