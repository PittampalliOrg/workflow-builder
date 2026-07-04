import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
	workflowExecutionLogs,
	workflowExecutions,
} from "$lib/server/db/schema";
import {
	getMultiTraceLlmSpans,
	getMultiTraceSpans,
	getMultiTraceToolSpans,
} from "$lib/server/otel/clickhouse";
import type {
	ObservabilityLlmMessage,
	ObservabilityLlmSpan,
	ObservabilityToolSpan,
	ObservabilityTraceSpan,
} from "$lib/types/observability";
import {
	denormalizeMlflowTraceId,
	downloadMlflowJsonArtifact,
	ensureBenchmarkInstanceMlflowRun,
	getMlflowNativeTrace,
	logBatch,
	logMlflowJsonArtifact,
	normalizeMlflowTraceId,
	publicMlflowTracesUrl,
	publicWorkflowBuilderTraceUrl,
} from "$lib/server/application/adapters/benchmark-mlflow";
import type { MlflowNativeTrace, MlflowNativeTraceSpan, MlflowTag } from "$lib/server/application/adapters/benchmark-mlflow";

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
};

type LoadTraceBundleOptions = {
	preferArtifact?: boolean;
	repairArtifact?: boolean;
};

type RawBuildInput = {
	runId: string;
	runInstanceId: string | null;
	instanceId: string;
	traceIds: string[];
	canonicalTraceId: string | null;
	mlflowExperimentId: string | null;
	mlflowRunId: string | null;
	artifactPath: string;
	workflowExecutionId?: string | null;
	workflowNodeSpans?: ObservabilityTraceSpan[];
};

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
	options?: LoadTraceBundleOptions;
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
			mlflowExperimentId: benchmarkRuns.mlflowExperimentId,
			runInstanceId: benchmarkRunInstances.id,
			instanceId: benchmarkRunInstances.instanceId,
			traceIds: benchmarkRunInstances.traceIds,
			mlflowRunId: benchmarkRunInstances.mlflowRunId,
			workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
			primaryTraceId: workflowExecutions.primaryTraceId,
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

	const auxiliaryTraceIds = normalizeTraceIds(row.traceIds);
	const canonicalTraceId =
		typeof row.primaryTraceId === "string" && row.primaryTraceId.trim()
			? row.primaryTraceId.trim()
			: auxiliaryTraceIds[0] ?? null;
	const traceIds = canonicalTraceId
		? [canonicalTraceId, ...auxiliaryTraceIds.filter((id) => id !== canonicalTraceId)]
		: auxiliaryTraceIds;
	const artifactPath = safeSwebenchTraceArtifactPath(row.instanceId);
	const workflowNodeSpans = row.workflowExecutionId
		? await loadWorkflowNodeTraceSpans({
				workflowExecutionId: row.workflowExecutionId,
				runId: row.runId,
				runInstanceId: row.runInstanceId,
				instanceId: row.instanceId,
				traceId: canonicalTraceId ?? traceIds[0] ?? null,
			})
		: [];
	const base: RawBuildInput = {
		runId: row.runId,
		runInstanceId: row.runInstanceId,
		instanceId: row.instanceId,
		traceIds,
		canonicalTraceId,
		mlflowExperimentId: row.mlflowExperimentId,
		mlflowRunId: row.mlflowRunId,
		artifactPath,
		workflowExecutionId: row.workflowExecutionId,
		workflowNodeSpans,
	};

	const preferArtifact = params.options?.preferArtifact ?? true;
	const repairArtifact = params.options?.repairArtifact ?? true;
	const warnings: string[] = [];

	if (preferArtifact && row.mlflowRunId) {
		try {
			const artifact = await downloadMlflowJsonArtifact<SwebenchTraceBundle>(
				row.mlflowRunId,
				artifactPath,
			);
			let artifactFound = false;
			if (artifact) {
				artifactFound = true;
				const artifactBackend = artifact.backend;
				if (!repairArtifact || artifactBackend === "mlflow_native") {
					return normalizeArtifactBundle(artifact, artifactPath, canonicalTraceId);
				}
				warnings.push(
					`MLflow artifact ${artifactPath} used ${artifactBackend}; rebuilt from native MLflow traces`,
				);
			}
			if (!artifactFound) {
				warnings.push(`MLflow artifact ${artifactPath} was missing; rebuilt from trace backends`);
			}
		} catch (err) {
			warnings.push(`MLflow artifact read failed; rebuilt from trace backends: ${errorMessage(err)}`);
		}
	}

	const bundle = await buildSwebenchTraceBundle(base, warnings);
	if (repairArtifact && (bundle.traceIds.length > 0 || bundle.traceSpans.length > 0)) {
		await logTraceBundleArtifact(params.runId, params.instanceId, bundle);
	}
	return bundle;
}

