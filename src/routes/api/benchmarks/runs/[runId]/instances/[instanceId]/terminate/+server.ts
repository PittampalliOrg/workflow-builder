import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const internal = validateInternalToken(request);
	if (!locals.session?.userId && !internal) return error(401, "Authentication required");
	if (!internal && !locals.session?.projectId) return error(404, "Run not found");
	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");
	const body = await request.json().catch(() => null);
	const result =
		await getApplicationAdapters().benchmarkInstanceLifecycle.terminateBenchmarkRunInstance({
			projectId: internal ? null : locals.session?.projectId,
			runId,
			instanceId,
			reason:
				body && typeof body.reason === "string"
					? body.reason
					: "benchmark instance terminated by user",
		});
	if (!result) return error(404, "Instance not found in this run");
	if (!result.cleanupConfirmed) {
		return json(
			{
				...result,
				error:
					"Durable workflow termination has not been confirmed; resources were left active for retry.",
			},
			{ status: 409 },
		);
	}
	return json(result);
};
