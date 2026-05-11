import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

function trackingUri(): string | null {
	const value = (env.MLFLOW_TRACKING_URI ?? '').trim().replace(/\/+$/, '');
	return value || null;
}

function publicMlflowUrl(): string | null {
	const value = (publicEnv.PUBLIC_MLFLOW_URL ?? env.PUBLIC_MLFLOW_URL ?? '')
		.trim()
		.replace(/\/+$/, '');
	return value || null;
}

function traceExperimentName(): string {
	return (env.MLFLOW_TRACE_EXPERIMENT_NAME ?? '').trim() || 'workflow-builder';
}

function configuredTraceExperimentId(): string | null {
	const value = (env.MLFLOW_TRACE_EXPERIMENT_ID ?? publicEnv.PUBLIC_MLFLOW_TRACE_EXPERIMENT_ID ?? '')
		.trim();
	return value || null;
}

function mlflowTraceRequestId(traceId: string): string {
	const value = traceId.trim();
	return value.startsWith('tr-') ? value : `tr-${value}`;
}

async function mlflowRequest<T>(path: string): Promise<T> {
	const base = trackingUri();
	if (!base) throw new Error('MLFLOW_TRACKING_URI is not configured');
	const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
	const timeoutMs = Number.isFinite(rawTimeoutMs) ? Math.max(500, rawTimeoutMs) : 3000;
	const res = await fetch(`${base}${path}`, {
		method: 'GET',
		signal: AbortSignal.timeout(timeoutMs),
		headers: { Accept: 'application/json' }
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`MLflow ${path} returned ${res.status}: ${text.slice(0, 500)}`);
	}
	return (await res.json()) as T;
}

let traceExperimentIdCache: string | null | undefined;

export function publicMlflowTraceSearchUrl(
	experimentId: string | null | undefined,
	filter?: { traceId?: string | null; sessionId?: string | null }
): string | null {
	const base = publicMlflowUrl();
	if (!base || !experimentId) return null;
	const traceId = filter?.traceId?.trim();
	const sessionId = filter?.sessionId?.trim();
	const encodedExperimentId = encodeURIComponent(experimentId);
	if (traceId) {
		const query = new URLSearchParams({ selectedEvaluationId: mlflowTraceRequestId(traceId) });
		return `${base}/#/experiments/${encodedExperimentId}/traces?${query.toString()}`;
	}
	if (sessionId) {
		return `${base}/#/experiments/${encodedExperimentId}/chat-sessions/${encodeURIComponent(sessionId)}`;
	}
	return `${base}/#/experiments/${encodedExperimentId}/traces`;
}

export async function getMlflowTraceExperimentId(): Promise<string | null> {
	const configured = configuredTraceExperimentId();
	if (configured) return configured;
	if (traceExperimentIdCache !== undefined) return traceExperimentIdCache;

	const base = publicMlflowUrl();
	const tracking = trackingUri();
	if (!base || !tracking) {
		traceExperimentIdCache = null;
		return null;
	}

	const query = new URLSearchParams({ experiment_name: traceExperimentName() });
	try {
		const payload = await mlflowRequest<{ experiment?: { experiment_id?: string } }>(
			`/api/2.0/mlflow/experiments/get-by-name?${query.toString()}`
		);
		traceExperimentIdCache = payload.experiment?.experiment_id ?? null;
	} catch (err) {
		console.warn('[mlflow] trace experiment lookup failed:', err instanceof Error ? err.message : err);
		traceExperimentIdCache = null;
	}
	return traceExperimentIdCache;
}

export async function publicMlflowTraceRedirectUrl(
	filter: { traceId?: string | null; sessionId?: string | null } = {}
): Promise<string | null> {
	const experimentId = await getMlflowTraceExperimentId();
	return publicMlflowTraceSearchUrl(experimentId, filter);
}

/**
 * Resolve a workflow execution id to an MLflow trace_id. Reads
 * `workflow_executions.primary_trace_id` (the OTEL trace_id captured by the
 * orchestrator at workflow start) and constructs the MLflow trace_id as
 * `tr-<otel_trace_id>` — that's the exact mapping the MLflow SDK uses
 * internally, so no MLflow round-trip needed.
 *
 * Returns the MLflow OSS UI URL or null if the execution row is missing /
 * MLflow is unconfigured.
 */
export async function resolveMlflowTraceUrlForExecution(
	executionId: string
): Promise<string | null> {
	const experimentId = await getMlflowTraceExperimentId();
	if (!experimentId) return null;

	const { db } = await import('$lib/server/db');
	const { workflowExecutions } = await import('$lib/server/db/schema');
	const { eq } = await import('drizzle-orm');

	const row = await db
		.select({ primaryTraceId: workflowExecutions.primaryTraceId })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	const traceId = row[0]?.primaryTraceId?.trim();
	if (!traceId) return null;
	return publicMlflowTraceSearchUrl(experimentId, { traceId });
}
