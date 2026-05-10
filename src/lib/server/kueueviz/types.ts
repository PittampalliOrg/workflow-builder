/**
 * Projected snapshot types — what the BFF emits to the browser.
 *
 * Upstream KueueViz returns full Kubernetes CRDs on every WebSocket
 * tick. We project down to UI-needed fields before fanning out to SSE
 * subscribers (10× shrink at medium-cluster scale, plus a stable shape
 * the Svelte UI can rely on without `unknown`s).
 */

export type WorkloadStatus =
	| 'pending'
	| 'reserving'
	| 'admitted'
	| 'finished'
	| 'failed'
	| 'evicted'
	| 'unknown';

export type WorkloadConditionLite = {
	type: string;
	status: string;
	reason?: string;
	message?: string;
	lastTransitionTime?: string;
};

export type WorkloadSnapshot = {
	uid: string;
	name: string;
	namespace: string;
	queueName: string;
	clusterQueueName: string | null;
	priority: number | null;
	priorityClassName: string | null;
	creationTimestamp: string;
	status: WorkloadStatus;
	active: boolean;
	conditions: WorkloadConditionLite[];
	podSetCount: number;
	totalPods: number;
	/**
	 * Labels lifted into the Workload from the pod template via Kueue's
	 * Plain Pod / Job integration. The orchestrator stamps `agent-app-id`,
	 * `benchmark-run-id`, `benchmark-instance-id`, `agent` etc here, and
	 * cross-feature joins (Sessions ↔ Workload, Benchmarks ↔ Workload)
	 * read these.
	 */
	labels: Record<string, string>;
};

export type ResourceQuantityLite = {
	resource: string;
	nominal: string;
	borrowingLimit?: string | null;
	lendingLimit?: string | null;
	used: string;
	reserved: string;
};

export type FlavorUsageLite = {
	flavor: string;
	resources: ResourceQuantityLite[];
};

export type ClusterQueueSnapshot = {
	name: string;
	cohort: string | null;
	queueingStrategy: string | null;
	stopPolicy: string | null;
	admittedWorkloads: number;
	pendingWorkloads: number;
	reservingWorkloads: number;
	flavorsUsage: FlavorUsageLite[];
	conditions: WorkloadConditionLite[];
};

export type LocalQueueSnapshot = {
	name: string;
	namespace: string;
	clusterQueue: string;
	admittedWorkloads: number;
	pendingWorkloads: number;
	reservingWorkloads: number;
};

export type ResourceFlavorSnapshot = {
	name: string;
	nodeLabels: Record<string, string>;
	nodeTaints: Array<{ key: string; value?: string; effect: string }>;
	tolerations: Array<{ key?: string; operator?: string; value?: string; effect?: string }>;
};

export type CohortSnapshot = {
	name: string;
	parentName: string | null;
	clusterQueues: string[];
};

export type WorkloadPodSetSummary = {
	name: string;
	count: number;
	requests: Record<string, string>;
};

export type WorkloadAdmissionAssignment = {
	podSetName: string;
	flavor: string;
	resourceAssignments: Record<string, string>;
};

export type WorkloadAdmission = {
	clusterQueue: string;
	assignments: WorkloadAdmissionAssignment[];
};

export type WorkloadDetailSnapshot = WorkloadSnapshot & {
	podSets: WorkloadPodSetSummary[];
	admission: WorkloadAdmission | null;
	annotations: Record<string, string>;
};

export type WorkloadEventSnapshot = {
	type: string;
	reason: string;
	message: string;
	count: number;
	firstTimestamp: string | null;
	lastTimestamp: string | null;
	source: string | null;
};

/** Connection state for a single endpoint subscription. */
export type StreamStatus = 'connecting' | 'open' | 'degraded' | 'closed';

export type StatusEvent = {
	state: StreamStatus;
	error?: string;
	at: string;
};
