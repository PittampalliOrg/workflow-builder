/**
 * ActivePieces Handler
 *
 * Executes ActivePieces piece actions via HTTP.
 * This handler formats requests in the AP-expected format and
 * transforms credentials to AP auth structure.
 */
import type {
  FunctionDefinition,
  WorkflowCredentials,
  ExecuteFunctionResult,
} from "../core/types.js";
import {
  mapCredentialsToActivePieces,
  isActivePiecesFunction,
  extractPieceNameFromSlug,
} from "../core/activepieces-credentials.js";

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * ActivePieces URL configuration
 */
const ACTIVEPIECES_URL =
  process.env.ACTIVEPIECES_URL || "https://activepieces.cnoe.localtest.me:8443";

export interface ActivePiecesExecuteInput {
  fn: FunctionDefinition;
  input: Record<string, unknown>;
  credentials: WorkflowCredentials;
  context: {
    executionId: string;
    workflowId: string;
    nodeId: string;
    nodeName: string;
  };
}

/**
 * Parse piece name and action name from function slug
 * Format: ap-{pieceName}/{actionName}
 */
function parseFunctionSlug(slug: string): { pieceName: string; actionName: string } | null {
  if (!isActivePiecesFunction(slug)) {
    return null;
  }

  // Remove "ap-" prefix
  const withoutPrefix = slug.substring(3);
  const slashIndex = withoutPrefix.indexOf("/");

  if (slashIndex === -1) {
    return null;
  }

  return {
    pieceName: withoutPrefix.substring(0, slashIndex),
    actionName: withoutPrefix.substring(slashIndex + 1),
  };
}

/**
 * Execute an ActivePieces piece action
 *
 * This sends a request to the ActivePieces execution endpoint
 * with credentials formatted for AP.
 */
export async function executeActivePieces(
  options: ActivePiecesExecuteInput
): Promise<ExecuteFunctionResult> {
  const { fn, input, credentials, context } = options;
  const startTime = Date.now();

  // Parse the function slug to get piece/action names
  const parsed = parseFunctionSlug(fn.slug);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid ActivePieces function slug: ${fn.slug}. Expected format: ap-{pieceName}/{actionName}`,
      duration_ms: Date.now() - startTime,
    };
  }

  const { pieceName, actionName } = parsed;

  console.log(
    `[ActivePieces Handler] Executing ${pieceName}/${actionName} for ${fn.slug}`
  );

  // Map credentials to AP format
  const apAuth = mapCredentialsToActivePieces(pieceName, credentials);

  // Build the AP execution URL
  // If webhookUrl is set, use it; otherwise construct from ACTIVEPIECES_URL
  const executionUrl =
    fn.webhookUrl ||
    `${ACTIVEPIECES_URL}/api/v1/pieces/${pieceName}/actions/${actionName}/execute`;

  const timeout = fn.webhookTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  try {
    // Build request headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Workflow-Builder-Execution-Id": context.executionId,
      "X-Workflow-Builder-Workflow-Id": context.workflowId,
      "X-Workflow-Builder-Node-Id": context.nodeId,
      "X-Workflow-Builder-Node-Name": context.nodeName,
      "X-Workflow-Builder-Function-Slug": fn.slug,
    };

    // Add API key if configured
    const apiKey = process.env.ACTIVEPIECES_API_KEY;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Build the request body in AP format
    const body = JSON.stringify({
      // Piece version (default to latest if not specified)
      pieceVersion: fn.version || "latest",
      // Action input values
      input,
      // Authentication in AP format
      auth: Object.keys(apAuth).length > 0 ? apAuth : undefined,
      // Server URL for OAuth refresh (optional)
      serverUrl: ACTIVEPIECES_URL,
    });

    console.log(`[ActivePieces Handler] POST ${executionUrl}`);

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const response = await fetch(executionUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const duration_ms = Date.now() - startTime;

      // Parse response
      const contentType = response.headers.get("content-type");
      let data: unknown;

      if (contentType?.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      // Check for HTTP error status
      if (!response.ok) {
        const errorMessage = extractErrorMessage(data, response.status);
        console.error(
          `[ActivePieces Handler] HTTP ${response.status}:`,
          errorMessage
        );

        return {
          success: false,
          error: errorMessage,
          data,
          duration_ms,
        };
      }

      // Check for AP-specific error structure
      if (data && typeof data === "object") {
        const typedData = data as Record<string, unknown>;

        // AP may return { success: false, error: { message, code } }
        if (typedData.success === false) {
          const error = typedData.error as Record<string, unknown> | undefined;
          const errorMessage = error?.message || typedData.message || "ActivePieces action failed";

          return {
            success: false,
            error: String(errorMessage),
            data,
            duration_ms,
          };
        }

        // AP may return { output: ... } for successful execution
        if ("output" in typedData) {
          return {
            success: true,
            data: typedData.output,
            duration_ms,
          };
        }
      }

      // Default: return the data as-is
      return {
        success: true,
        data,
        duration_ms,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: `ActivePieces request timed out after ${timeout}s`,
          duration_ms: Date.now() - startTime,
        };
      }

      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[ActivePieces Handler] Error executing ${fn.slug}:`,
      error
    );

    return {
      success: false,
      error: `ActivePieces execution failed: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Extract error message from response data
 */
function extractErrorMessage(data: unknown, statusCode: number): string {
  if (typeof data === "string") {
    return `HTTP ${statusCode}: ${data}`;
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // Try various error formats
    if (obj.error && typeof obj.error === "object") {
      const error = obj.error as Record<string, unknown>;
      if (error.message) {
        return `HTTP ${statusCode}: ${error.message}`;
      }
    }

    if (obj.message) {
      return `HTTP ${statusCode}: ${obj.message}`;
    }

    if (obj.error && typeof obj.error === "string") {
      return `HTTP ${statusCode}: ${obj.error}`;
    }
  }

  return `HTTP ${statusCode}: Request failed`;
}

/**
 * Check if a function should be handled by the ActivePieces handler
 */
export function shouldUseActivePiecesHandler(fn: FunctionDefinition): boolean {
  // Check if slug indicates an AP function
  if (isActivePiecesFunction(fn.slug)) {
    return true;
  }

  // Check if plugin ID indicates AP
  if (fn.pluginId.startsWith("activepieces-")) {
    return true;
  }

  // Check if webhook URL points to AP
  if (fn.webhookUrl?.includes("activepieces")) {
    return true;
  }

  return false;
}
