import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getVclusterPreview,
	teardownVclusterPreview,
} from "$lib/server/workflows/vcluster-preview";

/** Status of one Tier-2 preview (Job phase == environment readiness). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const preview = await getVclusterPreview(params.name);
	return json({ preview });
};

/** Tear down a Tier-2 preview (drops per-preview DB + vcluster delete). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const preview = await teardownVclusterPreview(params.name);
	return json({ preview });
};