function normalizeArtifactBundle(
	artifact: SwebenchTraceBundle,
	artifactPath: string,
	canonicalTraceId: string | null,
): SwebenchTraceBundle {
	return {
		...artifact,
		backend: "mlflow_artifact",
		artifactPath,
		canonicalTraceId:
			artifact.canonicalTraceId ??
			canonicalTraceId ??
			artifact.traceIds?.[0] ??
			null,
		auxiliaryTraces:
			artifact.auxiliaryTraces ??
			(artifact.traceIds ?? [])
				.filter((traceId) => traceId !== (artifact.canonicalTraceId ?? canonicalTraceId))
				.map((traceId) => ({ traceId, status: "missing" as const })),
		requiredContext:
			artifact.requiredContext ??
			defaultRequiredContext(
				artifact.traceSpans ?? [],
				artifact.llmSpans ?? [],
				artifact.toolSpans ?? [],
				artifact.canonicalTraceId ?? canonicalTraceId ?? null,
			),
		groups: artifact.groups ?? groupTraceSpans(artifact.traceSpans ?? []),
		warnings: sanitizedTraceBundleWarnings(artifact),
	};
}

export function sanitizedTraceBundleWarnings(bundle: Pick<SwebenchTraceBundle, "warnings" | "backend" | "source">): string[] {
	const warnings = bundle.warnings ?? [];
	const sourceKind = bundle.source?.kind ?? bundle.backend;
	if (sourceKind !== "mlflow_native") return warnings;
	return warnings.filter((warning) => !isTransientArtifactRepairWarning(warning));
}

function isTransientArtifactRepairWarning(warning: string): boolean {
	return (
		/^MLflow artifact .+ used .+; rebuilt from native MLflow traces$/.test(warning) ||
		/^MLflow artifact .+ was missing; rebuilt from trace backends$/.test(warning) ||
		warning.startsWith("MLflow artifact read failed; rebuilt from trace backends:")
	);
}

export async function materializeSwebenchTraceBundle(params: {
	runId: string;
	instanceId: string;
}): Promise<SwebenchTraceBundle | null> {
	const bundle = await loadSwebenchTraceBundle({
		...params,
		options: { preferArtifact: false, repairArtifact: true },
	});
	return bundle;
}

export async function logTraceBundleArtifact(
	runId: string,
	instanceId: string,
	bundle: SwebenchTraceBundle,
): Promise<void> {
	let mlflowRunId: string | null = null;
	try {
		mlflowRunId =
			bundle.source.mlflowRunId ??
			(await ensureBenchmarkInstanceMlflowRun({ runId, instanceId }));
		if (!mlflowRunId) return;
		await logTraceBundleTags(mlflowRunId, bundle);
		await logParentTraceSummaryTags(runId, bundle);
	} catch (err) {
		console.warn(
			`[mlflow] failed to log trace bundle tags ${runId}/${instanceId}:`,
			errorMessage(err),
		);
	}

	if (!mlflowRunId) return;
	try {
		await logMlflowJsonArtifact({
			runId: mlflowRunId,
			artifactPath: bundle.artifactPath,
			value: {
				...bundle,
				backend: bundle.backend === "none" ? "none" : bundle.backend,
				warnings: sanitizedTraceBundleWarnings(bundle),
			},
		});
	} catch (err) {
		console.warn(
			`[mlflow] failed to log trace bundle artifact ${runId}/${instanceId}:`,
			errorMessage(err),
		);
	}
}

