import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
} from "$lib/server/db/schema";

export type MlflowTag = { key: string; value: string };
type MlflowParam = { key: string; value: string };
type MlflowMetric = {
	key: string;
	value: number;
	timestamp: number;
	step?: number;
};
export type MlflowArtifactInfo = {
	path: string;
	isDir: boolean;
	fileSize: number | null;
};

const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);

function mlflowEnabled(): boolean {
	const enabled = (env.MLFLOW_ENABLED ?? "").trim().toLowerCase();
	if (enabled === "0" || enabled === "false" || enabled === "no" || enabled === "off") {
		return false;
	}
	return Boolean(trackingUri());
}

function trackingUri(): string | null {
	const value = (env.MLFLOW_TRACKING_URI ?? "").trim().replace(/\/+$/, "");
	return value || null;
}

function experimentName(): string {
	const configured = (env.MLFLOW_EXPERIMENT_NAME ?? "").trim();
	if (configured) return configured;
	const cluster = (env.WORKFLOW_BUILDER_ENV ?? "unknown").trim() || "unknown";
	return `workflow-builder/${cluster}/swebench`;
}

export function publicMlflowRunUrl(
	experimentId: string | null | undefined,
	runId: string | null | undefined,
): string | null {
	const base = (publicEnv.PUBLIC_MLFLOW_URL ?? env.PUBLIC_MLFLOW_URL ?? "")
		.trim()
		.replace(/\/+$/, "");
	if (!base || !experimentId || !runId) return null;
	return `${base}/#/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(runId)}`;
}

export function publicMlflowTracesUrl(
	_experimentId: string | null | undefined,
	traceId: string | null | undefined,
): string | null {
	const trimmed = traceId?.trim();
	if (!trimmed) return null;
	return `/api/observability/mlflow/traces/${encodeURIComponent(trimmed)}`;
}

async function mlflowRequest<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const base = trackingUri();
	if (!base) throw new Error("MLFLOW_TRACKING_URI is not configured");
	const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
	const timeoutMs = Number.isFinite(rawTimeoutMs) ? Math.max(500, rawTimeoutMs) : 3000;
	const res = await fetch(`${base}${path}`, {
		...init,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			...(init.method && init.method !== "GET"
				? { "Content-Type": "application/json" }
				: {}),
			...(init.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`MLflow ${path} returned ${res.status}: ${text.slice(0, 500)}`);
	}
	return (await res.json().catch(() => ({}))) as T;
}

