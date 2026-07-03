export type CapacityFleetActivityItem = { key: string; kind: string; id: string };

export type CapacityFleetActivity = {
	lastEventAt: string | null;
	recentCount: number;
	series: { t: string; value: number }[];
	tokens: number;
	tokensIn: number;
	tokensOut: number;
};

export type CapacityFleetActivityPort = {
	summarize(
		items: CapacityFleetActivityItem[],
		projectId?: string | null,
	): Promise<Record<string, CapacityFleetActivity>>;
};

export class ApplicationCapacityActiveService {
	constructor(private readonly deps: { fleetActivity: CapacityFleetActivityPort }) {}

	getFleetActivity(input: {
		items: CapacityFleetActivityItem[];
		projectId?: string | null;
	}): Promise<Record<string, CapacityFleetActivity>> {
		if (!Array.isArray(input.items) || input.items.length === 0) {
			return Promise.resolve({});
		}
		return this.deps.fleetActivity.summarize(input.items, input.projectId);
	}
}
