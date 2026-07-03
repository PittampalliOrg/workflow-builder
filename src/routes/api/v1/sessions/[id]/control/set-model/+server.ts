import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionAgentConfigCommandResult } from "$lib/server/application/session-agent-config";

/**
 * Change the model for subsequent turns. The session workflow merges the
 * canonical agent-config patch at the next turn boundary.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	return sessionAgentConfigResponse(
		await getApplicationAdapters().sessionAgentConfig.setModel({
			sessionId: params.id,
			body,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function sessionAgentConfigResponse(result: SessionAgentConfigCommandResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body);
}
