// Compare-runs engine. Joins per-run agent config, skills, MCP servers,
// hooks, plugins so the compare page can render an axis-diff view.
//
// Entry point: loadCompareData(projectId, runIds[]) returns:
//   - runs: RunConfigSummary[]      (per-run config snapshot)
//   - axisDiff: AxisDiff            (which axes differ across runs)
//   - grid: { runId: { instanceId: InstanceCell } }
//   - allInstanceIds, sharedInstanceIds, disagreements
//
// Project-scoping is enforced per-run, never batched.

import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agentVersions,
	agents,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
} from "$lib/server/db/schema";

export type AxisName =
	| "agent"
	| "agentVersion"
	| "model"
	| "modelLabel"
	| "mcpServerNames"
	| "skillNames"
	| "hookNames"
	| "pluginNames"
	| "concurrency"
	| "evaluationConcurrency"
	| "evaluatorResourceClass";

export type RunConfigSummary = {
	runId: string;
	suiteSlug: string;
	suiteName: string;
	createdAt: string;
	agent: { id: string; slug: string | null; name: string };
	agentVersion: number;
	model: string;
	modelLabel: string | null;
	mcpServerNames: string[];
	skillNames: string[];
	hookNames: string[];
	pluginNames: string[];
	concurrency: number;
	evaluationConcurrency: number;
	evaluatorResourceClass: string;
	resolved: number;
	total: number;
	resolvedRate: number;
	status: string;
};

export type AxisDiff = Record<
	AxisName,
	{
		differs: boolean;
		values: unknown[];
	}
>;

export type InstanceCell = {
	status: string;
	resolved: boolean;
	durationMs: number | null;
	tokens: number | null;
	error: string | null;
	sessionId: string | null;
};

export type CompareData = {
	runs: RunConfigSummary[];
	axisDiff: AxisDiff;
	grid: Record<string, Record<string, InstanceCell>>;
	allInstanceIds: string[];
	sharedInstanceIds: string[];
	disagreements: string[];
	// Phase F: pairwise regression test against the first run (treated as
	// baseline). Length = runs.length - 1; index `i` is the test of runs[i+1]
	// against runs[0]. Empty when fewer than 2 runs.
	regression: import("./regression").RegressionTest[][];
};

const AXES: readonly AxisName[] = [
	"agent",
	"agentVersion",
	"model",
	"modelLabel",
	"mcpServerNames",
	"skillNames",
	"hookNames",
	"pluginNames",
	"concurrency",
	"evaluationConcurrency",
	"evaluatorResourceClass",
];

