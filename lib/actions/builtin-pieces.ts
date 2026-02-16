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
						provider: "builtin",
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
						provider: "builtin",
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
			slug: "clone",
			label: "Clone Repository",
			description: "Clone a GitHub repository into the agent workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "repositoryOwner",
					label: "GitHub Owner",
					type: "dynamic-select",
					placeholder: "Select owner",
					required: true,
					dynamicOptions: {
						provider: "builtin",
						pieceName: "mastra",
						actionName: "mastra/clone",
						propName: "repositoryOwner",
						refreshers: [],
					},
				},
				{
					key: "repositoryRepo",
					label: "Repository Name",
					type: "dynamic-select",
					placeholder: "Select repository",
					required: true,
					dynamicOptions: {
						provider: "builtin",
						pieceName: "mastra",
						actionName: "mastra/clone",
						propName: "repositoryRepo",
						refreshers: ["repositoryOwner"],
					},
				},
				{
					key: "repositoryBranch",
					label: "Branch",
					type: "dynamic-select",
					defaultValue: "main",
					placeholder: "Select branch",
					dynamicOptions: {
						provider: "builtin",
						pieceName: "mastra",
						actionName: "mastra/clone",
						propName: "repositoryBranch",
						refreshers: ["repositoryOwner", "repositoryRepo"],
					},
				},
				{
					key: "repositoryToken",
					label: "GitHub Token (override)",
					type: "template-input",
					placeholder: "Uses GitHub connection token if blank",
				},
			],
			outputFields: [
				{ field: "success", description: "Whether the clone completed" },
				{
					field: "clonePath",
					description: "Path to the cloned repository",
				},
				{ field: "commitHash", description: "HEAD commit hash" },
				{ field: "repository", description: "owner/repo string" },
				{
					field: "file_count",
					description: "Number of files in cloned repo",
				},
			],
		},
		{
			slug: "plan",
			label: "Plan",
			description: "Generate a structured execution plan without executing it",
			category: "Mastra Agent",
			configFields: [
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder: "Describe what the agent should accomplish",
					rows: 4,
					required: true,
				},
				{
					key: "cwd",
					label: "Working Directory",
					type: "template-input",
					placeholder: "{{Clone.result.clonePath}}",
				},
			],
			outputFields: [
				{
					field: "plan",
					description: "The full plan object (goal + steps)",
				},
				{
					field: "plan.goal",
					description: "One-sentence goal summary",
				},
				{
					field: "plan.steps",
					description: "Ordered array of steps",
				},
				{
					field: "plan.estimated_tool_calls",
					description: "Expected tool call count",
				},
			],
		},
		{
			slug: "execute",
			label: "Execute Plan",
			description: "Execute a previously generated plan using workspace tools",
			category: "Mastra Agent",
			configFields: [
				{
					key: "prompt",
					label: "Prompt (optional)",
					type: "template-textarea",
					placeholder:
						"Additional instructions (plan steps are injected automatically)",
					rows: 3,
				},
				{
					key: "planJson",
					label: "Plan JSON",
					type: "template-textarea",
					placeholder: "{{Plan.plan}}",
					rows: 6,
					required: true,
				},
				{
					key: "cwd",
					label: "Working Directory",
					type: "template-input",
					placeholder: "{{Clone.result.clonePath}}",
				},
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
				},
			],
			outputFields: [
				{
					field: "text",
					description: "Agent summary of execution",
				},
				{
					field: "toolCalls",
					description: "Tools called during execution",
				},
				{ field: "usage", description: "Token usage" },
			],
		},
		{
			slug: "run",
			label: "Run Agent",
			description:
				"Run the Mastra dev agent with a prompt (agentic mode — agent decides which tools to use)",
			category: "Mastra Agent",
			configFields: [
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder:
						"Describe the task. The agent will use workspace tools autonomously.",
					rows: 4,
					required: true,
				},
				{
					key: "maxTurns",
					label: "Max Turns",
					type: "number",
					defaultValue: "50",
					placeholder: "50",
					min: 1,
				},
			],
			outputFields: [
				{ field: "text", description: "Agent response text" },
				{ field: "toolCalls", description: "Tools called during execution" },
				{ field: "usage", description: "Token usage" },
			],
		},
		{
			slug: "read-file",
			label: "Read File",
			description: "Read a file from the agent workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "File Path",
					type: "template-input",
					placeholder: "src/index.ts",
					required: true,
				},
			],
			outputFields: [{ field: "content", description: "File contents" }],
		},
		{
			slug: "write-file",
			label: "Write File",
			description: "Create or overwrite a file in the agent workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "File Path",
					type: "template-input",
					placeholder: "output/result.json",
					required: true,
				},
				{
					key: "content",
					label: "Content",
					type: "template-textarea",
					placeholder: "File content here...",
					rows: 8,
					required: true,
				},
			],
			outputFields: [
				{ field: "path", description: "Path of the written file" },
			],
		},
		{
			slug: "edit-file",
			label: "Edit File",
			description: "Find and replace text in a file",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "File Path",
					type: "template-input",
					placeholder: "src/index.ts",
					required: true,
				},
				{
					key: "old_string",
					label: "Find",
					type: "template-textarea",
					placeholder: "Text to find...",
					rows: 3,
					required: true,
				},
				{
					key: "new_string",
					label: "Replace",
					type: "template-textarea",
					placeholder: "Replacement text...",
					rows: 3,
					required: true,
				},
			],
			outputFields: [{ field: "path", description: "Path of the edited file" }],
		},
		{
			slug: "list-files",
			label: "List Files",
			description: "List files and directories in the workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "Directory Path",
					type: "template-input",
					placeholder: ".",
					defaultValue: ".",
					required: false,
				},
			],
			outputFields: [
				{ field: "files", description: "List of file/directory names" },
			],
		},
		{
			slug: "execute-command",
			label: "Execute Command",
			description: "Run a shell command in the agent workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "command",
					label: "Command",
					type: "template-input",
					placeholder: "ls -la",
					required: true,
				},
			],
			outputFields: [
				{ field: "stdout", description: "Standard output" },
				{ field: "stderr", description: "Error output" },
				{ field: "exitCode", description: "Exit code" },
			],
		},
		{
			slug: "delete",
			label: "Delete File",
			description: "Delete a file or directory from the workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "Path",
					type: "template-input",
					placeholder: "temp/old-file.txt",
					required: true,
				},
			],
			outputFields: [
				{ field: "deleted", description: "Whether the file was deleted" },
			],
		},
		{
			slug: "mkdir",
			label: "Create Directory",
			description: "Create a directory in the workspace",
			category: "Mastra Agent",
			configFields: [
				{
					key: "path",
					label: "Directory Path",
					type: "template-input",
					placeholder: "output/reports",
					required: true,
				},
			],
			outputFields: [
				{ field: "path", description: "Path of the created directory" },
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
			label: "Durable Agent Run",
			description:
				"Run the durable agent with a prompt — survives restarts, has built-in retries",
			category: "Durable Agent",
			configFields: [
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder: "What should the agent do?",
					required: true,
					rows: 4,
				},
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
					required: false,
				},
			],
			outputFields: [
				{ field: "text", description: "Agent response text" },
				{ field: "toolCalls", description: "Tools called during execution" },
				{
					field: "fileChanges",
					description: "Files created, modified, or deleted by the agent",
				},
				{
					field: "patch",
					description: "Unified diff patch of all file changes",
				},
				{ field: "usage", description: "Token usage statistics" },
			],
		},
	],
};

export function getBuiltinPieces(): IntegrationDefinition[] {
	return [MCP_PIECE, AGENT_PIECE, MASTRA_AGENT_PIECE, DURABLE_AGENT_PIECE];
}
