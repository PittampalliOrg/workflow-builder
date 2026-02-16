import { getErrorMessageAsync } from "@/lib/utils";

type ReplyToMcpClientInput = {
  runId: string;
  response: unknown;
};

type ReplyToMcpClientOutput =
  | { success: true; data: { responded: true; runId: string } }
  | { success: false; error: { message: string } };

const WORKFLOW_BUILDER_URL =
  process.env.WORKFLOW_BUILDER_URL ||
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

export async function mcpReplyToClientStep(
  input: ReplyToMcpClientInput
): Promise<ReplyToMcpClientOutput> {
  try {
    if (!INTERNAL_API_TOKEN) {
      return {
        success: false,
        error: { message: "INTERNAL_API_TOKEN is not configured on this service." },
      };
    }
    if (!input.runId) {
      return { success: false, error: { message: "runId is required." } };
    }

    let responseValue: unknown = input.response;
    if (typeof responseValue === "string") {
      const trimmed = responseValue.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          responseValue = JSON.parse(trimmed);
        } catch {
          // Leave as string if it's not valid JSON.
        }
      }
    }

    const res = await fetch(
      `${WORKFLOW_BUILDER_URL}/api/internal/mcp/runs/${encodeURIComponent(
        input.runId
      )}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": INTERNAL_API_TOKEN,
        },
        body: JSON.stringify({ response: responseValue }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        error: { message: `Failed to respond to MCP run. HTTP ${res.status}: ${body}` },
      };
    }

    return {
      success: true,
      data: {
        responded: true,
        runId: input.runId,
      },
    };
  } catch (err) {
    return { success: false, error: { message: await getErrorMessageAsync(err) } };
  }
}
