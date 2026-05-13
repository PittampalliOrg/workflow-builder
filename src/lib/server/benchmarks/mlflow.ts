import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	benchmarkInstances,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
	workflowExecutions,
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
const terminalInstanceStatuses = new Set([
	"resolved",
	"failed",
	"error",
	"timeout",
	"cancelled",
]);
const terminalMlflowStatuses = new Set(["FINISHED", "FAILED", "KILLED"]);

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

export function mlflowArtifactLocationForExperiment(name: string): string {
	return `mlflow-artifacts:/${name
		.split("/")
		.map((part) => safeArtifactName(part))
		.filter(Boolean)
		.join("/")}`;
}

export function normalizeMlflowTraceId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	const traceparent = raw.match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/);
	if (traceparent) return `tr-${traceparent[1]}`;
	const normalized = raw.startsWith("tr-") ? raw.slice(3) : raw;
	if (/^[a-f0-9]{32}$/.test(normalized) && !/^0+$/.test(normalized)) {
		return `tr-${normalized}`;
	}
	return null;
}

function resolveCanonicalMlflowTraceId(
	primaryTraceId: unknown,
	traceIds: unknown,
): string | null {
	const primary = normalizeMlflowTraceId(primaryTraceId);
	if (primary) return primary;
	if (Array.isArray(traceIds)) {
		for (const traceId of traceIds) {
			const normalized = normalizeMlflowTraceId(traceId);
			if (normalized) return normalized;
		}
	}
	return null;
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

function publicWorkflowBuilderUrl(): string | null {
	const base = (
		publicEnv.PUBLIC_WORKFLOW_BUILDER_URL ??
		publicEnv.PUBLIC_APP_URL ??
		env.PUBLIC_WORKFLOW_BUILDER_URL ??
		env.APP_PUBLIC_URL ??
		env.APP_URL ??
		env.NEXT_PUBLIC_APP_URL ??
		""
	)
		.trim()
		.replace(/\/+$/, "");
	return base || null;
}

export function publicWorkflowBuilderTraceUrl(
	traceId: string | null | undefined,
): string | null {
	const path = publicMlflowTracesUrl(null, traceId);
	if (!path) return null;
	const base = publicWorkflowBuilderUrl();
	return base ? `${base}${path}` : path;
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

function safeArtifactName(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^[._-]+|[._-]+$/g, "")
			.slice(0, 180) || "artifact"
	);
}

