import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";

export type {
	CapacityOwnerTimeline,
	CapacityOwnerTimelinePoint,
	CapacityPsiTrendPoint,
	CapacityPsiTrendsSnapshot,
	CapacityTrendsSnapshot,
	SchedulingLatencySnapshot,
} from "$lib/server/application/capacity-overview";

export const getSchedulingLatency = query(
	"unchecked",
	async (cluster: string) => {
		return getApplicationAdapters().capacityOverview.getSchedulingLatency(cluster);
	},
);

export const getCapacityPsiTrends = query(
	"unchecked",
	async (cluster: string) => {
		return getApplicationAdapters().capacityOverview.getPsiTrends(cluster);
	},
);

export const getCapacityTrends = query("unchecked", async (cluster: string) => {
	return getApplicationAdapters().capacityOverview.getTrends(cluster);
});

export const getCapacityOwnerTimeline = query(
	"unchecked",
	async ({ cluster, resource }: { cluster: string; resource: string }) => {
		return getApplicationAdapters().capacityOverview.getOwnerTimeline({
			cluster,
			resource,
		});
	},
);

export const getCapacityOverview = query(async () => {
	const event = getRequestEvent();
	return getApplicationAdapters().capacityOverview.getOverview({
		projectId: event.locals.session?.projectId,
		workspaceSlug: event.params.slug ?? "default",
	});
});
