import { query } from '$app/server';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { listAgentRuntimeSandboxes } from '$lib/server/agent-runtime-sandboxes';
import { attachSandboxSessions } from '$lib/server/sandbox-sessions';
import type { Sandbox } from '$lib/types/sandbox';
import { queryHistogramGrouped } from '$lib/server/otel/metrics';

export const getSandboxes = query(async (): Promise<Sandbox[]> => {
	const [openshellResult, runtimeResult] = await Promise.allSettled([
		openshellRuntimeFetch('/api/v1/sandboxes'),
		listAgentRuntimeSandboxes()
	]);
	const openshellSandboxes =
		openshellResult.status === 'fulfilled' && openshellResult.value.ok
			? normalizeSandboxResponse(await openshellResult.value.json())
			: [];
	const runtimeSandboxes =
		runtimeResult.status === 'fulfilled' ? runtimeResult.value : [];
	return attachSandboxSessions([...openshellSandboxes, ...runtimeSandboxes]);
});

const WARM_POOL_WINDOW_SEC = 3600;
const METRICS_DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? 'dev';

export type WarmPoolTemplateStat = {
	template: string;
	coldCount: number;
	warmCount: number;
	totalCount: number;
	hitRatePct: number;
	coldP50Ms: number | null;
	coldP95Ms: number | null;
	warmP50Ms: number | null;
	warmP95Ms: number | null;
	estimatedTimeSavedSec: number;
};

export type WarmPoolStats = {
	windowSeconds: number;
	cluster: string;
	perTemplate: WarmPoolTemplateStat[];
	hasData: boolean;
};

/**
 * Aggregate agent-sandbox claim-startup latency over the last hour, grouped
 * by sandbox_template + launch_type. Reads `agent_sandbox_claim_startup_latency_ms`
 * (Histogram). ClickHouse may be unreachable in some envs — wrapped in try/catch
 * so the page still loads; UI hides the card when hasData is false.
 */
export const getWarmPoolStats = query(async (): Promise<WarmPoolStats> => {
	const to = new Date();
	const from = new Date(to.getTime() - WARM_POOL_WINDOW_SEC * 1000);
	try {
		const rows = await queryHistogramGrouped(
			'agent_sandbox_claim_startup_latency_ms',
			['launch_type', 'sandbox_template'],
			[0.5, 0.95],
			{ from, to },
			{ cluster: METRICS_DEFAULT_CLUSTER }
		);
		type Acc = {
			cold?: { count: number; p50: number; p95: number };
			warm?: { count: number; p50: number; p95: number };
		};
		const byTemplate = new Map<string, Acc>();
		for (const row of rows) {
			const template = row.labels.sandbox_template || '(unknown)';
			const lt = (row.labels.launch_type || '').toLowerCase();
			const entry = byTemplate.get(template) ?? {};
			const payload = {
				count: row.count,
				p50: row.percentiles.p50,
				p95: row.percentiles.p95
			};
			if (lt === 'cold') entry.cold = payload;
			else if (lt === 'warm' || lt === 'pool' || lt === 'recycled')
				entry.warm = payload;
			byTemplate.set(template, entry);
		}
		const perTemplate: WarmPoolTemplateStat[] = [];
		for (const [template, acc] of byTemplate.entries()) {
			const cold = acc.cold;
			const warm = acc.warm;
			const coldCount = cold?.count ?? 0;
			const warmCount = warm?.count ?? 0;
			const total = coldCount + warmCount;
			if (total === 0) continue;
			const timeSaved =
				cold && warm && cold.p50 > warm.p50
					? ((cold.p50 - warm.p50) * warmCount) / 1000
					: 0;
			perTemplate.push({
				template,
				coldCount,
				warmCount,
				totalCount: total,
				hitRatePct: total > 0 ? (warmCount / total) * 100 : 0,
				coldP50Ms: cold?.p50 ?? null,
				coldP95Ms: cold?.p95 ?? null,
				warmP50Ms: warm?.p50 ?? null,
				warmP95Ms: warm?.p95 ?? null,
				estimatedTimeSavedSec: timeSaved
			});
		}
		perTemplate.sort((a, b) => b.totalCount - a.totalCount);
		return {
			windowSeconds: WARM_POOL_WINDOW_SEC,
			cluster: METRICS_DEFAULT_CLUSTER,
			perTemplate,
			hasData: perTemplate.length > 0
		};
	} catch {
		return {
			windowSeconds: WARM_POOL_WINDOW_SEC,
			cluster: METRICS_DEFAULT_CLUSTER,
			perTemplate: [],
			hasData: false
		};
	}
});
