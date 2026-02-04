import "server-only";

import { and, eq, like, or, sql } from "drizzle-orm";
import { db } from "./index";
import {
  functions,
  type NewFunction,
  type Function as FunctionType,
  type FunctionExecutionType,
  type RetryPolicy,
} from "./schema";

/**
 * Function definition with full details
 */
export type FunctionDefinition = FunctionType;

/**
 * Function summary for list views (excludes large schema fields)
 */
export type FunctionSummary = Pick<
  FunctionType,
  | "id"
  | "name"
  | "slug"
  | "description"
  | "pluginId"
  | "version"
  | "executionType"
  | "integrationType"
  | "isBuiltin"
  | "isEnabled"
  | "isDeprecated"
  | "createdAt"
  | "updatedAt"
>;

/**
 * Create function input
 */
export type CreateFunctionInput = {
  name: string;
  slug: string;
  description?: string;
  pluginId: string;
  version?: string;
  executionType: FunctionExecutionType;
  // OCI options
  imageRef?: string;
  command?: string;
  workingDir?: string;
  containerEnv?: Record<string, string>;
  // HTTP options
  webhookUrl?: string;
  webhookMethod?: string;
  webhookHeaders?: Record<string, string>;
  webhookTimeoutSeconds?: number;
  // Schema
  inputSchema?: unknown;
  outputSchema?: unknown;
  // Execution
  timeoutSeconds?: number;
  retryPolicy?: RetryPolicy;
  maxConcurrency?: number;
  // Metadata
  integrationType?: string;
  isBuiltin?: boolean;
  isEnabled?: boolean;
  createdBy?: string;
};

/**
 * Update function input
 */
export type UpdateFunctionInput = Partial<
  Omit<CreateFunctionInput, "slug" | "isBuiltin">
>;

/**
 * Get all functions with optional filters
 */
