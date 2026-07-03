import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = await request.json().catch(() => ({}));
	const result =
		await getApplicationAdapters().benchmarkCapacityDiagnostics.inspectLaunchCapacity({
			projectId: locals.session.projectId,
			body,
		});
	if (result.status === "error") {
		if (result.body) return json(result.body, { status: result.httpStatus });
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};
