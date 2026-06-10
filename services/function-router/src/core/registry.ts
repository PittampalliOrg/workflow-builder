/**
 * Function Registry
 *
 * Loads function routing configuration from ConfigMap (mounted as file)
 * or falls back to environment variable / hardcoded defaults.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FunctionRegistry, FunctionRegistryEntry } from "./types.js";

// Path to ConfigMap-mounted registry file
const REGISTRY_FILE_PATH =
  process.env.REGISTRY_FILE_PATH || "/config/functions.json";

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

/**
 * Load registry from file, environment, or use defaults
 */
export async function loadRegistry(): Promise<FunctionRegistry> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedRegistry && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  // Try loading from file (ConfigMap mount)
  if (existsSync(REGISTRY_FILE_PATH)) {
    try {
      const content = await readFile(REGISTRY_FILE_PATH, "utf-8");
      const loaded = JSON.parse(content) as FunctionRegistry;
      // ConfigMap is authoritative. Builtin fallbacks only fill in slugs that
      // the ConfigMap omits — this preserves the core workspace/browser/openshell
      // routes on sparse local-dev registries without overriding operator intent
      // expressed via the live ConfigMap.
      cachedRegistry = { ...BUILTIN_FALLBACK_REGISTRY, ...loaded };
      cacheTimestamp = now;
      console.log(
        `[Registry] Loaded ${Object.keys(cachedRegistry).length} entries from ${REGISTRY_FILE_PATH} (with builtin overrides)`,
      );
      return cachedRegistry;
    } catch (error) {
      console.error(
        `[Registry] Failed to load from ${REGISTRY_FILE_PATH}:`,
        error,
      );
    }
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

  // Built-in fallbacks before the broad "_default" catch-all
  if (BUILTIN_FALLBACK_REGISTRY[slug]) {
    return BUILTIN_FALLBACK_REGISTRY[slug];
  }
  if (BUILTIN_FALLBACK_REGISTRY[wildcardKey]) {
    return BUILTIN_FALLBACK_REGISTRY[wildcardKey];
  }

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
