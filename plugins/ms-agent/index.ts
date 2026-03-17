import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { MsAgentIcon } from "./icon";

const msAgentPlugin: IntegrationPlugin = {
	type: "ms-agent",
	label: "Microsoft Agent Framework",
	description:
		"Structured coding workflows backed by Microsoft Agent Framework specialists inside durable Dapr workflows",
	icon: MsAgentIcon,
	formFields: [],
	actions: [
		{
			slug: "run",
			label: "Run Microsoft Coding Workflow",
			description:
				"Run a structured coding workflow through Microsoft Agent Framework and Dapr child orchestration",
			category: "AI",
			stepFunction: "runMicrosoftAgentWorkflowStep",
			stepImportPath: "run",
			configFields: [
				{
					key: "workflowTemplateId",
					label: "Agent Profile",
					type: "select",
					required: true,
					defaultValue: "repo-review",
					options: [
						{ label: "Repository Review", value: "repo-review" },
						{ label: "Implement Task", value: "implement-task" },
						{ label: "Fix Tests", value: "fix-tests" },
						{ label: "Explain Code", value: "explain-code" },
						{ label: "Custom Coding Workflow", value: "custom-coding-workflow" },
						{ label: "Legacy Code Review", value: "code-review" },
					],
				},
				{
					key: "prompt",
					label: "Goal",
					type: "template-textarea",
					placeholder: "Describe the coding task or repository question.",
					required: true,
					rows: 5,
				},
				{
					key: "reviewFocusAreas",
					label: "Review Focus Areas",
					type: "template-input",
					required: false,
					placeholder: "security, performance, bugs",
				},
				{
					key: "workspaceRef",
					label: "Workspace Ref (optional)",
					type: "template-input",
					required: false,
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
				},
				{
					key: "cwd",
					label: "Repository Root (optional)",
					type: "template-input",
					required: false,
					placeholder: "{{@nodeId:Workspace Clone.clonePath}}",
				},
				{
					key: "expectedOutput",
					label: "Expected Output",
					type: "template-textarea",
					required: false,
					rows: 4,
					placeholder: "Summarize the expected deliverable or response shape.",
				},
				{
					key: "verifyCommands",
					label: "Verify Commands",
					type: "template-textarea",
					required: false,
					rows: 4,
					placeholder: "pnpm test\npnpm type-check",
				},
				{
					key: "applyFixes",
					label: "Apply Fixes",
					type: "select",
					required: false,
					defaultValue: "false",
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
					options: [
						{ label: "Disabled", value: "false" },
						{ label: "Enabled", value: "true" },
					],
				},
				{
					key: "maxIterations",
					label: "Max Iterations",
					type: "number",
					required: false,
					defaultValue: "25",
					min: 1,
				},
				{
					key: "toolGroup",
					label: "Tool Capability Bundle",
					type: "select",
					required: false,
					defaultValue: "all",
					options: [
						{ label: "Full Coding Tools", value: "all" },
						{ label: "Read + Edit", value: "read_write" },
						{ label: "Read Only", value: "read_only" },
					],
				},
				{
					key: "instructionsOverlay",
					label: "Instructions Overlay",
					type: "template-textarea",
					required: false,
					rows: 4,
					placeholder: "Add extra specialist instructions for this run.",
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
							placeholder: "azureappconfig",
						},
						{
							key: "configKeys",
							label: "Config Keys (optional)",
							type: "template-input",
							required: false,
							placeholder: "model,instructionsOverlay,maxIterations,toolGroup",
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
					key: "model",
					label: "Model",
					type: "template-input",
					required: false,
					defaultValue: "gpt-5.4",
					placeholder: "gpt-5.4",
				},
				{
					key: "timeoutMinutes",
					label: "Timeout (minutes)",
					type: "number",
					required: false,
					defaultValue: "10",
					min: 1,
					placeholder: "10",
				},
			],
			outputFields: [
				{ field: "text", description: "Final workflow output text" },
				{
					field: "workflowTemplateId",
					description: "Agent profile used for this run",
				},
				{
					field: "steps",
					description: "Outputs from the template steps executed by the workflow",
				},
				{
					field: "reviewFindings",
					description: "Prioritized review findings for code-review runs",
				},
				{
					field: "filesAnalyzed",
					description: "Workspace files read or searched during execution",
				},
				{
					field: "fixesApplied",
					description: "Workspace files modified during execution",
				},
				{
					field: "patch",
					description: "Unified diff for edits applied by the workflow",
				},
				{
					field: "agentWorkflowId",
					description: "Child workflow instance ID",
				},
				{
					field: "daprInstanceId",
					description: "Dapr workflow instance ID for observability",
				},
			],
		},
	],
};

registerIntegration(msAgentPlugin);
