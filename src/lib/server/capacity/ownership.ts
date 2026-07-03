import { createHash } from 'node:crypto';
import type {
	CapacityBlockedWorkload,
	CapacityContributorSnapshot,
	CapacityObserverSnapshot,
	CapacityOwnerHint,
	CapacityOwnerRef
} from '$lib/types/capacity';

export type SessionOwnershipRow = {
	sessionId: string;
	sessionTitle: string | null;
	sessionRuntimeAppId: string | null;
	agentId: string;
	agentName: string;
	agentSlug: string | null;
	workflowExecutionId: string | null;
	workflowId: string | null;
	workflowName: string | null;
};

export type BenchmarkOwnershipRow = {
	runId: string;
	runStatus: string;
	runInstanceRowId: string;
	instanceId: string;
	agentId: string | null;
	agentName: string | null;
	agentSlug: string | null;
	workflowExecutionId: string | null;
	workflowId: string | null;
	workflowName: string | null;
	sessionId: string | null;
	sessionTitle: string | null;
};

export type OwnershipContext = {
	projectId: string | null | undefined;
	workspaceSlug: string;
};

export type CapacityOwnershipRepository = {
	resolveSessionRows(input: {
		projectId: string;
		sessionIds: string[];
		agentAppIds: string[];
	}): Promise<SessionOwnershipRow[]>;
	resolveBenchmarkRows(input: {
		projectId: string;
		runIds: string[];
		instanceIds: string[];
	}): Promise<BenchmarkOwnershipRow[]>;
};

const EMPTY_OWNERSHIP_REPOSITORY: CapacityOwnershipRepository = {
	async resolveSessionRows() {
		return [];
	},
	async resolveBenchmarkRows() {
		return [];
	}
};

export async function enrichCapacitySnapshotOwnership(
	snapshot: CapacityObserverSnapshot,
	context: OwnershipContext,
	repository: CapacityOwnershipRepository = EMPTY_OWNERSHIP_REPOSITORY
): Promise<CapacityObserverSnapshot> {
	if (!context.projectId) return snapshot;
	const hints = collectHints(snapshot);
	if (hints.length === 0) return snapshot;

	const sessionIds = uniqueNonEmpty(hints.map((hint) => hint.sessionId));
	const agentAppIds = uniqueNonEmpty(hints.map((hint) => hint.agentAppId));
	const benchmarkRunIds = uniqueNonEmpty(hints.map((hint) => hint.benchmarkRunId));
	const benchmarkInstanceIds = uniqueNonEmpty(hints.map((hint) => hint.benchmarkInstanceId));

	const [sessionRows, benchmarkRows] = await Promise.all([
		repository.resolveSessionRows({
			projectId: context.projectId,
			sessionIds,
			agentAppIds
		}),
		repository.resolveBenchmarkRows({
			projectId: context.projectId,
			runIds: benchmarkRunIds,
			instanceIds: benchmarkInstanceIds
		})
	]);

	const sessionById = new Map(sessionRows.map((row) => [row.sessionId, row]));
	const sessionByAppId = new Map<string, SessionOwnershipRow>();
	for (const row of sessionRows) {
		if (row.sessionRuntimeAppId) sessionByAppId.set(row.sessionRuntimeAppId, row);
		sessionByAppId.set(sessionHostAppId(row.sessionId), row);
	}

	const benchmarkByRunId = new Map<string, BenchmarkOwnershipRow>();
	const benchmarkByInstanceId = new Map<string, BenchmarkOwnershipRow>();
	for (const row of benchmarkRows) {
		benchmarkByRunId.set(row.runId, row);
		benchmarkByRunId.set(normalizeHostExecutionLabelValue(row.runId), row);
		benchmarkByInstanceId.set(row.instanceId, row);
		benchmarkByInstanceId.set(normalizeHostExecutionLabelValue(row.instanceId), row);
	}

	const ownersForHints = (itemHints: CapacityOwnerHint[] | undefined): CapacityOwnerRef[] => {
		const refs: CapacityOwnerRef[] = [];
		for (const hint of itemHints ?? []) {
			const sessionRow =
				(hint.sessionId ? sessionById.get(hint.sessionId) : undefined) ??
				(hint.agentAppId ? sessionByAppId.get(hint.agentAppId) : undefined);
			if (sessionRow) {
				refs.push(...sessionOwners(sessionRow, context.workspaceSlug, hint));
			}

			const benchmarkRow =
				(hint.benchmarkRunId ? benchmarkByRunId.get(hint.benchmarkRunId) : undefined) ??
				(hint.benchmarkInstanceId
					? benchmarkByInstanceId.get(hint.benchmarkInstanceId)
					: undefined);
			if (benchmarkRow) {
				refs.push(...benchmarkOwners(benchmarkRow, context.workspaceSlug, hint));
			}
		}
		return dedupeOwners(refs);
	};

	return {
		...snapshot,
		blockedWorkloads: snapshot.blockedWorkloads.map((item) => ({
			...item,
			owners: ownersForHints(item.ownerHints)
		})),
		contributors: snapshot.contributors?.map((item) => ({
			...item,
			owners: ownersForHints(item.ownerHints)
		}))
	};
}

