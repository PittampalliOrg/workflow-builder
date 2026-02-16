import type { IntegrationDefinition } from "@/lib/actions/types";

/**
 * Builtin pieces that should appear in the action palette alongside AP pieces.
 *
 * These are plugins defined in `plugins/` that have their own step handlers
 * executed via the function-router / orchestrator, but need to be discoverable
 * in the UI action grid.
 */

const MCP_PIECE: IntegrationDefinition = {
	type: "mcp",
	label: "MCP",
	pieceName: "mcp",
	logoUrl: "",
	actions: [
		{
			slug: "reply-to-client",
			label: "Reply to MCP Client",
			description: "Return a response to the MCP client that called this tool",
			category: "MCP",
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
					placeholder: '{\n  "ok": true\n}',
					rows: 6,
					required: true,
				},
				{
					key: "respond",
					label: "Flow Execution",
					type: "select",
					required: false,
					options: [
						{ label: "Stop", value: "stop" },
						{ label: "Respond and Continue", value: "respond" },
					],
					defaultValue: "stop",
				},
			],
			outputFields: [
				{ field: "responded", description: "Whether a response was sent" },
				{ field: "runId", description: "MCP run ID that was responded to" },
			],
		},
	],
};

const DURABLE_AGENT_PIECE: IntegrationDefinition = {
	type: "durable",
	label: "Durable Agent",
	pieceName: "durable",
	logoUrl: "",
	actions: [
		{
			slug: "run",
			label: "Run Agent",
			description:
				"Run a durable LLM agent with tool-calling — survives restarts, built-in retries",
			category: "Durable Agent",
			configFields: [
				{
					key: "agentId",
					label: "Saved Agent",
					type: "dynamic-select",
					required: false,
					placeholder: "Select a saved agent (optional)",
					defaultValue: "",
					dynamicOptions: {
						provider: "builtin",
						pieceName: "durable",
						actionName: "durable/run",
						propName: "agentId",
						refreshers: [],
					},
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder:
						"Describe the task for the agent. You can reference previous outputs like {{@nodeId:Label.field}}.",
					required: true,
					rows: 6,
				},
				// ── Inline config (hidden when a saved agent is selected) ──
				{
					key: "model",
					label: "Model",
					type: "model-selector",
					placeholder: "Select a model",
					defaultValue: "openai/gpt-4o",
					showWhen: { field: "agentId", equals: "" },
					dynamicOptions: {
						provider: "builtin",
						pieceName: "durable",
						actionName: "durable/run",
						propName: "model",
						refreshers: [],
					},
				},
				{
					key: "instructions",
					label: "System Instructions",
					type: "template-textarea",
					placeholder: "Custom system prompt for the agent",
					rows: 6,
					showWhen: { field: "agentId", equals: "" },
				},
				{
					key: "tools",
					label: "Tools",
					type: "dynamic-multi-select",
					placeholder: "Select workspace tools",
					defaultValue: "[]",
					showWhen: { field: "agentId", equals: "" },
					dynamicOptions: {
						provider: "builtin",
						pieceName: "durable",
						actionName: "durable/run",
						propName: "tools",
						refreshers: [],
					},
				},
				// ── Always visible ──
				{
					key: "maxTurns",
					label: "Max Turns",
					type: "number",
					defaultValue: "50",
					placeholder: "50",
					min: 1,
				},
				{
					key: "timeoutMinutes",
					label: "Timeout (minutes)",
					type: "number",
					defaultValue: "30",
					placeholder: "30",
					min: 1,
				},
				{
					key: "stopCondition",
					label: "Stop Condition (optional)",
					type: "template-textarea",
					placeholder:
						"Describe what 'done' means. Example: Stop when the API returns status 200 and the response contains an id.",
					rows: 4,
				},
			],
			outputFields: [
				{ field: "text", description: "Agent response text" },
				{
					field: "toolCalls",
					description: "Tools called during execution",
				},
				{
					field: "fileChanges",
					description: "Files created, modified, or deleted by the agent",
				},
				{
					field: "patch",
					description: "Unified diff patch of all file changes",
				},
				{ field: "usage", description: "Token usage statistics" },
				{
					field: "agentWorkflowId",
					description: "Dapr workflow instance ID for this agent run",
				},
			],
		},
	],
};

export function getBuiltinPieces(): IntegrationDefinition[] {
	return [MCP_PIECE, DURABLE_AGENT_PIECE];
}
