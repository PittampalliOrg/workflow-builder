import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { getRuntimeMetadata } from "$lib/server/gitops/deployment-metadata";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	return json(await getRuntimeMetadata());
};
