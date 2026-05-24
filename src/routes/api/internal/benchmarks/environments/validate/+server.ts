import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	planSwebenchEnvironmentValidation,
	submitSwebenchEnvironmentValidationBuilds,
} from "$lib/server/benchmarks/environment-validation";
import { normalizeInstanceIds } from "$lib/server/benchmarks/swebench";
import { db } from "$lib/server/db";
import { requireInternal } from "$lib/server/internal-auth";

const DEFAULT_VALIDATION_LIMIT = 10;
const MAX_VALIDATION_LIMIT = 500;

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const suiteSlug = readRequiredString(body.suiteSlug ?? body.suite, "suiteSlug");
	const instanceIds = normalizeInstanceIds(
		body.instanceIds ?? body.selectedInstanceIds ?? [],
	);
	const limit = clampInt(body.limit, 1, MAX_VALIDATION_LIMIT, DEFAULT_VALIDATION_LIMIT);
	const targetValidatedCount =
		body.targetValidatedCount == null
			? null
			: clampInt(body.targetValidatedCount, 1, MAX_VALIDATION_LIMIT, limit);
	const allowBuild = body.allowBuild !== false;

	const plan = await planSwebenchEnvironmentValidation({
		suiteSlug,
		instanceIds,
		limit: instanceIds.length > 0 ? null : Math.max(limit, targetValidatedCount ?? 0, 500),
		syncBuildStatuses: true,
	});
	if (plan.missingInstanceIds.length > 0) {
		return json(
			{
				message: `SWE-bench metadata has not been imported for ${plan.missingInstanceIds.length} selected instance(s)`,
				suiteSlug: plan.suiteSlug,
				missingInstanceIds: plan.missingInstanceIds,
			},
			{ status: 409 },
		);
	}

	const submission = await submitSwebenchEnvironmentValidationBuilds({
		plan,
		limit,
		targetValidatedCount,
		allowBuild,
	});

	return json({
		suiteSlug: plan.suiteSlug,
		limit,
		targetValidatedCount,
		allowBuild,
		coverage: plan.coverage,
		validated: idsForStatus(plan, "validated"),
		building: idsForStatus(plan, "building"),
		notBuilt: idsForStatus(plan, "not_built"),
		failed: idsForStatus(plan, "failed"),
		submitted: submission.submitted,
		submittedBuilds: submission.results.map((result) => ({
			instanceId: result.instanceId,
			buildId: result.buildId,
			pipelineRunName: result.pipelineRunName,
			pipelineRunNamespace: result.pipelineRunNamespace,
			envSpecHash: result.envSpecHash,
			status: result.environmentStatus,
			reason: result.reason,
			error: result.error,
		})),
		results: submission.results,
		nextExactReadyInstanceIds: plan.nextExactReadyInstanceIds,
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

function readRequiredString(value: unknown, name: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw error(400, `${name} is required`);
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
