/**
 * HTTP Handler
 *
 * Executes functions by calling an external HTTP webhook.
 * Supports JSON payloads with configurable headers and timeouts.
 */
import type {
  FunctionDefinition,
  WorkflowCredentials,
  ExecuteFunctionResult,
} from "../core/types.js";

const DEFAULT_TIMEOUT_SECONDS = 30;

export interface HttpExecuteInput {
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
 * Execute an HTTP webhook function
 */
export async function executeHttp(
  options: HttpExecuteInput
): Promise<ExecuteFunctionResult> {
  const { fn, input, credentials, context } = options;
  const startTime = Date.now();

  if (!fn.webhookUrl) {
    return {
      success: false,
      error: `HTTP function ${fn.slug} has no webhookUrl configured`,
      duration_ms: Date.now() - startTime,
    };
  }

  const method = (fn.webhookMethod ?? "POST").toUpperCase();
  const timeout = fn.webhookTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  console.log(`[HTTP Handler] Calling ${method} ${fn.webhookUrl} for ${fn.slug}`);

  try {
    // Build headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Function-Slug": fn.slug,
      "X-Execution-Id": context.executionId,
      "X-Workflow-Id": context.workflowId,
      "X-Node-Id": context.nodeId,
      "X-Node-Name": context.nodeName,
    };

    // Add configured headers
    if (fn.webhookHeaders) {
      Object.assign(headers, fn.webhookHeaders);
    }

    // Add credentials as headers if they start with HEADER_
    // Otherwise, include them in the payload
    const credentialHeaders: Record<string, string> = {};
    const credentialPayload: Record<string, string> = {};

    for (const [key, value] of Object.entries(credentials)) {
      if (value) {
        if (key.startsWith("HEADER_")) {
          // Strip HEADER_ prefix and use as header name
          const headerName = key.substring(7);
          credentialHeaders[headerName] = value;
        } else {
          credentialPayload[key] = value;
        }
      }
    }

    Object.assign(headers, credentialHeaders);

    // Build request body
    const body = JSON.stringify({
      ...input,
      _credentials: credentialPayload,
      _context: {
        executionId: context.executionId,
        workflowId: context.workflowId,
        nodeId: context.nodeId,
        nodeName: context.nodeName,
        functionSlug: fn.slug,
      },
    });

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const response = await fetch(fn.webhookUrl, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
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
        return {
          success: false,
          error: `HTTP ${response.status}: ${
            typeof data === "string" ? data : JSON.stringify(data)
          }`,
          data,
          duration_ms,
        };
      }

      // Check if response contains a success field
      if (data && typeof data === "object" && "success" in data) {
        const typedData = data as { success: boolean; error?: string };
        if (typedData.success === false) {
          return {
            success: false,
            error: typedData.error || "Webhook returned failure",
            data,
            duration_ms,
          };
        }
      }

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
          error: `HTTP request timed out after ${timeout}s`,
          duration_ms: Date.now() - startTime,
        };
      }

      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[HTTP Handler] Error calling ${fn.webhookUrl}:`, error);

    return {
      success: false,
      error: `HTTP webhook failed: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Validate that a webhook URL is properly configured
 */
export function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
