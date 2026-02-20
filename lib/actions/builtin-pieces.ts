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
					key: "mode",
					label: "Mode",
					type: "select",
					required: true,
					defaultValue: "plan_mode",
					options: [
						{
							label: "Plan Mode",
							value: "plan_mode",
						},
						{ label: "Execute Direct", value: "execute_direct" },
					],
				},
				{
					key: "agentProfileTemplateId",
					label: "Agent Profile",
					type: "dynamic-select",
					required: true,
					placeholder: "Select an agent profile template",
					dynamicOptions: {
						provider: "builtin",
						pieceName: "durable",
						actionName: "durable/run",
						propName: "agentProfileTemplateId",
						refreshers: [],
					},
				},
				{
					label: "Dynamic Runtime Config (Dapr)",
					type: "group",
					fields: [
						{
							key: "configStoreName",
							label: "Config Store Name",
							type: "text",
							required: false,
							placeholder: "azureappconfig-workflow-builder",
						},
						{
							key: "configName",
							label: "Config Item Name (optional)",
							type: "text",
							required: false,
							placeholder: "agents/opendev",
						},
						{
							key: "configKeys",
							label: "Config Keys (optional)",
							type: "template-input",
							required: false,
							placeholder: "modelSpec,instructions,maxTurns,timeoutMinutes",
						},
						{
							key: "configMetadata",
							label: "Config Metadata JSON (optional)",
							type: "template-textarea",
							required: false,
							rows: 4,
							placeholder: '{\n  "label": "workflow-builder"\n}',
						},
					],
				},
				{
					key: "prompt",
					label: "Prompt / Goal",
					type: "template-textarea",
					placeholder:
						"Describe the task for the agent. In plan mode this produces the reviewable plan before execution.",
					required: true,
					rows: 6,
				},
				{
					key: "workspaceRef",
					label: "Workspace Ref (optional)",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					required: false,
				},
				{
					key: "cwd",
					label: "Repository Root (optional)",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Clone.clonePath}}",
					required: false,
				},
				{
					key: "maxTurns",
					label: "Max Turns",
					type: "number",
					required: false,
					defaultValue: "50",
					min: 1,
					placeholder: "50",
				},
				{
					key: "stopCondition",
					label: "Stop Condition (optional)",
					type: "template-textarea",
					placeholder:
						"Describe what 'done' means. Example: Stop when the API returns status 200 and the response contains an id.",
					rows: 4,
					showWhen: { field: "mode", equals: "execute_direct" },
				},
				{
					key: "requireFileChanges",
					label: "Require File Changes",
					type: "select",
					required: false,
					defaultValue: "true",
					showWhen: { field: "mode", equals: "execute_direct" },
					options: [
						{ label: "Enabled", value: "true" },
						{ label: "Disabled", value: "false" },
					],
				},
				{
					key: "approvalTimeoutMinutes",
					label: "Plan Approval Timeout (minutes)",
					type: "number",
					required: false,
					defaultValue: "60",
					min: 1,
					showWhen: { field: "mode", equals: "plan_mode" },
				},
				{
					key: "cleanupWorkspace",
					label: "Cleanup Workspace After Execute",
					type: "select",
					required: false,
					defaultValue: "true",
					showWhen: { field: "mode", equals: "execute_direct" },
					options: [
						{ label: "Enabled", value: "true" },
						{ label: "Disabled", value: "false" },
					],
				},
			],
			outputFields: [
				{
					field: "artifactRef",
					description: "Reference ID for persisted plan artifact",
				},
				{
					field: "plan",
					description: "Structured plan artifact JSON",
				},
				{
					field: "planMarkdown",
					description: "Markdown plan generated during plan mode",
				},
				{
					field: "planPolicy",
					description:
						"Plan mode policy metadata (read-only expectation + violations)",
				},
				{
					field: "tasks",
					description: "Task graph derived from plan artifact",
				},
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
				{
					field: "patchRef",
					description: "Reference to full patch artifact",
				},
				{
					field: "changeSummary",
					description: "Structured per-step file change metadata",
				},
				{
					field: "loopStopReason",
					description: "Loop termination reason from durable ReAct runtime",
				},
				{
					field: "loopStopCondition",
					description: "Matched stopWhen condition payload (if any)",
				},
				{
					field: "requiresApproval",
					description: "Approval requirement details when execution paused",
				},
				{
					field: "staticToolCalls",
					description:
						"Tool calls not executed (approval/declaration-only termination)",
				},
				{
					field: "usageTotals",
					description: "Accumulated token usage across loop steps",
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

const WORKSPACE_PIECE: IntegrationDefinition = {
	type: "workspace",
	label: "Workspace",
	pieceName: "workspace",
	logoUrl: "",
	actions: [
		{
			slug: "profile",
			label: "Workspace Profile",
			description:
				"Create or resolve an execution-scoped workspace profile for this workflow run",
			category: "Workspace",
			configFields: [
				{
					key: "name",
					label: "Profile Name",
					type: "template-input",
					placeholder: "workspace-profile",
					required: false,
				},
				{
					key: "rootPath",
					label: "Root Path (optional)",
					type: "template-input",
					placeholder: "workspaces/current",
					required: false,
				},
				{
					key: "enabledTools",
					label: "Enabled Tools",
					type: "dynamic-multi-select",
					placeholder: "Select workspace tools",
					defaultValue: '["read","write","edit","list","bash"]',
					required: false,
					dynamicOptions: {
						provider: "builtin",
						pieceName: "workspace",
						actionName: "workspace/profile",
						propName: "enabledTools",
						refreshers: [],
					},
				},
				{
					key: "requireReadBeforeWrite",
					label: "Read Before Write",
					type: "select",
					required: false,
					defaultValue: "false",
					options: [
						{ label: "Disabled", value: "false" },
						{ label: "Enabled", value: "true" },
					],
				},
				{
					key: "commandTimeoutMs",
					label: "Command Timeout (ms)",
					type: "number",
					required: false,
					defaultValue: "30000",
					min: 1000,
				},
			],
			outputFields: [
				{ field: "workspaceRef", description: "Workspace reference ID" },
				{ field: "executionId", description: "Workflow execution ID" },
				{ field: "rootPath", description: "Workspace root path" },
				{ field: "backend", description: "Workspace backend (k8s/local)" },
			],
		},
			{
				slug: "clone",
				label: "Workspace Clone Repository",
				description:
					"Clone via internal Gitea into an execution-scoped workspace (auto-imports from GitHub when missing)",
				category: "Workspace",
				configFields: [
					{
						key: "workspaceRef",
						label: "Workspace Ref",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					required: true,
					},
					{
						key: "repositoryUrl",
						label: "Repository URL (optional)",
						type: "template-input",
						placeholder:
							"https://gitea.cnoe.localtest.me:8443/giteaAdmin/repo.git",
						required: false,
					},
					{
						key: "repositoryOwner",
						label: "GitHub Owner",
						type: "dynamic-select",
						required: false,
						placeholder: "Select owner",
						dynamicOptions: {
							provider: "builtin",
							pieceName: "workspace",
						actionName: "workspace/clone",
						propName: "repositoryOwner",
						refreshers: [],
					},
				},
					{
						key: "repositoryRepo",
						label: "GitHub Repository",
						type: "dynamic-select",
						required: false,
						placeholder: "Select repository",
						dynamicOptions: {
							provider: "builtin",
							pieceName: "workspace",
						actionName: "workspace/clone",
						propName: "repositoryRepo",
						refreshers: ["repositoryOwner"],
					},
				},
					{
						key: "repositoryBranch",
						label: "Branch",
						type: "dynamic-select",
						required: true,
					placeholder: "Select branch",
					dynamicOptions: {
						provider: "builtin",
						pieceName: "workspace",
						actionName: "workspace/clone",
						propName: "repositoryBranch",
							refreshers: ["repositoryOwner", "repositoryRepo"],
						},
					},
					{
						key: "repositoryUsername",
						label: "Repository Username (optional)",
						type: "template-input",
						placeholder: "giteaAdmin",
						required: false,
					},
					{
						key: "repositoryToken",
						label: "Repository Token (optional)",
						type: "template-input",
						placeholder: "{{secrets.REPO_TOKEN}}",
						required: false,
					},
					{
						key: "targetDir",
						label: "Target Directory (optional)",
						type: "template-input",
					placeholder: "repo",
					required: false,
				},
			],
			outputFields: [
				{ field: "clonePath", description: "Cloned directory path" },
				{ field: "repository", description: "Repository owner/name" },
				{ field: "branch", description: "Checked out branch" },
				{ field: "commitHash", description: "Resolved commit hash" },
				{ field: "fileCount", description: "Tracked file count" },
				{
					field: "changeSummary",
					description: "Structured file change metadata for this step",
				},
			],
		},
		{
			slug: "command",
			label: "Workspace Command",
			description: "Execute a shell command in a workspace session",
			category: "Workspace",
			configFields: [
				{
					key: "workspaceRef",
					label: "Workspace Ref",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					required: true,
				},
				{
					key: "command",
					label: "Command",
					type: "template-textarea",
					placeholder: "ls -la",
					rows: 4,
					required: true,
				},
				{
					key: "timeoutMs",
					label: "Timeout (ms)",
					type: "number",
					defaultValue: "30000",
					min: 1000,
					required: false,
				},
			],
			outputFields: [
				{ field: "stdout", description: "Command stdout" },
				{ field: "stderr", description: "Command stderr" },
				{ field: "exitCode", description: "Process exit code" },
				{ field: "success", description: "Whether command succeeded" },
				{
					field: "changeSummary",
					description: "Structured file change metadata for this step",
				},
			],
		},
		{
			slug: "file",
			label: "Workspace File Operation",
			description: "Read, write, edit, or list files in a workspace",
			category: "Workspace",
			configFields: [
				{
					key: "workspaceRef",
					label: "Workspace Ref",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					required: true,
				},
				{
					key: "operation",
					label: "Operation",
					type: "select",
					required: true,
					defaultValue: "read",
					options: [
						{ label: "Read File", value: "read" },
						{ label: "Write File", value: "write" },
						{ label: "Edit File", value: "edit" },
						{ label: "List Files", value: "list" },
					],
				},
				{
					key: "path",
					label: "Path",
					type: "template-input",
					placeholder: "src/index.ts",
					required: false,
				},
				{
					key: "content",
					label: "Content",
					type: "template-textarea",
					placeholder: "File content",
					rows: 6,
					required: false,
					showWhen: { field: "operation", equals: "write" },
				},
				{
					key: "old_string",
					label: "Find Text",
					type: "template-textarea",
					placeholder: "Text to replace",
					rows: 4,
					required: false,
					showWhen: { field: "operation", equals: "edit" },
				},
				{
					key: "new_string",
					label: "Replace With",
					type: "template-textarea",
					placeholder: "Replacement text",
					rows: 4,
					required: false,
					showWhen: { field: "operation", equals: "edit" },
				},
			],
			outputFields: [
				{ field: "content", description: "Read file content" },
				{ field: "files", description: "Directory listing" },
				{ field: "path", description: "Affected path" },
				{
					field: "changeSummary",
					description: "Structured file change metadata for this step",
				},
			],
		},
		{
			slug: "cleanup",
			label: "Workspace Cleanup",
			description:
				"Cleanup workspace session(s) by workspaceRef or executionId",
			category: "Workspace",
			configFields: [
				{
					key: "workspaceRef",
					label: "Workspace Ref (optional)",
					type: "template-input",
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					required: false,
				},
				{
					key: "executionId",
					label: "Execution ID (optional)",
					type: "template-input",
					placeholder: "{{Trigger.__execution.id}}",
					required: false,
				},
			],
			outputFields: [
				{
					field: "cleanedWorkspaceRefs",
					description: "Workspace refs that were cleaned",
				},
			],
		},
	],
};

export function getBuiltinPieces(): IntegrationDefinition[] {
	return [MCP_PIECE, WORKSPACE_PIECE, DURABLE_AGENT_PIECE];
}
