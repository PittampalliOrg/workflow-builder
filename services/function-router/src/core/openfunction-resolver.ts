/**
 * OpenFunction URL Resolver
 *
 * Dynamically resolves OpenFunction app-ids to their internal Knative service URLs.
 * Uses the Kubernetes API directly for reliability (no library dependency issues).
 *
 * Resolution path:
 * 1. Query Function CRD → get serving.resourceRef
 * 2. Query Services with label openfunction.io/serving={resourceRef}
 * 3. Find the -latest service → construct internal URL
 */
import { readFileSync, existsSync } from "fs";

// Cache for function → URL mappings (TTL: 60 seconds)
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

// Response time tracking for cold start detection
// Stores a rolling window of recent response times per function
const responseTimeHistory = new Map<string, number[]>();
const MAX_HISTORY_SIZE = 10; // Keep last 10 response times

const NAMESPACE = process.env.FUNCTIONS_NAMESPACE || "workflow-builder";

// In-cluster Kubernetes API configuration
const K8S_API_SERVER = "https://kubernetes.default.svc";
const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

let serviceAccountToken: string | null = null;

/**
 * Get the service account token for in-cluster authentication
 */
function getServiceAccountToken(): string {
  if (serviceAccountToken) return serviceAccountToken;

  if (existsSync(TOKEN_PATH)) {
    serviceAccountToken = readFileSync(TOKEN_PATH, "utf-8").trim();
    console.log("[OpenFunction Resolver] Loaded service account token for in-cluster auth");
    return serviceAccountToken;
  }

  throw new Error("Not running in Kubernetes cluster - no service account token found");
}

/**
 * Make an authenticated request to the Kubernetes API
 */
async function k8sRequest<T>(path: string): Promise<T> {
  const token = getServiceAccountToken();

  // Use https module for proper CA certificate handling
  const https = await import("https");
  const ca = existsSync(CA_PATH) ? readFileSync(CA_PATH) : undefined;

  return new Promise((resolve, reject) => {
    const url = new URL(path, K8S_API_SERVER);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      ca,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(new Error(`Failed to parse K8s API response: ${e}`));
          }
        } else {
          reject(new Error(`Kubernetes API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

interface FunctionCR {
  status?: {
    serving?: {
      resourceRef?: string;
      state?: string;
    };
    addresses?: Array<{
      type: string;
      value: string;
    }>;
  };
}

interface ServiceList {
  items: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
  }>;
}

/**
 * Standalone service URL mappings.
 * These are regular K8s Deployments (not Knative) with a ClusterIP Service.
 */
const STANDALONE_SERVICES: Record<string, string> = {
  "fn-activepieces": `http://fn-activepieces-standalone.${process.env.FUNCTIONS_NAMESPACE || "workflow-builder"}.svc.cluster.local`,
  "planner-dapr-agent": `http://planner-dapr-agent.${process.env.FUNCTIONS_NAMESPACE || "workflow-builder"}.svc.cluster.local:8000`,
};

/**
 * Resolve an OpenFunction app-id to its internal Knative service URL.
 * Falls back to standalone service URLs for non-Knative deployments.
 *
 * @param appId - The OpenFunction app-id (e.g., "fn-openai")
 * @returns The internal HTTP URL for the function
 */
export async function resolveOpenFunctionUrl(appId: string): Promise<string> {
  // Check cache first
  const cached = urlCache.get(appId);
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`[OpenFunction Resolver] Cache hit for ${appId}: ${cached.url}`);
    return cached.url;
  }

  // Check standalone services first (no K8s API needed)
  const standaloneUrl = STANDALONE_SERVICES[appId];
  if (standaloneUrl) {
    console.log(`[OpenFunction Resolver] Standalone service: ${appId} → ${standaloneUrl}`);
    cacheUrl(appId, standaloneUrl);
    return standaloneUrl;
  }

  console.log(`[OpenFunction Resolver] Resolving URL for ${appId}`);

  try {
    // Step 1: Get the Function CRD
    const functionPath = `/apis/core.openfunction.io/v1beta2/namespaces/${NAMESPACE}/functions/${appId}`;
    const func = await k8sRequest<FunctionCR>(functionPath);

    // Check if Function has an address in status (some versions provide this)
    if (func.status?.addresses) {
      const internalAddr = func.status.addresses.find(
        (a) => a.type === "Internal" || a.type === "External"
      );
      if (internalAddr?.value) {
        const url = internalAddr.value.startsWith("http")
          ? internalAddr.value
          : `http://${internalAddr.value}`;
        cacheUrl(appId, url);
        return url;
      }
    }

    // Get the serving resourceRef
    const servingRef = func.status?.serving?.resourceRef;
    if (!servingRef) {
      throw new Error(`Function ${appId} has no serving.resourceRef in status`);
    }

    console.log(`[OpenFunction Resolver] ${appId} → serving: ${servingRef}`);

    // Step 2: Query Services with the serving label
    const servicesPath = `/api/v1/namespaces/${NAMESPACE}/services?labelSelector=openfunction.io/serving=${servingRef}`;
    const services = await k8sRequest<ServiceList>(servicesPath);

    // Find the -latest service (not -latest-private)
    const latestSvc = services.items.find(
      (svc) =>
        svc.metadata?.name?.endsWith("-latest") &&
        !svc.metadata?.name?.endsWith("-latest-private")
    );

    if (!latestSvc?.metadata?.name) {
      throw new Error(`No -latest service found for serving ${servingRef}`);
    }

    const url = `http://${latestSvc.metadata.name}.${NAMESPACE}.svc.cluster.local`;
    console.log(`[OpenFunction Resolver] ${appId} → ${url}`);

    cacheUrl(appId, url);
    return url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve OpenFunction URL for ${appId}: ${message}`);
  }
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
  console.log("[OpenFunction Resolver] Cache cleared");
}

/**
 * Pre-warm the cache by resolving all known OpenFunction app-ids.
 */
export async function warmCache(appIds: string[]): Promise<void> {
  console.log(`[OpenFunction Resolver] Pre-warming cache for ${appIds.length} functions`);

  const results = await Promise.allSettled(
    appIds.map((appId) => resolveOpenFunctionUrl(appId))
  );

  const successful = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  console.log(
    `[OpenFunction Resolver] Cache warm-up: ${successful} resolved, ${failed} failed`
  );
}

/**
 * Record a response time for a function (for cold start detection)
 */
export function recordResponseTime(appId: string, responseTimeMs: number): void {
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
  const filtered = sorted.filter(t => t <= median * 2);

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
  console.log("[OpenFunction Resolver] Response time history cleared");
}
