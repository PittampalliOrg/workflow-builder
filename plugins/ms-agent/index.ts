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
				"Run the Python travel-planner workflow through Dapr child workflow orchestration",
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
					key: "model",
					label: "Model",
					type: "text",
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
				{ field: "text", description: "Final itinerary text" },
				{
					field: "workflowTemplateId",
					description: "Workflow template used for this run",
				},
				{
					field: "steps",
					description: "Outputs from the extractor, planner, and expander agents",
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
