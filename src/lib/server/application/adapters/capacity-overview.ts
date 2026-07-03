import { SpanStatusCode, trace } from "@opentelemetry/api";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	queryClickHouse,
} from "$lib/server/otel/clickhouse";
import {
	queryHistogramPercentiles,
	queryTimeSeries,
	type TimeSeriesPoint,
} from "$lib/server/otel/metrics";
import { fetchCapacityObserverSnapshot } from "$lib/server/capacity/observer";
import {
	ACTIVE_BENCHMARK_STATUSES,
	ACTIVE_SESSION_STATUSES,
	ACTIVE_WORKFLOW_STATUSES,
	buildCapacityBusinessWork,
	emptyDetails,
	idsFor,
	itemEndMs,
	recentBenchmarkInstance,
	recentBenchmarkRun,
	recentSession,
	recentWorkflow,
	type CapacityBusinessWorkBenchmarkInstanceDetail,
	type CapacityBusinessWorkBenchmarkRunDetail,
	type CapacityBusinessWorkDetailMaps,
	type CapacityBusinessWorkRepository,
	type CapacityBusinessWorkSessionDetail,
	type CapacityBusinessWorkWorkflowDetail,
} from "$lib/server/capacity/business-work";
import {
	enrichCapacitySnapshotOwnership,
	normalizeHostExecutionLabelValue,
	sessionHostAppId,
	type BenchmarkOwnershipRow,
	type CapacityOwnershipRepository,
	type SessionOwnershipRow,
} from "$lib/server/capacity/ownership";
import { setSpanValue } from "$lib/server/observability/content";
import { db as defaultDb } from "$lib/server/db";
import {
	agents,
	benchmarkRunInstances,
	benchmarkRuns,
	sessions,
	workflowExecutions,
	workflows,
} from "$lib/server/db/schema";
import type {
	CapacityBusinessWorkItem,
	CapacityBusinessWorkSummary,
	CapacityObserverResult,
	CapacityObserverSnapshot,
} from "$lib/types/capacity";
import type {
	CapacityBusinessWorkPort,
	CapacityMetricsPort,
	CapacityObserverPort,
	CapacityOverviewContext,
	CapacityOwnerTimeline,
	CapacityOwnerTimelinePoint,
	CapacityOwnershipPort,
	CapacityPsiTrendPoint,
	CapacityPsiTrendsSnapshot,
	CapacityTelemetryPort,
	CapacityTrendsSnapshot,
	SchedulingLatencySnapshot,
} from "$lib/server/application/capacity-overview";

const WINDOW_SECONDS = 300;
const BUCKET_SECONDS = 30;
const TRENDS_WINDOW_SECONDS = 3600;
const TRENDS_BUCKET_SECONDS = 30;
const OWNER_TIMELINE_TOP_N = 8;

type Database = typeof defaultDb;

export class HttpCapacityObserverAdapter implements CapacityObserverPort {
	fetchSnapshot(): Promise<CapacityObserverResult> {
		return fetchCapacityObserverSnapshot();
	}
}

