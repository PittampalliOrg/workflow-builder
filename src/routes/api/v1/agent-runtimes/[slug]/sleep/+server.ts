import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { getApplicationAdapters } from "$lib/server/application";

/**
 * Admin-only: immediate sleep request. Dedicated runtimes scale to zero; shared
 * pools scale back to their configured minReplicas. Gated by
 * projectMembers.role=ADMIN in the caller's active workspace.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const slug = params.slug!;
	const result = await getApplicationAdapters().agentRuntimeControl.sleepRuntime({
		slug,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (result.status === "no_workspace") return error(400, "No active workspace");
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "forbidden") return error(403, result.message);
	return json({ ok: true });
};
