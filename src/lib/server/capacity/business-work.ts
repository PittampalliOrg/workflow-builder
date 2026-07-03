import type {
	CapacityBlockedWorkload,
	CapacityBusinessWorkItem,
	CapacityBusinessWorkKind,
	CapacityBusinessWorkSummary,
	CapacityContributorSnapshot,
	CapacityObserverSnapshot,
	CapacityOwnerRef
} from '$lib/types/capacity';

const RESOURCE_KEYS = ['cpu', 'memory', 'ephemeral-storage', 'pods'] as const;
// 'idle' included: a goal-loop / interactive session sits in `idle` between turns
// while its pod stays alive (it IS active work). Matches the activity-cell "live"
// set so panel inclusion and the live heartbeat dot agree.
export const ACTIVE_SESSION_STATUSES = new Set([
	'queued',
	'running',
	'rescheduling',
	'active',
	'starting',
	'idle'
]);
export const ACTIVE_BENCHMARK_STATUSES = new Set(['queued', 'running', 'inferencing', 'evaluating']);
export const ACTIVE_WORKFLOW_STATUSES = new Set(['pending', 'running']);

type ResourceKey = (typeof RESOURCE_KEYS)[number];
type ResourceMap = Record<string, number>;

type BusinessContext = {
	projectId?: string | null;
	workspaceSlug: string;
};

type MutableItem = CapacityBusinessWorkItem;

export type CapacityBusinessWorkSessionDetail = {
	id: string;
	title: string | null;
	status: string;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
	usage: Record<string, unknown>;
	agentId: string;
	agentName: string;
	agentSlug: string | null;
	modelSpec: string | null;
	workflowExecutionId: string | null;
	workflowId: string | null;
	workflowName: string | null;
};

export type CapacityBusinessWorkWorkflowDetail = {
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	workflowId: string;
	workflowName: string;
	currentNodeName: string | null;
	progress: number | null;
	rerunOfExecutionId: string | null;
	resumeFromNode: string | null;
};

export type CapacityBusinessWorkBenchmarkRunDetail = {
	id: string;
	status: string;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	modelNameOrPath: string;
	modelConfigLabel: string | null;
	agentId: string;
	agentName: string;
};

export type CapacityBusinessWorkBenchmarkInstanceDetail = {
	id: string;
	runId: string;
	instanceId: string;
	status: string;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	modelNameOrPath: string;
	modelConfigLabel: string | null;
	sessionId: string | null;
	workflowExecutionId: string | null;
};

export type CapacityBusinessWorkDetailMaps = {
	sessions: Map<string, CapacityBusinessWorkSessionDetail>;
	workflows: Map<string, CapacityBusinessWorkWorkflowDetail>;
	benchmarkRuns: Map<string, CapacityBusinessWorkBenchmarkRunDetail>;
	benchmarkInstances: Map<string, CapacityBusinessWorkBenchmarkInstanceDetail>;
};

export type CapacityBusinessWorkRepository = {
	loadDetails(
		items: CapacityBusinessWorkItem[],
		projectId: string
	): Promise<CapacityBusinessWorkDetailMaps>;
	loadDbWork(
		projectId: string,
		workspaceSlug: string
	): Promise<{ active: CapacityBusinessWorkItem[]; recent: CapacityBusinessWorkItem[] }>;
};

