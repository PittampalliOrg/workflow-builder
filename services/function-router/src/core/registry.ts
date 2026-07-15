/**
 * Function Registry
 *
 * Loads function routing configuration from ConfigMap (mounted as file)
 * or falls back to environment variable / hardcoded defaults.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FunctionRegistry, FunctionRegistryEntry } from "./types.js";

const DEFAULT_REGISTRY_FILE_PATH = "/config/functions.json";

export function registryFilePath(
  value = process.env.REGISTRY_FILE_PATH,
): string {
  return value?.trim() || DEFAULT_REGISTRY_FILE_PATH;
}

// Fallback default registry
const DEFAULT_REGISTRY: FunctionRegistry = {
  "system/*": { appId: "fn-system", type: "knative" },
  "workflow-orchestrator/*": {
    appId: "workflow-orchestrator",
    type: "knative",
  },
  code: { appId: "code-runtime", type: "knative" },
  "code/*": { appId: "code-runtime", type: "knative" },
  "browser/*": { appId: "openshell-agent-runtime", type: "knative" },
  "openshell/*": { appId: "openshell-agent-runtime", type: "knative" },
  // openshell-agent-runtime owns workspace/profile, workspace/command, and the
  // browser helpers post-consolidation. (workspace-runtime TS service was
  // decommissioned 2026-04-16 per CLAUDE.md.)
  "workspace/*": { appId: "openshell-agent-runtime", type: "knative" },
  "web/*": { appId: "crawl4ai-adapter", type: "knative" },
  // Default fallback: all other slugs are AP piece actions, resolved per piece
  // to the reconciler-provisioned ap-<piece>-service piece-runtime.
  _default: { type: "activepieces" },
};

/**
 * Built-in fallback routes that should apply even when the mounted registry
 * only defines a broad "_default" mapping.
 */
const BUILTIN_FALLBACK_REGISTRY: FunctionRegistry = {
  "workflow-orchestrator/*": {
    appId: "workflow-orchestrator",
    type: "knative",
  },
  code: { appId: "code-runtime", type: "knative" },
  "code/*": { appId: "code-runtime", type: "knative" },
  "browser/*": { appId: "openshell-agent-runtime", type: "knative" },
  "openshell/*": { appId: "openshell-agent-runtime", type: "knative" },
  "workspace/*": { appId: "openshell-agent-runtime", type: "knative" },
  "web/*": { appId: "crawl4ai-adapter", type: "knative" },
  // AP piece routing is cross-cutting: if the mounted ConfigMap is missing
  // _default (or not mounted at all), every AP action would fall through to
  // the throw-on-unknown branch. Defense-in-depth — belt and suspenders with
  // the ConfigMap's _default entry.
  _default: { type: "activepieces" },
};

/**
 * Sanitize an AP piece name exactly like the stacks activepieces-mcp
 * reconciler's `sanitize_piece` (the two MUST agree or the router will
 * dispatch to a service name the reconciler never created):
 * lowercase → strip "@activepieces/piece-" → non [a-z0-9-] → "-" →
 * collapse runs of "-" → trim leading/trailing "-".
 */
export function sanitizePieceName(piece: string): string {
  return piece
    .toLowerCase()
    .replace(/^@activepieces\/piece-/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

/**
 * Per-piece piece-runtime Knative Service name (reconciler naming contract:
 * `${MCPSERVICE_NAME_PREFIX:-ap-}<sanitized-piece>-service`).
 */
export function apPieceServiceName(piece: string): string {
  return `ap-${sanitizePieceName(piece)}-service`;
}

let cachedRegistry: FunctionRegistry | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

export function strictRegistryEnabled(
  value = process.env.FUNCTION_REGISTRY_STRICT,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function mergeMountedRegistry(
  loaded: FunctionRegistry,
  strict = strictRegistryEnabled(),
): FunctionRegistry {
  return strict ? loaded : { ...BUILTIN_FALLBACK_REGISTRY, ...loaded };
}

export function lookupBuiltinFallback(
  slug: string,
  strict = strictRegistryEnabled(),
): FunctionRegistryEntry | undefined {
  if (strict) return undefined;
  const pluginId = slug.split("/")[0];
  return (
    BUILTIN_FALLBACK_REGISTRY[slug] ??
    BUILTIN_FALLBACK_REGISTRY[`${pluginId}/*`]
  );
}

/**
 * Load registry from file, environment, or use defaults
 */
export async function loadRegistry(): Promise<FunctionRegistry> {
  const now = Date.now();
  const mountedRegistryPath = registryFilePath();
  const strict = strictRegistryEnabled();

  // Return cached if fresh
  if (cachedRegistry && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  // Try loading from file (ConfigMap mount)
  if (existsSync(mountedRegistryPath)) {
    try {
      const content = await readFile(mountedRegistryPath, "utf-8");
      const loaded = JSON.parse(content) as FunctionRegistry;
      // Strict mode makes the mounted registry complete and authoritative.
      // Regular mode retains builtins for sparse local-development registries.
      cachedRegistry = mergeMountedRegistry(loaded, strict);
      cacheTimestamp = now;
      console.log(
        `[Registry] Loaded ${Object.keys(cachedRegistry).length} entries from ${mountedRegistryPath}${strict ? " (strict)" : " (with builtin fallbacks)"}`,
      );
      return cachedRegistry;
    } catch (error) {
      console.error(
        `[Registry] Failed to load from ${mountedRegistryPath}:`,
        error,
      );
    }
  }

  if (strict) {
    console.error(
      "[Registry] Strict registry mode has no readable mounted registry; failing closed",
    );
    cachedRegistry = {};
    cacheTimestamp = now;
    return cachedRegistry;
  }

  // Try loading from environment variable
  const envRegistry = process.env.FUNCTION_REGISTRY;
  if (envRegistry) {
    try {
      cachedRegistry = JSON.parse(envRegistry) as FunctionRegistry;
      cacheTimestamp = now;
      console.log(
        `[Registry] Loaded ${Object.keys(cachedRegistry).length} entries from FUNCTION_REGISTRY env`,
      );
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
 * Throws an error if no matching Knative function is found.
 */
export async function lookupFunction(
  slug: string,
): Promise<FunctionRegistryEntry> {
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

  // Built-in fallbacks before the broad "_default" catch-all. Preview
  // environments disable these so every advertised route must close over a
  // service deployed in that vCluster.
  const builtinFallback = lookupBuiltinFallback(slug);
  if (builtinFallback) return builtinFallback;

  // Fallback to default (if configured)
  if (registry._default) {
    return registry._default;
  }

  // No Knative function mapping found for this slug
  throw new Error(
    `No Knative function registered for function slug "${slug}". ` +
      `Available patterns: ${Object.keys(registry).join(", ")}`,
  );
}

/**
 * Clear the registry cache (useful for testing)
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTimestamp = 0;
}
