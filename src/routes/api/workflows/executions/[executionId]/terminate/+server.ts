import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun, stopDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * POST /api/workflows/executions/[executionId]/terminate
 *
 * Terminate a running workflow execution and its per-session children. Routed
 * through the vetted lifecycle controller (mode=terminate), which confirms
 * durable closure and flips child sessions/agent-runs/workspace-sessions
 * terminal — replacing the old fire-and-forget 2s-timeout DB flip that could
 * report `cancelled` while the durable instance kept running. Prefer
 * POST .../stop for new callers (it supports purge/reset too).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		// No body is fine
	}
	const reason =
		typeof body?.reason === "string" && body.reason.trim()
			? body.reason.trim()
			: undefined;

	const target = { kind: "workflowExecution" as const, id: params.executionId };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Execution not found");
	// CMA scoping: 404 on cross-workspace terminate to avoid existence leak.
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Execution not found");
	}

	const result = await stopDurableRun(target, { mode: "terminate", reason });
	return json(
		{ success: result.confirmed, executionId: params.executionId, ...result },
		{ status: result.confirmed ? 200 : 409 },
	);
};
