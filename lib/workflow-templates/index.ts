import {
	buildCodingWorkflow,
	type CodingWorkflowBackend,
	type WorkflowTemplate,
} from "./coding-workflow";
import { buildOpenShellSessionWorkflow } from "./openshell-session-workflow";

export type TemplateInfo = {
	id: string;
	name: string;
	description: string;
	category: string;
	nodeCount: number;
	tags: string[];
	build: () => WorkflowTemplate;
};

export const workflowTemplates: TemplateInfo[] = [
	{
		id: "async-coding-deepagent",
		name: "Async Coding (OpenShell LangGraph)",
		description:
			"7-node coding workflow: OpenShell workspace provisioning, LangGraph plan/execute, review, and browser validation on the supported OpenShell runtime.",
		category: "AI Coding",
		nodeCount: 7,
		tags: ["coding", "agent", "sandbox", "browser-validation"],
		build: () => buildCodingWorkflow({ backend: "openshell-langgraph" }),
	},
	{
		id: "openshell-claude-session",
		name: "OpenShell Claude Session",
		description:
			"4-node launch workflow: trigger, workspace session, repo clone, and a persistent Claude session seeded inside an OpenShell sandbox for handoff.",
		category: "Agent",
		nodeCount: 4,
		tags: ["openshell", "claude", "sandbox", "handoff"],
		build: () => buildOpenShellSessionWorkflow(),
	},
];

export function getTemplate(id: string): TemplateInfo | undefined {
	return workflowTemplates.find((t) => t.id === id);
}

export {
	buildCodingWorkflow,
	type CodingWorkflowBackend,
	type WorkflowTemplate,
};