export async function buildCapacityBusinessWork(
	snapshot: CapacityObserverSnapshot,
	context: BusinessContext,
	repository: CapacityBusinessWorkRepository = EMPTY_BUSINESS_WORK_REPOSITORY
): Promise<CapacityBusinessWorkSummary> {
	const active = aggregateActiveWork(snapshot);
	const details = context.projectId
		? await repository.loadDetails(active, context.projectId)
		: emptyDetails();
	const dbWork = context.projectId
		? await repository.loadDbWork(context.projectId, context.workspaceSlug)
		: { active: [] as CapacityBusinessWorkItem[], recent: [] as CapacityBusinessWorkItem[] };
	const recent = dbWork.recent;

	for (const item of active) applyDetails(item, details, context.workspaceSlug);
	active.sort(compareActiveWork);

	const infrastructure = active.filter((item) => item.kind === 'infrastructure');
	const businessActive = active.filter((item) => item.kind !== 'infrastructure');

	// DB-authoritative backfill: the external capacity observer can report
	// contributors with NO owner attribution, so every pod collapses to
	// 'infrastructure' and genuinely-active sessions/runs never reach this panel.
	// Union in active DB rows (scoped to the project) keyed by `${kind}:${id}`.
	// Observer-derived items win on key (they carry real resource/pressure data);
	// DB-only items appear with zero observed resources but correct status/title.
	const businessActiveKeys = new Set(businessActive.map((item) => item.key));
	for (const item of dbWork.active) {
		if (!businessActiveKeys.has(item.key)) {
			businessActiveKeys.add(item.key);
			businessActive.push(item);
		}
	}
	businessActive.sort(compareActiveWork);
	const totals = emptyResources();
	const observedTotals = emptyResources();
	for (const item of businessActive) {
		addResources(totals, item.requestedResources);
		addResources(observedTotals, item.observedResources);
	}

	return {
		active: businessActive,
		recent,
		infrastructure,
		totals: {
			activeWork: businessActive.length,
			recentWork: recent.length,
			unattributedInfrastructure: infrastructure.length,
			requestedResources: totals,
			observedResources: observedTotals,
			blockedWorkloads: snapshot.blockedWorkloads.length
		},
		generatedAt: new Date().toISOString()
	};
}

export function aggregateActiveWork(snapshot: CapacityObserverSnapshot): CapacityBusinessWorkItem[] {
	const groups = new Map<string, MutableItem>();
	for (const contributor of snapshot.contributors ?? []) {
		const owner = primaryOwner(contributor.owners);
		const key = owner ? `${owner.kind}:${owner.id}` : infrastructureKey(contributor);
		const item = groups.get(key) ?? createItem(key, owner, contributor);
		addContributor(item, contributor, snapshot);
		groups.set(key, item);
	}
	for (const workload of snapshot.blockedWorkloads) {
		const owner = primaryOwner(workload.owners);
		const key = owner ? `${owner.kind}:${owner.id}` : `infrastructure:blocked:${workload.namespace}:${workload.name}`;
		const item = groups.get(key) ?? createItem(key, owner, workload);
		item.blockedWorkloadCount += 1;
		if (workload.queue) addUnique(item.queues, workload.queue);
		if (workload.namespace) addUnique(item.namespaces, workload.namespace);
		mergeOwners(item, workload.owners ?? []);
		groups.set(key, item);
	}
	return [...groups.values()].map((item) => ({
		...item,
		pressure: {
			cpuPct: pct(item.requestedResources.cpu, resourceAllocatable(snapshot, 'cpu')),
			memoryPct: pct(item.requestedResources.memory, resourceAllocatable(snapshot, 'memory')),
			podsPct: pct(item.requestedResources.pods, resourceAllocatable(snapshot, 'pods')),
			storagePct: pct(
				item.requestedResources['ephemeral-storage'],
				resourceAllocatable(snapshot, 'ephemeral-storage')
			)
		},
		telemetry: {
			requested: resourceTotal(item.requestedResources) > 0,
			observed: resourceTotal(item.observedResources) > 0
		}
	}));
}

function createItem(
	key: string,
	owner: CapacityOwnerRef | null,
	source: CapacityContributorSnapshot | CapacityBlockedWorkload
): MutableItem {
	const kind = (owner?.kind ?? 'infrastructure') as CapacityBusinessWorkKind;
	const id = owner?.id ?? key;
	const fallbackTitle =
		'podCount' in source
			? `${source.namespace}/${source.name}`
			: `${source.namespace}/${source.name}`;
	return {
		key,
		kind,
		id,
		title: owner?.label ?? fallbackTitle,
		status: 'active',
		href: owner?.href,
		active: true,
		startedAt: null,
		completedAt: null,
		ageSeconds: null,
		durationSeconds: null,
		model: null,
		provider: null,
		owners: owner ? [owner] : [],
		requestedResources: emptyResources(),
		observedResources: emptyResources(),
		podCount: 0,
		contributorCount: 0,
		blockedWorkloadCount: 0,
		queues: [],
		namespaces: [],
		contributorKeys: [],
		pressure: {},
		telemetry: { requested: false, observed: false }
	};
}

