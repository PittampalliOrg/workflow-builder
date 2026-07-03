import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Import an agent from a `.md` file with YAML frontmatter. Request body:
 *   { source: "---\nname: ...\n---\nBody..." }
 *
 * Resolves `environment` (by slug or id) and `vaults` (by id) on the host,
 * attaching to the created agent. Failures are non-fatal: an unresolved
 * environment/vault is dropped with a warning in the response.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const source = typeof body.source === "string" ? body.source : "";
	if (!source) return error(400, "source (markdown) is required");

	const result = await getApplicationAdapters().agentImportExport.importAgent({
		source,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	if (result.status === "invalid") return error(400, result.message);

	return json(
		{ agent: result.agent, warnings: result.warnings },
		{ status: 201 },
	);
};
