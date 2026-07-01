import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionLogPatch } from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

const ALLOWED_PATCH_KEYS = new Set([
	"status",
	"output",
	"error",
	"completedAt",
	"duration",
	"credentialFetchMs",
	"routingMs",
	"coldStartMs",
	"executionMs",
	"routedTo",
	"wasColdStart",
]);

function normalizeCompletedAt(value: unknown): Date | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new Error("completedAt must be an ISO string or null");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("completedAt must be a valid ISO date");
	return date;
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const executionId = params.executionId?.trim();
	const logId = params.logId?.trim();
	if (!executionId) return error(400, "executionId required");
	if (!logId) return error(400, "logId required");

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}

	const workflowData = getApplicationAdapters().workflowData;
	const execution = await workflowData.getExecutionById(executionId);
	if (!execution) return error(404, `execution ${executionId} not found`);

	const patch: WorkflowExecutionLogPatch = {};
	try {
		for (const [key, value] of Object.entries(body)) {
			if (!ALLOWED_PATCH_KEYS.has(key)) continue;
			Object.assign(patch, {
				[key]: key === "completedAt" ? normalizeCompletedAt(value) : value,
			});
		}
	} catch (err) {
		return error(400, err instanceof Error ? err.message : "invalid log patch");
	}
	if (Object.keys(patch).length === 0) return error(400, "no supported log fields supplied");

	const log = await workflowData.updateExecutionLog(executionId, logId, patch);
	if (!log) return error(404, `log ${logId} not found`);
	return json({ ok: true, log });
};