function asObj(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function namesFromMcpServers(servers: unknown): string[] {
	if (!Array.isArray(servers)) return [];
	return servers
		.map((s) => {
			const o = asObj(s);
			if (!o) return null;
			const name =
				(typeof o.name === "string" && o.name) ||
				(typeof o.server_name === "string" && o.server_name) ||
				(typeof o.serverName === "string" && o.serverName) ||
				(typeof o.displayName === "string" && o.displayName) ||
				null;
			return typeof name === "string" ? name : null;
		})
		.filter((s): s is string => Boolean(s))
		.sort();
}

function namesFromSkills(skills: unknown): string[] {
	if (!Array.isArray(skills)) return [];
	return skills
		.map((s) => {
			const o = asObj(s);
			if (!o) return null;
			const name =
				(typeof o.name === "string" && o.name) ||
				(typeof o.slug === "string" && o.slug) ||
				(typeof o.skillName === "string" && o.skillName) ||
				null;
			return name;
		})
		.filter((s): s is string => Boolean(s))
		.sort();
}

function namesFromHooks(hooks: unknown): string[] {
	const obj = asObj(hooks);
	if (!obj) return [];
	const names = new Set<string>();
	for (const [eventType, matchers] of Object.entries(obj)) {
		if (Array.isArray(matchers) && matchers.length > 0) {
			names.add(eventType);
		}
	}
	return [...names].sort();
}

function namesFromPlugins(plugins: unknown): string[] {
	if (!Array.isArray(plugins)) return [];
	return plugins.filter((s): s is string => typeof s === "string").sort();
}

export function summarizeRunConfig(input: {
	runId: string;
	suiteSlug: string;
	suiteName: string;
	createdAt: Date;
	status: string;
	agent: { id: string; slug: string | null; name: string };
	agentVersion: number;
	model: string;
	modelLabel: string | null;
	concurrency: number;
	evaluationConcurrency: number;
	evaluatorResourceClass: string;
	resolved: number;
	total: number;
	config: Record<string, unknown> | null;
}): RunConfigSummary {
	const cfg = input.config ?? {};
	return {
		runId: input.runId,
		suiteSlug: input.suiteSlug,
		suiteName: input.suiteName,
		createdAt: input.createdAt.toISOString(),
		agent: input.agent,
		agentVersion: input.agentVersion,
		model: input.model,
		modelLabel: input.modelLabel,
		mcpServerNames: namesFromMcpServers(cfg.mcpServers),
		skillNames: namesFromSkills(cfg.skills),
		hookNames: namesFromHooks(cfg.hooks),
		pluginNames: namesFromPlugins(cfg.plugins),
		concurrency: input.concurrency,
		evaluationConcurrency: input.evaluationConcurrency,
		evaluatorResourceClass: input.evaluatorResourceClass,
		resolved: input.resolved,
		total: input.total,
		resolvedRate: input.total > 0 ? input.resolved / input.total : 0,
		status: input.status,
	};
}

export function buildAxisDiff(runs: RunConfigSummary[]): AxisDiff {
	const out: Partial<AxisDiff> = {};
	for (const axis of AXES) {
		const values = runs.map((r) => readAxis(r, axis));
		const fingerprints = values.map((v) => JSON.stringify(v ?? null));
		out[axis] = {
			differs: new Set(fingerprints).size > 1,
			values,
		};
	}
	return out as AxisDiff;
}

function readAxis(r: RunConfigSummary, axis: AxisName): unknown {
	switch (axis) {
		case "agent":
			return r.agent.slug ?? r.agent.id ?? r.agent.name;
		case "agentVersion":
			return r.agentVersion;
		case "model":
			return r.model;
		case "modelLabel":
			return r.modelLabel;
		case "mcpServerNames":
			return r.mcpServerNames;
		case "skillNames":
			return r.skillNames;
		case "hookNames":
			return r.hookNames;
		case "pluginNames":
			return r.pluginNames;
		case "concurrency":
			return r.concurrency;
		case "evaluationConcurrency":
			return r.evaluationConcurrency;
		case "evaluatorResourceClass":
			return r.evaluatorResourceClass;
	}
}

function tokenSum(usage: Record<string, unknown> | null | undefined): number | null {
	if (!usage) return null;
	const t = usage.total_tokens ?? usage.totalTokens;
	if (typeof t === "number" && Number.isFinite(t)) return t;
	const i = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
	const o = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
	const sum = (Number.isFinite(i) ? i : 0) + (Number.isFinite(o) ? o : 0);
	return sum > 0 ? sum : null;
}

function durationFor(
	startedAt: Date | null,
	completedAt: Date | null,
): number | null {
	if (!startedAt || !completedAt) return null;
	const a = startedAt.getTime();
	const b = completedAt.getTime();
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
	return b - a;
}

export async function loadCompareData(
	projectId: string,
	runIds: string[],
): Promise<CompareData> {
	if (!db) throw error(503, "Database not configured");
	const database = db;
	const ids = Array.from(new Set(runIds.map((s) => s.trim()).filter(Boolean)));
	if (ids.length < 2) throw error(400, "Provide at least 2 runs to compare");
	if (ids.length > 4) throw error(400, "Compare supports at most 4 runs");

	const runs: RunConfigSummary[] = [];
	const grid: Record<string, Record<string, InstanceCell>> = {};

	for (const runId of ids) {
		const [row] = await database
			.select({
				run: benchmarkRuns,
				suiteSlug: benchmarkSuites.slug,
				suiteName: benchmarkSuites.name,
				agentName: agents.name,
				agentSlug: agents.slug,
				config: agentVersions.config,
			})
			.from(benchmarkRuns)
			.innerJoin(
				benchmarkSuites,
				eq(benchmarkSuites.id, benchmarkRuns.suiteId),
			)
			.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.leftJoin(
				agentVersions,
				and(
					eq(agentVersions.agentId, benchmarkRuns.agentId),
					eq(agentVersions.version, benchmarkRuns.agentVersion),
				),
			)
			.where(
				and(
					eq(benchmarkRuns.id, runId),
					eq(benchmarkRuns.projectId, projectId),
				),
			)
			.limit(1);

		if (!row) throw error(404, `Run ${runId} not found`);

		const summary = (row.run.summary ?? {}) as Record<string, unknown>;
		const total =
			typeof summary.total === "number"
				? summary.total
				: Array.isArray(row.run.selectedInstanceIds)
					? row.run.selectedInstanceIds.length
					: 0;
		const resolved =
			typeof summary.resolved === "number" ? summary.resolved : 0;

		runs.push(
			summarizeRunConfig({
				runId,
				suiteSlug: row.suiteSlug,
				suiteName: row.suiteName,
				createdAt: row.run.createdAt,
				status: row.run.status,
				agent: {
					id: row.run.agentId,
					slug: row.agentSlug ?? null,
					name: row.agentName,
				},
				agentVersion: row.run.agentVersion,
				model: row.run.modelNameOrPath,
				modelLabel: row.run.modelConfigLabel,
				concurrency: row.run.concurrency,
				evaluationConcurrency: row.run.evaluationConcurrency,
				evaluatorResourceClass: row.run.evaluatorResourceClass,
				resolved,
				total,
				config: row.config as Record<string, unknown> | null,
			}),
		);

		const instanceRows = await database
			.select({
				instanceId: benchmarkRunInstances.instanceId,
				status: benchmarkRunInstances.status,
				startedAt: benchmarkRunInstances.startedAt,
				inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
				usage: benchmarkRunInstances.usage,
				error: benchmarkRunInstances.error,
				sessionId: benchmarkRunInstances.sessionId,
			})
			.from(benchmarkRunInstances)
			.where(eq(benchmarkRunInstances.runId, runId));

		const cells: Record<string, InstanceCell> = {};
		for (const ri of instanceRows) {
			cells[ri.instanceId] = {
				status: ri.status,
				resolved: ri.status === "resolved",
				durationMs: durationFor(ri.startedAt, ri.inferenceCompletedAt),
				tokens: tokenSum(ri.usage as Record<string, unknown> | null),
				error: ri.error,
				sessionId: ri.sessionId,
			};
		}
		grid[runId] = cells;
	}

	const allInstanceIds = [
		...new Set(Object.values(grid).flatMap((m) => Object.keys(m))),
	].sort();
	const sharedInstanceIds = allInstanceIds.filter((id) =>
		runs.every((r) => grid[r.runId]?.[id]),
	);
	const disagreements = sharedInstanceIds.filter((id) => {
		const verdicts = runs.map((r) => grid[r.runId]?.[id]?.resolved);
		return new Set(verdicts).size > 1;
	});

	const axisDiff = buildAxisDiff(runs);

	// Phase F: pairwise regression tests vs runs[0] as baseline.
	const { compareRuns } = await import("./regression");
	const regression: import("./regression").RegressionTest[][] = [];
	if (runs.length >= 2) {
		const baselineRunId = runs[0].runId;
		for (let i = 1; i < runs.length; i++) {
			try {
				regression.push(await compareRuns(baselineRunId, runs[i].runId));
			} catch (err) {
				console.warn(
					`[compare] regression test ${baselineRunId} vs ${runs[i].runId} failed:`,
					err,
				);
				regression.push([]);
			}
		}
	}

	return {
		runs,
		axisDiff,
		grid,
		allInstanceIds,
		sharedInstanceIds,
		disagreements,
		regression,
	};
}
