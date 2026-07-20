import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
	workflowExecutionLogs,
	workflowExecutions,
} from "$lib/server/db/schema";
import {
	getMultiTraceSpanSummaries,
	searchTraceLlmSpans,
	searchTraceToolSpans,
} from "$lib/server/otel/clickhouse";
import type { BenchmarkTraceBundleQueryOptions } from "$lib/server/application/benchmark-route-operations";
import type {
	ObservabilityLlmMessage,
	ObservabilityLlmSpan,
	ObservabilityToolSpan,
	ObservabilityTraceSpan,
} from "$lib/types/observability";
export type SwebenchTraceBundleBackend =
	| "mlflow_artifact"
	| "mlflow_native"
	| "clickhouse_derived"
	| "clickhouse_raw"
	| "workflow_logs"
	| "none";

export type SwebenchTraceBundle = {
	version: 1;
	backend: SwebenchTraceBundleBackend;
	artifactPath: string;
	runId: string;
	runInstanceId: string | null;
	instanceId: string;
	traceIds: string[];
	canonicalTraceId: string | null;
	auxiliaryTraces: Array<{ traceId: string; status: "found" | "missing" }>;
	mlflowTracesUrl: string | null;
	traceSpans: ObservabilityTraceSpan[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	summary: {
		traceCount: number;
		traceSpanCount: number;
		llmSpanCount: number;
		toolSpanCount: number;
		errorSpanCount: number;
		source: SwebenchTraceBundleBackend;
	};
	requiredContext: {
		rootPresent: boolean;
		statusFinalized: boolean;
		nodeSpansPresent: boolean;
		llmToolSpansPresent: boolean;
		agentIdentityComplete: boolean;
		auxiliaryTracesFound: number;
		auxiliaryTracesMissing: number;
	};
	groups: {
		workflowRoot: number;
		workflowNodes: number;
		agentTurns: number;
		llmCalls: number;
		toolCalls: number;
		workspaceActions: number;
		evaluatorHarness: number;
	};
	source: {
		kind: SwebenchTraceBundleBackend;
		generatedAt: string;
		mlflowRunId: string | null;
		derivedLlmSpanCount: number;
		derivedToolSpanCount: number;
		rawTraceSpanCount: number;
	};
	warnings: string[];
	truncated: boolean;
	nextCursor: string | null;
};

const DEFAULT_TRACE_BUNDLE_LIMIT = 50;
const MAX_TRACE_BUNDLE_LIMIT = 50;
const MAX_TRACE_IDS = 32;

type TraceBundlePage = {
	limit: number;
	offset: number;
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
};

type RawBuildInput = {
	runId: string;
	runInstanceId: string | null;
	instanceId: string;
	traceIds: string[];
	canonicalTraceId: string | null;
	/** Read-compatible fields accepted from older callers; no longer queried. */
	mlflowExperimentId?: string | null;
	mlflowRunId?: string | null;
	artifactPath: string;
	workflowExecutionId?: string | null;
	workflowNodeSpans?: ObservabilityTraceSpan[];
	workflowNodeSpansTruncated?: boolean;
	page?: TraceBundlePage;
};

export function encodeTraceBundleCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ v: 1, offset: Math.max(0, Math.floor(offset)) }))
		.toString("base64url");
}

export function decodeTraceBundleCursor(cursor: string | null | undefined): number {
	if (!cursor?.trim()) return 0;
	if (cursor.trim().length > 256) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as {
			v?: unknown;
			offset?: unknown;
		};
		if (parsed.v === 1 && Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0) {
			return Math.min(100_000, Number(parsed.offset));
		}
	} catch {
		// Invalid cursors restart at the first page and emit a warning below.
	}
	return 0;
}

function traceBundlePage(
	options: BenchmarkTraceBundleQueryOptions | undefined,
	defaults: { startedAt?: string | Date | null; completedAt?: string | Date | null },
): TraceBundlePage {
	const requestedLimit = Number(options?.limit);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(MAX_TRACE_BUNDLE_LIMIT, Math.max(1, Math.floor(requestedLimit)))
		: DEFAULT_TRACE_BUNDLE_LIMIT;
	const defaultStart = validDate(defaults.startedAt);
	const defaultEnd = validDate(defaults.completedAt);
	const requestedStart = validDate(options?.timeWindow?.startedAt);
	const requestedEnd = validDate(options?.timeWindow?.completedAt);
	return {
		limit,
		offset: decodeTraceBundleCursor(options?.cursor),
		startedAt: laterDate(defaultStart, requestedStart)?.toISOString(),
		completedAt: earlierDate(defaultEnd, requestedEnd)?.toISOString(),
	};
}

function validDate(value: string | Date | null | undefined): Date | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

function laterDate(left: Date | null, right: Date | null): Date | null {
	if (!left) return right;
	if (!right) return left;
	return left.getTime() >= right.getTime() ? left : right;
}

function earlierDate(left: Date | null, right: Date | null): Date | null {
	if (!left) return right;
	if (!right) return left;
	return left.getTime() <= right.getTime() ? left : right;
}

