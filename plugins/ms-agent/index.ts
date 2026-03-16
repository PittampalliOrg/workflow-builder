import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { MsAgentIcon } from "./icon";

const msAgentPlugin: IntegrationPlugin = {
	type: "ms-agent",
	label: "Microsoft Agent Workflow",
	description:
		"Sequential Dapr workflow backed by dapr-agents activities and Microsoft Agent Framework agents",
	icon: MsAgentIcon,
	formFields: [],
	actions: [
		{
			slug: "run",
			label: "Run Microsoft Agent Workflow",
			description:
				"Run the Python Microsoft Agent workflow through Dapr child workflow orchestration",
			category: "AI",
			stepFunction: "runMicrosoftAgentWorkflowStep",
			stepImportPath: "run",
			configFields: [
				{
					key: "workflowTemplateId",
					label: "Workflow Template",
					type: "select",
					required: true,
					defaultValue: "travel-planner",
					options: [
						{
							label: "Travel Planner",
							value: "travel-planner",
						},
						{
							label: "Code Review",
							value: "code-review",
						},
					],
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder: "Plan a trip to Paris with a focus on museums and food.",
					required: true,
					rows: 5,
				},
				{
					key: "reviewFocusAreas",
					label: "Review Focus Areas",
					type: "template-input",
					required: false,
					placeholder: "security, performance, bugs",
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
				},
				{
					key: "workspaceRef",
					label: "Workspace Ref (optional)",
					type: "template-input",
					required: false,
					placeholder: "{{@nodeId:Workspace Profile.workspaceRef}}",
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
				},
				{
					key: "cwd",
					label: "Repository Root (optional)",
					type: "template-input",
					required: false,
					placeholder: "{{@nodeId:Workspace Clone.clonePath}}",
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
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
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
				},
				{
					key: "instructionsOverlay",
					label: "Instructions Overlay",
					type: "template-textarea",
					required: false,
					rows: 4,
					placeholder: "Add extra review or fix-up instructions for this run.",
					showWhen: { field: "workflowTemplateId", equals: "code-review" },
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
					defaultValue: "gpt-5.2",
					placeholder: "gpt-5.2",
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
					description: "Workflow template used for this run",
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
