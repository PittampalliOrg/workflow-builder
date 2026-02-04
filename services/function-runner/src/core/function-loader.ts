/**
 * Function Loader
 *
 * Loads function definitions from the PostgreSQL database.
 * Supports loading by ID or by slug (e.g., "openai/generate-text").
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";
import type { FunctionDefinition, FunctionExecutionType } from "./types.js";

/**
 * Raw database row type
 */
interface FunctionRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  plugin_id: string;
  version: string;
  execution_type: string;
  image_ref: string | null;
  command: string | null;
  working_dir: string | null;
  container_env: Record<string, string> | null;
  webhook_url: string | null;
  webhook_method: string | null;
  webhook_headers: Record<string, string> | null;
  webhook_timeout_seconds: number | null;
  input_schema: unknown;
  output_schema: unknown;
  timeout_seconds: number | null;
  retry_policy: unknown;
  max_concurrency: number | null;
  integration_type: string | null;
  is_builtin: boolean | null;
  is_enabled: boolean | null;
  is_deprecated: boolean | null;
}

/**
 * Convert database row to FunctionDefinition
 */
function rowToFunction(row: FunctionRow): FunctionDefinition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    pluginId: row.plugin_id,
    version: row.version,
    executionType: row.execution_type as FunctionExecutionType,
    imageRef: row.image_ref,
    command: row.command,
    workingDir: row.working_dir,
    containerEnv: row.container_env,
    webhookUrl: row.webhook_url,
    webhookMethod: row.webhook_method,
    webhookHeaders: row.webhook_headers,
    webhookTimeoutSeconds: row.webhook_timeout_seconds,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    timeoutSeconds: row.timeout_seconds,
    retryPolicy: row.retry_policy as FunctionDefinition["retryPolicy"],
    maxConcurrency: row.max_concurrency,
    integrationType: row.integration_type,
    isBuiltin: row.is_builtin,
    isEnabled: row.is_enabled,
    isDeprecated: row.is_deprecated,
  };
}

/**
 * In-memory cache for function definitions
 * TTL: 60 seconds
 */
const functionCache = new Map<
  string,
  { fn: FunctionDefinition; timestamp: number }
>();
const CACHE_TTL_MS = 60 * 1000;

/**
 * Get from cache if not expired
 */
function getFromCache(key: string): FunctionDefinition | null {
  const cached = functionCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.fn;
  }
  if (cached) {
    functionCache.delete(key);
  }
  return null;
}

/**
 * Set in cache
 */
function setInCache(key: string, fn: FunctionDefinition): void {
  functionCache.set(key, { fn, timestamp: Date.now() });
}

/**
 * Load a function definition by ID
 */
export async function loadFunctionById(
  id: string
): Promise<FunctionDefinition | null> {
  // Check cache
  const cached = getFromCache(`id:${id}`);
  if (cached) return cached;

  const db = getDb();

  const result = await db.execute<FunctionRow>(sql`
    SELECT
      id, name, slug, description, plugin_id, version, execution_type,
      image_ref, command, working_dir, container_env,
      webhook_url, webhook_method, webhook_headers, webhook_timeout_seconds,
      input_schema, output_schema, timeout_seconds, retry_policy, max_concurrency,
      integration_type, is_builtin, is_enabled, is_deprecated
    FROM functions
    WHERE id = ${id} AND is_enabled = true
    LIMIT 1
  `);

  if (result.length === 0) {
    return null;
  }

  const fn = rowToFunction(result[0]);
  setInCache(`id:${id}`, fn);
  setInCache(`slug:${fn.slug}`, fn);
  return fn;
}

/**
 * Load a function definition by slug (e.g., "openai/generate-text")
 */
export async function loadFunctionBySlug(
  slug: string
): Promise<FunctionDefinition | null> {
  // Check cache
  const cached = getFromCache(`slug:${slug}`);
  if (cached) return cached;

  const db = getDb();

  const result = await db.execute<FunctionRow>(sql`
    SELECT
      id, name, slug, description, plugin_id, version, execution_type,
      image_ref, command, working_dir, container_env,
      webhook_url, webhook_method, webhook_headers, webhook_timeout_seconds,
      input_schema, output_schema, timeout_seconds, retry_policy, max_concurrency,
      integration_type, is_builtin, is_enabled, is_deprecated
    FROM functions
    WHERE slug = ${slug} AND is_enabled = true
    LIMIT 1
  `);

  if (result.length === 0) {
    return null;
  }

  const fn = rowToFunction(result[0]);
  setInCache(`id:${fn.id}`, fn);
  setInCache(`slug:${slug}`, fn);
  return fn;
}

/**
 * Load a function by either ID or slug
 */
export async function loadFunction(
  idOrSlug: string
): Promise<FunctionDefinition | null> {
  // Try slug first (more common)
  const bySlug = await loadFunctionBySlug(idOrSlug);
  if (bySlug) return bySlug;

  // Try ID
  return loadFunctionById(idOrSlug);
}

/**
 * List all available functions
 */
export async function listFunctions(): Promise<FunctionDefinition[]> {
  const db = getDb();

  const result = await db.execute<FunctionRow>(sql`
    SELECT
      id, name, slug, description, plugin_id, version, execution_type,
      image_ref, command, working_dir, container_env,
      webhook_url, webhook_method, webhook_headers, webhook_timeout_seconds,
      input_schema, output_schema, timeout_seconds, retry_policy, max_concurrency,
      integration_type, is_builtin, is_enabled, is_deprecated
    FROM functions
    WHERE is_enabled = true
    ORDER BY slug ASC
  `);

  return result.map(rowToFunction);
}

/**
 * List functions by plugin
 */
export async function listFunctionsByPlugin(
  pluginId: string
): Promise<FunctionDefinition[]> {
  const db = getDb();

  const result = await db.execute<FunctionRow>(sql`
    SELECT
      id, name, slug, description, plugin_id, version, execution_type,
      image_ref, command, working_dir, container_env,
      webhook_url, webhook_method, webhook_headers, webhook_timeout_seconds,
      input_schema, output_schema, timeout_seconds, retry_policy, max_concurrency,
      integration_type, is_builtin, is_enabled, is_deprecated
    FROM functions
    WHERE plugin_id = ${pluginId} AND is_enabled = true
    ORDER BY slug ASC
  `);

  return result.map(rowToFunction);
}

/**
 * Clear the function cache (useful for testing or after updates)
 */
export function clearFunctionCache(): void {
  functionCache.clear();
}
