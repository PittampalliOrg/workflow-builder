import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const status = body.status === "timeout" || body.status === "cancelled" ? body.status : "error";
	const instance =
		await getApplicationAdapters().benchmarkRouteOperations.markInstanceInferenceFailure(
			{
				runId: params.runId,
				instanceId: params.instanceId,
				status,
				error: typeof body.error === "string" ? body.error : null,
				terminationReason:
					typeof body.terminationReason === "string"
						? body.terminationReason
						: null,
			},
		);
	if (!instance) return error(404, "Benchmark instance not found");
	return json({ success: true, instance });
};
