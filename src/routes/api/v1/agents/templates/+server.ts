import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { AGENT_TEMPLATES } from "$lib/server/agent-templates/catalog";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	// Return a trimmed listing — don't ship the full config shape in the list view
	return json({
		templates: AGENT_TEMPLATES.map((t) => ({
			slug: t.slug,
			name: t.name,
			description: t.description,
			providerIcons: t.providerIcons,
			highlights: t.highlights,
			mcpServerCount: t.suggestedMcpServers?.length ?? 0,
			model: t.config.modelSpec,
		})),
	});
};
