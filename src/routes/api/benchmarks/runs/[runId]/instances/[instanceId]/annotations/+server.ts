// Phase K — human annotation CRUD for a single benchmark run instance.
// GET returns the calling user's verdict + reasoning (or null) plus the
// aggregate counts across all users for this instance. POST upserts the
// caller's row keyed on (run_instance_id, user_id).

import { error, json } from "@sveltejs/kit";
import { and, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstanceAnnotations,
	benchmarkRunInstances,
	benchmarkRuns,
	type BenchmarkInstanceAnnotationVerdict,
} from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

const ALLOWED_VERDICTS: BenchmarkInstanceAnnotationVerdict[] = [
	"correct",
	"incorrect",
	"partial",
	"unsure",
];

async function resolveInstance(
	database: NonNullable<typeof db>,
	projectId: string,
	runId: string,
	rawInstanceId: string,
) {
	const instanceId = decodeURIComponent(rawInstanceId);
	const [runRow] = await database
		.select({ id: benchmarkRuns.id })
		.from(benchmarkRuns)
		.where(
			and(
				eq(benchmarkRuns.id, runId),
				eq(benchmarkRuns.projectId, projectId),
			),
		)
		.limit(1);
	if (!runRow) return null;

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
	return instance ?? null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");

	const instance = await resolveInstance(
		database,
		locals.session.projectId,
		runId,
		params.instanceId,
	);
	if (!instance) return error(404, "Instance not found in this run");

	const [my] = await database
		.select({
			id: benchmarkRunInstanceAnnotations.id,
			verdict: benchmarkRunInstanceAnnotations.verdict,
			reasoning: benchmarkRunInstanceAnnotations.reasoning,
			updatedAt: benchmarkRunInstanceAnnotations.updatedAt,
		})
		.from(benchmarkRunInstanceAnnotations)
		.where(
			and(
				eq(benchmarkRunInstanceAnnotations.runInstanceId, instance.id),
				eq(benchmarkRunInstanceAnnotations.userId, locals.session.userId),
			),
		)
		.limit(1);

	const aggregateRows = await database
		.select({
			verdict: benchmarkRunInstanceAnnotations.verdict,
			count: sql<number>`count(*)::int`,
		})
		.from(benchmarkRunInstanceAnnotations)
		.where(eq(benchmarkRunInstanceAnnotations.runInstanceId, instance.id))
		.groupBy(benchmarkRunInstanceAnnotations.verdict);
	const counts: Record<BenchmarkInstanceAnnotationVerdict, number> = {
		correct: 0,
		incorrect: 0,
		partial: 0,
		unsure: 0,
	};
	for (const row of aggregateRows) {
		const v = row.verdict as BenchmarkInstanceAnnotationVerdict;
		counts[v] = Number(row.count);
	}

	return json({
		mine: my
			? {
					verdict: my.verdict,
					reasoning: my.reasoning,
					updatedAt: my.updatedAt.toISOString(),
				}
			: null,
		counts,
	});
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");

	const body = (await request.json().catch(() => ({}))) as {
		verdict?: string;
		reasoning?: string | null;
	};

	const verdict = body.verdict?.trim() as BenchmarkInstanceAnnotationVerdict | undefined;
	if (!verdict || !ALLOWED_VERDICTS.includes(verdict)) {
		return error(400, "verdict must be one of: " + ALLOWED_VERDICTS.join(", "));
	}
	const reasoning = body.reasoning?.trim() || null;

	const instance = await resolveInstance(
		database,
		locals.session.projectId,
		runId,
		params.instanceId,
	);
	if (!instance) return error(404, "Instance not found in this run");

	const userId = locals.session.userId;

	await database
		.insert(benchmarkRunInstanceAnnotations)
		.values({
			runInstanceId: instance.id,
			userId,
			verdict,
			reasoning,
		})
		.onConflictDoUpdate({
			target: [
				benchmarkRunInstanceAnnotations.runInstanceId,
				benchmarkRunInstanceAnnotations.userId,
			],
			set: {
				verdict,
				reasoning,
				updatedAt: new Date(),
			},
		});

	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");

	const instance = await resolveInstance(
		database,
		locals.session.projectId,
		runId,
		params.instanceId,
	);
	if (!instance) return error(404, "Instance not found in this run");

	await database
		.delete(benchmarkRunInstanceAnnotations)
		.where(
			and(
				eq(benchmarkRunInstanceAnnotations.runInstanceId, instance.id),
				eq(benchmarkRunInstanceAnnotations.userId, locals.session.userId),
			),
		);

	return json({ ok: true });
};
