import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/pieces?auth=true
 * Returns all pieces that require auth (for connection creation combobox).
 */
export const GET: RequestHandler = async ({ url }) => {
	const authOnly = url.searchParams.get('auth') === 'true';
	try {
		return json(await getApplicationAdapters().workflowData.listConnectablePieces({ authOnly }));
	} catch (err) {
		if (err instanceof Error && err.message === "Database not configured") {
			return json([]);
		}
		throw err;
	}
};
