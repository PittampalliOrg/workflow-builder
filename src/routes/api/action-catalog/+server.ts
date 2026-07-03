import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ locals }) => {
	return json(
		await getApplicationAdapters().actionCatalog.loadSnapshot({
			userId: locals.session?.userId ?? null,
		}),
	);
};
