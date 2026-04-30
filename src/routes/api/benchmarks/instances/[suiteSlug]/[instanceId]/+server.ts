import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkInstances, benchmarkSuites } from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!db) error(503, "Database not configured");

	const suiteSlug = decodeURIComponent(params.suiteSlug ?? "");
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!suiteSlug || !instanceId) error(400, "suiteSlug and instanceId required");

	const [row] = await db
		.select({
			id: benchmarkInstances.id,
			instanceId: benchmarkInstances.instanceId,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			problemStatement: benchmarkInstances.problemStatement,
			hintsText: benchmarkInstances.hintsText,
			testMetadata: benchmarkInstances.testMetadata,
			goldPatch: benchmarkInstances.goldPatch,
			metadata: benchmarkInstances.metadata,
			suiteSlug: benchmarkSuites.slug,
			suiteName: benchmarkSuites.name,
		})
		.from(benchmarkInstances)
		.innerJoin(
			benchmarkSuites,
			eq(benchmarkInstances.suiteId, benchmarkSuites.id),
		)
		.where(
			and(
				eq(benchmarkSuites.slug, suiteSlug),
				eq(benchmarkInstances.instanceId, instanceId),
			),
		)
		.limit(1);

	if (!row) error(404, `Instance not found: ${suiteSlug}/${instanceId}`);

	return json({ instance: row });
};