export async function listMlflowArtifacts(
	runId: string,
	path = "",
	options: { proxiedFallback?: boolean } = {},
): Promise<MlflowArtifactInfo[]> {
	const qs = new URLSearchParams({ run_id: runId });
	if (path) qs.set("path", path);
	const payload = await mlflowRequest<{
		files?: Array<{ path?: string; is_dir?: boolean; file_size?: number | string }>;
	}>(`/api/2.0/mlflow/artifacts/list?${qs.toString()}`, { method: "GET" });
	const files = payload.files ?? [];
	if (files.length > 0) {
		return files.map((file) => ({
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
	if (options.proxiedFallback === false) {
		return [];
	}
	const artifactQs = new URLSearchParams({ run_id: runId });
	if (path) artifactQs.set("path", path);
	let artifactPayload: {
		files?: Array<{ path?: string; is_dir?: boolean; file_size?: number | string }>;
	};
	try {
		artifactPayload = await mlflowRequest<{
			files?: Array<{ path?: string; is_dir?: boolean; file_size?: number | string }>;
		}>(`/api/2.0/mlflow-artifacts/artifacts?${artifactQs.toString()}`, { method: "GET" });
	} catch (err) {
		if (isMlflowMissingArtifactError(err)) {
			return [];
		}
		throw err;
	}
	return (artifactPayload.files ?? []).map((file) => ({
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
	const listed = await listMlflowArtifacts(runId, artifactPath, { proxiedFallback: false });
	const listedExact = listed.some(
		(file) => !file.isDir && file.path.replace(/^\/+/, "") === artifactPath.replace(/^\/+/, ""),
	);
	if (listed.length > 0 && !listedExact) {
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
	if (listed.length === 0 && isMlflowMissingArtifactError(lastErr)) {
		return null;
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(`Failed to download MLflow artifact ${artifactPath}`);
}

function isMlflowMissingArtifactError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes(" returned 404") || message.includes("RESOURCE_DOES_NOT_EXIST");
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
	console.warn(
		`[mlflow] SWE-bench experiment ${name} was not found; creating it with artifact_location=${mlflowArtifactLocationForExperiment(name)}`,
	);
	let created: { experiment_id?: string };
	try {
		created = await mlflowRequest<{ experiment_id?: string }>(
			"/api/2.0/mlflow/experiments/create",
			{
				method: "POST",
				body: JSON.stringify({
					name,
					artifact_location: mlflowArtifactLocationForExperiment(name),
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

async function getRun(runId: string): Promise<{
	info?: { run_id?: string; status?: string; experiment_id?: string };
	data?: { tags?: MlflowTag[] };
} | null> {
	const qs = new URLSearchParams({ run_id: runId });
	const payload = await mlflowRequest<{
		run?: {
			info?: { run_id?: string; status?: string; experiment_id?: string };
			data?: { tags?: MlflowTag[] };
		};
	}>(`/api/2.0/mlflow/runs/get?${qs.toString()}`, { method: "GET" });
	return payload.run ?? null;
}

function escapeMlflowFilterValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function searchTagFilter(tags: MlflowTag[]): string {
	return tags
		.map((item) => `tags.\`${item.key}\` = '${escapeMlflowFilterValue(item.value)}'`)
		.join(" AND ");
}

async function findRunByTags(
	experimentId: string,
	tags: MlflowTag[],
): Promise<string | null> {
	if (tags.length === 0) return null;
	const payload = await mlflowRequest<{
		runs?: Array<{ info?: { run_id?: string; lifecycle_stage?: string } }>;
	}>("/api/2.0/mlflow/runs/search", {
		method: "POST",
		body: JSON.stringify({
			experiment_ids: [experimentId],
			filter: searchTagFilter(tags),
			max_results: 1,
			order_by: ["attributes.start_time DESC"],
		}),
	});
	const run = (payload.runs ?? []).find(
		(candidate) => candidate.info?.lifecycle_stage !== "deleted" && candidate.info?.run_id,
	);
	return run?.info?.run_id ?? null;
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

async function updateRunStatusOnce(runId: string, status: string, endTime?: Date | null) {
	try {
		const run = await getRun(runId);
		const current = run?.info?.status;
		if (current && terminalMlflowStatuses.has(current)) return;
	} catch (err) {
		warnMlflow(`failed to inspect MLflow run status ${runId}`, err);
	}
	await updateRunStatus(runId, status, endTime);
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
			agentMlflowUri: agentVersions.mlflowUri,
			agentConfigHash: agentVersions.configHash,
		})
		.from(benchmarkRuns)
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.leftJoin(
			agentVersions,
			and(
				eq(agentVersions.agentId, benchmarkRuns.agentId),
				eq(agentVersions.version, benchmarkRuns.agentVersion),
			),
		)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!row) return null;
	if (row.run.mlflowRunId) return row.run.mlflowRunId;
	try {
		const experimentId = await getOrCreateExperimentId();
		const identityTags = [
			tag("workflow_builder.kind", "swebench_run"),
			tag("workflow_builder.benchmark_run_id", row.run.id),
		];
		let mlflowRunId = await findRunByTags(experimentId, identityTags);
		if (!mlflowRunId) {
			mlflowRunId = await createRun({
				experimentId,
				name: `${row.suiteSlug}/${row.agentSlug ?? row.run.agentId}/${row.run.id.slice(0, 8)}`,
				startTime: row.run.startedAt ?? row.run.createdAt,
				tags: [
					...identityTags,
					tag("workflow_builder.project_id", row.run.projectId),
					tag("workflow_builder.env", env.WORKFLOW_BUILDER_ENV ?? "unknown"),
					tag("swebench.suite", row.suiteSlug),
					tag("agent.id", row.run.agentId),
					tag("agent.slug", row.agentSlug),
					tag("agent.version", row.run.agentVersion),
					tag("agent.config_hash", row.agentConfigHash),
					tag("agent.mlflow_uri", row.agentMlflowUri),
					tag("agent.runtime", row.run.agentRuntime),
					tag("mlflow.dataset.id", row.run.mlflowDatasetId),
				],
			});
		}
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
				param("agent_config_hash", row.agentConfigHash),
				param("agent_mlflow_uri", row.agentMlflowUri),
				param("agent_runtime", row.run.agentRuntime),
				param("agent_runtime_app_id", row.run.agentRuntimeAppId),
				param("mlflow_dataset_id", row.run.mlflowDatasetId),
				param("model_name_or_path", row.run.modelNameOrPath),
				param("model_config_label", row.run.modelConfigLabel),
				param("concurrency", row.run.concurrency),
				param("evaluation_concurrency", row.run.evaluationConcurrency),
				param("timeout_seconds", row.run.timeoutSeconds),
				param("max_turns", row.run.maxTurns),
				param("evaluator_resource_class", row.run.evaluatorResourceClass),
				param("evaluator_image", env.SWEBENCH_EVALUATOR_IMAGE),
				param("git_sha", env.GIT_SHA ?? env.SOURCE_VERSION ?? env.VERCEL_GIT_COMMIT_SHA),
				param("prompt_template_version", env.SWEBENCH_PROMPT_TEMPLATE_VERSION),
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
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			instanceMlflowDatasetId: benchmarkInstances.mlflowDatasetId,
			instanceMlflowDatasetRecordId: benchmarkInstances.mlflowDatasetRecordId,
			primaryTraceId: workflowExecutions.primaryTraceId,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.suiteId, benchmarkRuns.suiteId),
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
			),
		)
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
		)
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) return null;
	const mlflowTraceId = resolveCanonicalMlflowTraceId(
		row.primaryTraceId,
		row.runInstance.traceIds,
	);
	const mlflowDatasetId =
		row.runInstance.mlflowDatasetId ?? row.instanceMlflowDatasetId ?? row.run.mlflowDatasetId;
	const mlflowDatasetRecordId =
		row.runInstance.mlflowDatasetRecordId ?? row.instanceMlflowDatasetRecordId;
	if (row.runInstance.mlflowRunId) {
		if (
			(mlflowTraceId && row.runInstance.mlflowTraceId !== mlflowTraceId) ||
			(mlflowDatasetId && row.runInstance.mlflowDatasetId !== mlflowDatasetId) ||
			(mlflowDatasetRecordId &&
				row.runInstance.mlflowDatasetRecordId !== mlflowDatasetRecordId)
		) {
			await database
				.update(benchmarkRunInstances)
				.set({
					mlflowTraceId,
					mlflowDatasetId: mlflowDatasetId ?? row.runInstance.mlflowDatasetId,
					mlflowDatasetRecordId:
						mlflowDatasetRecordId ?? row.runInstance.mlflowDatasetRecordId,
					updatedAt: new Date(),
				})
				.where(eq(benchmarkRunInstances.id, row.runInstance.id));
		}
		return row.runInstance.mlflowRunId;
	}
	try {
		const experimentId = row.run.mlflowExperimentId ?? (await getOrCreateExperimentId());
		const identityTags = [
			tag("workflow_builder.kind", "swebench_instance"),
			tag("workflow_builder.benchmark_run_id", row.run.id),
			tag("workflow_builder.benchmark_run_instance_id", row.runInstance.id),
		];
		let mlflowRunId = await findRunByTags(experimentId, identityTags);
		if (!mlflowRunId) {
			mlflowRunId = await createRun({
				experimentId,
				name: row.runInstance.instanceId,
				startTime: row.runInstance.startedAt ?? row.run.startedAt ?? row.run.createdAt,
				tags: [
					tag("mlflow.parentRunId", parentRunId),
					...identityTags,
					tag("workflow_builder.workflow_execution_id", row.runInstance.workflowExecutionId),
					tag("workflow_builder.primary_trace_id", row.primaryTraceId),
					tag("workflow_builder.mlflow_trace_id", mlflowTraceId),
					tag("mlflow.trace_id", mlflowTraceId),
					tag("mlflow.dataset.id", mlflowDatasetId),
					tag("mlflow.dataset.record_id", mlflowDatasetRecordId),
					tag("swebench.suite", row.suiteSlug),
					tag("swebench.instance_id", row.runInstance.instanceId),
					tag("swebench.repo", row.repo),
					tag("swebench.base_commit", row.baseCommit),
					tag("agent.id", row.run.agentId),
					tag("agent.version", row.run.agentVersion),
					tag("agent.runtime", row.run.agentRuntime),
				],
			});
		}
		await database
			.update(benchmarkRunInstances)
			.set({
				mlflowRunId,
				mlflowTraceId,
				mlflowDatasetId: mlflowDatasetId ?? null,
				mlflowDatasetRecordId: mlflowDatasetRecordId ?? null,
				updatedAt: new Date(),
			})
			.where(eq(benchmarkRunInstances.id, row.runInstance.id));
		await logBatch(mlflowRunId, {
			params: [
				param("instance_id", row.runInstance.instanceId),
				param("run_id", row.run.id),
				param("repo", row.repo),
				param("base_commit", row.baseCommit),
				param("mlflow_trace_id", mlflowTraceId),
				param("mlflow_dataset_id", mlflowDatasetId),
				param("mlflow_dataset_record_id", mlflowDatasetRecordId),
				param(
					"environment_key",
					readRecordString(row.runInstance.inferenceEnvironment, "environmentKey"),
				),
				param(
					"environment_image",
					readRecordString(row.runInstance.inferenceEnvironment, "sandboxImage"),
				),
				param(
					"environment_image_digest",
					readRecordString(row.runInstance.inferenceEnvironment, "digest"),
				),
				param("model_name_or_path", row.run.modelNameOrPath),
			],
			tags: [
				tag("workflow_builder.status", row.runInstance.status),
				tag("workflow_builder.inference_status", row.runInstance.inferenceStatus),
				tag("workflow_builder.evaluation_status", row.runInstance.evaluationStatus),
				tag("workflow_builder.workflow_execution_id", row.runInstance.workflowExecutionId),
				tag("workflow_builder.primary_trace_id", row.primaryTraceId),
				tag("workflow_builder.mlflow_trace_id", mlflowTraceId),
				tag("mlflow.trace_id", mlflowTraceId),
				tag("mlflow.dataset.id", mlflowDatasetId),
				tag("mlflow.dataset.record_id", mlflowDatasetRecordId),
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
			.select({
				runInstance: benchmarkRunInstances,
				primaryTraceId: workflowExecutions.primaryTraceId,
			})
			.from(benchmarkRunInstances)
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
			)
			.where(
				and(
					eq(benchmarkRunInstances.runId, params.runId),
					eq(benchmarkRunInstances.instanceId, params.instanceId),
				),
			)
			.limit(1);
		if (!row) return;
		const instance = row.runInstance;
		const mlflowTraceId =
			instance.mlflowTraceId ??
			resolveCanonicalMlflowTraceId(row.primaryTraceId, instance.traceIds);
		if (mlflowTraceId && instance.mlflowTraceId !== mlflowTraceId) {
			await db
				.update(benchmarkRunInstances)
				.set({ mlflowTraceId, updatedAt: new Date() })
				.where(eq(benchmarkRunInstances.id, instance.id));
		}
		const usage = isRecord(instance.usage) ? instance.usage : {};
		const timings = isRecord(instance.timings) ? instance.timings : {};
		const patchLineCount =
			instance.patchAddedLines == null && instance.patchRemovedLines == null
				? null
				: (instance.patchAddedLines ?? 0) + (instance.patchRemovedLines ?? 0);
		await logBatch(mlflowRunId, {
			metrics: compactMetrics([
				metric("resolved", instance.status === "resolved" ? 1 : 0),
				metric("empty_patch", instance.evaluationStatus === "empty_patch" ? 1 : 0),
				metric("patch_bytes", instance.patchBytes),
				metric("patch_added_lines", instance.patchAddedLines),
				metric("patch_removed_lines", instance.patchRemovedLines),
				metric("patch_lines", patchLineCount),
				metric("patch_files_touched", instance.patchFilesTouched),
				metric("patch_files_overlap_gold", instance.patchFilesOverlapGold),
				metric(
					"patch_well_formed",
					instance.patchWellFormed ? 1 : instance.patchWellFormed === false ? 0 : null,
				),
				metric("turn_count", instance.turnCount),
				metric("tool_call_count", instance.toolCallCount),
				metric("ttft_first_ms", instance.ttftFirstMs),
				metric("ttft_first_tool_ms", instance.ttftFirstToolMs),
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
				tag("workflow_builder.status", instance.status),
				tag("workflow_builder.inference_status", instance.inferenceStatus),
				tag("workflow_builder.evaluation_status", instance.evaluationStatus),
				tag("workflow_builder.session_id", instance.sessionId),
				tag("workflow_builder.workflow_execution_id", instance.workflowExecutionId),
				tag("workflow_builder.primary_trace_id", row.primaryTraceId),
				tag("workflow_builder.mlflow_trace_id", mlflowTraceId),
				tag("mlflow.trace_id", mlflowTraceId),
				tag("mlflow.dataset.id", instance.mlflowDatasetId),
				tag("mlflow.dataset.record_id", instance.mlflowDatasetRecordId),
				tag("workflow_builder.dapr_instance_id", instance.daprInstanceId),
				tag("workflow_builder.sandbox_name", instance.sandboxName),
				tag("workflow_builder.workspace_ref", instance.workspaceRef),
				tag("workflow_builder.trace_ids", instance.traceIds),
				tag("workflow_builder.patch_sha256", instance.patchSha256),
				tag("workflow_builder.logs_path", instance.logsPath),
				tag("workflow_builder.termination_reason", instance.terminationReason),
			],
		});
		const safeInstanceId = safeArtifactName(instance.instanceId);
		if (typeof instance.modelPatch === "string") {
			await logMlflowTextArtifact({
				runId: mlflowRunId,
				artifactPath: `patches/${safeInstanceId}.patch`,
				text: instance.modelPatch,
				contentType: "text/x-diff; charset=utf-8",
			});
		}
		if (isRecord(instance.harnessResult)) {
			await logMlflowJsonArtifact({
				runId: mlflowRunId,
				artifactPath: "harness/result.json",
				value: instance.harnessResult,
			});
		}
		if (typeof instance.testOutputSummary === "string") {
			await logMlflowTextArtifact({
				runId: mlflowRunId,
				artifactPath: "harness/test-output-summary.txt",
				text: instance.testOutputSummary,
			});
		}
		if (terminalInstanceStatuses.has(instance.status)) {
			const status =
				instance.status === "cancelled"
					? "KILLED"
					: instance.status === "error" || instance.status === "timeout"
						? "FAILED"
						: "FINISHED";
			await updateRunStatusOnce(
				mlflowRunId,
				status,
				instance.evaluatedAt ?? instance.inferenceCompletedAt ?? new Date(),
			);
		}
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
				tag("workflow_builder.mlflow_eval_run_id", run.mlflowEvalRunId ?? summary.mlflowEvalRunId),
				tag("mlflow.dataset.id", run.mlflowDatasetId),
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
			await updateRunStatusOnce(mlflowRunId, mlflowStatus, run.completedAt ?? new Date());
		}
	} catch (err) {
		warnMlflow(`failed to sync benchmark MLflow run ${runId}`, err);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(value: unknown, key: string): string | null {
	if (!isRecord(value)) return null;
	const candidate = value[key];
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
