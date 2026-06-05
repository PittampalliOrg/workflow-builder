export type GitOpsResourceRef = {
	group: string | null;
	version: string | null;
	resource: string | null;
	kind: string | null;
	namespace: string | null;
	name: string | null;
	uid: string | null;
};

export type GitOpsActivityEvent = {
	eventId: string;
	sequence: number;
	source: string;
	resourceRef: GitOpsResourceRef;
	activityKey: string;
	activityType: string;
	phase: string | null;
	reason: string | null;
	message: string | null;
	observedAt: string;
	correlation: Record<string, unknown>;
	raw: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export type GitOpsActivityEventsResponse = {
	generatedAt: string;
	events: GitOpsActivityEvent[];
};
