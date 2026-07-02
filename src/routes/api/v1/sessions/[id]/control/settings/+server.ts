import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";

/**
 * Synchronous read: session row + agent config + environment config.
 * Used by the session UI's settings drawer. No event raised.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getApplicationAdapters().workflowData.getSessionEventStreamSnapshot({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!session) return error(404, "Session not found");

	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	const environment = session.environmentId
		? await resolveEnvironmentRef({
				id: session.environmentId,
				version: session.environmentVersion ?? undefined,
			})
		: null;

	return json({
		session,
		agent: agent
			? {
					id: agent.id,
					slug: agent.slug,
					version: agent.version,
					config: agent.config,
				}
			: null,
		environment: environment
			? {
					id: environment.id,
					slug: environment.slug,
					version: environment.version,
					config: environment.config,
				}
			: null,
	});
};
