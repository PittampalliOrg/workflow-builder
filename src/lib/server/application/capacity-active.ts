import type { PendingInput } from "$lib/types/sessions";

export type CapacityFleetActivityItem = { key: string; kind: string; id: string };

export type CapacityFleetActivity = {
	lastEventAt: string | null;
	recentCount: number;
	series: { t: string; value: number }[];
	tokens: number;
	tokensIn: number;
	tokensOut: number;
	/** Non-null when a mapped session is waiting on a human (sessions.pending_input).
	 * For a workflowRun key, set if ANY child session is parked. Drives the Fleet
	 * "Needs input" badge without a per-row event scan. */
	pendingInput: PendingInput | null;
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
