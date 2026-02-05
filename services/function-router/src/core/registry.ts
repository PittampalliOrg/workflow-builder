/**
 * Function Registry
 *
 * Loads function routing configuration from ConfigMap (mounted as file)
 * or falls back to environment variable / hardcoded defaults.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FunctionRegistry, FunctionRegistryEntry } from "./types.js";

// Path to ConfigMap-mounted registry file
const REGISTRY_FILE_PATH = process.env.REGISTRY_FILE_PATH || "/config/functions.json";

// Fallback default registry (OpenFunctions only)
const DEFAULT_REGISTRY: FunctionRegistry = {
  // OpenFunctions (scale-to-zero Knative services)
  "openai/generate-text": { appId: "fn-openai", type: "openfunction" },
  "openai/generate-image": { appId: "fn-openai", type: "openfunction" },
  "openai/*": { appId: "fn-openai", type: "openfunction" },
  "slack/*": { appId: "fn-slack", type: "openfunction" },
  "github/*": { appId: "fn-github", type: "openfunction" },
  "resend/*": { appId: "fn-resend", type: "openfunction" },
  "stripe/*": { appId: "fn-stripe", type: "openfunction" },
  "linear/*": { appId: "fn-linear", type: "openfunction" },
  "firecrawl/*": { appId: "fn-firecrawl", type: "openfunction" },
  "perplexity/*": { appId: "fn-perplexity", type: "openfunction" },
};

let cachedRegistry: FunctionRegistry | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Load registry from file, environment, or use defaults
 */
export async function loadRegistry(): Promise<FunctionRegistry> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedRegistry && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  // Try loading from file (ConfigMap mount)
  if (existsSync(REGISTRY_FILE_PATH)) {
    try {
      const content = await readFile(REGISTRY_FILE_PATH, "utf-8");
      cachedRegistry = JSON.parse(content) as FunctionRegistry;
      cacheTimestamp = now;
      console.log(`[Registry] Loaded ${Object.keys(cachedRegistry).length} entries from ${REGISTRY_FILE_PATH}`);
      return cachedRegistry;
    } catch (error) {
      console.error(`[Registry] Failed to load from ${REGISTRY_FILE_PATH}:`, error);
    }
  }

  // Try loading from environment variable
  const envRegistry = process.env.FUNCTION_REGISTRY;
  if (envRegistry) {
    try {
      cachedRegistry = JSON.parse(envRegistry) as FunctionRegistry;
      cacheTimestamp = now;
      console.log(`[Registry] Loaded ${Object.keys(cachedRegistry).length} entries from FUNCTION_REGISTRY env`);
      return cachedRegistry;
    } catch (error) {
      console.error("[Registry] Failed to parse FUNCTION_REGISTRY env:", error);
    }
  }

  // Fallback to defaults
  console.log("[Registry] Using default registry configuration");
  cachedRegistry = DEFAULT_REGISTRY;
  cacheTimestamp = now;
  return cachedRegistry;
}

/**
 * Look up the target service for a function slug
 *
 * Supports:
 * - Exact match: "openai/generate-text"
 * - Wildcard match: "openai/*" matches any openai function
 * - Default fallback: "_default" (if configured in registry file)
 *
 * Throws an error if no matching OpenFunction is found.
 */
export async function lookupFunction(slug: string): Promise<FunctionRegistryEntry> {
  const registry = await loadRegistry();

  // Try exact match first
  if (registry[slug]) {
    return registry[slug];
  }

  // Try wildcard match (e.g., "openai/*")
  const pluginId = slug.split("/")[0];
  const wildcardKey = `${pluginId}/*`;
  if (registry[wildcardKey]) {
    return registry[wildcardKey];
  }

  // Fallback to default (if configured)
  if (registry["_default"]) {
    return registry["_default"];
  }

  // No OpenFunction found for this slug
  throw new Error(
    `No OpenFunction registered for function slug "${slug}". ` +
    `Available patterns: ${Object.keys(registry).join(", ")}`
  );
}

/**
 * Clear the registry cache (useful for testing)
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTimestamp = 0;
}
