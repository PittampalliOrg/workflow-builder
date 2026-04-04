import { env } from '$env/dynamic/private';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const DEFAULT_MAX_RETRIES = 3;

interface DaprRequestOptions extends RequestInit {
	maxRetries?: number;
}

/**
 * Make a request to a Dapr service with retry logic.
 * Mirrors the retry behavior from the Next.js workflow-builder dapr-client.ts.
 */
export async function daprFetch(
	url: string,
	options: DaprRequestOptions = {}
): Promise<Response> {
	const { maxRetries = DEFAULT_MAX_RETRIES, ...fetchOptions } = options;
	const method = (fetchOptions.method || 'GET').toUpperCase();

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, fetchOptions);

			if (
				RETRYABLE_STATUS_CODES.has(response.status) &&
				SAFE_METHODS.has(method) &&
				attempt < maxRetries
			) {
				await new Promise((r) => setTimeout(r, attempt * 250));
				continue;
			}

			return response;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries && SAFE_METHODS.has(method)) {
				await new Promise((r) => setTimeout(r, attempt * 250));
				continue;
			}
		}
	}

	throw lastError || new Error('daprFetch failed after retries');
}

/** Get the workflow orchestrator base URL */
export function getOrchestratorUrl(): string {
	return (
		env.WORKFLOW_ORCHESTRATOR_URL ||
		env.DAPR_ORCHESTRATOR_URL ||
		'http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080'
	);
}

/** Get the function router base URL */
export function getFunctionRouterUrl(): string {
	return (
		env.FUNCTION_RUNNER_URL ||
		'http://function-router.workflow-builder.svc.cluster.local:8080'
	);
}

/** Get the durable agent base URL */
export function getDurableAgentUrl(): string {
	return (
		env.DURABLE_AGENT_URL ||
		'http://durable-agent.workflow-builder.svc.cluster.local:8001'
	);
}

/** Get the fn-activepieces base URL */
export function getFnActivepiecesUrl(): string {
	return (
		env.FN_ACTIVEPIECES_URL ||
		'http://fn-activepieces.workflow-builder.svc.cluster.local:8080'
	);
}

// ---------------------------------------------------------------------------
// Workflow-capable service discovery
// ---------------------------------------------------------------------------

export interface WorkflowServiceDescriptor {
	id: string;
	getBaseUrl: () => string;
	introspectPath: string;
}

/**
 * Static registry of services that register Dapr workflow activities.
 * Add new entries here when a new workflow-capable service is deployed.
 */
export function getWorkflowCapableServices(): WorkflowServiceDescriptor[] {
	return [
		{
			id: 'workflow-orchestrator',
			getBaseUrl: getOrchestratorUrl,
			introspectPath: '/api/v2/runtime/introspect',
		},
		{
			id: 'fn-activepieces',
			getBaseUrl: getFnActivepiecesUrl,
			introspectPath: '/api/runtime/introspect',
		},
	];
}
