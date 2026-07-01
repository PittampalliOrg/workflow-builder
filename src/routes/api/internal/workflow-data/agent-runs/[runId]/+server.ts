import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowAgentRunStatus } from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

const VALID_STATUSES = new Set<WorkflowAgentRunStatus>([
	"running",
	"completed",
	"failed",
]);

type LifecycleBody = {
	status?: WorkflowAgentRunStatus;
	result?: Record<string, unknown> | null;
	error?: string | null;
	workspaceRef?: string | null;
	eventPublished?: boolean;
};

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const runId = params.runId?.trim();
	if (!runId) return error(400, "runId required");

	const body = (await request.json().catch(() => null)) as LifecycleBody | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}
	const status = normalizeString(body.status);
	if (!status || !VALID_STATUSES.has(status as WorkflowAgentRunStatus)) {
		return error(400, "status must be one of running, completed, failed");
	}

	const result = await getApplicationAdapters().workflowData.updateAgentRunLifecycle({
		id: runId,
		status: status as "running" | "completed" | "failed",
		result:
			body.result && typeof body.result === "object" && !Array.isArray(body.result)
				? body.result
				: body.result === null
					? null
					: undefined,
		error: normalizeString(body.error),
		workspaceRef: normalizeString(body.workspaceRef),
		eventPublished: body.eventPublished === true,
	});

	return json({ ok: true, ...result });
};