export async function logBenchmarkTraceSummaryArtifact(runId: string): Promise<void> {
	if (!db) return;
	const database = db;
	const [run] = await database
		.select({ mlflowRunId: benchmarkRuns.mlflowRunId })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run?.mlflowRunId) return;
	const rows = await database
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			status: benchmarkRunInstances.status,
			inferenceStatus: benchmarkRunInstances.inferenceStatus,
			evaluationStatus: benchmarkRunInstances.evaluationStatus,
			traceIds: benchmarkRunInstances.traceIds,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));
	const summary = {
		version: 1,
		runId,
		generatedAt: new Date().toISOString(),
		instances: rows.map((row) => {
			const traceIds = normalizeTraceIds(row.traceIds);
			return {
				instanceId: row.instanceId,
				status: row.status,
				inferenceStatus: row.inferenceStatus,
				evaluationStatus: row.evaluationStatus,
				traceCount: traceIds.length,
				artifactPath: safeSwebenchTraceArtifactPath(row.instanceId),
			};
		}),
	};
	try {
		await logMlflowJsonArtifact({
			runId: run.mlflowRunId,
			artifactPath: "traces/summary.json",
			value: summary,
		});
	} catch (err) {
		console.warn(`[mlflow] failed to log trace summary ${runId}:`, errorMessage(err));
	}
}

async function logTraceBundleTags(
	mlflowRunId: string,
	bundle: SwebenchTraceBundle,
): Promise<void> {
	await logBatch(mlflowRunId, {
		tags: compactTags([
			{ key: "workflow_builder.trace_bundle_path", value: bundle.artifactPath },
			{ key: "workflow_builder.trace_backend", value: "mlflow_artifact" },
			{ key: "workflow_builder.trace_count", value: String(bundle.traceIds.length) },
			{ key: "workflow_builder.first_trace_id", value: bundle.canonicalTraceId ?? bundle.traceIds[0] ?? "" },
			{
				key: "workflow_builder.trace_url",
				value:
					publicWorkflowBuilderTraceUrl(bundle.canonicalTraceId ?? bundle.traceIds[0]) ??
					bundle.mlflowTracesUrl ??
					"",
			},
			{
				key: "workflow_builder.trace_span_count",
				value: String(bundle.summary.traceSpanCount),
			},
			{
				key: "workflow_builder.llm_span_count",
				value: String(bundle.summary.llmSpanCount),
			},
			{
				key: "workflow_builder.tool_span_count",
				value: String(bundle.summary.toolSpanCount),
			},
		]),
	});
}

async function logParentTraceSummaryTags(
	runId: string,
	bundle: SwebenchTraceBundle,
): Promise<void> {
	if (!db) return;
	const database = db;
	const [run] = await database
		.select({ mlflowRunId: benchmarkRuns.mlflowRunId })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run?.mlflowRunId) return;

	const rows = await database
		.select({ traceIds: benchmarkRunInstances.traceIds })
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));
	const traceIds = new Set<string>(bundle.traceIds);
	for (const row of rows) {
		for (const traceId of normalizeTraceIds(row.traceIds)) {
			traceIds.add(traceId);
		}
	}
	const firstTraceId = traceIds.values().next().value as string | undefined;
	await logBatch(run.mlflowRunId, {
		tags: compactTags([
			{ key: "workflow_builder.trace_count", value: String(traceIds.size) },
			{ key: "workflow_builder.first_trace_id", value: firstTraceId ?? "" },
			{
				key: "workflow_builder.trace_url",
				value: publicWorkflowBuilderTraceUrl(firstTraceId) ?? "",
			},
			{
				key: "workflow_builder.latest_trace_bundle_path",
				value: bundle.artifactPath,
			},
		]),
	});
}

