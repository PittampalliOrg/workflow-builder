import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	agents,
	benchmarkRunInstances,
	benchmarkRuns,
	sessions,
	workflowExecutions,
	workflows
} from '$lib/server/db/schema';
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
const ACTIVE_SESSION_STATUSES = new Set(['queued', 'running', 'rescheduling', 'active', 'starting']);
const ACTIVE_BENCHMARK_STATUSES = new Set(['queued', 'running', 'inferencing', 'evaluating']);
const ACTIVE_WORKFLOW_STATUSES = new Set(['pending', 'running']);

type ResourceKey = (typeof RESOURCE_KEYS)[number];
type ResourceMap = Record<string, number>;

type BusinessContext = {
	projectId?: string | null;
	workspaceSlug: string;
};

type MutableItem = CapacityBusinessWorkItem;

type SessionDetail = {
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

type WorkflowDetail = {
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	workflowId: string;
	workflowName: string;
};

type BenchmarkRunDetail = {
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

type BenchmarkInstanceDetail = {
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

type DetailMaps = {
	sessions: Map<string, SessionDetail>;
	workflows: Map<string, WorkflowDetail>;
	benchmarkRuns: Map<string, BenchmarkRunDetail>;
	benchmarkInstances: Map<string, BenchmarkInstanceDetail>;
};

export async function buildCapacityBusinessWork(
	snapshot: CapacityObserverSnapshot,
	context: BusinessContext
): Promise<CapacityBusinessWorkSummary> {
	const active = aggregateActiveWork(snapshot);
	const details = context.projectId ? await loadDetails(active, context.projectId) : emptyDetails();
	const recent = context.projectId ? await loadRecentWork(context.projectId, context.workspaceSlug) : [];

	for (const item of active) applyDetails(item, details, context.workspaceSlug);
	active.sort(compareActiveWork);

	const infrastructure = active.filter((item) => item.kind === 'infrastructure');
	const businessActive = active.filter((item) => item.kind !== 'infrastructure');
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

async function loadDetails(items: CapacityBusinessWorkItem[], projectId: string): Promise<DetailMaps> {
	const idsByKind = {
		session: idsFor(items, 'session'),
		workflowRun: idsFor(items, 'workflowRun'),
		benchmarkRun: idsFor(items, 'benchmarkRun'),
		benchmarkInstance: idsFor(items, 'benchmarkInstance')
	};
	const [sessionRows, workflowRows, benchmarkRunRows, benchmarkInstanceRows] = await Promise.all([
		selectSessions(projectId, idsByKind.session),
		selectWorkflowExecutions(projectId, idsByKind.workflowRun),
		selectBenchmarkRuns(projectId, idsByKind.benchmarkRun),
		selectBenchmarkInstances(projectId, idsByKind.benchmarkInstance)
	]);
	return {
		sessions: new Map(sessionRows.map((row) => [row.id, row])),
		workflows: new Map(workflowRows.map((row) => [row.id, row])),
		benchmarkRuns: new Map(benchmarkRunRows.map((row) => [row.id, row])),
		benchmarkInstances: new Map(benchmarkInstanceRows.map((row) => [row.id, row]))
	};
}

function emptyDetails(): DetailMaps {
	return {
		sessions: new Map(),
		workflows: new Map(),
		benchmarkRuns: new Map(),
		benchmarkInstances: new Map()
	};
}

async function selectSessions(projectId: string, ids: string[]): Promise<SessionDetail[]> {
	if (!db || ids.length === 0) return [];
	return (await db
		.select({
			id: sessions.id,
			title: sessions.title,
			status: sessions.status,
			createdAt: sessions.createdAt,
			updatedAt: sessions.updatedAt,
			completedAt: sessions.completedAt,
			usage: sessions.usage,
			agentId: agents.id,
			agentName: agents.name,
			agentSlug: agents.slug,
			modelSpec: sql<string | null>`${sessions.usage}->>'modelSpec'`,
			workflowExecutionId: sessions.workflowExecutionId,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name
		})
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.leftJoin(workflowExecutions, eq(workflowExecutions.id, sessions.workflowExecutionId))
		.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(and(eq(sessions.projectId, projectId), inArray(sessions.id, ids)))) as SessionDetail[];
}

async function selectWorkflowExecutions(projectId: string, ids: string[]): Promise<WorkflowDetail[]> {
	if (!db || ids.length === 0) return [];
	return (await db
		.select({
			id: workflowExecutions.id,
			status: workflowExecutions.status,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration,
			workflowId: workflows.id,
			workflowName: workflows.name
		})
		.from(workflowExecutions)
		.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(and(eq(workflowExecutions.projectId, projectId), inArray(workflowExecutions.id, ids)))) as WorkflowDetail[];
}

async function selectBenchmarkRuns(projectId: string, ids: string[]): Promise<BenchmarkRunDetail[]> {
	if (!db || ids.length === 0) return [];
	return (await db
		.select({
			id: benchmarkRuns.id,
			status: benchmarkRuns.status,
			startedAt: benchmarkRuns.startedAt,
			completedAt: benchmarkRuns.completedAt,
			createdAt: benchmarkRuns.createdAt,
			updatedAt: benchmarkRuns.updatedAt,
			modelNameOrPath: benchmarkRuns.modelNameOrPath,
			modelConfigLabel: benchmarkRuns.modelConfigLabel,
			agentId: agents.id,
			agentName: agents.name
		})
		.from(benchmarkRuns)
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(and(eq(benchmarkRuns.projectId, projectId), inArray(benchmarkRuns.id, ids)))) as BenchmarkRunDetail[];
}

async function selectBenchmarkInstances(
	projectId: string,
	ids: string[]
): Promise<BenchmarkInstanceDetail[]> {
	if (!db || ids.length === 0) return [];
	return (await db
		.select({
			id: benchmarkRunInstances.id,
			runId: benchmarkRunInstances.runId,
			instanceId: benchmarkRunInstances.instanceId,
			status: benchmarkRunInstances.status,
			startedAt: benchmarkRunInstances.startedAt,
			completedAt: benchmarkRunInstances.evaluatedAt,
			createdAt: benchmarkRunInstances.createdAt,
			updatedAt: benchmarkRunInstances.updatedAt,
			modelNameOrPath: benchmarkRuns.modelNameOrPath,
			modelConfigLabel: benchmarkRuns.modelConfigLabel,
			sessionId: benchmarkRunInstances.sessionId,
			workflowExecutionId: benchmarkRunInstances.workflowExecutionId
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.where(and(eq(benchmarkRuns.projectId, projectId), inArray(benchmarkRunInstances.id, ids)))) as BenchmarkInstanceDetail[];
}

async function loadRecentWork(
	projectId: string,
	workspaceSlug: string
): Promise<CapacityBusinessWorkItem[]> {
	if (!db) return [];
	const [sessionRows, workflowRows, runRows, instanceRows] = await Promise.all([
		(await db
			.select({
				id: sessions.id,
				title: sessions.title,
				status: sessions.status,
				createdAt: sessions.createdAt,
				updatedAt: sessions.updatedAt,
				completedAt: sessions.completedAt,
				usage: sessions.usage,
				agentId: agents.id,
				agentName: agents.name,
				agentSlug: agents.slug,
				modelSpec: sql<string | null>`${sessions.usage}->>'modelSpec'`,
				workflowExecutionId: sessions.workflowExecutionId,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.leftJoin(workflowExecutions, eq(workflowExecutions.id, sessions.workflowExecutionId))
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(sessions.projectId, projectId))
			.orderBy(desc(sessions.updatedAt))
			.limit(25)) as SessionDetail[],
		(await db
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
				workflowId: workflows.id,
				workflowName: workflows.name
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(workflowExecutions.projectId, projectId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(25)) as WorkflowDetail[],
		(await db
			.select({
				id: benchmarkRuns.id,
				status: benchmarkRuns.status,
				startedAt: benchmarkRuns.startedAt,
				completedAt: benchmarkRuns.completedAt,
				createdAt: benchmarkRuns.createdAt,
				updatedAt: benchmarkRuns.updatedAt,
				modelNameOrPath: benchmarkRuns.modelNameOrPath,
				modelConfigLabel: benchmarkRuns.modelConfigLabel,
				agentId: agents.id,
				agentName: agents.name
			})
			.from(benchmarkRuns)
			.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.where(eq(benchmarkRuns.projectId, projectId))
			.orderBy(desc(benchmarkRuns.updatedAt))
			.limit(25)) as BenchmarkRunDetail[],
		(await db
			.select({
				id: benchmarkRunInstances.id,
				runId: benchmarkRunInstances.runId,
				instanceId: benchmarkRunInstances.instanceId,
				status: benchmarkRunInstances.status,
				startedAt: benchmarkRunInstances.startedAt,
				completedAt: benchmarkRunInstances.evaluatedAt,
				createdAt: benchmarkRunInstances.createdAt,
				updatedAt: benchmarkRunInstances.updatedAt,
				modelNameOrPath: benchmarkRuns.modelNameOrPath,
				modelConfigLabel: benchmarkRuns.modelConfigLabel,
				sessionId: benchmarkRunInstances.sessionId,
				workflowExecutionId: benchmarkRunInstances.workflowExecutionId
			})
			.from(benchmarkRunInstances)
			.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
			.where(eq(benchmarkRuns.projectId, projectId))
			.orderBy(desc(benchmarkRunInstances.updatedAt))
			.limit(25)) as BenchmarkInstanceDetail[]
	]);
	const recent = [
		...sessionRows.filter((row) => row.completedAt || !ACTIVE_SESSION_STATUSES.has(row.status)).map((row) => recentSession(row, workspaceSlug)),
		...workflowRows.filter((row) => row.completedAt || !ACTIVE_WORKFLOW_STATUSES.has(row.status)).map((row) => recentWorkflow(row, workspaceSlug)),
		...runRows.filter((row) => row.completedAt || !ACTIVE_BENCHMARK_STATUSES.has(row.status)).map((row) => recentBenchmarkRun(row, workspaceSlug)),
		...instanceRows.filter((row) => row.completedAt || !ACTIVE_BENCHMARK_STATUSES.has(row.status)).map((row) => recentBenchmarkInstance(row, workspaceSlug))
	];
	return recent.sort((a, b) => itemEndMs(b) - itemEndMs(a)).slice(0, 12);
}

function applyDetails(item: CapacityBusinessWorkItem, details: DetailMaps, workspaceSlug: string) {
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

function applySessionDetail(item: CapacityBusinessWorkItem, row: SessionDetail, workspaceSlug: string) {
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

function applyWorkflowDetail(item: CapacityBusinessWorkItem, row: WorkflowDetail, workspaceSlug: string) {
	item.title = `${row.workflowName} run`;
	item.status = row.status;
	item.startedAt = row.startedAt.toISOString();
	item.completedAt = row.completedAt?.toISOString() ?? null;
	item.ageSeconds = secondsSince(row.startedAt);
	item.durationSeconds = row.duration ? Number(row.duration) / 1000 : secondsBetween(row.startedAt, row.completedAt ?? new Date());
	item.href = `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.id}`;
}

function applyBenchmarkRunDetail(item: CapacityBusinessWorkItem, row: BenchmarkRunDetail, workspaceSlug: string) {
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
	row: BenchmarkInstanceDetail,
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

function recentSession(row: SessionDetail, workspaceSlug: string): CapacityBusinessWorkItem {
	const item = baseRecent('session', row.id, row.title?.trim() || row.agentName || shortId(row.id), `/workspaces/${workspaceSlug}/sessions/${row.id}`);
	applySessionDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

function recentWorkflow(row: WorkflowDetail, workspaceSlug: string): CapacityBusinessWorkItem {
	const item = baseRecent('workflowRun', row.id, `${row.workflowName} run`, `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.id}`);
	applyWorkflowDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

function recentBenchmarkRun(row: BenchmarkRunDetail, workspaceSlug: string): CapacityBusinessWorkItem {
	const item = baseRecent('benchmarkRun', row.id, `Benchmark ${shortId(row.id)}`, `/workspaces/${workspaceSlug}/benchmarks/runs/${row.id}`);
	applyBenchmarkRunDetail(item, row, workspaceSlug);
	item.active = false;
	return item;
}

function recentBenchmarkInstance(row: BenchmarkInstanceDetail, workspaceSlug: string): CapacityBusinessWorkItem {
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

function idsFor(items: CapacityBusinessWorkItem[], kind: CapacityBusinessWorkKind): string[] {
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

function itemEndMs(item: CapacityBusinessWorkItem): number {
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
