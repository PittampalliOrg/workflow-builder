// Phase K — human annotation CRUD for a single benchmark run instance.
// GET returns the calling user's verdict + reasoning (or null) plus the
// aggregate counts across all users for this instance. POST upserts the
// caller's row keyed on (run_instance_id, user_id).

import { error, json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");
	const instanceId = decodeURIComponent(params.instanceId);

	let result;
	try {
		result = await getApplicationAdapters().workflowData.getBenchmarkRunInstanceAnnotations({
			runId,
			instanceId,
			projectId: locals.session.projectId,
			userId: locals.session.userId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (result.status === "not_found") return error(404, "Instance not found in this run");

	return json({
		mine: result.mine
			? {
					verdict: result.mine.verdict,
					reasoning: result.mine.reasoning,
					updatedAt: result.mine.updatedAt.toISOString(),
				}
			: null,
		counts: result.counts,
	});
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");
	const instanceId = decodeURIComponent(params.instanceId);

	const body = (await request.json().catch(() => ({}))) as {
		verdict?: string;
		reasoning?: string | null;
	};

	let result;
	try {
		result = await getApplicationAdapters().workflowData.upsertBenchmarkRunInstanceAnnotation({
			runId,
			instanceId,
			projectId: locals.session.projectId,
			userId: locals.session.userId,
			verdict: body.verdict,
			reasoning: body.reasoning,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (result.status === "invalid_verdict") {
		return error(400, "verdict must be one of: " + result.allowed.join(", "));
	}
	if (result.status === "not_found") return error(404, "Instance not found in this run");

	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	if (!runId || !params.instanceId) return error(400, "runId and instanceId required");
	const instanceId = decodeURIComponent(params.instanceId);

	let result;
	try {
		result = await getApplicationAdapters().workflowData.deleteBenchmarkRunInstanceAnnotation({
			runId,
			instanceId,
			projectId: locals.session.projectId,
			userId: locals.session.userId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (result.status === "not_found") return error(404, "Instance not found in this run");

	return json({ ok: true });
};
