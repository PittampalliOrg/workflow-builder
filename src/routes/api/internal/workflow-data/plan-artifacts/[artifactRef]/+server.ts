import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowPlanArtifactStatus } from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

const VALID_STATUSES = new Set<WorkflowPlanArtifactStatus>([
	"draft",
	"approved",
	"superseded",
	"executed",
	"failed",
]);

type PatchBody = {
	status?: WorkflowPlanArtifactStatus;
	metadata?: Record<string, unknown> | null;
};

function normalizeMetadata(value: unknown): Record<string, unknown> | null | undefined {
	if (value === undefined) return undefined;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const artifactRef = params.artifactRef?.trim();
	if (!artifactRef) return error(400, "artifactRef required");

	const artifact = await getApplicationAdapters().workflowData.getPlanArtifact(artifactRef);
	if (!artifact) return error(404, `plan artifact ${artifactRef} not found`);
	return json({ artifact });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const artifactRef = params.artifactRef?.trim();
	if (!artifactRef) return error(400, "artifactRef required");

	const body = (await request.json().catch(() => null)) as PatchBody | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}
	if (!body.status || !VALID_STATUSES.has(body.status)) {
		return error(400, `status must be one of ${[...VALID_STATUSES].join(", ")}`);
	}

	const result = await getApplicationAdapters().workflowData.updatePlanArtifactStatus({
		artifactRef,
		status: body.status,
		metadata: normalizeMetadata(body.metadata),
	});
	return json({ ok: true, ...result });
};
