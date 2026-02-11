/**
 * Function URL Resolver (Knative-only)
 *
 * In this stack, serverless functions are deployed as Knative Services (KService)
 * in the workflow-builder namespace. The internal service DNS name is stable:
 *
 *   http://{ksvcName}.{namespace}.svc.cluster.local
 *
 * This resolver intentionally does NOT depend on OpenFunctions CRDs/controllers.
 */

// Cache for appId → URL mappings (TTL: 60 seconds)
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

// Response time tracking for cold start detection
// Stores a rolling window of recent response times per function
const responseTimeHistory = new Map<string, number[]>();
const MAX_HISTORY_SIZE = 10; // Keep last 10 response times

const NAMESPACE = process.env.FUNCTIONS_NAMESPACE || "workflow-builder";

/**
 * Standalone service URL mappings (non-Knative).
 * These are regular K8s Deployments with a ClusterIP Service.
 */
const STANDALONE_SERVICES: Record<string, string> = {
	"planner-dapr-agent": `http://planner-dapr-agent.${NAMESPACE}.svc.cluster.local:8000`,
};

/**
 * Resolve a function app-id to its internal service URL.
 *
 * @param appId - The function app-id / Knative Service name (e.g., "fn-openai")
 * @returns The internal HTTP URL for the function
 */
export async function resolveOpenFunctionUrl(appId: string): Promise<string> {
	// Check cache first
	const cached = urlCache.get(appId);
	if (cached && Date.now() < cached.expiresAt) {
		console.log(`[Function Resolver] Cache hit for ${appId}: ${cached.url}`);
		return cached.url;
	}

	// Check standalone services first (no K8s API needed)
	const standaloneUrl = STANDALONE_SERVICES[appId];
	if (standaloneUrl) {
		console.log(
			`[Function Resolver] Standalone service: ${appId} → ${standaloneUrl}`,
		);
		cacheUrl(appId, standaloneUrl);
		return standaloneUrl;
	}

	// Knative Service (cluster-local): the ClusterIP Service exposes port 80.
	const url = `http://${appId}.${NAMESPACE}.svc.cluster.local`;
	console.log(`[Function Resolver] Knative service: ${appId} → ${url}`);
	cacheUrl(appId, url);
	return url;
}

function cacheUrl(appId: string, url: string): void {
	urlCache.set(appId, {
		url,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
}

/**
 * Clear the URL cache (useful for testing or after deployments)
 */
export function clearCache(): void {
	urlCache.clear();
	console.log("[Function Resolver] Cache cleared");
}

/**
 * Pre-warm the cache by resolving all known function app-ids.
 */
export async function warmCache(appIds: string[]): Promise<void> {
	console.log(
		`[Function Resolver] Pre-warming cache for ${appIds.length} functions`,
	);

	const results = await Promise.allSettled(
		appIds.map((appId) => resolveOpenFunctionUrl(appId)),
	);

	const successful = results.filter((r) => r.status === "fulfilled").length;
	const failed = results.filter((r) => r.status === "rejected").length;

	console.log(
		`[Function Resolver] Cache warm-up: ${successful} resolved, ${failed} failed`,
	);
}

/**
 * Record a response time for a function (for cold start detection)
 */
export function recordResponseTime(
	appId: string,
	responseTimeMs: number,
): void {
	let history = responseTimeHistory.get(appId);
	if (!history) {
		history = [];
		responseTimeHistory.set(appId, history);
	}

	history.push(responseTimeMs);

	// Keep only the last N entries
	if (history.length > MAX_HISTORY_SIZE) {
		history.shift();
	}
}

/**
 * Get the average response time for a function (for cold start detection)
 *
 * Returns 0 if not enough data is available (need at least 3 data points)
 */
export function getResponseTimeAverage(appId: string): number {
	const history = responseTimeHistory.get(appId);
	if (!history || history.length < 3) {
		return 0; // Not enough data for meaningful average
	}

	// Calculate average of response times (excluding outliers > 2x median)
	const sorted = [...history].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];

	// Filter out outliers (likely cold starts we already recorded)
	const filtered = sorted.filter((t) => t <= median * 2);

	if (filtered.length < 2) {
		return 0; // All data points are outliers
	}

	const sum = filtered.reduce((acc, t) => acc + t, 0);
	return Math.round(sum / filtered.length);
}

/**
 * Clear response time history (useful for testing)
 */
export function clearResponseTimeHistory(): void {
	responseTimeHistory.clear();
	console.log("[Function Resolver] Response time history cleared");
}
