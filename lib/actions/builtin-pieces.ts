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

const AGENT_PIECE: IntegrationDefinition = {
	type: "agent",
	label: "Agent",
	pieceName: "agent",
	logoUrl: "",
	actions: [
		{
			slug: "run",
			label: "Run Agent",
			description:
				"Run a durable LLM agent with tool-calling inside a workflow step",
			category: "Agent",
			configFields: [
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder:
						"Describe the task for the agent. You can reference previous outputs like {{@nodeId:Label.field}}.",
					rows: 6,
					required: true,
				},
				{
					key: "model",
					label: "Model",
					type: "model-selector",
					placeholder: "Select a model",
					defaultValue: "gpt-5.2-codex",
					dynamicOptions: {
						provider: "planner",
						pieceName: "agent",
						actionName: "agent/run",
						propName: "model",
						refreshers: [],
					},
				},
				{
					key: "maxTurns",
					label: "Max Turns",
					type: "number",
					defaultValue: "20",
				},
				{
					key: "stopCondition",
					label: "Stop Condition (optional)",
					type: "template-textarea",
					placeholder:
						"Describe what 'done' means. Example: Stop when the API returns status 200 and the response contains an id.",
					rows: 4,
					required: false,
				},
				{
					key: "timeoutMinutes",
					label: "Timeout (minutes)",
					type: "number",
					defaultValue: "30",
				},
				{
					key: "allowedActionsJson",
					label: "Allowed Actions",
					type: "dynamic-multi-select",
					placeholder: "Select allowed actions",
					defaultValue: "[]",
					dynamicOptions: {
						provider: "planner",
						pieceName: "agent",
						actionName: "agent/run",
						propName: "allowedActionsJson",
						refreshers: [],
					},
				},
				{
					key: "agentToolsJson",
					label: "Agent Tools (JSON, optional)",
					type: "template-textarea",
					placeholder:
						'[{"type":"ACTION","toolName":"HttpRequest","actionType":"system/http-request"}]',
					rows: 6,
					defaultValue: "[]",
				},
			],
			outputFields: [
				{ field: "summary", description: "Agent summary" },
				{
					field: "result",
					description: "Agent structured result payload (best-effort)",
				},
				{
					field: "agentWorkflowId",
					description: "Dapr workflow instance ID for this agent run",
				},
			],
		},
	],
};

const MASTRA_AGENT_PIECE: IntegrationDefinition = {
	type: "mastra",
	label: "Mastra Agent",
	pieceName: "mastra",
	logoUrl: "",
	actions: [
		{
			slug: "run-tool",
			label: "Run Tool",
			description:
				"Execute a Mastra tool through the Dapr-native mastra-agent service",
			category: "Mastra Agent",
			configFields: [
				{
					key: "toolId",
					label: "Tool",
					type: "dynamic-select",
					required: true,
					placeholder: "Select a tool",
					dynamicOptions: {
						provider: "planner",
						pieceName: "mastra",
						actionName: "mastra/run-tool",
						propName: "toolId",
						refreshers: [],
					},
				},
				{
					key: "argsJson",
					label: "Tool Args (JSON)",
					type: "template-textarea",
					placeholder: '{\n  "name": "Ada"\n}',
					rows: 6,
					defaultValue: "{}",
				},
			],
			outputFields: [
				{ field: "toolId", description: "The tool that was executed" },
				{ field: "result", description: "Tool execution result payload" },
				{
					field: "workflowId",
					description: "Durable workflow instance ID (if returned)",
				},
				{ field: "status", description: "Workflow status (if returned)" },
			],
		},
	],
};

export function getBuiltinPieces(): IntegrationDefinition[] {
	return [MCP_PIECE, AGENT_PIECE, MASTRA_AGENT_PIECE];
}
