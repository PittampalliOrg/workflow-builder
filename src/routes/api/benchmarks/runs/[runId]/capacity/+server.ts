import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result =
		await getApplicationAdapters().benchmarkCapacityDiagnostics.getRunCapacity({
			projectId: locals.session.projectId,
			runId: params.runId,
		});
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body);
};
