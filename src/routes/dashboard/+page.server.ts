import type { PageServerLoad } from './$types';

type Source<T> = {
	ok: boolean;
	status: number | null;
	data: T | null;
	error: string | null;
};

type DashboardPayload = {
	stats?: {
		activeSessions?: number;
		sessionsToday?: number;
		archivedLast24h?: number;
		tokensOut7d?: number;
		tokensIn7d?: number;
		totalAgents?: number;
		totalEnvironments?: number;
		totalVaults?: number;
	};
	activeSessions?: Array<Record<string, unknown>>;
	recentChanges?: Array<Record<string, unknown>>;
};

type RunsPayload = { runs?: Array<Record<string, unknown>> };
type DevPayload = { environments?: Array<Record<string, unknown>> };
type GitOpsPayload = { events?: Array<Record<string, unknown>> };
type UsagePayload = {
	totals?: {
		tokensIn?: number;
		tokensOut?: number;
		cacheReadTokens?: number;
		cacheCreateTokens?: number;
		sessionCount?: number;
		toolCalls?: number;
	};
};
type CostPayload = { totalCost?: number; byModel?: Array<Record<string, unknown>> };

async function readSource<T>(fetch: typeof globalThis.fetch, path: string): Promise<Source<T>> {
	try {
		const response = await fetch(path);
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				data: null,
				error: `HTTP ${response.status}`
			};
		}
		return {
			ok: true,
			status: response.status,
			data: (await response.json()) as T,
			error: null
		};
	} catch (err) {
		return {
			ok: false,
			status: null,
			data: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isLiveStatus(value: unknown): boolean {
	return ['running', 'pending', 'rescheduling', 'provisioning', 'progressing'].includes(
		String(value ?? '').toLowerCase()
	);
}

function isBadStatus(value: unknown): boolean {
	return ['error', 'failed', 'failure', 'degraded', 'unhealthy'].includes(
		String(value ?? '').toLowerCase()
	);
}

function latest(items: Array<{ at: string | null }>): string | null {
	return items
		.map((item) => item.at)
		.filter((value): value is string => !!value)
		.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
}

export const load: PageServerLoad = async ({ fetch }) => {
	const now = new Date();
	const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const end = now.toISOString();

	const [dashboard, runs, capacity, dev, gitops, usage, cost] = await Promise.all([
		readSource<DashboardPayload>(fetch, '/api/v1/dashboard'),
		readSource<RunsPayload>(fetch, '/api/v1/runs?limit=30'),
		readSource<Record<string, unknown>>(fetch, '/api/capacity/overview'),
		readSource<DevPayload>(fetch, '/api/dev-environments'),
		readSource<GitOpsPayload>(fetch, '/api/v1/gitops/events?limit=30'),
		readSource<UsagePayload>(
			fetch,
			`/api/v1/usage?start=${encodeURIComponent(weekAgo)}&end=${encodeURIComponent(end)}`
		),
		readSource<CostPayload>(
			fetch,
			`/api/v1/cost?start=${encodeURIComponent(monthAgo)}&end=${encodeURIComponent(end)}`
		)
	]);

	const activeSessions = dashboard.data?.activeSessions ?? [];
	const allRuns = runs.data?.runs ?? [];
	const liveRuns = allRuns.filter((run) => isLiveStatus(run.status));
	const failedRuns = allRuns.filter((run) => isBadStatus(run.status));
	const environments = dev.data?.environments ?? [];
	const liveEnvironments = environments.filter((env) => env.ready === true || isLiveStatus(env.runStatus));
	const gitopsEvents = gitops.data?.events ?? [];
	const activeDeployEvents = gitopsEvents.filter((event) => isLiveStatus(event.phase));

	const observer = capacity.data?.observer as
		| { available?: boolean; snapshot?: Record<string, unknown> | null; error?: string | null }
		| undefined;
	const capacityObserverAvailable = capacity.ok && observer?.available === true;
	const capacityObserverError =
		capacity.error ??
		(observer?.error ? `observer: ${observer.error}` : !capacity.ok ? 'Capacity endpoint unavailable' : null) ??
		(observer?.available === false ? 'Capacity observer unavailable' : null);
	const snapshot = observer?.snapshot ?? null;
	const queues = Array.isArray(snapshot?.queues) ? (snapshot.queues as Array<Record<string, unknown>>) : [];
	const resources = Array.isArray(snapshot?.resources)
		? (snapshot.resources as Array<Record<string, unknown>>)
		: [];
	const blockedWorkloads = Array.isArray(snapshot?.blockedWorkloads)
		? (snapshot.blockedWorkloads as Array<Record<string, unknown>>)
		: [];
	const warnings = Array.isArray(snapshot?.warnings) ? (snapshot.warnings as string[]) : [];
	const pendingWorkloads = queues.reduce((sum, queue) => sum + asNumber(queue.pendingWorkloads), 0);
	const admittedWorkloads = queues.reduce((sum, queue) => sum + asNumber(queue.admittedWorkloads), 0);
	const inactiveQueues = queues.filter((queue) => queue.active === false);
	const resourcePressure = resources
		.map((resource) => {
			const budget = asNumber(resource.renderedBudget) || asNumber(resource.allocatable);
			return budget > 0 ? Math.max(0, Math.min(1, asNumber(resource.requested) / budget)) : 0;
		})
		.sort((a, b) => b - a)[0] ?? null;

	const liveWork = [
		...activeSessions.map((session) => ({
			kind: 'session',
			id: asString(session.id) ?? 'session',
			title: asString(session.title) ?? 'Untitled session',
			status: asString(session.status) ?? 'running',
			at: asString(session.updatedAt) ?? asString(session.createdAt),
			href: `/workspaces/default/sessions/${asString(session.id) ?? ''}`,
			meta: asString(session.agentName) ?? 'Agent session'
		})),
		...liveRuns.map((run) => ({
			kind: 'run',
			id: asString(run.executionId) ?? 'run',
			title: asString(run.workflowName) ?? asString(run.executionId) ?? 'Workflow run',
			status: asString(run.status) ?? 'running',
			at: asString(run.startedAt),
			href: `/workspaces/default/workflows/${asString(run.workflowId) ?? ''}/runs/${asString(run.executionId) ?? ''}`,
			meta: `${asNumber(run.sessionCount)} linked sessions`
		})),
		...liveEnvironments.map((env) => ({
			kind: 'preview',
			id: asString(env.executionId) ?? 'preview',
			title: asString(env.service) ?? 'Preview environment',
			status: env.ready === true ? 'ready' : asString(env.runStatus) ?? 'starting',
			at: asString(env.createdAt),
			href: asString(env.browseUrl) ?? `/workspaces/default/workflows/runtime-preview/${asString(env.executionId) ?? ''}`,
			meta: asString(env.sandboxName) ?? asString(env.workspaceRef) ?? 'Live preview'
		})),
		...activeDeployEvents.map((event) => ({
			kind: 'deploy',
			id: asString(event.eventId) ?? 'deploy',
			title:
				asString((event.resourceRef as Record<string, unknown> | undefined)?.name) ??
				asString(event.activityKey) ??
				'GitOps delivery',
			status: asString(event.phase) ?? 'active',
			at: asString(event.observedAt) ?? asString(event.createdAt),
			href: '/admin/gitops',
			meta: asString(event.reason) ?? asString(event.activityType) ?? 'Deployment activity'
		}))
	].sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());

	const timeline = [
		...allRuns.slice(0, 12).map((run) => ({
			kind: 'run',
			title: asString(run.workflowName) ?? 'Workflow run',
			status: asString(run.status) ?? 'unknown',
			at: asString(run.startedAt),
			href: `/workspaces/default/workflows/${asString(run.workflowId) ?? ''}/runs/${asString(run.executionId) ?? ''}`,
			detail: asString(run.executionId)
		})),
		...(dashboard.data?.recentChanges ?? []).map((change) => ({
			kind: asString(change.kind) ?? 'change',
			title: `${asString(change.resourceName) ?? 'Resource'} v${asNumber(change.version)}`,
			status: 'published',
			at: asString(change.publishedAt),
			href:
				change.kind === 'agent'
					? `/workspaces/default/agents/${asString(change.resourceId) ?? ''}`
					: `/workspaces/default/environments/${asString(change.resourceId) ?? ''}`,
			detail: 'Published version'
		})),
		...gitopsEvents.slice(0, 12).map((event) => ({
			kind: 'deploy',
			title:
				asString((event.resourceRef as Record<string, unknown> | undefined)?.name) ??
				asString(event.activityKey) ??
				'GitOps event',
			status: asString(event.phase) ?? asString(event.reason) ?? 'observed',
			at: asString(event.observedAt) ?? asString(event.createdAt),
			href: '/admin/gitops',
			detail: asString(event.message) ?? asString(event.activityType)
		}))
	]
		.filter((item) => item.at)
		.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
		.slice(0, 14);

	const telemetrySources: Record<string, Source<unknown>> = {
		dashboard,
		runs,
		capacity: {
			ok: capacityObserverAvailable,
			status: capacity.status,
			data: capacity.data,
			error: capacityObserverAvailable ? null : (capacityObserverError ?? 'Capacity observer unavailable')
		},
		'dev environments': dev,
		GitOps: gitops,
		usage,
		cost
	};

	const sourceErrors = Object.entries(telemetrySources)
		.filter(([, source]) => !source.ok)
		.map(([name, source]) => `${name}: ${source.error}`);
	const criticalTelemetryUnavailable = !dashboard.ok || !runs.ok || !capacityObserverAvailable;
	const optionalTelemetryUnavailable = sourceErrors.length > 0 && !criticalTelemetryUnavailable;

	const healthReasons: string[] = [];
	if (failedRuns.length > 0) healthReasons.push(`${failedRuns.length} recent workflow run failures`);
	if (!capacityObserverAvailable) {
		healthReasons.push(`Capacity telemetry unavailable: ${capacityObserverError ?? 'observer offline'}`);
	}
	if (blockedWorkloads.length > 0) healthReasons.push(`${blockedWorkloads.length} blocked workloads`);
	if (inactiveQueues.length > 0) healthReasons.push(`${inactiveQueues.length} inactive capacity queues`);
	if (warnings.length > 0) healthReasons.push(warnings[0]);
	if (pendingWorkloads > 0) healthReasons.push(`${pendingWorkloads} workloads waiting for admission`);
	if (optionalTelemetryUnavailable) healthReasons.push(`${sourceErrors.length} optional telemetry sources unavailable`);

	const health =
		failedRuns.length > 0 ||
		blockedWorkloads.length > 0 ||
		inactiveQueues.length > 0 ||
		criticalTelemetryUnavailable
			? 'degraded'
			: warnings.length > 0 || pendingWorkloads > 0 || sourceErrors.length > 0
				? 'attention'
				: 'healthy';

	const narrative =
		health === 'healthy'
			? 'System is steady: live work is admitted, recent activity has no visible failures, and all critical telemetry is reporting.'
			: criticalTelemetryUnavailable
				? 'System confidence is degraded: critical telemetry is missing, so capacity and live-work health need verification.'
				: health === 'attention'
					? 'System needs attention: work is still moving, but capacity or telemetry signals should be checked.'
					: 'System is degraded: recent failures or capacity blockers are affecting operational confidence.';

	return {
		loadedAt: now.toISOString(),
		health,
		healthReasons: healthReasons.slice(0, 4),
		narrative,
		stats: dashboard.data?.stats ?? {},
		liveWork,
		timeline,
		capacity: {
			available: capacityObserverAvailable,
			cluster: asString(snapshot?.cluster),
			sampledAt: asString(snapshot?.sampledAt),
			pendingWorkloads: capacityObserverAvailable ? pendingWorkloads : null,
			admittedWorkloads: capacityObserverAvailable ? admittedWorkloads : null,
			blockedWorkloads: capacityObserverAvailable ? blockedWorkloads.length : null,
			inactiveQueues: capacityObserverAvailable ? inactiveQueues.length : null,
			resourcePressure: capacityObserverAvailable ? resourcePressure : null,
			warnings: warnings.slice(0, 4),
			error: capacityObserverAvailable ? null : (capacityObserverError ?? 'Capacity observer unavailable')
		},
		usage: {
			tokensIn7d: usage.data?.totals?.tokensIn ?? dashboard.data?.stats?.tokensIn7d ?? null,
			tokensOut7d: usage.data?.totals?.tokensOut ?? dashboard.data?.stats?.tokensOut7d ?? null,
			cacheReadTokens7d: usage.data?.totals?.cacheReadTokens ?? null,
			toolCalls7d: usage.data?.totals?.toolCalls ?? null,
			cost30d: cost.data?.totalCost ?? null,
			topModel: asString(cost.data?.byModel?.[0]?.model)
		},
		counts: {
			activeSessions: dashboard.data?.stats?.activeSessions ?? activeSessions.length,
			liveRuns: liveRuns.length,
			livePreviews: liveEnvironments.length,
			activeDeploys: activeDeployEvents.length,
			recentFailures: failedRuns.length
		},
		sources: telemetrySources,
		lastSignalAt: latest([...liveWork, ...timeline])
	};
};
