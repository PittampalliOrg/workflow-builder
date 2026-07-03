import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/runtimes — read-only projection of the runtime registry SSOT for the
 * canvas agent node's capability-driven config UI. An agent's `runtime` field
 * resolves to one of these descriptors; the config panel uses the capabilities
 * to decide which options are relevant (model override, CLI credential prereq,
 * native-vs-custom goal, etc.) so new runtimes surface automatically.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return json(getApplicationAdapters().runtimeCatalog.listRuntimes());
};
