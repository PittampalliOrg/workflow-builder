import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { McpIcon } from "./icon";

const mcpPlugin: IntegrationPlugin = {
  type: "mcp",
  pieceName: "mcp",
  label: "MCP",
  description: "Hosted MCP server tools and control",
  icon: McpIcon,

  // No credentials required for MCP reply action.
  formFields: [],

  actions: [
    {
      slug: "reply-to-client",
      label: "Reply to MCP Client",
      description: "Return a response to the MCP client that called this tool",
      category: "MCP",
      stepFunction: "mcpReplyToClientStep",
      stepImportPath: "reply-to-client",
      outputFields: [
        { field: "responded", description: "Whether a response was sent" },
        { field: "runId", description: "MCP run ID that was responded to" },
      ],
      configFields: [
        {
          key: "runId",
          label: "Run ID",
          type: "template-input",
          placeholder: "{{Trigger.__mcp.runId}}",
          example: "{{Trigger.__mcp.runId}}",
          required: true,
        },
        {
          key: "response",
          label: "Response (JSON)",
          type: "template-textarea",
          placeholder: "{\n  \"ok\": true\n}",
          rows: 6,
          required: true,
        },
      ],
    },
  ],
};

registerIntegration(mcpPlugin);

export default mcpPlugin;
