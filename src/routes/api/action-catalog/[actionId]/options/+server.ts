import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationActionOptionsError } from "$lib/server/application/action-options";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}

	const actionId = params.actionId;
	if (!actionId) {
		throw error(400, "actionId is required");
	}

	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	try {
		const result = await getApplicationAdapters().actionOptions.getOptions({
			actionId,
			userId: locals.session.userId,
			body,
			requestUrl: request.url,
			cookie: request.headers.get("cookie") || "",
		});
		return json(result.payload, { status: result.status });
	} catch (err) {
		if (err instanceof ApplicationActionOptionsError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
