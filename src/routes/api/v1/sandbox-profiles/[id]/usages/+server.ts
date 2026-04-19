import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { findProfileUsages, getProfile } from "$lib/server/sandbox-profiles/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const profile = await getProfile(params.id);
	if (!profile) return error(404, "Profile not found");
	const usages = await findProfileUsages(profile.slug);
	return json({ usages, total: usages.length });
};
