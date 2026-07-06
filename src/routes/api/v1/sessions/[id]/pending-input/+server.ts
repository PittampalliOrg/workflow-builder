import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

// Session-scoped read of the needs-input cache (sessions.pending_input). Lets a
// list/fleet client poll a single parked session without opening its event
// stream. Project-scoped exactly like the sibling session GET (getSessionDetail
// enforces workspace ownership); events remain the source of truth.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getApplicationAdapters().workflowData.getSessionDetail({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!session) return error(404, "Session not found");
	return json({ pendingInput: session.pendingInput ?? null });
};
