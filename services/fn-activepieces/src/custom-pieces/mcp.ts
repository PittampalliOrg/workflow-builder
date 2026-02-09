import {
  createAction,
  createPiece,
  PieceAuth,
  Property,
} from "@activepieces/pieces-framework";

const WORKFLOW_BUILDER_URL =
  process.env.WORKFLOW_BUILDER_URL ||
  "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

const replyToMcpClient = createAction({
  name: "reply-to-client",
  displayName: "Reply to MCP Client",
  description: "Return a response to the MCP client that called this tool.",
  auth: PieceAuth.None(),
  props: {
    runId: Property.ShortText({
      displayName: "Run ID",
      description: "MCP run identifier (usually {{Trigger.__mcp.runId}}).",
      required: true,
    }),
    response: Property.LongText({
      displayName: "Response (JSON)",
      description:
        "JSON string returned to the MCP client when the tool waits for response.",
      required: true,
    }),
    respond: Property.StaticDropdown({
      displayName: "Flow Execution",
      required: false,
      defaultValue: "stop",
      options: {
        disabled: false,
        options: [
          { label: "Stop", value: "stop" },
          { label: "Respond and Continue", value: "respond" },
        ],
      },
    }),
  },
  async run(context) {
    if (!INTERNAL_API_TOKEN) {
      throw new Error(
        "INTERNAL_API_TOKEN is not configured on fn-activepieces"
      );
    }

    const runId = String(context.propsValue.runId || "").trim();
    if (!runId) {
      throw new Error("runId is required");
    }

    const raw = String(context.propsValue.response || "");
    let responseValue: unknown = raw;
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        responseValue = JSON.parse(trimmed);
      } catch {
        // Keep as string if invalid JSON.
      }
    }

    const res = await fetch(
      `${WORKFLOW_BUILDER_URL}/api/internal/mcp/runs/${encodeURIComponent(
        runId
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
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to respond to MCP run. HTTP ${res.status}: ${text}`
      );
    }

    // Signal to the workflow orchestrator that it should stop early if requested.
    // The orchestrator treats this as a reserved key.
    const respond = String(context.propsValue.respond || "stop");

    return {
      responded: true,
      runId,
      respond,
      __workflow_builder_control: {
        stop: respond === "stop",
      },
    };
  },
});

export const mcp = createPiece({
  name: "mcp",
  displayName: "MCP",
  description: "Hosted MCP server utilities",
  logoUrl: "",
  version: "0.1.0",
  auth: PieceAuth.None(),
  actions: [replyToMcpClient],
  triggers: [],
});