async function mlflowTextRequest(
	path: string,
	init: RequestInit = {},
): Promise<string> {
	const base = trackingUri();
	if (!base) throw new Error("MLFLOW_TRACKING_URI is not configured");
	const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
	const timeoutMs = Number.isFinite(rawTimeoutMs) ? Math.max(500, rawTimeoutMs) : 3000;
	const res = await fetch(`${base}${path}`, {
		...init,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			Accept: "application/json, text/plain, */*",
			...(init.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`MLflow ${path} returned ${res.status}: ${text.slice(0, 500)}`);
	}
	return await res.text();
}

function warnMlflow(message: string, err: unknown) {
	console.warn(`[mlflow] ${message}:`, err instanceof Error ? err.message : err);
}

function encodeArtifactPath(path: string): string {
	return path
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export async function listMlflowArtifacts(
	runId: string,
	path = "",
): Promise<MlflowArtifactInfo[]> {
	const qs = new URLSearchParams({ run_id: runId });
	if (path) qs.set("path", path);
	const payload = await mlflowRequest<{
		files?: Array<{ path?: string; is_dir?: boolean; file_size?: number | string }>;
	}>(`/api/2.0/mlflow/artifacts/list?${qs.toString()}`, { method: "GET" });
	return (payload.files ?? []).map((file) => ({
		path: String(file.path ?? ""),
		isDir: Boolean(file.is_dir),
		fileSize:
			typeof file.file_size === "number"
				? file.file_size
				: typeof file.file_size === "string" && Number.isFinite(Number(file.file_size))
					? Number(file.file_size)
					: null,
	}));
}

export async function downloadMlflowTextArtifact(
	runId: string,
	artifactPath: string,
): Promise<string | null> {
	const listed = await listMlflowArtifacts(runId, artifactPath);
	if (
		!listed.some(
			(file) => !file.isDir && file.path.replace(/^\/+/, "") === artifactPath.replace(/^\/+/, ""),
		)
	) {
		return null;
	}
	const encodedPath = encodeArtifactPath(artifactPath);
	const runQuery = new URLSearchParams({ run_id: runId });
	const attempts = [
		`/api/2.0/mlflow-artifacts/artifacts/${encodedPath}?${runQuery.toString()}`,
		`/get-artifact?${new URLSearchParams({ run_id: runId, path: artifactPath }).toString()}`,
		`/get-artifact?${new URLSearchParams({ run_uuid: runId, path: artifactPath }).toString()}`,
	];
	let lastErr: unknown = null;
	for (const path of attempts) {
		try {
			return await mlflowTextRequest(path, { method: "GET" });
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(`Failed to download MLflow artifact ${artifactPath}`);
}

export async function downloadMlflowJsonArtifact<T>(
	runId: string,
	artifactPath: string,
): Promise<T | null> {
	const text = await downloadMlflowTextArtifact(runId, artifactPath);
	if (text == null) return null;
	return JSON.parse(text) as T;
}

export async function logMlflowTextArtifact(params: {
	runId: string;
	artifactPath: string;
	text: string;
	contentType?: string;
}): Promise<void> {
	const encodedPath = encodeArtifactPath(params.artifactPath);
	await mlflowTextRequest(
		`/api/2.0/mlflow-artifacts/artifacts/${encodedPath}?${new URLSearchParams({
			run_id: params.runId,
		}).toString()}`,
		{
			method: "PUT",
			body: params.text,
			headers: {
				"Content-Type": params.contentType ?? "text/plain; charset=utf-8",
			},
		},
	);
}

export async function logMlflowJsonArtifact(params: {
	runId: string;
	artifactPath: string;
	value: unknown;
}): Promise<void> {
	await logMlflowTextArtifact({
		runId: params.runId,
		artifactPath: params.artifactPath,
		text: `${JSON.stringify(params.value, null, 2)}\n`,
		contentType: "application/json; charset=utf-8",
	});
}

async function getOrCreateExperimentId(): Promise<string> {
	const name = experimentName();
	const qs = new URLSearchParams({ experiment_name: name });
	try {
		const found = await mlflowRequest<{
			experiment?: { experiment_id?: string };
		}>(`/api/2.0/mlflow/experiments/get-by-name?${qs.toString()}`, {
			method: "GET",
		});
		if (found.experiment?.experiment_id) return found.experiment.experiment_id;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("RESOURCE_DOES_NOT_EXIST") && !msg.includes("404")) throw err;
	}
	let created: { experiment_id?: string };
	try {
		created = await mlflowRequest<{ experiment_id?: string }>(
			"/api/2.0/mlflow/experiments/create",
			{
				method: "POST",
				body: JSON.stringify({
					name,
					tags: [
						{ key: "workflow_builder.kind", value: "swebench" },
						{ key: "workflow_builder.env", value: env.WORKFLOW_BUILDER_ENV ?? "unknown" },
					],
				}),
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("RESOURCE_ALREADY_EXISTS") && !msg.includes("already exists")) {
			throw err;
		}
		const retry = await mlflowRequest<{ experiment?: { experiment_id?: string } }>(
			`/api/2.0/mlflow/experiments/get-by-name?${qs.toString()}`,
			{ method: "GET" },
		);
		created = { experiment_id: retry.experiment?.experiment_id };
	}
	if (!created.experiment_id) throw new Error("MLflow experiment create returned no id");
	return created.experiment_id;
}

async function createRun(params: {
	experimentId: string;
	name: string;
	tags: MlflowTag[];
	startTime?: Date | null;
}): Promise<string> {
	const payload = {
		experiment_id: params.experimentId,
		start_time: (params.startTime ?? new Date()).getTime(),
		tags: [{ key: "mlflow.runName", value: params.name }, ...params.tags],
	};
	const created = await mlflowRequest<{
		run?: { info?: { run_id?: string } };
	}>("/api/2.0/mlflow/runs/create", {
		method: "POST",
		body: JSON.stringify(payload),
	});
	const runId = created.run?.info?.run_id;
	if (!runId) throw new Error("MLflow run create returned no run id");
	return runId;
}

export async function logBatch(
	runId: string,
	payload: {
		params?: MlflowParam[];
		metrics?: MlflowMetric[];
		tags?: MlflowTag[];
	},
) {
	if (
		(payload.params?.length ?? 0) === 0 &&
		(payload.metrics?.length ?? 0) === 0 &&
		(payload.tags?.length ?? 0) === 0
	) {
		return;
	}
	await mlflowRequest("/api/2.0/mlflow/runs/log-batch", {
		method: "POST",
		body: JSON.stringify({ run_id: runId, ...payload }),
	});
}

async function updateRunStatus(runId: string, status: string, endTime?: Date | null) {
	await mlflowRequest("/api/2.0/mlflow/runs/update", {
		method: "POST",
		body: JSON.stringify({
			run_id: runId,
			status,
			...(endTime ? { end_time: endTime.getTime() } : {}),
		}),
	});
}

function tag(key: string, value: unknown): MlflowTag {
	return { key, value: stringValue(value) };
}

function param(key: string, value: unknown): MlflowParam {
	return { key, value: stringValue(value) };
}

function metric(key: string, value: unknown, step = 0): MlflowMetric | null {
	if (value == null) return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return null;
	return { key, value: n, timestamp: Date.now(), step };
}

function stringValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.slice(0, 5000);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value).slice(0, 5000);
}

function compactMetrics(values: Array<MlflowMetric | null>): MlflowMetric[] {
	return values.filter((m): m is MlflowMetric => Boolean(m));
}

export async function ensureBenchmarkMlflowRun(runId: string): Promise<string | null> {
	if (!mlflowEnabled() || !db) return null;
	const database = db;
	const [row] = await database
		.select({
			run: benchmarkRuns,
			suiteSlug: benchmarkSuites.slug,
			suiteName: benchmarkSuites.name,
			agentName: agents.name,
			agentSlug: agents.slug,
		})
		.from(benchmarkRuns)
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!row) return null;
	if (row.run.mlflowRunId) return row.run.mlflowRunId;
	try {
		const experimentId = await getOrCreateExperimentId();
		const mlflowRunId = await createRun({
			experimentId,
			name: `${row.suiteSlug}/${row.agentSlug ?? row.run.agentId}/${row.run.id.slice(0, 8)}`,
			startTime: row.run.startedAt ?? row.run.createdAt,
			tags: [
				tag("workflow_builder.kind", "swebench_run"),
				tag("workflow_builder.benchmark_run_id", row.run.id),
				tag("workflow_builder.project_id", row.run.projectId),
				tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
				tag("swebench.suite", row.suiteSlug),
				tag("agent.id", row.run.agentId),
				tag("agent.slug", row.agentSlug),
				tag("agent.version", row.run.agentVersion),
			],
		});
		await database
			.update(benchmarkRuns)
			.set({
				mlflowExperimentId: experimentId,
				mlflowRunId,
				updatedAt: new Date(),
			})
			.where(eq(benchmarkRuns.id, row.run.id));
		await logBatch(mlflowRunId, {
			params: [
				param("suite", row.suiteSlug),
				param("suite_name", row.suiteName),
				param("agent_id", row.run.agentId),
				param("agent_slug", row.agentSlug),
				param("agent_version", row.run.agentVersion),
				param("agent_runtime", row.run.agentRuntime),
				param("agent_runtime_app_id", row.run.agentRuntimeAppId),
				param("model_name_or_path", row.run.modelNameOrPath),
				param("model_config_label", row.run.modelConfigLabel),
				param("concurrency", row.run.concurrency),
				param("evaluation_concurrency", row.run.evaluationConcurrency),
				param("timeout_seconds", row.run.timeoutSeconds),
				param("max_turns", row.run.maxTurns),
				param("evaluator_resource_class", row.run.evaluatorResourceClass),
				param("selected_instance_count", row.run.selectedInstanceIds.length),
				param("tags", row.run.tags),
			],
			metrics: compactMetrics([
				metric("selected_instance_count", row.run.selectedInstanceIds.length),
			]),
			tags: [tag("workflow_builder.status", row.run.status)],
		});
		return mlflowRunId;
	} catch (err) {
		warnMlflow(`failed to create benchmark MLflow run ${runId}`, err);
		return null;
	}
}

export async function ensureBenchmarkInstanceMlflowRun(params: {
	runId: string;
	instanceId: string;
}): Promise<string | null> {
	if (!mlflowEnabled() || !db) return null;
	const parentRunId = await ensureBenchmarkMlflowRun(params.runId);
	if (!parentRunId) return null;
	const database = db;
	const [row] = await database
		.select({
			run: benchmarkRuns,
			runInstance: benchmarkRunInstances,
			suiteSlug: benchmarkSuites.slug,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) return null;
	if (row.runInstance.mlflowRunId) return row.runInstance.mlflowRunId;
	try {
		const experimentId = row.run.mlflowExperimentId ?? (await getOrCreateExperimentId());
		const mlflowRunId = await createRun({
			experimentId,
			name: row.runInstance.instanceId,
			startTime: row.runInstance.startedAt ?? row.run.startedAt ?? row.run.createdAt,
			tags: [
				tag("mlflow.parentRunId", parentRunId),
				tag("workflow_builder.kind", "swebench_instance"),
				tag("workflow_builder.benchmark_run_id", row.run.id),
				tag("workflow_builder.benchmark_run_instance_id", row.runInstance.id),
				tag("swebench.suite", row.suiteSlug),
				tag("swebench.instance_id", row.runInstance.instanceId),
			],
		});
		await database
			.update(benchmarkRunInstances)
			.set({ mlflowRunId, updatedAt: new Date() })
			.where(eq(benchmarkRunInstances.id, row.runInstance.id));
		await logBatch(mlflowRunId, {
			params: [
				param("instance_id", row.runInstance.instanceId),
				param("run_id", row.run.id),
				param("model_name_or_path", row.run.modelNameOrPath),
			],
			tags: [
				tag("workflow_builder.status", row.runInstance.status),
				tag("workflow_builder.inference_status", row.runInstance.inferenceStatus),
				tag("workflow_builder.evaluation_status", row.runInstance.evaluationStatus),
			],
		});
		return mlflowRunId;
	} catch (err) {
		warnMlflow(
			`failed to create benchmark instance MLflow run ${params.runId}/${params.instanceId}`,
			err,
		);
		return null;
	}
}

export async function syncBenchmarkInstanceMlflow(params: {
	runId: string;
	instanceId: string;
}): Promise<void> {
	if (!mlflowEnabled() || !db) return;
	try {
		const mlflowRunId = await ensureBenchmarkInstanceMlflowRun(params);
		if (!mlflowRunId) return;
		const [row] = await db
			.select()
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, params.runId),
					eq(benchmarkRunInstances.instanceId, params.instanceId),
				),
			)
			.limit(1);
		if (!row) return;
		const usage = isRecord(row.usage) ? row.usage : {};
		const timings = isRecord(row.timings) ? row.timings : {};
		await logBatch(mlflowRunId, {
			metrics: compactMetrics([
				metric("resolved", row.status === "resolved" ? 1 : 0),
				metric("patch_bytes", row.patchBytes),
				metric("patch_added_lines", row.patchAddedLines),
				metric("patch_removed_lines", row.patchRemovedLines),
				metric("patch_files_touched", row.patchFilesTouched),
				metric("patch_files_overlap_gold", row.patchFilesOverlapGold),
				metric(
					"patch_well_formed",
					row.patchWellFormed ? 1 : row.patchWellFormed === false ? 0 : null,
				),
				metric("turn_count", row.turnCount),
				metric("tool_call_count", row.toolCallCount),
				metric("ttft_first_ms", row.ttftFirstMs),
				metric("ttft_first_tool_ms", row.ttftFirstToolMs),
				metric("input_tokens", usage.input_tokens),
				metric("output_tokens", usage.output_tokens),
				metric("cache_read_tokens", usage.cache_read_input_tokens),
				metric("cache_create_tokens", usage.cache_creation_input_tokens),
				metric("cost_usd", usage.cost_usd),
				metric("inference_duration_ms", timings.inference_duration_ms),
				metric("evaluation_duration_ms", timings.evaluation_duration_ms),
				metric("workflow_duration_ms", timings.workflow_duration_ms),
				metric("sandbox_startup_ms", timings.sandbox_startup_ms),
				metric("repo_checkout_ms", timings.repo_checkout_ms),
				metric("agent_solve_ms", timings.agent_solve_ms),
				metric("patch_extraction_ms", timings.patch_extraction_ms),
				metric("cleanup_ms", timings.cleanup_ms),
				metric("turn_duration_ms", timings.turn_duration_ms),
				metric("active_turn_elapsed_ms", timings.active_turn_elapsed_ms),
				metric("llm_duration_ms", timings.llm_duration_ms),
				metric("llm_duration_p90_ms", timings.llm_duration_p90_ms),
				metric("tool_duration_ms", timings.tool_duration_ms),
				metric("tool_duration_p90_ms", timings.tool_duration_p90_ms),
			]),
			tags: [
				tag("workflow_builder.status", row.status),
				tag("workflow_builder.inference_status", row.inferenceStatus),
				tag("workflow_builder.evaluation_status", row.evaluationStatus),
				tag("workflow_builder.session_id", row.sessionId),
				tag("workflow_builder.workflow_execution_id", row.workflowExecutionId),
				tag("workflow_builder.dapr_instance_id", row.daprInstanceId),
				tag("workflow_builder.sandbox_name", row.sandboxName),
				tag("workflow_builder.workspace_ref", row.workspaceRef),
				tag("workflow_builder.trace_ids", row.traceIds),
				tag("workflow_builder.patch_sha256", row.patchSha256),
				tag("workflow_builder.logs_path", row.logsPath),
				tag("workflow_builder.termination_reason", row.terminationReason),
			],
		});
	} catch (err) {
		warnMlflow(
			`failed to sync instance MLflow metrics ${params.runId}/${params.instanceId}`,
			err,
		);
	}
}

