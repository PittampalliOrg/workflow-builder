export type McpPropertyType =
  | "TEXT"
  | "NUMBER"
  | "BOOLEAN"
  | "DATE"
  | "ARRAY"
  | "OBJECT";

export type McpInputProperty = {
  name: string;
  type: McpPropertyType;
  required: boolean;
  description?: string;
};

export type McpTriggerConfig = {
  triggerType: "MCP";
  toolName?: string;
  toolDescription?: string;
  /**
   * Stored as JSON string in workflow node config for editor parity with other schema builders.
   */
  inputSchema?: string;
  /**
   * Stored as string ("true"/"false") in node config.
   * When true, the MCP gateway will block until Reply-to-client responds.
   */
  returnsResponse?: string;
  /**
   * Stored as string ("true"/"false") in node config.
   * When false, the workflow is not exposed as an MCP tool.
   */
  enabled?: string;
};
