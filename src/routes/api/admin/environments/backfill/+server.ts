import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * One-shot admin endpoint to create a default environment and link every
 * agent that has no `environment_id` to it. Idempotent. Invoked at Phase 1
 * cutover deploy time so the new resolver has something to resolve for
 * existing agents.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return json(await getApplicationAdapters().environments.backfillDefault());
};