export async function getFunctions(options?: {
  pluginId?: string;
  executionType?: FunctionExecutionType;
  integrationType?: string;
  includeDisabled?: boolean;
  includeDeprecated?: boolean;
  search?: string;
}): Promise<FunctionSummary[]> {
  const conditions = [];

  // By default, only return enabled functions
  if (!options?.includeDisabled) {
    conditions.push(eq(functions.isEnabled, true));
  }

  // By default, exclude deprecated functions
  if (!options?.includeDeprecated) {
    conditions.push(eq(functions.isDeprecated, false));
  }

  if (options?.pluginId) {
    conditions.push(eq(functions.pluginId, options.pluginId));
  }

  if (options?.executionType) {
    conditions.push(eq(functions.executionType, options.executionType));
  }

  if (options?.integrationType) {
    conditions.push(eq(functions.integrationType, options.integrationType));
  }

  if (options?.search) {
    const searchPattern = `%${options.search}%`;
    conditions.push(
      or(
        like(functions.name, searchPattern),
        like(functions.slug, searchPattern),
        like(functions.description, searchPattern)
      )
    );
  }

  const results = await db
    .select({
      id: functions.id,
      name: functions.name,
      slug: functions.slug,
      description: functions.description,
      pluginId: functions.pluginId,
      version: functions.version,
      executionType: functions.executionType,
      integrationType: functions.integrationType,
      isBuiltin: functions.isBuiltin,
      isEnabled: functions.isEnabled,
      isDeprecated: functions.isDeprecated,
      createdAt: functions.createdAt,
      updatedAt: functions.updatedAt,
    })
    .from(functions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(functions.slug);

  return results;
}

/**
 * Get a function by ID
 */
export async function getFunctionById(
  id: string
): Promise<FunctionDefinition | null> {
  const result = await db
    .select()
    .from(functions)
    .where(eq(functions.id, id))
    .limit(1);

  return result[0] || null;
}

/**
 * Get a function by slug
 */
export async function getFunctionBySlug(
  slug: string
): Promise<FunctionDefinition | null> {
  const result = await db
    .select()
    .from(functions)
    .where(eq(functions.slug, slug))
    .limit(1);

  return result[0] || null;
}

/**
 * Check if a slug is available
 */
export async function isSlugAvailable(
  slug: string,
  excludeId?: string
): Promise<boolean> {
  const conditions = [eq(functions.slug, slug)];
  if (excludeId) {
    conditions.push(sql`${functions.id} != ${excludeId}`);
  }

  const result = await db
    .select({ id: functions.id })
    .from(functions)
    .where(and(...conditions))
    .limit(1);

  return result.length === 0;
}

/**
 * Create a new function
 */
export async function createFunction(
  input: CreateFunctionInput
): Promise<FunctionDefinition> {
  const [result] = await db
    .insert(functions)
    .values({
      name: input.name,
      slug: input.slug,
      description: input.description,
      pluginId: input.pluginId,
      version: input.version || "1.0.0",
      executionType: input.executionType,
      imageRef: input.imageRef,
      command: input.command,
      workingDir: input.workingDir,
      containerEnv: input.containerEnv,
      webhookUrl: input.webhookUrl,
      webhookMethod: input.webhookMethod || "POST",
      webhookHeaders: input.webhookHeaders,
      webhookTimeoutSeconds: input.webhookTimeoutSeconds || 30,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      timeoutSeconds: input.timeoutSeconds || 300,
      retryPolicy: input.retryPolicy,
      maxConcurrency: input.maxConcurrency || 0,
      integrationType: input.integrationType,
      isBuiltin: input.isBuiltin ?? false,
      isEnabled: input.isEnabled ?? true,
      isDeprecated: false,
      createdBy: input.createdBy,
    })
    .returning();

  return result;
}

/**
 * Update a function
 * Note: Cannot update builtin functions or change slug
 */
export async function updateFunction(
  id: string,
  input: UpdateFunctionInput,
  options?: { allowBuiltinUpdate?: boolean }
): Promise<FunctionDefinition | null> {
  // Check if function exists and is not builtin
  const existing = await getFunctionById(id);
  if (!existing) {
    return null;
  }

  if (existing.isBuiltin && !options?.allowBuiltinUpdate) {
    throw new Error("Cannot update builtin functions");
  }

  const updateData: Partial<NewFunction> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined)
    updateData.description = input.description;
  if (input.pluginId !== undefined) updateData.pluginId = input.pluginId;
  if (input.version !== undefined) updateData.version = input.version;
  if (input.executionType !== undefined)
    updateData.executionType = input.executionType;
  if (input.imageRef !== undefined) updateData.imageRef = input.imageRef;
  if (input.command !== undefined) updateData.command = input.command;
  if (input.workingDir !== undefined) updateData.workingDir = input.workingDir;
  if (input.containerEnv !== undefined)
    updateData.containerEnv = input.containerEnv;
  if (input.webhookUrl !== undefined) updateData.webhookUrl = input.webhookUrl;
  if (input.webhookMethod !== undefined)
    updateData.webhookMethod = input.webhookMethod;
  if (input.webhookHeaders !== undefined)
    updateData.webhookHeaders = input.webhookHeaders;
  if (input.webhookTimeoutSeconds !== undefined)
    updateData.webhookTimeoutSeconds = input.webhookTimeoutSeconds;
  if (input.inputSchema !== undefined) updateData.inputSchema = input.inputSchema;
  if (input.outputSchema !== undefined)
    updateData.outputSchema = input.outputSchema;
  if (input.timeoutSeconds !== undefined)
    updateData.timeoutSeconds = input.timeoutSeconds;
  if (input.retryPolicy !== undefined) updateData.retryPolicy = input.retryPolicy;
  if (input.maxConcurrency !== undefined)
    updateData.maxConcurrency = input.maxConcurrency;
  if (input.integrationType !== undefined)
    updateData.integrationType = input.integrationType;
  if (input.isEnabled !== undefined) updateData.isEnabled = input.isEnabled;

  const [result] = await db
    .update(functions)
    .set(updateData)
    .where(eq(functions.id, id))
    .returning();

  return result || null;
}

/**
 * Soft delete a function by disabling it
 * Note: Cannot delete builtin functions
 */
export async function deleteFunction(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const existing = await getFunctionById(id);
  if (!existing) {
    return { success: false, error: "Function not found" };
  }

  if (existing.isBuiltin) {
    return { success: false, error: "Cannot delete builtin functions" };
  }

  await db
    .update(functions)
    .set({ isEnabled: false, updatedAt: new Date() })
    .where(eq(functions.id, id));

  return { success: true };
}

/**
 * Validate that function slugs exist
 * Returns list of invalid slugs
 */
export async function validateFunctionSlugs(
  slugs: string[]
): Promise<string[]> {
  if (slugs.length === 0) {
    return [];
  }

  const uniqueSlugs = [...new Set(slugs)];

  const existing = await db
    .select({ slug: functions.slug })
    .from(functions)
    .where(and(
      sql`${functions.slug} IN ${uniqueSlugs}`,
      eq(functions.isEnabled, true)
    ));

  const existingSlugs = new Set(existing.map((r) => r.slug));
  return uniqueSlugs.filter((slug) => !existingSlugs.has(slug));
}

/**
 * Get functions grouped by plugin
 */
export async function getFunctionsGroupedByPlugin(): Promise<
  Record<string, FunctionSummary[]>
> {
  const allFunctions = await getFunctions();
  const grouped: Record<string, FunctionSummary[]> = {};

  for (const fn of allFunctions) {
    if (!grouped[fn.pluginId]) {
      grouped[fn.pluginId] = [];
    }
    grouped[fn.pluginId].push(fn);
  }

  return grouped;
}
