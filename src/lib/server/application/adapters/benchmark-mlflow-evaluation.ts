import { eq } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import type {
	BenchmarkMlflowEvaluationRecord,
	BenchmarkMlflowEvaluationRepository,
} from "$lib/server/application/benchmark-mlflow-evaluation";
import { syncBenchmarkRunMlflow } from "$lib/server/application/adapters/benchmark-mlflow";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): NonNullable<Database> {
	if (!database) throw new Error("Database not configured");
	return database;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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
			.select({ summary: benchmarkRuns.summary })
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, input.runId))
			.limit(1);
		if (!run) return null;
		const existingSummary = isRecord(run.summary) ? run.summary : {};
		const mlflowEvaluation = isRecord(input.summary) ? input.summary : {};
		await database
			.update(benchmarkRuns)
			.set({
				summary: {
					...existingSummary,
					mlflowEvalRunId: input.mlflowEvalRunId,
					mlflowEvaluation: {
						...mlflowEvaluation,
						mlflowEvalRunId: input.mlflowEvalRunId,
					},
				},
				mlflowEvalRunId: input.mlflowEvalRunId,
				updatedAt: new Date(),
			})
			.where(eq(benchmarkRuns.id, input.runId));
		await syncBenchmarkRunMlflow(input.runId);
		return { mlflowEvalRunId: input.mlflowEvalRunId };
	}
}
