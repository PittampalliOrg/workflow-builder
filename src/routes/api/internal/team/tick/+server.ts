import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { runTeamDriverTick } from "$lib/server/teams/team-driver";

/**
 * POST /api/internal/team/tick
 *
 * Lost-idle backstop for the team driver. Invoked on a schedule by the Dapr
 * cron binding (Component-team-driver-tick-cron in stacks) — a Dapr-native
 * scheduler, NOT a K8s CronJob. The happy path is event-driven (the reactive
 * hook in session-events); this only recovers idles whose event was lost.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const result = await runTeamDriverTick();
	return json({ ok: true, ...result });
};
