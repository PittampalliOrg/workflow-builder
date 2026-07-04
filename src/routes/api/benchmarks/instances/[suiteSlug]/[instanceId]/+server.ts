import { error, json } from "@sveltejs/kit";
import {
	contaminationRiskMetadataState,
	publicSwebenchTestMetadata,
	wantsContaminationRiskMetadata,
} from "$lib/server/benchmarks/contamination";
import { getApplicationAdapters } from "$lib/server/application";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) error(401, "Authentication required");

	const suiteSlug = decodeURIComponent(params.suiteSlug ?? "");
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!suiteSlug || !instanceId) error(400, "suiteSlug and instanceId required");
	const application = getApplicationAdapters();
	const workflowData = application.workflowData;
	const benchmarkEnvironmentValidation =
		application.benchmarkEnvironmentValidation;
	const wantsAuditMetadata = wantsContaminationRiskMetadata(url);
	let includeContaminationRiskMetadata = false;
	try {
		includeContaminationRiskMetadata =
			wantsAuditMetadata &&
			(await workflowData.canViewContaminationRiskMetadata({
				userId: locals.session.userId,
				projectId: locals.session.projectId,
			}));
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			error(503, "Database not configured");
		}
		throw err;
	}
	if (wantsAuditMetadata && !includeContaminationRiskMetadata) {
		error(403, "Contamination-risk metadata audit access required");
	}

	let row;
	try {
		row = await workflowData.getBenchmarkInstanceDetail({
			suiteSlug,
			instanceId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			error(503, "Database not configured");
		}
		throw err;
	}

	if (!row) error(404, `Instance not found: ${suiteSlug}/${instanceId}`);

	const environment = benchmarkEnvironmentValidation.planInstanceEnvironment({
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
