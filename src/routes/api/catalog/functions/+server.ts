import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ locals }) => {
	try {
		return json(
			await getApplicationAdapters().workflowData.listCatalogFunctions({
				userId: locals.session?.userId ?? null,
			}),
		);
	} catch (err) {
		if (err instanceof Error && err.message === "Database not configured") {
			return json({
				functions: [],
				count: 0,
				error: String(err),
			});
		}
		throw err;
	}
};
