import {
	summarizeFleetActivity,
} from "$lib/server/sessions/fleet-activity";
import type {
	CapacityFleetActivity,
	CapacityFleetActivityItem,
	CapacityFleetActivityPort,
} from "$lib/server/application/capacity-active";

export class SessionFleetActivityAdapter implements CapacityFleetActivityPort {
	summarize(
		items: CapacityFleetActivityItem[],
		projectId?: string | null,
	): Promise<Record<string, CapacityFleetActivity>> {
		return summarizeFleetActivity(items, projectId);
	}
}
