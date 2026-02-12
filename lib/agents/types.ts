/**
 * Agent tool schema (inspired by Activepieces) for representing which tools an
 * LLM agent can use inside a workflow step.
 *
 * In workflow-builder, these are primarily used by the builtin `agent/run`
 * action as an optional structured alternative to `allowedActionsJson`.
 */

export enum FieldControlMode {
	AGENT_DECIDE = "agent-decide",
	CHOOSE_YOURSELF = "choose-yourself",
	LEAVE_EMPTY = "leave-empty",
}

export type PredefinedInputField = {
	mode: FieldControlMode;
	value: unknown;
};

export type PredefinedInputs = {
	/**
	 * Optional connection reference or auth hint. This is intentionally loose:
	 * workflow-builder does not share Activepieces' auth model 1:1.
	 */
	auth?: string;
	fields: Record<string, PredefinedInputField>;
};

export enum AgentToolType {
	/**
	 * A workflow-builder action type (e.g. "system/http-request", "slack/send-message").
	 */
	ACTION = "ACTION",

	/**
	 * A workflow-builder workflow (by workflow id). Not yet executed by the agent
	 * runtime, but included for forward-compat.
	 */
	WORKFLOW = "WORKFLOW",

	/**
	 * MCP tool server.
	 */
	MCP = "MCP",
}

export type AgentActionTool = {
	type: AgentToolType.ACTION;
	toolName: string;
	actionType: string;
	predefinedInput?: PredefinedInputs;
};

export type AgentWorkflowTool = {
	type: AgentToolType.WORKFLOW;
	toolName: string;
	workflowId: string;
};

export enum McpProtocol {
	SSE = "sse",
	STREAMABLE_HTTP = "streamable-http",
	SIMPLE_HTTP = "http",
}

export enum McpAuthType {
	NONE = "none",
	ACCESS_TOKEN = "access_token",
	API_KEY = "api_key",
	HEADERS = "headers",
}

export type McpAuthNone = {
	type: McpAuthType.NONE;
};

export type McpAuthAccessToken = {
	type: McpAuthType.ACCESS_TOKEN;
	accessToken: string;
};

export type McpAuthApiKey = {
	type: McpAuthType.API_KEY;
	apiKey: string;
	apiKeyHeader: string;
};

export type McpAuthHeaders = {
	type: McpAuthType.HEADERS;
	headers: Record<string, string>;
};

export type McpAuthConfig =
	| McpAuthNone
	| McpAuthAccessToken
	| McpAuthApiKey
	| McpAuthHeaders;

export type AgentMcpTool = {
	type: AgentToolType.MCP;
	toolName: string;
	serverUrl: string;
	protocol: McpProtocol;
	auth: McpAuthConfig;
};

export type AgentTool = AgentActionTool | AgentWorkflowTool | AgentMcpTool;
