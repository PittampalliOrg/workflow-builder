import { getRequestEvent, query } from "$app/server";
import {
	summarizeFleetActivity,
	type FleetActivity,
	type FleetActivityItem,
} from "$lib/server/sessions/fleet-activity";

/**
 * Per-row activity for the Fleet "Active work" table. The page passes the
 * currently-active item identities ({key, kind, id}); we return a map keyed by
 * item.key with a heartbeat timestamp + a short event-rate series. Project-
 * scoped via the request session, mirroring getCapacityOverview.
 */
export const getFleetActivity = query(
	"unchecked",
	async (items: FleetActivityItem[]): Promise<Record<string, FleetActivity>> => {
		if (!Array.isArray(items) || items.length === 0) return {};
		const event = getRequestEvent();
		const projectId = event.locals.session?.projectId;
		return summarizeFleetActivity(items, projectId);
	},
);