function addContributor(
	item: MutableItem,
	contributor: CapacityContributorSnapshot,
	snapshot: CapacityObserverSnapshot
) {
	item.contributorCount += 1;
	item.podCount += contributor.podCount;
	item.contributorKeys.push(contributor.key);
	if (contributor.queue) addUnique(item.queues, contributor.queue);
	if (contributor.namespace) addUnique(item.namespaces, contributor.namespace);
	addResources(item.requestedResources, contributor.resources);
	addResources(item.observedResources, contributor.observedResources ?? {});
	mergeOwners(item, contributor.owners ?? []);
	item.pressure = {
		cpuPct: pct(item.requestedResources.cpu, resourceAllocatable(snapshot, 'cpu')),
		memoryPct: pct(item.requestedResources.memory, resourceAllocatable(snapshot, 'memory')),
		podsPct: pct(item.requestedResources.pods, resourceAllocatable(snapshot, 'pods')),
		storagePct: pct(
			item.requestedResources['ephemeral-storage'],
			resourceAllocatable(snapshot, 'ephemeral-storage')
		)
	};
}

function primaryOwner(owners: CapacityOwnerRef[] | undefined): CapacityOwnerRef | null {
	if (!owners?.length) return null;
	for (const kind of ['benchmarkInstance', 'workflowRun', 'session', 'benchmarkRun', 'agent'] as const) {
		const found = owners.find((owner) => owner.kind === kind);
		if (found) return found;
	}
	return owners[0];
}

function infrastructureKey(contributor: CapacityContributorSnapshot): string {
	const name = contributor.kind === 'critical' ? contributor.name : `${contributor.namespace}/${contributor.name}`;
	return `infrastructure:${contributor.kind}:${name}`;
}

const EMPTY_BUSINESS_WORK_REPOSITORY: CapacityBusinessWorkRepository = {
	async loadDetails() {
		return emptyDetails();
	},
	async loadDbWork() {
		return { active: [], recent: [] };
	}
};

export function emptyDetails(): CapacityBusinessWorkDetailMaps {
	return {
		sessions: new Map(),
		workflows: new Map(),
		benchmarkRuns: new Map(),
		benchmarkInstances: new Map()
	};
}

function applyDetails(
	item: CapacityBusinessWorkItem,
	details: CapacityBusinessWorkDetailMaps,
	workspaceSlug: string
) {
	if (item.kind === 'session') {
		const row = details.sessions.get(item.id);
		if (!row) return;
		applySessionDetail(item, row, workspaceSlug);
	}
	if (item.kind === 'workflowRun') {
		const row = details.workflows.get(item.id);
		if (!row) return;
		applyWorkflowDetail(item, row, workspaceSlug);
	}
	if (item.kind === 'benchmarkRun') {
		const row = details.benchmarkRuns.get(item.id);
		if (!row) return;
		applyBenchmarkRunDetail(item, row, workspaceSlug);
	}
	if (item.kind === 'benchmarkInstance') {
		const row = details.benchmarkInstances.get(item.id);
		if (!row) return;
		applyBenchmarkInstanceDetail(item, row, workspaceSlug);
	}
}

