import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import {
	canViewContaminationRiskMetadata,
	contaminationRiskMetadataState,
	publicSwebenchTestMetadata,
	wantsContaminationRiskMetadata,
} from "$lib/server/benchmarks/contamination";
import { plannedSwebenchInferenceEnvironment } from "$lib/server/environments/environment-image-builds";
import { db } from "$lib/server/db";
import { benchmarkInstances, benchmarkSuites } from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!db) error(503, "Database not configured");

	const suiteSlug = decodeURIComponent(params.suiteSlug ?? "");
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!suiteSlug || !instanceId) error(400, "suiteSlug and instanceId required");
	const includeContaminationRiskMetadata =
		wantsContaminationRiskMetadata(url) &&
		(await canViewContaminationRiskMetadata({
			userId: locals.session.userId,
			projectId: locals.session.projectId,
		}));
	if (wantsContaminationRiskMetadata(url) && !includeContaminationRiskMetadata) {
		error(403, "Contamination-risk metadata audit access required");
	}

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

	const environment = plannedSwebenchInferenceEnvironment({
		dataset: row.suiteSlug,
		suiteSlug:
			row.suiteSlug === "SWE-bench_Verified"
				? "SWE-bench_Verified"
				: "SWE-bench_Lite",
		instanceId: row.instanceId,
		repo: row.repo ?? "",
		baseCommit: row.baseCommit ?? "",
		testMetadata: row.testMetadata,
	});

	return json({
		instance: {
			id: row.id,
			instanceId: row.instanceId,
			repo: row.repo,
			baseCommit: row.baseCommit,
			problemStatement: row.problemStatement,
			hintsText: row.hintsText,
			testMetadata: includeContaminationRiskMetadata
				? row.testMetadata
				: publicSwebenchTestMetadata(row.testMetadata),
			goldPatch: includeContaminationRiskMetadata ? row.goldPatch : null,
			metadata: includeContaminationRiskMetadata ? row.metadata : null,
			suiteSlug: row.suiteSlug,
			suiteName: row.suiteName,
			environment: {
				environmentStatus: environment.environmentStatus,
				environmentKey: environment.environmentKey ?? null,
				buildStrategy: environment.buildStrategy ?? null,
				version: environment.version ?? null,
			},
			contaminationRiskMetadata: contaminationRiskMetadataState(
				includeContaminationRiskMetadata,
			),
		},
	});
};
