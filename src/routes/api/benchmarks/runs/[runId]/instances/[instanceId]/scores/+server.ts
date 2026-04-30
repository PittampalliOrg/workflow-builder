import { error, json } from "@sveltejs/kit";
import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRunInstanceScores,
	benchmarkRuns,
} from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

// Phase G/I: scorer rows for a single benchmark instance.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");

	const [runRow] = await database
		.select({ id: benchmarkRuns.id })
		.from(benchmarkRuns)
		.where(
			and(
				eq(benchmarkRuns.id, runId),
				eq(benchmarkRuns.projectId, locals.session.projectId),
			),
		)
		.limit(1);
	if (!runRow) return error(404, "Run not found");

	const [instance] = await database
		.select({ id: benchmarkRunInstances.id })
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, runId),
				eq(benchmarkRunInstances.instanceId, instanceId),
			),
		)
		.limit(1);
	if (!instance) return error(404, "Instance not found in this run");

	const scores = await database
		.select({
			id: benchmarkRunInstanceScores.id,
			scorerName: benchmarkRunInstanceScores.scorerName,
			scorerVersion: benchmarkRunInstanceScores.scorerVersion,
			score: benchmarkRunInstanceScores.score,
			reasoning: benchmarkRunInstanceScores.reasoning,
			metadata: benchmarkRunInstanceScores.metadata,
			createdAt: benchmarkRunInstanceScores.createdAt,
		})
		.from(benchmarkRunInstanceScores)
		.where(eq(benchmarkRunInstanceScores.runInstanceId, instance.id))
		.orderBy(asc(benchmarkRunInstanceScores.scorerName));

	return json({
		scores: scores.map((s) => ({
			...s,
			createdAt: s.createdAt.toISOString(),
		})),
	});
};