function applySessionDetail(
	item: CapacityBusinessWorkItem,
	row: CapacityBusinessWorkSessionDetail,
	workspaceSlug: string
) {
	item.title = row.title?.trim() || row.agentName || shortId(row.id);
	item.status = row.status;
	item.startedAt = row.createdAt.toISOString();
	item.completedAt = row.completedAt?.toISOString() ?? null;
	item.ageSeconds = secondsSince(row.createdAt);
	item.durationSeconds = secondsBetween(row.createdAt, row.completedAt ?? new Date());
	item.model = row.modelSpec || modelFromUsage(row.usage);
	item.provider = providerFromModel(item.model);
	item.href = `/workspaces/${workspaceSlug}/sessions/${row.id}`;
}

function applyWorkflowDetail(
	item: CapacityBusinessWorkItem,
	row: CapacityBusinessWorkWorkflowDetail,
	workspaceSlug: string
) {
	item.title = `${row.workflowName} run`;
	item.status = row.status;
	item.startedAt = row.startedAt.toISOString();
	item.completedAt = row.completedAt?.toISOString() ?? null;
	item.ageSeconds = secondsSince(row.startedAt);
	item.durationSeconds = row.duration ? Number(row.duration) / 1000 : secondsBetween(row.startedAt, row.completedAt ?? new Date());
	item.currentNodeName = row.currentNodeName;
	item.progress = row.progress;
	item.rerunOfExecutionId = row.rerunOfExecutionId;
	item.forkedFromNode = row.resumeFromNode;
	item.workflowId = row.workflowId;
	item.href = `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.id}`;
}

function applyBenchmarkRunDetail(
	item: CapacityBusinessWorkItem,
	row: CapacityBusinessWorkBenchmarkRunDetail,
	workspaceSlug: string
) {
	item.title = `Benchmark ${shortId(row.id)}`;
	item.status = row.status;
	item.startedAt = row.startedAt?.toISOString() ?? row.createdAt.toISOString();
	item.completedAt = row.completedAt?.toISOString() ?? null;
	item.ageSeconds = secondsSince(row.startedAt ?? row.createdAt);
	item.durationSeconds = secondsBetween(row.startedAt ?? row.createdAt, row.completedAt ?? new Date());
	item.model = row.modelNameOrPath;
	item.provider = providerFromModel(row.modelNameOrPath);
	item.href = `/workspaces/${workspaceSlug}/benchmarks/runs/${row.id}`;
}

function applyBenchmarkInstanceDetail(
	item: CapacityBusinessWorkItem,
	row: CapacityBusinessWorkBenchmarkInstanceDetail,
	workspaceSlug: string
) {
	item.title = row.instanceId;
	item.status = row.status;
	item.startedAt = row.startedAt?.toISOString() ?? row.createdAt.toISOString();
	item.completedAt = row.completedAt?.toISOString() ?? null;
	item.ageSeconds = secondsSince(row.startedAt ?? row.createdAt);
	item.durationSeconds = secondsBetween(row.startedAt ?? row.createdAt, row.completedAt ?? new Date());
	item.model = row.modelNameOrPath;
	item.provider = providerFromModel(row.modelNameOrPath);
	item.href = `/workspaces/${workspaceSlug}/benchmarks/runs/${row.runId}`;
}

