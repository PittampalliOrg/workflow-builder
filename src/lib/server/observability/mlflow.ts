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
 * Resolve a workflow execution id to an MLflow trace_id by searching the
 * configured trace experiment for the most recent trace tagged with
 * `workflow.execution.id = <executionId>`. Returns the MLflow OSS UI URL for
 * that trace, or null if no match (or MLflow is unconfigured / unreachable).
 *
 * Uses MLflow 3.x's `POST /api/3.0/mlflow/traces/search` because the older
 * `/api/2.0/mlflow/traces` endpoint only accepts experiment-scoped filters
 * via the `locations` payload, not `tag.X` predicates.
 */
export async function resolveMlflowTraceUrlForExecution(
	executionId: string
): Promise<string | null> {
	const tracking = trackingUri();
	const experimentId = await getMlflowTraceExperimentId();
	if (!tracking || !experimentId) return null;

	const rawTimeoutMs = Number(env.MLFLOW_REQUEST_TIMEOUT_MS ?? 3000);
	const timeoutMs = Number.isFinite(rawTimeoutMs) ? Math.max(500, rawTimeoutMs) : 3000;

	try {
		const res = await fetch(`${tracking}/api/3.0/mlflow/traces/search`, {
			method: 'POST',
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				locations: [{ type: 'MLFLOW_EXPERIMENT', mlflow_experiment_id: experimentId }],
				filter: `tag.\`workflow.execution.id\` = '${executionId.replace(/'/g, "''")}'`,
				max_results: 1,
				order_by: [{ field_name: 'timestamp_ms', ascending: false }]
			})
		});
		if (!res.ok) return null;
		const payload = (await res.json()) as {
			traces?: Array<{ trace_info?: { trace_id?: string }; trace_id?: string }>;
		};
		const trace = payload.traces?.[0];
		const traceId = trace?.trace_info?.trace_id ?? trace?.trace_id;
		if (!traceId) return null;
		return publicMlflowTraceSearchUrl(experimentId, { traceId });
	} catch (err) {
		console.warn(
			'[mlflow] execution trace lookup failed:',
			err instanceof Error ? err.message : err
		);
		return null;
	}
}