async function loadWorkflowNodeTraceSpans(input: {
	workflowExecutionId: string;
	runId: string;
	runInstanceId: string | null;
	instanceId: string;
	traceId: string | null;
}): Promise<ObservabilityTraceSpan[]> {
	if (!db) return [];
	const logs = await db
		.select({
			id: workflowExecutionLogs.id,
			nodeId: workflowExecutionLogs.nodeId,
			nodeName: workflowExecutionLogs.nodeName,
			nodeType: workflowExecutionLogs.nodeType,
			activityName: workflowExecutionLogs.activityName,
			status: workflowExecutionLogs.status,
			input: workflowExecutionLogs.input,
			output: workflowExecutionLogs.output,
			error: workflowExecutionLogs.error,
			startedAt: workflowExecutionLogs.startedAt,
			completedAt: workflowExecutionLogs.completedAt,
			duration: workflowExecutionLogs.duration,
		})
		.from(workflowExecutionLogs)
		.where(eq(workflowExecutionLogs.executionId, input.workflowExecutionId))
		.orderBy(asc(workflowExecutionLogs.startedAt));
	if (logs.length === 0) return [];

	const traceId =
		normalizeBundleTraceId(input.traceId ?? "") ??
		`workflow-${safeSyntheticId(input.workflowExecutionId)}`;
	return logs.map((log, index) => {
		const duration = workflowLogDurationMs(log);
		const checkout =
			log.nodeId === "checkout_repo"
				? checkoutAttributes(log.input ?? null, log.output)
				: {};
		const status = log.status === "error" ? "error" : "ok";
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

function checkoutAttributes(input: unknown, output: unknown): Record<string, unknown> {
	const attributes: Record<string, unknown> = {
		"workspace.action": "checkout_repo",
		"git.operation": "checkout",
	};
	const command = stringByPath(input, ["command", "body.command", "input.command"]);
	const outputRecord = recordFromValue(output);
	const result = outputRecord ? recordFromValue(outputRecord.result) ?? outputRecord : null;
	const stderr = stringFrom(result?.stderr);
	const stdout = stringFrom(result?.stdout);
	const repoUrl =
		extractGitRepoUrl(command) ??
		extractGitRepoUrl(stderr) ??
		extractGitRepoUrl(stdout);
	if (repoUrl) attributes["git.repo_url"] = repoUrl;
	if (stderr) attributes["git.stderr_excerpt"] = stderr.slice(0, 1000);
	if (stdout) attributes["git.stdout_excerpt"] = stdout.slice(0, 1000);
	return attributes;
}

function stringByPath(value: unknown, paths: string[]): string | null {
	for (const path of paths) {
		let node = value;
		let found = true;
		for (const part of path.split(".")) {
			const record = recordFromValue(node);
			if (!record || !(part in record)) {
				found = false;
				break;
			}
			node = record[part];
		}
		if (!found) continue;
		const text = stringFrom(node);
		if (text) return text;
	}
	return null;
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

function compactTags(tags: MlflowTag[]): MlflowTag[] {
	return tags.filter((tag) => tag.value.trim().length > 0);
}

export async function buildSwebenchTraceBundleFromClickHouse(
	input: RawBuildInput,
	warnings: string[] = [],
): Promise<SwebenchTraceBundle> {
	const mlflowTracesUrl = publicMlflowTracesUrl(
		input.mlflowExperimentId,
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
		});
	}

	let traceSpans: ObservabilityTraceSpan[] = [];
	let llmSpans: ObservabilityLlmSpan[] = [];
	let toolSpans: ObservabilityToolSpan[] = [];
	try {
		[llmSpans, toolSpans, traceSpans] = await Promise.all([
			getMultiTraceLlmSpans(input.traceIds),
			getMultiTraceToolSpans(input.traceIds),
			getMultiTraceSpans(input.traceIds),
		]);
	} catch (err) {
		warnings.push(`ClickHouse trace query failed: ${errorMessage(err)}`);
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

	return createBundle(input, {
		backend,
		mlflowTracesUrl,
		traceSpans,
		llmSpans,
		toolSpans,
		warnings,
		derivedLlmSpanCount,
		derivedToolSpanCount,
	});
}

export async function buildSwebenchTraceBundle(
	input: RawBuildInput,
	warnings: string[] = [],
): Promise<SwebenchTraceBundle> {
	const native = await buildSwebenchTraceBundleFromMlflowNative(input, warnings);
	if (native.summary.traceSpanCount > 0 && native.backend !== "workflow_logs") return native;
	return buildSwebenchTraceBundleFromClickHouse(input, warnings);
}

export async function buildSwebenchTraceBundleFromMlflowNative(
	input: RawBuildInput,
	warnings: string[] = [],
	loadNativeTrace: (traceId: string) => Promise<MlflowNativeTrace | null> = getMlflowNativeTrace,
): Promise<SwebenchTraceBundle> {
	const mlflowTracesUrl = publicMlflowTracesUrl(
		input.mlflowExperimentId,
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
		});
	}

	const traceSpans: ObservabilityTraceSpan[] = [];
	for (const traceId of input.traceIds) {
		try {
			const native = await loadNativeTrace(traceId);
			if (!native?.trace?.spans?.length) continue;
			traceSpans.push(...normalizeMlflowNativeTraceSpans(native, traceId));
		} catch (err) {
			warnings.push(`MLflow native trace read failed for ${traceId}: ${errorMessage(err)}`);
		}
	}
	const mergedTraceSpans = mergeTraceSpans(traceSpans, input.workflowNodeSpans ?? []);
	const normalized = normalizeRawTraceSpans(traceSpans);
	return createBundle(input, {
		backend: traceSpans.length > 0 ? "mlflow_native" : input.workflowNodeSpans?.length ? "workflow_logs" : "none",
		mlflowTracesUrl,
		traceSpans: mergedTraceSpans,
		llmSpans: normalized.llmSpans,
		toolSpans: normalized.toolSpans,
		warnings,
		derivedLlmSpanCount: normalized.llmSpans.length,
		derivedToolSpanCount: normalized.toolSpans.length,
	});
}

export function normalizeMlflowNativeTraceSpans(
	native: MlflowNativeTrace,
	requestedTraceId: string,
): ObservabilityTraceSpan[] {
	const traceInfoId = native.trace?.trace_info?.trace_id;
	const bundleTraceId =
		normalizeBundleTraceId(requestedTraceId) ??
		denormalizeMlflowTraceId(traceInfoId) ??
		String(traceInfoId ?? requestedTraceId);
	return (native.trace?.spans ?? []).map((span) =>
		normalizeMlflowNativeTraceSpan(span, bundleTraceId),
	);
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
			mlflowRunId: input.mlflowRunId,
			derivedLlmSpanCount: values.derivedLlmSpanCount,
			derivedToolSpanCount: values.derivedToolSpanCount,
			rawTraceSpanCount: values.traceSpans.length,
		},
		warnings: values.warnings,
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

function normalizeMlflowNativeTraceSpan(
	span: MlflowNativeTraceSpan,
	traceId: string,
): ObservabilityTraceSpan {
	const attributes = mlflowAttributesToRecord(span.attributes ?? []);
	const startMs = nanosToMillis(span.start_time_unix_nano);
	const endMs = nanosToMillis(span.end_time_unix_nano);
	const duration = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : 0;
	const statusCode = span.status?.code ?? null;
	const statusMessage = span.status?.message ?? undefined;
	return {
		traceId,
		spanId: span.span_id ?? `${span.name ?? "span"}:${String(span.start_time_unix_nano ?? "")}`,
		parentSpanId: span.parent_id ?? span.parent_span_id ?? null,
		operationName: span.name ?? "(unknown span)",
		serviceName:
			firstString(attributes, [
				"service.name",
				"service_name",
				"telemetry.sdk.name",
				"agent.app_id",
				"agent.name",
			]) ?? "mlflow",
		startTime: startMs != null ? new Date(startMs).toISOString() : new Date(0).toISOString(),
		duration,
		status: statusCode === "STATUS_CODE_ERROR" ? "error" : "ok",
		statusCode: statusCode ?? undefined,
		statusMessage,
		spanKind: firstString(attributes, ["span.kind"]) ?? undefined,
		attributes,
		resourceAttributes: {},
		depth: 0,
	};
}

function normalizeBundleTraceId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return normalizeMlflowTraceId(trimmed)?.slice(3) ?? trimmed;
}

