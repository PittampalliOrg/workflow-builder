import { eq } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import type {
	BenchmarkMlflowEvaluationRecord,
	BenchmarkMlflowEvaluationRepository,
} from "$lib/server/application/benchmark-mlflow-evaluation";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): NonNullable<Database> {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class PostgresBenchmarkMlflowEvaluationRepository
	implements BenchmarkMlflowEvaluationRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	async recordEvaluation(input: {
		runId: string;
		mlflowEvalRunId: string;
		summary: Record<string, unknown> | null;
	}): Promise<BenchmarkMlflowEvaluationRecord | null> {
		const database = requireDb(this.database);
		const [run] = await database
			.select({ id: benchmarkRuns.id })
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, input.runId))
			.limit(1);
		if (!run) return null;
		// Old coordinator histories may still POST this callback. Accept it after
		// verifying the run, but do not create a second evaluation projection;
		// native benchmark result rows and summaries are already authoritative.
		void input.summary;
		return { mlflowEvalRunId: input.mlflowEvalRunId };
	}
}