export function recentSession(
	row: CapacityBusinessWorkSessionDetail,
	workspaceSlug: string
): CapacityBusinessWorkItem {
	const item = baseRecent('session', row.id, row.title?.trim() || row.agentName || shortId(row.id), `/workspaces/${workspaceSlug}/sessions/${row.id}`);
	applySessionDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

export function recentWorkflow(
	row: CapacityBusinessWorkWorkflowDetail,
	workspaceSlug: string
): CapacityBusinessWorkItem {
	const item = baseRecent('workflowRun', row.id, `${row.workflowName} run`, `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.id}`);
	applyWorkflowDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

export function recentBenchmarkRun(
	row: CapacityBusinessWorkBenchmarkRunDetail,
	workspaceSlug: string
): CapacityBusinessWorkItem {
	const item = baseRecent('benchmarkRun', row.id, `Benchmark ${shortId(row.id)}`, `/workspaces/${workspaceSlug}/benchmarks/runs/${row.id}`);
	applyBenchmarkRunDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

export function recentBenchmarkInstance(
	row: CapacityBusinessWorkBenchmarkInstanceDetail,
	workspaceSlug: string
): CapacityBusinessWorkItem {
	const item = baseRecent('benchmarkInstance', row.id, row.instanceId, `/workspaces/${workspaceSlug}/benchmarks/runs/${row.runId}`);
	applyBenchmarkInstanceDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

function baseRecent(
	kind: CapacityBusinessWorkKind,
	id: string,
	title: string,
	href: string
): CapacityBusinessWorkItem {
	return {
		key: `${kind}:${id}`,
		kind,
		id,
		title,
		status: 'unknown',
		href,
		active: false,
		owners: [{ kind: kind as Exclude<CapacityBusinessWorkKind, 'infrastructure'>, id, label: title, href }],
		requestedResources: emptyResources(),
		observedResources: emptyResources(),
		resourceSeconds: emptyResources(),
		podCount: 0,
		contributorCount: 0,
		blockedWorkloadCount: 0,
		queues: [],
		namespaces: [],
		contributorKeys: [],
		pressure: {},
		telemetry: { requested: false, observed: false }
	};
}

function compareActiveWork(a: CapacityBusinessWorkItem, b: CapacityBusinessWorkItem): number {
	if (b.blockedWorkloadCount !== a.blockedWorkloadCount) return b.blockedWorkloadCount - a.blockedWorkloadCount;
	const cpu = (b.pressure.cpuPct ?? 0) - (a.pressure.cpuPct ?? 0);
	if (cpu !== 0) return cpu;
	return resourceTotal(b.requestedResources) - resourceTotal(a.requestedResources);
}

export function idsFor(items: CapacityBusinessWorkItem[], kind: CapacityBusinessWorkKind): string[] {
	return [...new Set(items.filter((item) => item.kind === kind).map((item) => item.id))];
}

function mergeOwners(item: MutableItem, owners: CapacityOwnerRef[]) {
	const seen = new Set(item.owners.map((owner) => `${owner.kind}:${owner.id}`));
	for (const owner of owners) {
		const key = `${owner.kind}:${owner.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		item.owners.push(owner);
	}
}

function emptyResources(): ResourceMap {
	return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, 0]));
}

function addResources(target: ResourceMap, source: ResourceMap) {
	for (const key of RESOURCE_KEYS) {
		target[key] = (target[key] ?? 0) + Number(source[key] ?? 0);
	}
}

function addUnique(target: string[], value: string) {
	if (!target.includes(value)) target.push(value);
}

function resourceTotal(resources: ResourceMap): number {
	return RESOURCE_KEYS.reduce((acc, key) => acc + Math.max(0, Number(resources[key] ?? 0)), 0);
}

function resourceAllocatable(snapshot: CapacityObserverSnapshot, resource: ResourceKey): number {
	return snapshot.resources.find((entry) => entry.resource === resource)?.allocatable ?? 0;
}

function pct(value: number | undefined, total: number): number | null {
	if (!total) return null;
	return Math.max(0, (Number(value ?? 0) / total) * 100);
}

function secondsSince(value: Date): number {
	return secondsBetween(value, new Date());
}

function secondsBetween(start: Date, end: Date): number {
	return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

export function itemEndMs(item: CapacityBusinessWorkItem): number {
	return new Date(item.completedAt ?? item.startedAt ?? 0).getTime() || 0;
}

function modelFromUsage(usage: Record<string, unknown>): string | null {
	for (const key of ['modelSpec', 'model', 'model_name', 'modelName']) {
		const value = usage[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function providerFromModel(model: string | null | undefined): string | null {
	if (!model) return null;
	const [provider] = model.split('/');
	return provider && provider !== model ? provider : null;
}

function shortId(id: string): string {
	return id.length <= 12 ? id : `${id.slice(0, 8)}...`;
}

export const __capacityBusinessWorkForTest = {
	aggregateActiveWork,
	primaryOwner,
	emptyResources,
	addResources,
	providerFromModel
};
