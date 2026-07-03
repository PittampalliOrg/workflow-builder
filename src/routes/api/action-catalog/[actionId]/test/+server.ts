import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationActionCatalogTestError } from "$lib/server/application/action-catalog-test";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}

	const actionId = params.actionId;
	if (!actionId) {
		throw error(400, "Action id is required");
	}

	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	try {
		return json(
			await getApplicationAdapters().actionCatalogTest.execute({
				actionId,
				userId: locals.session.userId,
				body,
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationActionCatalogTestError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