export class PostgresCapacityBusinessWorkRepository
	implements CapacityBusinessWorkRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	async loadDetails(
		items: CapacityBusinessWorkItem[],
		projectId: string,
	): Promise<CapacityBusinessWorkDetailMaps> {
		if (!this.database) return emptyDetails();
		const idsByKind = {
			session: idsFor(items, "session"),
			workflowRun: idsFor(items, "workflowRun"),
			benchmarkRun: idsFor(items, "benchmarkRun"),
			benchmarkInstance: idsFor(items, "benchmarkInstance"),
		};
		const [sessionRows, workflowRows, benchmarkRunRows, benchmarkInstanceRows] =
			await Promise.all([
				this.selectSessions(projectId, idsByKind.session),
				this.selectWorkflowExecutions(projectId, idsByKind.workflowRun),
				this.selectBenchmarkRuns(projectId, idsByKind.benchmarkRun),
				this.selectBenchmarkInstances(projectId, idsByKind.benchmarkInstance),
			]);
		return {
			sessions: new Map(sessionRows.map((row) => [row.id, row])),
			workflows: new Map(workflowRows.map((row) => [row.id, row])),
			benchmarkRuns: new Map(benchmarkRunRows.map((row) => [row.id, row])),
			benchmarkInstances: new Map(
				benchmarkInstanceRows.map((row) => [row.id, row]),
			),
		};
	}

	async loadDbWork(
		projectId: string,
		workspaceSlug: string,
	): Promise<{
		active: CapacityBusinessWorkItem[];
		recent: CapacityBusinessWorkItem[];
	}> {
		if (!this.database) return { active: [], recent: [] };
		const [sessionRows, workflowRows, runRows, instanceRows] = await Promise.all([
			this.selectRecentSessions(projectId),
			this.selectRecentWorkflowExecutions(projectId),
			this.selectRecentBenchmarkRuns(projectId),
			this.selectRecentBenchmarkInstances(projectId),
		]);
		const recent = [
			...sessionRows
				.filter(
					(row) => row.completedAt || !ACTIVE_SESSION_STATUSES.has(row.status),
				)
				.map((row) => recentSession(row, workspaceSlug)),
			...workflowRows
				.filter(
					(row) => row.completedAt || !ACTIVE_WORKFLOW_STATUSES.has(row.status),
				)
				.map((row) => recentWorkflow(row, workspaceSlug)),
			...runRows
				.filter(
					(row) =>
						row.completedAt || !ACTIVE_BENCHMARK_STATUSES.has(row.status),
				)
				.map((row) => recentBenchmarkRun(row, workspaceSlug)),
			...instanceRows
				.filter(
					(row) =>
						row.completedAt || !ACTIVE_BENCHMARK_STATUSES.has(row.status),
				)
				.map((row) => recentBenchmarkInstance(row, workspaceSlug)),
		];
		const markActive = (item: CapacityBusinessWorkItem) => {
			item.active = true;
			return item;
		};
		const active = [
			...sessionRows
				.filter(
					(row) =>
						!row.completedAt && ACTIVE_SESSION_STATUSES.has(row.status),
				)
				.map((row) => markActive(recentSession(row, workspaceSlug))),
			...workflowRows
				.filter(
					(row) =>
						!row.completedAt && ACTIVE_WORKFLOW_STATUSES.has(row.status),
				)
				.map((row) => markActive(recentWorkflow(row, workspaceSlug))),
			...runRows
				.filter(
					(row) =>
						!row.completedAt && ACTIVE_BENCHMARK_STATUSES.has(row.status),
				)
				.map((row) => markActive(recentBenchmarkRun(row, workspaceSlug))),
			...instanceRows
				.filter(
					(row) =>
						!row.completedAt && ACTIVE_BENCHMARK_STATUSES.has(row.status),
				)
				.map((row) => markActive(recentBenchmarkInstance(row, workspaceSlug))),
		];
		return {
			active,
			recent: recent.sort((a, b) => itemEndMs(b) - itemEndMs(a)).slice(0, 12),
		};
	}

	private async selectSessions(
		projectId: string,
		ids: string[],
	): Promise<CapacityBusinessWorkSessionDetail[]> {
		if (!this.database || ids.length === 0) return [];
		return (await this.database
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
				workflowName: workflows.name,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(
				and(eq(sessions.projectId, projectId), inArray(sessions.id, ids)),
			)) as CapacityBusinessWorkSessionDetail[];
	}

	private async selectWorkflowExecutions(
		projectId: string,
		ids: string[],
	): Promise<CapacityBusinessWorkWorkflowDetail[]> {
		if (!this.database || ids.length === 0) return [];
		return (await this.database
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
				workflowId: workflows.id,
				workflowName: workflows.name,
				currentNodeName: workflowExecutions.currentNodeName,
				progress: workflowExecutions.progress,
				rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
				resumeFromNode: workflowExecutions.resumeFromNode,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(
				and(
					eq(workflowExecutions.projectId, projectId),
					inArray(workflowExecutions.id, ids),
				),
			)) as CapacityBusinessWorkWorkflowDetail[];
	}

	private async selectBenchmarkRuns(
		projectId: string,
		ids: string[],
	): Promise<CapacityBusinessWorkBenchmarkRunDetail[]> {
		if (!this.database || ids.length === 0) return [];
		return (await this.database
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
				agentName: agents.name,
			})
			.from(benchmarkRuns)
			.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.where(
				and(eq(benchmarkRuns.projectId, projectId), inArray(benchmarkRuns.id, ids)),
			)) as CapacityBusinessWorkBenchmarkRunDetail[];
	}

	private async selectBenchmarkInstances(
		projectId: string,
		ids: string[],
	): Promise<CapacityBusinessWorkBenchmarkInstanceDetail[]> {
		if (!this.database || ids.length === 0) return [];
		return (await this.database
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
				workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
			})
			.from(benchmarkRunInstances)
			.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
			.where(
				and(
					eq(benchmarkRuns.projectId, projectId),
					inArray(benchmarkRunInstances.id, ids),
				),
			)) as CapacityBusinessWorkBenchmarkInstanceDetail[];
	}

	private selectRecentSessions(
		projectId: string,
	): Promise<CapacityBusinessWorkSessionDetail[]> {
		if (!this.database) return Promise.resolve([]);
		return this.database
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
				workflowName: workflows.name,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(sessions.projectId, projectId))
			.orderBy(desc(sessions.updatedAt))
			.limit(25) as Promise<CapacityBusinessWorkSessionDetail[]>;
	}

	private selectRecentWorkflowExecutions(
		projectId: string,
	): Promise<CapacityBusinessWorkWorkflowDetail[]> {
		if (!this.database) return Promise.resolve([]);
		return this.database
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
				workflowId: workflows.id,
				workflowName: workflows.name,
				currentNodeName: workflowExecutions.currentNodeName,
				progress: workflowExecutions.progress,
				rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
				resumeFromNode: workflowExecutions.resumeFromNode,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(workflowExecutions.projectId, projectId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(25) as Promise<CapacityBusinessWorkWorkflowDetail[]>;
	}

	private selectRecentBenchmarkRuns(
		projectId: string,
	): Promise<CapacityBusinessWorkBenchmarkRunDetail[]> {
		if (!this.database) return Promise.resolve([]);
		return this.database
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
				agentName: agents.name,
			})
			.from(benchmarkRuns)
			.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.where(eq(benchmarkRuns.projectId, projectId))
			.orderBy(desc(benchmarkRuns.updatedAt))
			.limit(25) as Promise<CapacityBusinessWorkBenchmarkRunDetail[]>;
	}

	private selectRecentBenchmarkInstances(
		projectId: string,
	): Promise<CapacityBusinessWorkBenchmarkInstanceDetail[]> {
		if (!this.database) return Promise.resolve([]);
		return this.database
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
				workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
			})
			.from(benchmarkRunInstances)
			.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
			.where(eq(benchmarkRuns.projectId, projectId))
			.orderBy(desc(benchmarkRunInstances.updatedAt))
			.limit(25) as Promise<CapacityBusinessWorkBenchmarkInstanceDetail[]>;
	}
}