export function safeSwebenchTraceArtifactPath(instanceId: string): string {
	const safe =
		instanceId
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^[._-]+|[._-]+$/g, "")
			.slice(0, 180) || "instance";
	return `traces/${safe}/trace-bundle.json`;
}

export async function loadSwebenchTraceBundle(params: {
	runId: string;
	instanceId: string;
	projectId?: string | null;
	options?: BenchmarkTraceBundleQueryOptions;
}): Promise<SwebenchTraceBundle | null> {
	if (!db) return null;
	const database = db;
	const whereRun =
		params.projectId == null
			? eq(benchmarkRuns.id, params.runId)
			: and(eq(benchmarkRuns.id, params.runId), eq(benchmarkRuns.projectId, params.projectId));
	const [row] = await database
		.select({
			runId: benchmarkRuns.id,
			runInstanceId: benchmarkRunInstances.id,
			instanceId: benchmarkRunInstances.instanceId,
			traceIds: benchmarkRunInstances.traceIds,
			workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
			primaryTraceId: workflowExecutions.primaryTraceId,
			instanceStartedAt: benchmarkRunInstances.startedAt,
			inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
			instanceCreatedAt: benchmarkRunInstances.createdAt,
			runStartedAt: benchmarkRuns.startedAt,
			runCompletedAt: benchmarkRuns.completedAt,
			executionStartedAt: workflowExecutions.startedAt,
			executionCompletedAt: workflowExecutions.completedAt,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(workflowExecutions, eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId))
		.where(
			and(
				whereRun,
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) return null;

	const warnings: string[] = [];
	const recordedTraceIds = Array.isArray(row.traceIds)
		? row.traceIds.filter(
				(value): value is string =>
					typeof value === "string" && Boolean(value.trim()),
			)
		: [];
	const auxiliaryTraceIds = normalizeTraceIds(row.traceIds);
	const invalidTraceIdCount = recordedTraceIds.filter(
		(traceId) => normalizeTraceBundleId(traceId) === null,
	).length;
	if (invalidTraceIdCount > 0) {
		warnings.push(`${invalidTraceIdCount} invalid recorded trace id(s) were omitted`);
	}
	const normalizedPrimaryTraceId =
		typeof row.primaryTraceId === "string"
			? normalizeTraceBundleId(row.primaryTraceId)
			: null;
	if (
		typeof row.primaryTraceId === "string" &&
		row.primaryTraceId.trim() &&
		!normalizedPrimaryTraceId
	) {
		warnings.push("The recorded primary trace id was invalid; using an auxiliary trace id");
	}
	const canonicalTraceId =
		normalizedPrimaryTraceId ?? auxiliaryTraceIds[0] ?? null;
	const allTraceIds = canonicalTraceId
		? [canonicalTraceId, ...auxiliaryTraceIds.filter((id) => id !== canonicalTraceId)]
		: auxiliaryTraceIds;
	const traceIds = allTraceIds.slice(0, MAX_TRACE_IDS);
	if (allTraceIds.length > traceIds.length) {
		warnings.push(
			`Trace id set was capped at ${MAX_TRACE_IDS}; ${allTraceIds.length - traceIds.length} ids were omitted`,
		);
	}
	const page = traceBundlePage(params.options, {
		startedAt:
			row.executionStartedAt ?? row.instanceStartedAt ?? row.runStartedAt ?? row.instanceCreatedAt,
		completedAt:
			row.executionCompletedAt ?? row.inferenceCompletedAt ?? row.runCompletedAt,
	});
	if (params.options?.cursor?.trim() && page.offset === 0) {
		warnings.push("Invalid trace cursor; restarted at the first page");
	}
	const artifactPath = safeSwebenchTraceArtifactPath(row.instanceId);
	let workflowNodeBatch = { spans: [] as ObservabilityTraceSpan[], truncated: false };
	if (row.workflowExecutionId) {
		try {
			workflowNodeBatch = await loadWorkflowNodeTraceSpans({
				workflowExecutionId: row.workflowExecutionId,
				runId: row.runId,
				runInstanceId: row.runInstanceId,
				instanceId: row.instanceId,
				traceId: canonicalTraceId ?? traceIds[0] ?? null,
				limit: page.limit,
				offset: page.offset,
			});
		} catch (err) {
			warnings.push(`Workflow node span query failed: ${errorMessage(err)}`);
		}
	}
	const base: RawBuildInput = {
		runId: row.runId,
		runInstanceId: row.runInstanceId,
		instanceId: row.instanceId,
		traceIds,
		canonicalTraceId,
		artifactPath,
		workflowExecutionId: row.workflowExecutionId,
		workflowNodeSpans: workflowNodeBatch.spans,
		workflowNodeSpansTruncated: workflowNodeBatch.truncated,
		page,
	};

	return buildSwebenchTraceBundle(base, warnings);
}

async function loadWorkflowNodeTraceSpans(input: {
	workflowExecutionId: string;
	runId: string;
	runInstanceId: string | null;
	instanceId: string;
	traceId: string | null;
	limit: number;
	offset: number;
}): Promise<{ spans: ObservabilityTraceSpan[]; truncated: boolean }> {
	if (!db) return { spans: [], truncated: false };
	const logs = await db
		.select({
			id: workflowExecutionLogs.id,
			nodeId: workflowExecutionLogs.nodeId,
			nodeName: workflowExecutionLogs.nodeName,
			nodeType: workflowExecutionLogs.nodeType,
			activityName: workflowExecutionLogs.activityName,
			status: workflowExecutionLogs.status,
			checkoutCommand: sql<string | null>`case when ${workflowExecutionLogs.nodeId} = 'checkout_repo' then left(coalesce(${workflowExecutionLogs.input} #>> '{command}', ${workflowExecutionLogs.input} #>> '{body,command}', ${workflowExecutionLogs.input} #>> '{input,command}'), 2000) end`,
			checkoutStderr: sql<string | null>`case when ${workflowExecutionLogs.nodeId} = 'checkout_repo' then left(coalesce(${workflowExecutionLogs.output} #>> '{result,stderr}', ${workflowExecutionLogs.output} #>> '{stderr}'), 2000) end`,
			checkoutStdout: sql<string | null>`case when ${workflowExecutionLogs.nodeId} = 'checkout_repo' then left(coalesce(${workflowExecutionLogs.output} #>> '{result,stdout}', ${workflowExecutionLogs.output} #>> '{stdout}'), 2000) end`,
			error: sql<string | null>`left(${workflowExecutionLogs.error}, 1000)`,
			startedAt: workflowExecutionLogs.startedAt,
			completedAt: workflowExecutionLogs.completedAt,
			duration: workflowExecutionLogs.duration,
		})
		.from(workflowExecutionLogs)
		.where(eq(workflowExecutionLogs.executionId, input.workflowExecutionId))
		.orderBy(asc(workflowExecutionLogs.startedAt), asc(workflowExecutionLogs.id))
		.limit(input.limit + 1)
		.offset(input.offset);
	if (logs.length === 0) return { spans: [], truncated: false };

	const traceId =
		normalizeTraceBundleId(input.traceId ?? "") ??
		`workflow-${safeSyntheticId(input.workflowExecutionId)}`;
	const truncated = logs.length > input.limit;
	const spans = logs.slice(0, input.limit).map((log, index) => {
		const duration = workflowLogDurationMs(log);
		const checkout =
			log.nodeId === "checkout_repo"
				? checkoutAttributes({
						command: log.checkoutCommand,
						stderr: log.checkoutStderr,
						stdout: log.checkoutStdout,
					})
				: {};
		const status: ObservabilityTraceSpan["status"] =
			log.status === "error" ? "error" : "ok";
		const attributes: Record<string, unknown> = {
			"gen_ai.operation.name": "workflow.node",
			"workflow.execution.id": input.workflowExecutionId,
			"workflow.node.id": log.nodeId,
			"workflow.node.name": log.nodeName,
			"workflow.node.type": log.nodeType,
			"workflow.activity.name": log.activityName,
			"workflow_builder.synthetic": true,
			"workflow_builder.source": "workflow_execution_logs",
			"workflow_builder.log_id": log.id,
			"swebench.run_id": input.runId,
			"swebench.run_instance_id": input.runInstanceId,
			"swebench.instance_id": input.instanceId,
			...checkout,
		};
		if (log.error?.trim()) attributes["error.message"] = log.error.trim().slice(0, 1000);
		return {
			traceId,
			spanId: `workflow-log-${safeSyntheticId(log.id || `${index}`)}`,
			parentSpanId: null,
			operationName: `workflow.node.${log.nodeId}`,
			serviceName: "workflow-builder",
			startTime: log.startedAt.toISOString(),
			duration,
			status,
			statusCode: status === "error" ? "STATUS_CODE_ERROR" : "OK",
			statusMessage: log.error ?? undefined,
			spanKind: "SPAN_KIND_INTERNAL",
			attributes,
			resourceAttributes: {
				"service.name": "workflow-builder",
			},
			depth: 0,
		};
	});
	return { spans, truncated };
}

function mergeTraceSpans(
	primary: ObservabilityTraceSpan[],
	synthetic: ObservabilityTraceSpan[],
): ObservabilityTraceSpan[] {
	if (synthetic.length === 0) {
		return [...primary].sort((a, b) => a.startTime.localeCompare(b.startTime));
	}
	const seen = new Set<string>();
	const merged: ObservabilityTraceSpan[] = [];
	for (const span of [...primary, ...synthetic]) {
		const key = `${span.traceId}:${span.spanId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(span);
	}
	return merged.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function workflowLogDurationMs(log: {
	duration: unknown;
	startedAt: Date;
	completedAt: Date | null;
}): number {
	const direct =
		typeof log.duration === "number"
			? log.duration
			: typeof log.duration === "string" && log.duration.trim()
				? Number.parseInt(log.duration, 10)
				: NaN;
	if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
	if (log.completedAt) {
		const elapsed = log.completedAt.getTime() - log.startedAt.getTime();
		if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
	}
	return 0;
}

function checkoutAttributes(input: {
	command: string | null;
	stderr: string | null;
	stdout: string | null;
}): Record<string, unknown> {
	const attributes: Record<string, unknown> = {
		"workspace.action": "checkout_repo",
		"git.operation": "checkout",
	};
	const command = stringFrom(input.command);
	const stderr = stringFrom(input.stderr);
	const stdout = stringFrom(input.stdout);
	const repoUrl =
		extractGitRepoUrl(command) ??
		extractGitRepoUrl(stderr) ??
		extractGitRepoUrl(stdout);
	if (repoUrl) attributes["git.repo_url"] = repoUrl;
	if (stderr) attributes["git.stderr_excerpt"] = stderr.slice(0, 1000);
	if (stdout) attributes["git.stdout_excerpt"] = stdout.slice(0, 1000);
	return attributes;
}

function extractGitRepoUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const https = value.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/);
	if (https?.[0]) return https[0].endsWith(".git") ? https[0] : `${https[0]}.git`;
	const from = value.match(/From\s+(https:\/\/github\.com\/[^\s]+)/);
	if (from?.[1]) return from[1].endsWith(".git") ? from[1] : `${from[1]}.git`;
	return null;
}

function safeSyntheticId(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^[._-]+|[._-]+$/g, "")
			.slice(0, 120) || "span"
	);
}

export async function buildSwebenchTraceBundleFromClickHouse(
	input: RawBuildInput,
	warnings: string[] = [],
): Promise<SwebenchTraceBundle> {
	const page = input.page ?? {
		limit: DEFAULT_TRACE_BUNDLE_LIMIT,
		offset: 0,
	};
	const mlflowTracesUrl = publicTraceUrl(
		input.canonicalTraceId ?? input.traceIds[0],
	);
	if (input.traceIds.length === 0) {
		if (input.workflowNodeSpans?.length) {
			warnings.push("No agent trace ids were recorded; showing workflow node spans from workflow_execution_logs");
		}
		return createBundle(input, {
			backend: input.workflowNodeSpans?.length ? "workflow_logs" : "none",
			mlflowTracesUrl,
			traceSpans: input.workflowNodeSpans ?? [],
			llmSpans: [],
			toolSpans: [],
			warnings,
			derivedLlmSpanCount: 0,
			derivedToolSpanCount: 0,
			truncated: Boolean(input.workflowNodeSpansTruncated),
			nextCursor: input.workflowNodeSpansTruncated
				? encodeTraceBundleCursor(page.offset + page.limit)
				: null,
		});
	}

	const queryWindow = {
		startedAt: page.startedAt,
		completedAt: page.completedAt,
		offset: page.offset,
	};
	const workflowExecutionId = input.workflowExecutionId?.trim() ?? "";
	if (!workflowExecutionId) {
		warnings.push("Derived LLM and tool evidence is unavailable because the workflow execution id is missing");
	}
	const [rawResult, llmResult, toolResult] = await Promise.allSettled([
		getMultiTraceSpanSummaries(input.traceIds, {
			...queryWindow,
			limit: page.limit,
		}),
		workflowExecutionId
			? searchTraceLlmSpans(input.traceIds, {
					...queryWindow,
					workflowExecutionId,
					limit: page.limit + 1,
				})
			: Promise.resolve([]),
		workflowExecutionId
			? searchTraceToolSpans(input.traceIds, {
					...queryWindow,
					workflowExecutionId,
					limit: page.limit + 1,
				})
			: Promise.resolve([]),
	]);

	let traceSpans: ObservabilityTraceSpan[] = [];
	let llmSpans: ObservabilityLlmSpan[] = [];
	let toolSpans: ObservabilityToolSpan[] = [];
	let rawTruncated = false;
	let llmTruncated = false;
	let toolTruncated = false;
	if (rawResult.status === "fulfilled") {
		traceSpans = rawResult.value.spans;
		rawTruncated = rawResult.value.truncated;
	} else {
		warnings.push(`Raw ClickHouse span query failed: ${errorMessage(rawResult.reason)}`);
	}
	if (llmResult.status === "fulfilled") {
		llmTruncated = llmResult.value.length > page.limit;
		llmSpans = llmResult.value.slice(0, page.limit);
	} else {
		warnings.push(`ClickHouse LLM span query failed: ${errorMessage(llmResult.reason)}`);
	}
	if (toolResult.status === "fulfilled") {
		toolTruncated = toolResult.value.length > page.limit;
		toolSpans = toolResult.value.slice(0, page.limit);
	} else {
		warnings.push(`ClickHouse tool span query failed: ${errorMessage(toolResult.reason)}`);
	}

	llmSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	toolSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	traceSpans.sort((a, b) => a.startTime.localeCompare(b.startTime));

	const derivedLlmSpanCount = llmSpans.length;
	const derivedToolSpanCount = toolSpans.length;
	let backend: SwebenchTraceBundleBackend = "clickhouse_derived";
	if (traceSpans.length > 0 && (llmSpans.length === 0 || toolSpans.length === 0)) {
		const normalized = normalizeRawTraceSpans(traceSpans);
		if (llmSpans.length === 0 && normalized.llmSpans.length > 0) {
			warnings.push(
				"ClickHouse derived obs.llm_spans returned zero rows while raw OTel LLM spans exist",
			);
			llmSpans = normalized.llmSpans;
			backend = "clickhouse_raw";
		}
		if (toolSpans.length === 0 && normalized.toolSpans.length > 0) {
			warnings.push(
				"ClickHouse derived obs.tool_spans returned zero rows while raw OTel tool spans exist",
			);
			toolSpans = normalized.toolSpans;
			backend = "clickhouse_raw";
		}
	} else if (traceSpans.length === 0 && llmSpans.length === 0 && toolSpans.length === 0) {
		backend = "none";
	}
	if (traceSpans.length > 0 && llmSpans.length > 0) {
		llmSpans = enrichLlmSpansWithRawTraceAttributes(llmSpans, traceSpans);
	}
	if (input.workflowNodeSpans?.length) {
		traceSpans = mergeTraceSpans(traceSpans, input.workflowNodeSpans);
		if (backend === "none") backend = "workflow_logs";
	}
	const truncated =
		rawTruncated ||
		llmTruncated ||
		toolTruncated ||
		Boolean(input.workflowNodeSpansTruncated);
	if (truncated) {
		warnings.push(`Trace bundle page is capped at ${page.limit} rows per evidence stream`);
	}

	return createBundle(input, {
		backend,
		mlflowTracesUrl,
		traceSpans,
		llmSpans,
		toolSpans,
		warnings,
		derivedLlmSpanCount,
		derivedToolSpanCount,
		truncated,
		nextCursor: truncated ? encodeTraceBundleCursor(page.offset + page.limit) : null,
	});
}

export async function buildSwebenchTraceBundle(
	input: RawBuildInput,
	warnings: string[] = [],
): Promise<SwebenchTraceBundle> {
	return buildSwebenchTraceBundleFromClickHouse(input, warnings);
}

export function normalizeRawTraceSpans(traceSpans: ObservabilityTraceSpan[]): {
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
} {
	const llmSpans: ObservabilityLlmSpan[] = [];
	const toolSpans: ObservabilityToolSpan[] = [];
	for (const span of traceSpans) {
		const attributes = flattenAttributes(span.attributes ?? {});
		const kind = firstString(attributes, ["openinference.span.kind", "span.type"])?.toLowerCase();
		const mlflowSpanType = firstString(attributes, ["mlflow.spanType"])?.toLowerCase();
		const operation = span.operationName.toLowerCase();
		const durableTaskWrapper =
			Boolean(firstString(attributes, ["durabletask.type"])) &&
			!mlflowSpanType &&
			!kind &&
			!firstString(attributes, ["llm.model_name", "gen_ai.request.model", "model", "model_name"]) &&
			!firstString(attributes, ["tool.name", "tool_name", "mcp.tool.name", "function.name", "gen_ai.tool.name"]);
		const toolLike =
			mlflowSpanType === "tool" ||
			kind === "tool" ||
			kind === "function" ||
			(!durableTaskWrapper && operation.includes("tool")) ||
			Boolean(
				firstString(attributes, [
					"tool.name",
					"tool_name",
					"mcp.tool.name",
					"function.name",
					"gen_ai.tool.name",
				]),
			);
		if (toolLike) {
			toolSpans.push(normalizeRawToolSpan(span, attributes));
			continue;
		}
		if (
			mlflowSpanType === "chat_model" ||
			mlflowSpanType === "llm" ||
			kind === "llm" ||
			kind === "chat" ||
			kind === "language_model" ||
			(!durableTaskWrapper && operation.includes("llm")) ||
			Boolean(firstString(attributes, ["llm.model_name", "gen_ai.request.model", "model", "model_name"]))
		) {
			llmSpans.push(normalizeRawLlmSpan(span, attributes));
			continue;
		}
	}
	return {
		llmSpans: llmSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
		toolSpans: toolSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
	};
}

export function enrichLlmSpansWithRawTraceAttributes(
	llmSpans: ObservabilityLlmSpan[],
	traceSpans: ObservabilityTraceSpan[],
): ObservabilityLlmSpan[] {
	const rawById = new Map<string, ObservabilityTraceSpan>();
	for (const span of traceSpans) {
		rawById.set(`${span.traceId}:${span.spanId}`, span);
	}
	return llmSpans.map((span) => {
		const raw = rawById.get(`${span.traceId}:${span.spanId}`);
		if (!raw) return span;
		const usage = usageFromAttributes(flattenAttributes(raw.attributes ?? {}));
		if (!hasUsage(usage)) return span;
		return {
			...span,
			promptTokens: span.promptTokens ?? usage.promptTokens,
			completionTokens: span.completionTokens ?? usage.completionTokens,
			totalTokens: span.totalTokens ?? usage.totalTokens,
			cacheReadInputTokens: span.cacheReadInputTokens ?? usage.cacheReadInputTokens,
			cacheCreationInputTokens: span.cacheCreationInputTokens ?? usage.cacheCreationInputTokens,
			reasoningTokens: span.reasoningTokens ?? usage.reasoningTokens,
		};
	});
}

function createBundle(
	input: RawBuildInput,
	values: {
		backend: SwebenchTraceBundleBackend;
		mlflowTracesUrl: string | null;
		traceSpans: ObservabilityTraceSpan[];
		llmSpans: ObservabilityLlmSpan[];
		toolSpans: ObservabilityToolSpan[];
		warnings: string[];
		derivedLlmSpanCount: number;
		derivedToolSpanCount: number;
		truncated: boolean;
		nextCursor: string | null;
	},
): SwebenchTraceBundle {
	const errorSpanCount = values.traceSpans.filter((span) => span.status === "error").length;
	const foundTraceIds = new Set(values.traceSpans.map((span) => span.traceId));
	const auxiliaryTraces = input.traceIds
		.filter((traceId) => traceId !== input.canonicalTraceId)
		.map((traceId) => ({
			traceId,
			status: foundTraceIds.has(traceId) ? "found" as const : "missing" as const,
		}));
	const groups = groupTraceSpans(values.traceSpans);
	const requiredContext = defaultRequiredContext(
		values.traceSpans,
		values.llmSpans,
		values.toolSpans,
		input.canonicalTraceId,
	);
	return {
		version: 1,
		backend: values.backend,
		artifactPath: input.artifactPath,
		runId: input.runId,
		runInstanceId: input.runInstanceId,
		instanceId: input.instanceId,
		traceIds: input.traceIds,
		canonicalTraceId: input.canonicalTraceId,
		auxiliaryTraces,
		mlflowTracesUrl: values.mlflowTracesUrl,
		traceSpans: values.traceSpans,
		llmSpans: values.llmSpans,
		toolSpans: values.toolSpans,
		summary: {
			traceCount: input.traceIds.length,
			traceSpanCount: values.traceSpans.length,
			llmSpanCount: values.llmSpans.length,
			toolSpanCount: values.toolSpans.length,
			errorSpanCount,
			source: values.backend,
		},
		requiredContext: {
			...requiredContext,
			auxiliaryTracesFound: auxiliaryTraces.filter((trace) => trace.status === "found").length,
			auxiliaryTracesMissing: auxiliaryTraces.filter((trace) => trace.status === "missing").length,
		},
		groups,
		source: {
			kind: values.backend,
			generatedAt: new Date().toISOString(),
			mlflowRunId: null,
			derivedLlmSpanCount: values.derivedLlmSpanCount,
			derivedToolSpanCount: values.derivedToolSpanCount,
			rawTraceSpanCount: values.traceSpans.length,
		},
		warnings: values.warnings,
		truncated: values.truncated,
		nextCursor: values.nextCursor,
	};
}

function groupTraceSpans(traceSpans: ObservabilityTraceSpan[]): SwebenchTraceBundle["groups"] {
	const groups: SwebenchTraceBundle["groups"] = {
		workflowRoot: 0,
		workflowNodes: 0,
		agentTurns: 0,
		llmCalls: 0,
		toolCalls: 0,
		workspaceActions: 0,
		evaluatorHarness: 0,
	};
	for (const span of traceSpans) {
		const attrs = span.attributes ?? {};
		const name = span.operationName.toLowerCase();
		const operation = String(attrs["gen_ai.operation.name"] ?? "").toLowerCase();
		const spanType = String(attrs["mlflow.spanType"] ?? attrs["span.type"] ?? "").toLowerCase();
		const service = span.serviceName.toLowerCase();
		if (span.operationName === "workflow.finalize" || operation === "workflow") {
			groups.workflowRoot += 1;
		} else if (name.startsWith("workflow.node.") || operation === "workflow.node") {
			groups.workflowNodes += 1;
		} else if (name.includes("interaction") || spanType === "agent") {
			groups.agentTurns += 1;
		} else if (spanType === "chat_model" || name.includes("llm") || operation === "chat") {
			groups.llmCalls += 1;
		} else if (spanType === "tool" || name.includes("tool")) {
			groups.toolCalls += 1;
		} else if (name.startsWith("workspace/") || name.includes("workspace")) {
			groups.workspaceActions += 1;
		} else if (service.includes("evaluator") || name.includes("harness") || name.includes("swebench")) {
			groups.evaluatorHarness += 1;
		}
	}
	return groups;
}

function defaultRequiredContext(
	traceSpans: ObservabilityTraceSpan[],
	llmSpans: ObservabilityLlmSpan[],
	toolSpans: ObservabilityToolSpan[],
	canonicalTraceId: string | null,
): SwebenchTraceBundle["requiredContext"] {
	const groups = groupTraceSpans(traceSpans);
	const rootPresent = traceSpans.some(
		(span) =>
			(!canonicalTraceId || span.traceId === canonicalTraceId) &&
			(span.operationName === "workflow.finalize" ||
				span.attributes?.["gen_ai.operation.name"] === "workflow"),
	);
	const statusFinalized = traceSpans.some((span) => {
		if (canonicalTraceId && span.traceId !== canonicalTraceId) return false;
		if (
			span.operationName !== "workflow.finalize" &&
			span.attributes?.["gen_ai.operation.name"] !== "workflow"
		) {
			return false;
		}
		const status = String(
			span.attributes?.["workflow.status"] ?? span.attributes?.["status"] ?? span.statusCode ?? "",
		).toUpperCase();
		return status.includes("OK") || status.includes("ERROR");
	});
	const agentIdentityComplete = [...llmSpans, ...toolSpans].some((span) => {
		const rawSpan = traceSpans.find((candidate) => candidate.spanId === span.spanId);
		const attrs = rawSpan?.attributes ?? {};
		return Boolean(
			attrs["workflow.id"] &&
				attrs["workflow.execution.id"] &&
				attrs["workflow.node.id"] &&
				attrs["workflow.node.name"] &&
				attrs["agent.id"] &&
				attrs["agent.version"] &&
				attrs["agent.slug"] &&
				attrs["agent.app_id"],
		);
	});
	return {
		rootPresent,
		statusFinalized,
		nodeSpansPresent: groups.workflowNodes > 0,
		llmToolSpansPresent: llmSpans.length > 0 || toolSpans.length > 0,
		agentIdentityComplete,
		auxiliaryTracesFound: 0,
		auxiliaryTracesMissing: 0,
	};
}

export function normalizeTraceBundleId(value: string): string | null {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	const traceparent = trimmed.match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/);
	if (traceparent && !/^0+$/.test(traceparent[1])) return traceparent[1];
	const normalized = trimmed.startsWith("tr-") ? trimmed.slice(3) : trimmed;
	if (/^[a-f0-9]{32}$/.test(normalized) && !/^0+$/.test(normalized)) return normalized;
	return null;
}

function publicTraceUrl(traceId: string | null | undefined): string | null {
	const normalized = traceId ? normalizeTraceBundleId(traceId) : null;
	return normalized ? `/observability/${encodeURIComponent(normalized)}` : null;
}


function normalizeRawLlmSpan(
	span: ObservabilityTraceSpan,
	attributes: Record<string, unknown>,
): ObservabilityLlmSpan {
	const inputMessages = messagesFromValue(firstValue(attributes, [
		"input.value",
		"llm.input_messages",
		"gen_ai.prompt",
		"prompt",
	]), "user");
	const outputMessages = messagesFromValue(firstValue(attributes, [
		"output.value",
		"llm.output_messages",
		"gen_ai.completion",
		"completion",
	]), "assistant");
	const usage = usageFromAttributes(attributes);
	return {
		...spanRef(span),
		modelName:
			firstString(attributes, [
				"llm.model_name",
				"gen_ai.request.model",
				"model",
				"model_name",
			]) ?? null,
		provider:
			firstString(attributes, ["llm.provider", "gen_ai.system", "provider", "model_provider"]) ??
			null,
		inputMessages,
		outputMessages,
		invocationParameters: recordFromValue(
			firstValue(attributes, ["invocation_parameters", "llm.invocation_parameters"]),
		),
		finishReason:
			firstString(attributes, [
				"finish_reason",
				"llm.finish_reason",
				"gen_ai.response.finish_reasons",
			]) ?? null,
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.totalTokens,
		cacheReadInputTokens: usage.cacheReadInputTokens,
		cacheCreationInputTokens: usage.cacheCreationInputTokens,
		reasoningTokens: usage.reasoningTokens,
		inputMessagesTruncated: false,
		outputMessagesTruncated: false,
		invocationParametersTruncated: false,
	};
}

function usageFromAttributes(attributes: Record<string, unknown>): Pick<
	ObservabilityLlmSpan,
	| "promptTokens"
	| "completionTokens"
	| "totalTokens"
	| "cacheReadInputTokens"
	| "cacheCreationInputTokens"
	| "reasoningTokens"
> {
	return {
		promptTokens: firstNumber(attributes, [
			"llm.token_count.prompt",
			"gen_ai.usage.input_tokens",
			"usage.prompt_tokens",
			"prompt_tokens",
			"input_tokens",
		]),
		completionTokens: firstNumber(attributes, [
			"llm.token_count.completion",
			"gen_ai.usage.output_tokens",
			"usage.completion_tokens",
			"completion_tokens",
			"output_tokens",
		]),
		totalTokens: firstNumber(attributes, [
			"llm.token_count.total",
			"gen_ai.usage.total_tokens",
			"usage.total_tokens",
			"total_tokens",
		]),
		cacheReadInputTokens: firstNumber(attributes, [
			"gen_ai.usage.cache_read_input_tokens",
			"llm.token_count.cache_read",
			"usage.cache_read_input_tokens",
			"cache_read_input_tokens",
			"cached_content_token_count",
			"prompt_tokens_details.cached_tokens",
			"usage.prompt_tokens_details.cached_tokens",
		]),
		cacheCreationInputTokens: firstNumber(attributes, [
			"gen_ai.usage.cache_creation_input_tokens",
			"llm.token_count.cache_creation",
			"usage.cache_creation_input_tokens",
			"cache_creation_input_tokens",
			"cache_creation_tokens",
		]),
		reasoningTokens: firstNumber(attributes, [
			"gen_ai.usage.reasoning_tokens",
			"llm.token_count.reasoning",
			"usage.reasoning_tokens",
			"reasoning_tokens",
			"thoughts_token_count",
			"completion_tokens_details.reasoning_tokens",
			"usage.completion_tokens_details.reasoning_tokens",
		]),
	};
}

function hasUsage(usage: ReturnType<typeof usageFromAttributes>): boolean {
	return Object.values(usage).some((value) => value != null);
}

function normalizeRawToolSpan(
	span: ObservabilityTraceSpan,
	attributes: Record<string, unknown>,
): ObservabilityToolSpan {
	return {
		...spanRef(span),
		toolName:
			firstString(attributes, [
				"tool.name",
				"tool_name",
				"mcp.tool.name",
				"function.name",
				"gen_ai.tool.name",
			]) ??
			span.operationName ??
			"(unknown tool)",
		toolArguments: firstParsedValue(attributes, [
			"tool.arguments",
			"tool_args",
			"input.value",
			"function.arguments",
		]),
		toolResult: firstParsedValue(attributes, [
			"tool.result",
			"tool_result",
			"output.value",
			"function.output",
		]),
		toolArgumentsTruncated: false,
		toolResultTruncated: false,
	};
}

function spanRef(span: ObservabilityTraceSpan) {
	const attrs = span.attributes ?? {};
	const resources = span.resourceAttributes ?? {};
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		parentSpanId: span.parentSpanId,
		serviceName: span.serviceName,
		timestamp: span.startTime,
		sessionId: stringFrom(attrs["session.id"] ?? resources["session.id"]) ?? "",
		workflowExecutionId:
			stringFrom(
				attrs["workflow.execution.id"] ??
					resources["workflow.execution.id"] ??
					attrs["workflow_execution_id"],
			) ?? "",
		agentRunId:
			stringFrom(attrs["agent.run.id"] ?? attrs["agent_run_id"] ?? resources["agent.run.id"]) ??
			null,
		statusCode: span.statusCode ?? (span.status === "error" ? "STATUS_CODE_ERROR" : "OK"),
	};
}

function normalizeTraceIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.filter((item): item is string => typeof item === "string")
				.map(normalizeTraceBundleId)
				.filter((item): item is string => item !== null),
		),
	);
}

function flattenAttributes(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		const parsed = maybeJson(raw);
		out[key] = parsed;
		if (isRecord(parsed)) {
			flattenAttributeRecord(out, key, parsed);
		}
	}
	return out;
}

function flattenAttributeRecord(
	out: Record<string, unknown>,
	prefix: string,
	value: Record<string, unknown>,
): void {
	for (const [childKey, rawChildValue] of Object.entries(value)) {
		const childValue = maybeJson(rawChildValue);
		out[`${prefix}.${childKey}`] = childValue;
		out[childKey] ??= childValue;
		if (isRecord(childValue)) {
			flattenAttributeRecord(out, `${prefix}.${childKey}`, childValue);
		}
	}
}

function messagesFromValue(value: unknown, role: string): ObservabilityLlmMessage[] {
	const parsed = maybeJson(value);
	if (Array.isArray(parsed)) {
		return parsed.map((item) => normalizeMessage(item, role)).filter(Boolean);
	}
	if (isRecord(parsed) && Array.isArray(parsed.messages)) {
		return parsed.messages.map((item) => normalizeMessage(item, role)).filter(Boolean);
	}
	if (parsed == null || parsed === "") return [];
	return [{ role, content: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }];
}

function normalizeMessage(value: unknown, fallbackRole: string): ObservabilityLlmMessage {
	if (!isRecord(value)) {
		return { role: fallbackRole, content: value == null ? null : String(value) };
	}
	return {
		role: stringFrom(value.role) ?? fallbackRole,
		content: value.content == null ? null : String(value.content),
		name: stringFrom(value.name) ?? undefined,
		toolCallId: stringFrom(value.tool_call_id ?? value.toolCallId) ?? undefined,
		toolCalls: Array.isArray(value.tool_calls)
			? (value.tool_calls as ObservabilityLlmMessage["toolCalls"])
			: Array.isArray(value.toolCalls)
				? (value.toolCalls as ObservabilityLlmMessage["toolCalls"])
				: undefined,
	};
}

function firstValue(attributes: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (attributes[key] != null && attributes[key] !== "") return attributes[key];
	}
	return null;
}

function firstParsedValue(attributes: Record<string, unknown>, keys: string[]): unknown {
	return maybeJson(firstValue(attributes, keys));
}

function firstString(attributes: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = stringFrom(attributes[key]);
		if (value) return value;
	}
	return null;
}

function firstNumber(attributes: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = attributes[key];
		const n =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: NaN;
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function recordFromValue(value: unknown): Record<string, unknown> | null {
	const parsed = maybeJson(value);
	return isRecord(parsed) ? parsed : null;
}

function maybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!["{", "["].includes(trimmed[0])) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function stringFrom(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
