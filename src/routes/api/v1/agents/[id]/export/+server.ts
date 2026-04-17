import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getAgent } from "$lib/server/agents/registry";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";
import { serializeAgentMarkdown } from "$lib/server/agents/markdown";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const agent = await getAgent(params.id);
	if (!agent) return error(404, "Agent not found");

	let environmentSlug: string | undefined;
	if (agent.environmentId) {
		const env = await resolveEnvironmentRef({
			id: agent.environmentId,
			version: agent.environmentVersion ?? undefined,
		});
		environmentSlug = env?.slug ?? agent.environmentId;
	}

	const markdown = serializeAgentMarkdown({
		name: agent.name,
		description: agent.description,
		config: agent.config,
		environmentSlugOrId: environmentSlug,
		vaultIds: agent.defaultVaultIds,
	});

	return new Response(markdown, {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${agent.slug}.md"`,
		},
	});
};
