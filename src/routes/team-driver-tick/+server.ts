import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { runTeamDriverTick } from "$lib/server/teams/team-driver";

/**
 * POST /team-driver-tick — invoked on a schedule by the Dapr cron INPUT binding
 * `team-driver-tick` (Dapr input bindings POST to the app at /<component-name>,
 * so the path must equal the component name). Dapr-native scheduler, NOT a K8s
 * CronJob.
 *
 * Unauthenticated by design and safe: the tick only re-nudges teammates that are
 * BOTH idle AND have claimable work, with deterministic sourceEventIds (deduped),
 * so a stray external call is at worst a no-op or an already-desired nudge. It is
 * a lost-idle BACKSTOP; the reactive session-events hook is the happy path.
 */
export const POST: RequestHandler = async () => {
	const result = await runTeamDriverTick();
	return json({ ok: true, ...result });
};

// Dapr confirms an input-binding subscription by probing OPTIONS /<name> and
// requires a 2xx; without this SvelteKit returns 405 and Dapr never delivers the
// cron events. Also accept GET as a no-op health probe.
export const OPTIONS: RequestHandler = async () => new Response(null, { status: 200 });
export const GET: RequestHandler = async () => json({ ok: true, nudged: 0 });
