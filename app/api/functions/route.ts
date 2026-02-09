import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
  getFunctions,
  createFunction,
  isSlugAvailable,
  type FunctionSummary,
  type CreateFunctionInput,
} from "@/lib/db/functions";
import type { FunctionExecutionType } from "@/lib/db/schema";

/**
 * Response type for GET /api/functions
 */
export type GetFunctionsResponse = {
  functions: FunctionSummary[];
};

/**
 * Request type for POST /api/functions
 */
export type CreateFunctionRequest = {
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
  // Execution config
  timeoutSeconds?: number;
  maxConcurrency?: number;
  // Metadata
  integrationType?: string;
};

/**
 * Response type for POST /api/functions
 */
export type CreateFunctionResponse = FunctionSummary;

/**
 * GET /api/functions
 * List all available functions
 *
 * Query params:
 * - pluginId: Filter by plugin
 * - executionType: Filter by execution type (builtin, oci, http)
 * - integrationType: Filter by integration type
 * - search: Search by name, slug, or description
 * - includeDisabled: Include disabled functions (default: false)
 */
export async function GET(request: Request) {
  try {
    // Auth is optional for listing functions - public endpoint for workflow builder
    const session = await getSession(request);

    // Parse query params
    const { searchParams } = new URL(request.url);
    const pluginId = searchParams.get("pluginId") || undefined;
    const executionType = searchParams.get("executionType") as
      | FunctionExecutionType
      | undefined;
    const integrationType = searchParams.get("integrationType") || undefined;
    const search = searchParams.get("search") || undefined;
    const includeDisabled = searchParams.get("includeDisabled") === "true";

    const functions = await getFunctions({
      pluginId,
      executionType,
      integrationType,
      search,
      includeDisabled: includeDisabled && !!session?.user, // Only authenticated users can see disabled
    });

    const response: GetFunctionsResponse = {
      functions,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to get functions:", error);
    return NextResponse.json(
      {
        error: "Failed to get functions",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/functions
 * Create a new function (requires authentication)
 */
export async function POST(request: Request) {
  try {
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: CreateFunctionRequest = await request.json();

    // Validate required fields
    if (!body.name || !body.slug || !body.pluginId || !body.executionType) {
      return NextResponse.json(
        { error: "name, slug, pluginId, and executionType are required" },
        { status: 400 }
      );
    }

    // Validate slug format: lowercase, alphanumeric with dashes and slashes
    const slugPattern = /^[a-z0-9]+\/[a-z0-9-]+$/;
    if (!slugPattern.test(body.slug)) {
      return NextResponse.json(
        {
          error:
            'Invalid slug format. Must be "plugin/function-name" (lowercase, alphanumeric with dashes)',
        },
        { status: 400 }
      );
    }

    // Check slug availability
    const available = await isSlugAvailable(body.slug);
    if (!available) {
      return NextResponse.json(
        { error: "Slug is already in use" },
        { status: 409 }
      );
    }

    // Validate execution type specific fields
    if (body.executionType === "oci" && !body.imageRef) {
      return NextResponse.json(
        { error: "imageRef is required for OCI execution type" },
        { status: 400 }
      );
    }

    if (body.executionType === "http" && !body.webhookUrl) {
      return NextResponse.json(
        { error: "webhookUrl is required for HTTP execution type" },
        { status: 400 }
      );
    }

    const input: CreateFunctionInput = {
      ...body,
      isBuiltin: false, // User-created functions are never builtin
      isEnabled: true,
      createdBy: session.user.id,
    };

    const fn = await createFunction(input);

    const response: CreateFunctionResponse = {
      id: fn.id,
      name: fn.name,
      slug: fn.slug,
      description: fn.description,
      pluginId: fn.pluginId,
      version: fn.version,
      executionType: fn.executionType,
      integrationType: fn.integrationType,
      isBuiltin: fn.isBuiltin,
      isEnabled: fn.isEnabled,
      isDeprecated: fn.isDeprecated,
      createdAt: fn.createdAt,
      updatedAt: fn.updatedAt,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("Failed to create function:", error);
    return NextResponse.json(
      {
        error: "Failed to create function",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
