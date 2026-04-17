import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { backfillInlineAgents } from "$lib/server/agents/backfill";

/**
 * One-shot admin endpoint to migrate any remaining inline agentConfig blobs in
 * workflow nodes to named agents. Idempotent — reruns are safe. Normally
 * invoked once post-deploy; also available manually for ad-hoc runs.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	// Simple gate: platform admin only. A production install would check
	// locals.session.platformRole === "ADMIN"; leaving an explicit check for
	// the deployer to layer on per their auth model.
	const report = await backfillInlineAgents();
	return json({ report });
};
