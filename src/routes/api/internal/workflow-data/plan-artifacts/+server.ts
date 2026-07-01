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

type PlanArtifactBody = {
	artifactRef?: string;
	workflowExecutionId?: string;
	workflowId?: string;
	nodeId?: string;
	goal?: string;
	planJson?: Record<string, unknown>;
	planMarkdown?: string | null;
	sourcePrompt?: string | null;
	artifactType?: string | null;
	status?: WorkflowPlanArtifactStatus;
	workspaceRef?: string | null;
	clonePath?: string | null;
	metadata?: Record<string, unknown> | null;
};

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as PlanArtifactBody | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}

	const artifactRef = normalizeString(body.artifactRef);
	const workflowExecutionId = normalizeString(body.workflowExecutionId);
	const workflowId = normalizeString(body.workflowId);
	const nodeId = normalizeString(body.nodeId);
	const goal = normalizeString(body.goal);
	if (!artifactRef || !workflowExecutionId || !workflowId || !nodeId || !goal) {
		return error(400, "artifactRef, workflowExecutionId, workflowId, nodeId, and goal are required");
	}
	if (!body.planJson || typeof body.planJson !== "object" || Array.isArray(body.planJson)) {
		return error(400, "planJson object is required");
	}
	const status = body.status ?? "draft";
	if (!VALID_STATUSES.has(status)) {
		return error(400, `status must be one of ${[...VALID_STATUSES].join(", ")}`);
	}

	const result = await getApplicationAdapters().workflowData.upsertPlanArtifact({
		artifactRef,
		workflowExecutionId,
		workflowId,
		nodeId,
		goal,
		planJson: body.planJson,
		planMarkdown: normalizeString(body.planMarkdown),
		sourcePrompt: normalizeString(body.sourcePrompt) ?? goal,
		artifactType: normalizeString(body.artifactType) ?? "claude_task_graph_v1",
		status,
		workspaceRef: normalizeString(body.workspaceRef),
		clonePath: normalizeString(body.clonePath),
		metadata: normalizeMetadata(body.metadata),
	});

	return json({ ok: true, ...result });
};
