/**
 * POST|GET /api/internal/executions/[id]/ap-resume/[requestId]
 *
 * Resume target for Activepieces WEBHOOK pauses (piece-runtime
 * `generateResumeUrl`, gated on AP_RESUME_PUBLIC_BASE_URL — see
 * docs/activepieces-integration-architecture.md §2.4). An external SaaS
 * (approval link click, callback webhook, …) hits this URL; we capture
 * query params + body and raise the Dapr external event
 * `ap.resume.<requestId>` on the paused workflow instance — the
 * orchestrator's `wait_for_external_event` resumes the SW 1.0 task, which
 * re-invokes /execute with `execution_type: "RESUME"` and the captured
 * payload as `resume_payload`.
 *
 * Auth: deliberately NOT internal-token gated — external SaaS calls it.
 * Validation instead: execution row exists, is RUNNING, has a Dapr
 * instance, and the requestId is plausible. Both GET and POST are accepted
 * (SaaS webhook/redirect behaviors vary).
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { workflowExecutions } from "$lib/server/db/schema";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";

// Loose plausibility check (UUIDs and orchestrator-minted ids fit); blocks
// junk/path-probing without coupling to a specific id format.
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

async function parseBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";
	try {
		if (contentType.includes("application/json")) {
			return await request.json();
		}
		if (
			contentType.includes("application/x-www-form-urlencoded") ||
			contentType.includes("multipart/form-data")
		) {
			const form = await request.formData();
			const out: Record<string, unknown> = {};
			for (const [key, value] of form.entries()) {
				out[key] = typeof value === "string" ? value : value.name;
			}
			return out;
		}
		const text = await request.text();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

async function handleResume(
	params: { id?: string; requestId?: string },
	url: URL,
	body: unknown,
): Promise<Response> {
	const executionId = params.id?.trim();
	const requestId = params.requestId?.trim();
	if (!executionId) throw error(400, "execution id required");
	if (!requestId || !REQUEST_ID_RE.test(requestId)) {
		throw error(400, "invalid resume requestId");
	}
	if (!db) throw error(503, "Database not configured");

	const rows = await db
		.select({
			id: workflowExecutions.id,
			status: workflowExecutions.status,
			daprInstanceId: workflowExecutions.daprInstanceId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	const execution = rows[0];
	if (!execution) throw error(404, "execution not found");
	if (execution.status !== "running") {
		throw error(409, `execution is ${execution.status}, not running`);
	}
	if (!execution.daprInstanceId) {
		throw error(409, "execution has no Dapr workflow instance");
	}

	const queryParams = Object.fromEntries(url.searchParams.entries());

	const res = await daprFetch(
		`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(execution.daprInstanceId)}/events`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				eventName: `ap.resume.${requestId}`,
				eventData: { requestId, queryParams, body },
			}),
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error(
			`[ap-resume] Failed to raise ap.resume.${requestId} on ${execution.daprInstanceId}: ` +
				`${res.status} ${detail.slice(0, 200)}`,
		);
		throw error(502, "failed to deliver resume event to the workflow");
	}

	console.log(
		`[ap-resume] Raised ap.resume.${requestId} on execution ${executionId} ` +
			`(instance=${execution.daprInstanceId})`,
	);
	return json({ ok: true, executionId, requestId });
}

export const POST: RequestHandler = async ({ params, request, url }) => {
	const body = await parseBody(request);
	return handleResume(params, url, body);
};

export const GET: RequestHandler = async ({ params, url }) => {
	return handleResume(params, url, null);
};
