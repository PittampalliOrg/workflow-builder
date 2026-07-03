import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Reverse-lookup: which agents bind a given preset (and at what version).
 * Used by the project Prompts editor to show "Used by N agents" with stale
 * indicators when bindings are pinned to an older version. Project-scoped:
 * the preset must belong to the caller's workspace, and only agents in the
 * same workspace are scanned.
 *
 * The N-agents-per-workspace count is bounded (typically <100), so the
 * straightforward "load configs in memory and filter" beats a JSONB
 * containment query on first reach. Replace with `config @>` containment if
 * the agent count grows past ~1000 per workspace.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(400, "No active workspace");

	const presetId = params.id;
	if (!presetId) return error(400, "preset id is required");

	try {
		const result = await getApplicationAdapters().workflowData.getPromptPresetUsages({
			presetId,
			projectId: locals.session.projectId,
		});
		if (!result) return error(404, "Preset not found in this workspace");
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
};
