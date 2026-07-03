import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	const action = await getApplicationAdapters().actionCatalog.getDetail({
		actionId: params.actionId,
		userId: locals.session?.userId ?? null,
	});
	if (!action) {
		return json({ error: "Action not found" }, { status: 404 });
	}
	return json(action);
};
