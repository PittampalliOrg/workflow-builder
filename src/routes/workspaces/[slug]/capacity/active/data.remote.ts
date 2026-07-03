import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	CapacityFleetActivity,
	CapacityFleetActivityItem,
} from "$lib/server/application/capacity-active";

/**
 * Per-row activity for the Fleet "Active work" table. The page passes the
 * currently-active item identities ({key, kind, id}); we return a map keyed by
 * item.key with a heartbeat timestamp + a short event-rate series. Project-
 * scoped via the request session, mirroring getCapacityOverview.
 */
export const getFleetActivity = query(
	"unchecked",
	async (
		items: CapacityFleetActivityItem[],
	): Promise<Record<string, CapacityFleetActivity>> => {
		const event = getRequestEvent();
		return getApplicationAdapters().capacityActive.getFleetActivity({
			items,
			projectId: event.locals.session?.projectId,
		});
	},
);
