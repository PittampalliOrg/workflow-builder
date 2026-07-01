import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

type IncomingLog = {
	id?: string;
	nodeId?: string;
	nodeName?: string;
	nodeType?: string;
	activityName?: string | null;
	status?: "pending" | "running" | "success" | "error";
	input?: unknown;
	output?: unknown;
	error?: string | null;
	startedAt?: string;
	completedAt?: string | null;
	duration?: string | null;
	credentialFetchMs?: number | null;
	routingMs?: number | null;
	coldStartMs?: number | null;
	executionMs?: number | null;
	routedTo?: string | null;
	wasColdStart?: boolean | null;
};

const VALID_LOG_STATUSES = new Set(["pending", "running", "success", "error"]);

function parseDate(value: string | null | undefined, field: string): Date | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid ISO date`);
	return date;
}

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const executionId = params.executionId?.trim();
	if (!executionId) return error(400, "executionId required");

	const body = (await request.json().catch(() => null)) as IncomingLog | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}
	if (!body.nodeId || !body.nodeName || !body.nodeType || !body.status) {
		return error(400, "nodeId, nodeName, nodeType, and status are required");
	}
	if (!VALID_LOG_STATUSES.has(body.status)) {
		return error(400, "status must be one of pending, running, success, error");
	}

	const workflowData = getApplicationAdapters().workflowData;
	const execution = await workflowData.getExecutionById(executionId);
	if (!execution) return error(404, `execution ${executionId} not found`);

	let startedAt: Date | undefined;
	let completedAt: Date | null | undefined;
	try {
		startedAt = parseDate(body.startedAt, "startedAt") ?? undefined;
		completedAt = parseDate(body.completedAt, "completedAt");
	} catch (err) {
		return error(400, err instanceof Error ? err.message : "invalid date");
	}

	const log = await workflowData.appendExecutionLog({
		...(body.id ? { id: body.id } : {}),
		executionId,
		nodeId: body.nodeId,
		nodeName: body.nodeName,
		nodeType: body.nodeType,
		activityName: body.activityName ?? null,
		status: body.status,
		input: body.input,
		output: body.output,
		error: body.error ?? null,
		...(startedAt ? { startedAt } : {}),
		...(completedAt !== undefined ? { completedAt } : {}),
		duration: body.duration ?? null,
		credentialFetchMs: body.credentialFetchMs ?? null,
		routingMs: body.routingMs ?? null,
		coldStartMs: body.coldStartMs ?? null,
		executionMs: body.executionMs ?? null,
		routedTo: body.routedTo ?? null,
		wasColdStart: body.wasColdStart ?? null,
	});

	return json({ ok: true, log });
};
