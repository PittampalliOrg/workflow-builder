import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	planSwebenchEnvironmentValidation,
	submitSwebenchEnvironmentValidationBuilds,
} from "$lib/server/benchmarks/environment-validation";
import {
	normalizeInstanceIds,
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";

const DEFAULT_VALIDATION_LIMIT = 10;
const MAX_VALIDATION_LIMIT = 100;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const suiteSlug = requireSuiteSlug(body.suiteSlug ?? body.suite);
	const requestedInstanceIds = normalizeInstanceIds(
		body.instanceIds ?? body.selectedInstanceIds ?? [],
	);
	const limit = clampInt(body.limit, 1, MAX_VALIDATION_LIMIT, DEFAULT_VALIDATION_LIMIT);
	const targetValidatedCount =
		body.targetValidatedCount == null
			? null
			: clampInt(body.targetValidatedCount, 1, 500, limit);

	const plan = await planSwebenchEnvironmentValidation({
		suiteSlug,
		instanceIds: requestedInstanceIds,
		limit: requestedInstanceIds.length > 0 ? null : 500,
	}).catch(mapEnvironmentValidationError);
	if (plan.missingInstanceIds.length > 0) {
		return error(
			409,
			`SWE-bench metadata has not been imported for ${plan.missingInstanceIds.length} selected instance(s): ${plan.missingInstanceIds.slice(0, 20).join(", ")}`,
		);
	}

	const submission = await submitSwebenchEnvironmentValidationBuilds({
		plan,
		limit,
		targetValidatedCount,
		allowBuild: true,
	}).catch(mapEnvironmentValidationError);

	return json({
		suiteSlug,
		limit,
		targetValidatedCount,
		missingInstanceIds: plan.missingInstanceIds,
		coverage: {
			total: plan.coverage.total,
			validated: plan.coverage.validated,
			building: plan.coverage.building,
			failed: plan.coverage.failed,
			notBuilt: plan.coverage.notBuilt,
		},
		selected: submission.selected.length,
		submitted: submission.submitted,
		results: submission.results,
		validated: idsForStatus(plan, "validated"),
		building: idsForStatus(plan, "building"),
		notBuilt: idsForStatus(plan, "not_built"),
		failed: idsForStatus(plan, "failed"),
		submittedBuilds: submission.results.map((result) => ({
			instanceId: result.instanceId,
			buildId: result.buildId,
			pipelineRunName: result.pipelineRunName,
			pipelineRunNamespace: result.pipelineRunNamespace,
			envSpecHash: result.envSpecHash,
			status: result.environmentStatus,
		})),
		nextExactReadyInstanceIds: plan.nextExactReadyInstanceIds,
		skipped: {
			alreadyValidated: plan.coverage.validated,
			alreadyBuilding: plan.coverage.building,
			failedRequiresReset: plan.coverage.failed,
			missingMetadata: plan.coverage.missingMetadata,
		},
	});
};

function idsForStatus(
	plan: Awaited<ReturnType<typeof planSwebenchEnvironmentValidation>>,
	status: "validated" | "building" | "failed" | "not_built",
): string[] {
	return plan.planned
		.filter((item) => item.status === status)
		.map((item) => item.row.instanceId);
}

function requireSuiteSlug(value: unknown): SwebenchSuiteSlug {
	if (typeof value !== "string" || !value.trim()) {
		throw error(400, "suiteSlug is required");
	}
	return normalizeSwebenchSuiteSlug(value);
}

function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function mapEnvironmentValidationError(err: unknown): never {
	if (err instanceof Error && err.message === "Database not configured") {
		throw error(503, "Database not configured");
	}
	throw err;
}
