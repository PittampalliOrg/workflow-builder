import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { confirmDurableStop, inspectDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * GET /api/workflows/executions/[executionId]/stop/status
 *
 * Poll the convergence of a previously-requested stop (the UI shows "Stopping…"
 * after a 202 and polls this until `state:"confirmed"`). Idempotent: finalizes
 * the DB + reaps sandboxes once the durable tree is confirmed terminal.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const target = { kind: "workflowExecution" as const, id: params.executionId };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Execution not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Execution not found");
	}
	const result = await confirmDurableStop(target);
	return json({ state: result.state });
};