export class PostgresCapacityOwnershipRepository
	implements CapacityOwnershipRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	async resolveSessionRows(params: {
		projectId: string;
		sessionIds: string[];
		agentAppIds: string[];
	}): Promise<SessionOwnershipRow[]> {
		const rows = new Map<string, SessionOwnershipRow>();
		const append = (next: SessionOwnershipRow[]) => {
			for (const row of next) rows.set(row.sessionId, row);
		};

		if (params.sessionIds.length > 0) {
			append(
				await this.selectSessionOwnershipRows(
					params.projectId,
					inArray(sessions.id, params.sessionIds),
				),
			);
		}
		if (params.agentAppIds.length > 0) {
			append(
				await this.selectSessionOwnershipRows(
					params.projectId,
					inArray(sessions.runtimeAppId, params.agentAppIds),
				),
			);
		}

		const unresolvedAppIds = params.agentAppIds.filter((id) => {
			for (const row of rows.values()) {
				if (
					row.sessionRuntimeAppId === id ||
					sessionHostAppId(row.sessionId) === id
				) {
					return false;
				}
			}
			return true;
		});
		if (unresolvedAppIds.length > 0) {
			const recentRows = await this.selectRecentSessionOwnershipRows(
				params.projectId,
			);
			append(
				recentRows.filter((row) =>
					unresolvedAppIds.includes(sessionHostAppId(row.sessionId)),
				),
			);
		}

		return [...rows.values()];
	}

	async resolveBenchmarkRows(params: {
		projectId: string;
		runIds: string[];
		instanceIds: string[];
	}): Promise<BenchmarkOwnershipRow[]> {
		if (
			!this.database ||
			(params.runIds.length === 0 && params.instanceIds.length === 0)
		) {
			return [];
		}
		const rows = (await this.database
			.select({
				runId: benchmarkRuns.id,
				runStatus: benchmarkRuns.status,
				runInstanceRowId: benchmarkRunInstances.id,
				instanceId: benchmarkRunInstances.instanceId,
				agentId: agents.id,
				agentName: agents.name,
				agentSlug: agents.slug,
				workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				sessionId: benchmarkRunInstances.sessionId,
				sessionTitle: sessions.title,
			})
			.from(benchmarkRunInstances)
			.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
			.leftJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.leftJoin(sessions, eq(sessions.id, benchmarkRunInstances.sessionId))
			.where(eq(benchmarkRuns.projectId, params.projectId))
			.orderBy(desc(benchmarkRunInstances.updatedAt))
			.limit(500)) as BenchmarkOwnershipRow[];

		const runLabels = new Set(params.runIds);
		const instanceLabels = new Set(params.instanceIds);
		return rows.filter(
			(row) =>
				runLabels.has(row.runId) ||
				runLabels.has(normalizeHostExecutionLabelValue(row.runId)) ||
				instanceLabels.has(row.instanceId) ||
				instanceLabels.has(normalizeHostExecutionLabelValue(row.instanceId)),
		);
	}

	private async selectSessionOwnershipRows(
		projectId: string,
		condition: Parameters<typeof and>[0],
	): Promise<SessionOwnershipRow[]> {
		if (!this.database) return [];
		return (await this.database
			.select({
				sessionId: sessions.id,
				sessionTitle: sessions.title,
				sessionRuntimeAppId: sessions.runtimeAppId,
				agentId: agents.id,
				agentName: agents.name,
				agentSlug: agents.slug,
				workflowExecutionId: sessions.workflowExecutionId,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(
				and(eq(sessions.projectId, projectId), condition),
			)) as SessionOwnershipRow[];
	}

	private async selectRecentSessionOwnershipRows(
		projectId: string,
	): Promise<SessionOwnershipRow[]> {
		if (!this.database) return [];
		return (await this.database
			.select({
				sessionId: sessions.id,
				sessionTitle: sessions.title,
				sessionRuntimeAppId: sessions.runtimeAppId,
				agentId: agents.id,
				agentName: agents.name,
				agentSlug: agents.slug,
				workflowExecutionId: sessions.workflowExecutionId,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(sessions.projectId, projectId))
			.orderBy(desc(sessions.updatedAt))
			.limit(300)) as SessionOwnershipRow[];
	}
}

export class LegacyCapacityOwnershipAdapter implements CapacityOwnershipPort {
	constructor(
		private readonly repository: CapacityOwnershipRepository = new PostgresCapacityOwnershipRepository(),
	) {}

	enrich(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityObserverSnapshot> {
		return enrichCapacitySnapshotOwnership(snapshot, context, this.repository);
	}
}

export class LegacyCapacityBusinessWorkAdapter implements CapacityBusinessWorkPort {
	constructor(
		private readonly repository: CapacityBusinessWorkRepository = new PostgresCapacityBusinessWorkRepository(),
	) {}

	build(
		snapshot: CapacityObserverSnapshot,
		context: CapacityOverviewContext,
	): Promise<CapacityBusinessWorkSummary> {
		return buildCapacityBusinessWork(snapshot, context, this.repository);
	}
}

export class OtelCapacityRemoteTelemetryAdapter implements CapacityTelemetryPort {
	private readonly tracer = trace.getTracer("workflow-builder.capacity-remote");

	async trace<T>(
		name: string,
		payload: unknown,
		fn: () => Promise<T>,
	): Promise<T> {
		const parentSpan = trace.getActiveSpan();
		const input = { remoteCall: name, payload };
		setSpanValue(parentSpan, "input", input);

		return this.tracer.startActiveSpan(
			`workflow-builder.remote ${name}`,
			async (span) => {
				span.setAttribute("workflow_builder.remote.name", name);
				setSpanValue(span, "input", input);
				try {
					const output = await fn();
					setSpanValue(span, "output", output);
					setSpanValue(parentSpan, "output", output);
					return output;
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					const output = { ok: false, error: err.message, remoteCall: name };
					setSpanValue(span, "output", output);
					setSpanValue(parentSpan, "output", output);
					span.recordException(err);
					span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
					throw error;
				} finally {
					span.end();
				}
			},
		);
	}
}

export class ClickHouseCapacityMetricsAdapter implements CapacityMetricsPort {
	async getSchedulingLatency(cluster: string): Promise<SchedulingLatencySnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - WINDOW_SECONDS * 1000);
		const filters = { cluster };
		try {
			const [percentiles, series] = await Promise.all([
				queryHistogramPercentiles(
					"dapr_runtime_workflow_scheduling_latency",
					[0.5, 0.95],
					{ from, to },
					filters,
				),
				queryTimeSeries(
					"dapr_runtime_workflow_scheduling_latency",
					BUCKET_SECONDS,
					{ from, to },
					filters,
					"avg",
				),
			]);
			const sparkline = series.map((point) => ({
				t: point.t.toISOString(),
				valueMs: point.value * 1000,
			}));
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				p50Ms:
					percentiles.count > 0 ? percentiles.percentiles.p50 * 1000 : null,
				p95Ms:
					percentiles.count > 0 ? percentiles.percentiles.p95 * 1000 : null,
				samples: percentiles.count,
				sparkline,
				hasData: percentiles.count > 0,
			};
		} catch {
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				p50Ms: null,
				p95Ms: null,
				samples: 0,
				sparkline: [],
				hasData: false,
			};
		}
	}

	async getPsiTrends(cluster: string): Promise<CapacityPsiTrendsSnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - WINDOW_SECONDS * 1000);
		const filters = { cluster };
		const empty = {
			cluster,
			windowSeconds: WINDOW_SECONDS,
			bucketSeconds: BUCKET_SECONDS,
			source: "unavailable" as const,
			cpuSomeAvg60Pct: [],
			memorySomeAvg60Pct: [],
			ioSomeAvg60Pct: [],
			coverageRatioPct: [],
			hasData: false,
		};
		try {
			const [cpu, memory, io, coverage] = await Promise.all([
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "cpu" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "memory" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_some_avg60_pct",
					BUCKET_SECONDS,
					{ from, to },
					{ ...filters, attribute: { resource: "io" } },
					"max",
				),
				queryTimeSeries(
					"capacity_observer_psi_coverage_ratio",
					BUCKET_SECONDS,
					{ from, to },
					filters,
					"min",
				),
			]);
			const mapPoints = (points: TimeSeriesPoint[], scale = 1) =>
				points.map((point) => ({
					t: point.t.toISOString(),
					value: point.value * scale,
				}));
			return {
				cluster,
				windowSeconds: WINDOW_SECONDS,
				bucketSeconds: BUCKET_SECONDS,
				source: "clickhouse",
				cpuSomeAvg60Pct: mapPoints(cpu),
				memorySomeAvg60Pct: mapPoints(memory),
				ioSomeAvg60Pct: mapPoints(io),
				coverageRatioPct: mapPoints(coverage, 100),
				hasData: cpu.length + memory.length + io.length + coverage.length > 0,
			};
		} catch {
			return empty;
		}
	}

	async getTrends(cluster: string): Promise<CapacityTrendsSnapshot> {
		const to = new Date();
		const from = new Date(to.getTime() - TRENDS_WINDOW_SECONDS * 1000);
		const bucket = TRENDS_BUCKET_SECONDS;
		const clusterClause = `ResourceAttributes['k8s.cluster.name'] = '${escapeClickHouseString(cluster)}'`;
		const timeClause = `TimeUnix >= fromUnixTimestamp64Milli(${from.getTime()}) AND TimeUnix <= fromUnixTimestamp64Milli(${to.getTime()})`;

		const empty: CapacityTrendsSnapshot = {
			cluster,
			windowSeconds: TRENDS_WINDOW_SECONDS,
			bucketSeconds: bucket,
			source: "unavailable",
			utilizationPctByResource: {},
			actualUsagePctByResource: {},
			admitted: [],
			pending: [],
			reserving: [],
			latencyAvgMs: [],
			hasData: false,
		};

		const resourceSeriesSql = (metric: string) => `
		SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
		       Attributes['resource'] AS res,
		       avg(Value) AS v
		FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
		WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
		GROUP BY bucket, res
		ORDER BY bucket ASC`;

		const workloadSeriesSql = (metric: string) => `
		SELECT bucket, sum(qv) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['queue'] AS q,
			       max(Value) AS qv
			FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
			WHERE MetricName = '${escapeClickHouseString(metric)}' AND ${clusterClause} AND ${timeClause}
			GROUP BY bucket, q
		) GROUP BY bucket ORDER BY bucket ASC`;

		const latencySql = `
		SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
		       sum(Sum) / nullIf(sum(Count), 0) * 1000 AS v
		FROM ${CLICKHOUSE_DB}.otel_metrics_histogram
		WHERE MetricName = 'dapr_runtime_workflow_scheduling_latency' AND ${clusterClause} AND ${timeClause}
		GROUP BY bucket
		HAVING sum(Count) > 0
		ORDER BY bucket ASC`;

		const memoryActualSql = `
		SELECT bucket, sum(v) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['id'] AS id,
			       max(Value) AS v
			FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
			WHERE MetricName = 'container_memory_working_set_bytes'
			  AND ${clusterClause}
			  AND ${timeClause}
			  AND Attributes['container'] != ''
			GROUP BY bucket, id
		) GROUP BY bucket ORDER BY bucket ASC`;

		const cpuActualSql = `
		SELECT bucket, sum(rate) AS v FROM (
			SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
			       Attributes['id'] AS id,
			       greatest(0, (max(Value) - min(Value)) / greatest(1, dateDiff('second', min(TimeUnix), max(TimeUnix)))) AS rate
			FROM ${CLICKHOUSE_DB}.otel_metrics_sum
			WHERE MetricName = 'container_cpu_usage_seconds_total'
			  AND ${clusterClause}
			  AND ${timeClause}
			  AND Attributes['container'] != ''
			  AND Attributes['cpu'] = 'total'
			GROUP BY bucket, id
			HAVING count() > 1
		) GROUP BY bucket ORDER BY bucket ASC`;

		try {
			const [
				requestedRows,
				allocRows,
				admittedRows,
				pendingRows,
				reservingRows,
				latencyRows,
				actualMemoryRows,
				actualCpuRows,
				observedRows,
			] = await Promise.all([
				queryClickHouse(resourceSeriesSql("cluster_capacity_requested")),
				queryClickHouse(resourceSeriesSql("cluster_capacity_allocatable")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_admitted_workloads")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_pending_workloads")),
				queryClickHouse(workloadSeriesSql("kueue_clusterqueue_reserving_workloads")),
				queryClickHouse(latencySql),
				queryClickHouse(memoryActualSql),
				queryClickHouse(cpuActualSql),
				queryClickHouse(resourceSeriesSql("cluster_capacity_observed")),
			]);

			const allocByResBucket = new Map<string, number>();
			for (const row of allocRows) {
				const res = String(row.res ?? "");
				const t = new Date(String(row.bucket)).toISOString();
				allocByResBucket.set(`${res}|${t}`, Number(row.v) || 0);
			}

			const utilizationPctByResource: Record<
				string,
				CapacityPsiTrendPoint[]
			> = {};
			for (const row of requestedRows) {
				const res = String(row.res ?? "");
				const t = new Date(String(row.bucket)).toISOString();
				const requested = Number(row.v) || 0;
				const allocatable = allocByResBucket.get(`${res}|${t}`) ?? 0;
				if (allocatable <= 0) continue;
				const pct = Math.max(0, Math.min(100, (requested / allocatable) * 100));
				(utilizationPctByResource[res] ??= []).push({ t, value: pct });
			}

			const actualUsagePctByResource: Record<
				string,
				CapacityPsiTrendPoint[]
			> = {};
			const addActualSeries = (
				resource: "cpu" | "memory",
				rows: Record<string, unknown>[],
			) => {
				for (const row of rows) {
					const t = new Date(String(row.bucket)).toISOString();
					const allocatable = allocByResBucket.get(`${resource}|${t}`) ?? 0;
					if (allocatable <= 0) continue;
					const observed = Number(row.v) || 0;
					const pct = Math.max(0, Math.min(100, (observed / allocatable) * 100));
					(actualUsagePctByResource[resource] ??= []).push({ t, value: pct });
				}
			};
			const observedByResource = new Map<string, Record<string, unknown>[]>();
			for (const row of observedRows) {
				const res = String(row.res ?? "");
				if (!res) continue;
				const rows = observedByResource.get(res) ?? [];
				rows.push(row);
				observedByResource.set(res, rows);
			}
			addActualSeries(
				"memory",
				actualMemoryRows.length > 0
					? actualMemoryRows
					: (observedByResource.get("memory") ?? []),
			);
			addActualSeries(
				"cpu",
				actualCpuRows.length > 0
					? actualCpuRows
					: (observedByResource.get("cpu") ?? []),
			);

			const toSeries = (
				rows: Record<string, unknown>[],
			): CapacityPsiTrendPoint[] =>
				rows.map((row) => ({
					t: new Date(String(row.bucket)).toISOString(),
					value: Number(row.v) || 0,
				}));

			const admitted = toSeries(admittedRows);
			const pending = toSeries(pendingRows);
			const reserving = toSeries(reservingRows);
			const latencyAvgMs = toSeries(latencyRows);
			const hasData =
				Object.keys(utilizationPctByResource).length > 0 ||
				Object.keys(actualUsagePctByResource).length > 0 ||
				admitted.length + pending.length + reserving.length + latencyAvgMs.length >
					0;

			return {
				cluster,
				windowSeconds: TRENDS_WINDOW_SECONDS,
				bucketSeconds: bucket,
				source: "clickhouse",
				utilizationPctByResource,
				actualUsagePctByResource,
				admitted,
				pending,
				reserving,
				latencyAvgMs,
				hasData,
			};
		} catch {
			return empty;
		}
	}

	async getOwnerTimeline(input: {
		cluster: string;
		resource: string;
	}): Promise<CapacityOwnerTimeline> {
		const { cluster, resource } = input;
		const to = new Date();
		const from = new Date(to.getTime() - TRENDS_WINDOW_SECONDS * 1000);
		const bucket = TRENDS_BUCKET_SECONDS;
		const clusterClause = `ResourceAttributes['k8s.cluster.name'] = '${escapeClickHouseString(cluster)}'`;
		const resourceClause = `Attributes['resource'] = '${escapeClickHouseString(resource)}'`;
		const timeClause = `TimeUnix >= fromUnixTimestamp64Milli(${from.getTime()}) AND TimeUnix <= fromUnixTimestamp64Milli(${to.getTime()})`;
		const empty: CapacityOwnerTimeline = {
			cluster,
			resource,
			windowSeconds: TRENDS_WINDOW_SECONDS,
			bucketSeconds: bucket,
			owners: [],
			buckets: [],
			hasData: false,
		};

		try {
			const ownerSql = `
				SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket,
				       Attributes['owner_kind'] AS kind,
				       Attributes['owner_id'] AS id,
				       max(Value) AS v
				FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
				WHERE MetricName = 'capacity_observer_owner_requested' AND ${resourceClause} AND ${clusterClause} AND ${timeClause}
				GROUP BY bucket, kind, id
				ORDER BY bucket ASC`;
			const allocSql = `
				SELECT toStartOfInterval(TimeUnix, INTERVAL ${bucket} SECOND) AS bucket, avg(Value) AS v
				FROM ${CLICKHOUSE_DB}.otel_metrics_gauge
				WHERE MetricName = 'cluster_capacity_allocatable' AND ${resourceClause} AND ${clusterClause} AND ${timeClause}
				GROUP BY bucket ORDER BY bucket ASC`;
			const [ownerRows, allocRows] = await Promise.all([
				queryClickHouse(ownerSql),
				queryClickHouse(allocSql),
			]);

			const allocByBucket = new Map<string, number>();
			for (const row of allocRows) {
				allocByBucket.set(
					new Date(String(row.bucket)).toISOString(),
					Number(row.v) || 0,
				);
			}

			type Row = {
				t: string;
				key: string;
				kind: string;
				id: string;
				pct: number;
			};
			const rows: Row[] = [];
			const peakByOwner = new Map<
				string,
				{ kind: string; id: string; peak: number }
			>();
			for (const row of ownerRows) {
				const t = new Date(String(row.bucket)).toISOString();
				const alloc = allocByBucket.get(t) ?? 0;
				if (alloc <= 0) continue;
				const kind = String(row.kind ?? "");
				const id = String(row.id ?? "");
				if (!id) continue;
				const key = `${kind}:${id}`;
				const pct = Math.max(0, ((Number(row.v) || 0) / alloc) * 100);
				rows.push({ t, key, kind, id, pct });
				const prev = peakByOwner.get(key);
				if (!prev || pct > prev.peak) {
					peakByOwner.set(key, { kind, id, peak: pct });
				}
			}

			const ranked = [...peakByOwner.entries()].sort(
				(a, b) => b[1].peak - a[1].peak,
			);
			const topKeys = new Set(
				ranked.slice(0, OWNER_TIMELINE_TOP_N).map(([key]) => key),
			);
			const owners = ranked
				.filter(([key]) => topKeys.has(key))
				.map(([key, info]) => ({ key, kind: info.kind, id: info.id }));

			const bucketMap = new Map<string, CapacityOwnerTimelinePoint>();
			for (const row of rows) {
				const point = bucketMap.get(row.t) ?? {
					t: row.t,
					values: {},
					other: 0,
				};
				if (topKeys.has(row.key)) {
					point.values[row.key] = (point.values[row.key] ?? 0) + row.pct;
				} else {
					point.other += row.pct;
				}
				bucketMap.set(row.t, point);
			}
			const buckets = [...bucketMap.values()].sort((a, b) =>
				a.t.localeCompare(b.t),
			);

			return {
				cluster,
				resource,
				windowSeconds: TRENDS_WINDOW_SECONDS,
				bucketSeconds: bucket,
				owners,
				buckets,
				hasData: buckets.length > 0,
			};
		} catch {
			return empty;
		}
	}
}