function collectHints(snapshot: CapacityObserverSnapshot): CapacityOwnerHint[] {
	return [
		...snapshot.blockedWorkloads.flatMap((item) => item.ownerHints ?? []),
		...(snapshot.contributors ?? []).flatMap((item) => item.ownerHints ?? [])
	].filter(hasAnyHint);
}

function hasAnyHint(hint: CapacityOwnerHint): boolean {
	return Boolean(
		hint.sessionId?.trim() ||
			hint.agentAppId?.trim() ||
			hint.benchmarkRunId?.trim() ||
			hint.benchmarkInstanceId?.trim()
	);
}

function sessionOwners(
	row: SessionOwnershipRow,
	workspaceSlug: string,
	hint: CapacityOwnerHint
): CapacityOwnerRef[] {
	const owners: CapacityOwnerRef[] = [];
	if (row.workflowExecutionId && row.workflowId) {
		owners.push({
			kind: 'workflowRun',
			id: row.workflowExecutionId,
			label: row.workflowName ? `${row.workflowName} run` : shortId(row.workflowExecutionId),
			href: `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.workflowExecutionId}`,
			secondaryLabel: shortId(row.workflowExecutionId),
			source: hint.source,
			confidence: hint.sessionId === row.sessionId ? 'direct' : 'derived'
		});
	}
	owners.push({
		kind: 'session',
		id: row.sessionId,
		label: row.sessionTitle?.trim() || shortId(row.sessionId),
		href: `/workspaces/${workspaceSlug}/sessions/${row.sessionId}`,
		source: hint.source,
		confidence: hint.sessionId === row.sessionId ? 'direct' : 'derived'
	});
	owners.push({
		kind: 'agent',
		id: row.agentId,
		label: row.agentName || row.agentSlug || shortId(row.agentId),
		href: `/workspaces/${workspaceSlug}/agents/${row.agentId}`,
		secondaryLabel: row.agentSlug ?? undefined,
		source: hint.source,
		confidence: 'derived'
	});
	return owners;
}

function benchmarkOwners(
	row: BenchmarkOwnershipRow,
	workspaceSlug: string,
	hint: CapacityOwnerHint
): CapacityOwnerRef[] {
	const owners: CapacityOwnerRef[] = [];
	if (row.workflowExecutionId && row.workflowId) {
		owners.push({
			kind: 'workflowRun',
			id: row.workflowExecutionId,
			label: row.workflowName ? `${row.workflowName} run` : shortId(row.workflowExecutionId),
			href: `/workspaces/${workspaceSlug}/workflows/${row.workflowId}/runs/${row.workflowExecutionId}`,
			source: hint.source,
			confidence: 'inferred'
		});
	}
	if (row.sessionId) {
		owners.push({
			kind: 'session',
			id: row.sessionId,
			label: row.sessionTitle?.trim() || shortId(row.sessionId),
			href: `/workspaces/${workspaceSlug}/sessions/${row.sessionId}`,
			source: hint.source,
			confidence: 'inferred'
		});
	}
	if (row.agentId) {
		owners.push({
			kind: 'agent',
			id: row.agentId,
			label: row.agentName || row.agentSlug || shortId(row.agentId),
			href: `/workspaces/${workspaceSlug}/agents/${row.agentId}`,
			source: hint.source,
			confidence: 'inferred'
		});
	}
	owners.push(
		{
			kind: 'benchmarkRun',
			id: row.runId,
			label: `Benchmark ${shortId(row.runId)}`,
			href: `/workspaces/${workspaceSlug}/benchmarks/runs/${row.runId}`,
			secondaryLabel: row.runStatus,
			source: hint.source,
			confidence: hint.benchmarkRunId === row.runId ? 'direct' : 'inferred'
		},
		{
			kind: 'benchmarkInstance',
			id: row.runInstanceRowId,
			label: row.instanceId,
			href: `/workspaces/${workspaceSlug}/benchmarks/runs/${row.runId}`,
			source: hint.source,
			confidence: hint.benchmarkInstanceId === row.instanceId ? 'direct' : 'inferred'
		}
	);
	return owners;
}

function dedupeOwners(owners: CapacityOwnerRef[]): CapacityOwnerRef[] {
	const seen = new Set<string>();
	const out: CapacityOwnerRef[] = [];
	for (const owner of owners) {
		const key = `${owner.kind}:${owner.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(owner);
	}
	const order = ['workflowRun', 'session', 'agent', 'benchmarkRun', 'benchmarkInstance'];
	return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

export function sessionHostAppId(sessionId: string): string {
	const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
	return `agent-session-${digest}`;
}

export function normalizeHostExecutionLabelValue(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 63)
			.replace(/-+$/g, '') || 'execution'
	);
}

function shortId(id: string): string {
	return id.length <= 12 ? id : `${id.slice(0, 8)}...`;
}

export const __capacityOwnershipForTest = {
	normalizeHostExecutionLabelValue,
	sessionHostAppId,
	sessionOwners,
	benchmarkOwners,
	dedupeOwners
};