function nanosToMillis(value: unknown): number | null {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: NaN;
	if (!Number.isFinite(n)) return null;
	return n / 1_000_000;
}

function mlflowAttributesToRecord(
	attributes: Array<{ key?: string; value?: unknown }>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const attr of attributes) {
		if (!attr.key) continue;
		out[attr.key] = mlflowAttributeValue(attr.value);
	}
	return out;
}

function mlflowAttributeValue(value: unknown): unknown {
	if (!isRecord(value)) return value;
	if ("string_value" in value) return value.string_value;
	if ("int_value" in value) {
		const n = Number(value.int_value);
		return Number.isFinite(n) ? n : value.int_value;
	}
	if ("double_value" in value) {
		const n = Number(value.double_value);
		return Number.isFinite(n) ? n : value.double_value;
	}
	if ("bool_value" in value) return Boolean(value.bool_value);
	if ("bytes_value" in value) return value.bytes_value;
	if (isRecord(value.array_value)) {
		const items = value.array_value.values;
		return Array.isArray(items) ? items.map(mlflowAttributeValue) : [];
	}
	if (isRecord(value.kvlist_value)) {
		const items = value.kvlist_value.values;
		if (!Array.isArray(items)) return {};
		const out: Record<string, unknown> = {};
		for (const item of items) {
			if (isRecord(item) && typeof item.key === "string") {
				out[item.key] = mlflowAttributeValue(item.value);
			}
		}
		return out;
	}
	return value;
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
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim()),
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