export async function syncBenchmarkRunMlflow(
	runId: string,
	options: { terminate?: boolean } = {},
): Promise<void> {
	if (!mlflowEnabled() || !db) return;
	try {
		const mlflowRunId = await ensureBenchmarkMlflowRun(runId);
		if (!mlflowRunId) return;
		const [run] = await db
			.select()
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runId))
			.limit(1);
		if (!run) return;
		const summary = isRecord(run.summary) ? run.summary : {};
		await logBatch(mlflowRunId, {
			metrics: compactMetrics([
				metric("total", summary.total),
				metric("resolved_count", summary.resolved),
				metric("failed_count", summary.failed),
				metric("error_count", summary.error),
				metric("timeout_count", summary.timeout),
				metric("cancelled_count", summary.cancelled),
				metric("resolution_rate", summary.resolvedRate),
				metric("selected_instance_count", run.selectedInstanceIds.length),
			]),
			tags: [
				tag("workflow_builder.status", run.status),
				tag("workflow_builder.coordinator_execution_id", run.coordinatorExecutionId),
				tag("workflow_builder.evaluator_job_name", run.evaluatorJobName),
				tag("workflow_builder.predictions_path", run.predictionsPath),
				tag("workflow_builder.error", run.error),
			],
		});
		if (options.terminate || terminalRunStatuses.has(run.status)) {
			const mlflowStatus =
				run.status === "completed"
					? "FINISHED"
					: run.status === "cancelled"
						? "KILLED"
						: "FAILED";
			await updateRunStatus(mlflowRunId, mlflowStatus, run.completedAt ?? new Date());
		}
	} catch (err) {
		warnMlflow(`failed to sync benchmark MLflow run ${runId}`, err);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
