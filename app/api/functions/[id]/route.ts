import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getFunctionById,
  updateFunction,
  deleteFunction,
  type FunctionDefinition,
  type UpdateFunctionInput,
} from "@/lib/db/functions";
import type { FunctionExecutionType, RetryPolicy } from "@/lib/db/schema";

type RouteParams = {
  params: Promise<{ id: string }>;
};

/**
 * Response type for GET /api/functions/[id]
 */
export type GetFunctionResponse = FunctionDefinition;

/**
 * Request type for PATCH /api/functions/[id]
 */
export type UpdateFunctionRequest = {
  name?: string;
  description?: string;
  pluginId?: string;
  version?: string;
  executionType?: FunctionExecutionType;
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
  retryPolicy?: RetryPolicy;
  maxConcurrency?: number;
  // Metadata
  integrationType?: string;
  isEnabled?: boolean;
};

/**
 * Response type for PATCH /api/functions/[id]
 */
export type UpdateFunctionResponse = FunctionDefinition;

/**
 * Response type for DELETE /api/functions/[id]
 */
export type DeleteFunctionResponse = {
  success: boolean;
  error?: string;
};

/**
 * GET /api/functions/[id]
 * Get a function by ID
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    const fn = await getFunctionById(id);

    if (!fn) {
      return NextResponse.json({ error: "Function not found" }, { status: 404 });
    }

    const response: GetFunctionResponse = fn;
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to get function:", error);
    return NextResponse.json(
      {
        error: "Failed to get function",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/functions/[id]
 * Update a function (requires authentication)
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body: UpdateFunctionRequest = await request.json();

    // Check if function exists
    const existing = await getFunctionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Function not found" }, { status: 404 });
    }

    // Check if user can update this function
    // Users can only update functions they created (not builtin)
    if (existing.isBuiltin) {
      return NextResponse.json(
        { error: "Cannot update builtin functions" },
        { status: 403 }
      );
    }

    // If changing execution type, validate required fields
    const effectiveType = body.executionType || existing.executionType;
    if (effectiveType === "oci") {
      const effectiveImageRef = body.imageRef ?? existing.imageRef;
      if (!effectiveImageRef) {
        return NextResponse.json(
          { error: "imageRef is required for OCI execution type" },
          { status: 400 }
        );
      }
    }

    if (effectiveType === "http") {
      const effectiveWebhookUrl = body.webhookUrl ?? existing.webhookUrl;
      if (!effectiveWebhookUrl) {
        return NextResponse.json(
          { error: "webhookUrl is required for HTTP execution type" },
          { status: 400 }
        );
      }
    }

    const input: UpdateFunctionInput = {
      name: body.name,
      description: body.description,
      pluginId: body.pluginId,
      version: body.version,
      executionType: body.executionType,
      imageRef: body.imageRef,
      command: body.command,
      workingDir: body.workingDir,
      containerEnv: body.containerEnv,
      webhookUrl: body.webhookUrl,
      webhookMethod: body.webhookMethod,
      webhookHeaders: body.webhookHeaders,
      webhookTimeoutSeconds: body.webhookTimeoutSeconds,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
      timeoutSeconds: body.timeoutSeconds,
      retryPolicy: body.retryPolicy,
      maxConcurrency: body.maxConcurrency,
      integrationType: body.integrationType,
      isEnabled: body.isEnabled,
    };

    const fn = await updateFunction(id, input);

    if (!fn) {
      return NextResponse.json(
        { error: "Failed to update function" },
        { status: 500 }
      );
    }

    const response: UpdateFunctionResponse = fn;
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to update function:", error);
    return NextResponse.json(
      {
        error: "Failed to update function",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/functions/[id]
 * Soft delete (disable) a function (requires authentication)
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Check if function exists
    const existing = await getFunctionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Function not found" }, { status: 404 });
    }

    // Check if user can delete this function
    if (existing.isBuiltin) {
      return NextResponse.json(
        { error: "Cannot delete builtin functions" },
        { status: 403 }
      );
    }

    const result = await deleteFunction(id);

    const response: DeleteFunctionResponse = result;
    return NextResponse.json(response);
  } catch (error) {
    console.error("Failed to delete function:", error);
    return NextResponse.json(
      {
        error: "Failed to delete function",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
