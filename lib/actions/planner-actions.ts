import type {
	IntegrationDefinition,
	IntegrationType,
} from "@/lib/actions/types";

export const PLANNER_INTEGRATION_TYPE = "planner";
export const PLANNER_CATEGORY_LABEL = "AI Planner";

const CONNECTIONLESS_INTEGRATIONS = new Set<string>([PLANNER_INTEGRATION_TYPE]);

const PLANNER_DAPR_ACTIVITY_NAMES = [
	"run_planning",
	"persist_tasks",
	"run_execution",
	"clone_repository",
	"testing",
	"sandboxed_execution_and_testing",
] as const;

export const HIDDEN_DAPR_ACTIVITY_NAMES = new Set<string>(
	PLANNER_DAPR_ACTIVITY_NAMES,
);

function toAliasKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

const plannerAliasEntries: Array<[string, string]> = [
	["planner/clone", "planner/clone"],
	["clone", "planner/clone"],
	["clone_repository", "planner/clone"],
	["clone repository", "planner/clone"],
	["dapr:clone_repository", "planner/clone"],

	["planner/run-workflow", "planner/run-workflow"],
	["planner/run_workflow", "planner/run-workflow"],
	["run-workflow", "planner/run-workflow"],
	["run_workflow", "planner/run-workflow"],
	["run planner workflow", "planner/run-workflow"],
	["run_planner_workflow", "planner/run-workflow"],

	["planner/plan", "planner/plan"],
	["planner/plan_tasks", "planner/plan"],
	["plan", "planner/plan"],
	["plan_tasks", "planner/plan"],
	["run_planning", "planner/plan"],
	["run planning agent", "planner/plan"],
	["plan tasks only", "planner/plan"],
	["dapr:run_planning", "planner/plan"],

	["planner/execute", "planner/execute"],
	["planner/execute_tasks", "planner/execute"],
	["execute", "planner/execute"],
	["execute_tasks", "planner/execute"],
	["run_execution", "planner/execute"],
	["run execution agent", "planner/execute"],
	["execute tasks only", "planner/execute"],
	["execute plan tasks only", "planner/execute"],
	["dapr:run_execution", "planner/execute"],

	["planner/multi-step", "planner/multi-step"],
	["planner/multi_step", "planner/multi-step"],
	["multi-step", "planner/multi-step"],
	["multi_step", "planner/multi-step"],
	["clone, plan & execute in sandbox", "planner/multi-step"],
	["clone plan execute in sandbox", "planner/multi-step"],

	["planner/approve", "planner/approve"],
	["approve", "planner/approve"],
	["approve_plan", "planner/approve"],
	["approve plan", "planner/approve"],

	["planner/status", "planner/status"],
	["planner/check_status", "planner/status"],
	["status", "planner/status"],
	["check_status", "planner/status"],
	["check status", "planner/status"],
	["check plan status", "planner/status"],
] as const;

const PLANNER_ACTION_ALIAS_INDEX = new Map<string, string>(
	plannerAliasEntries.map(([from, to]) => [toAliasKey(from), to]),
);

const PLANNER_ACTION_REQUIRED_INTEGRATIONS: Record<string, IntegrationType> = {
	"planner/clone": "github",
	"planner/multi-step": "github",
};

export function normalizePlannerActionType(actionType: string): string {
	if (!actionType) {
		return actionType;
	}
	return PLANNER_ACTION_ALIAS_INDEX.get(toAliasKey(actionType)) ?? actionType;
}

export function requiresConnectionForIntegration(
	integrationType: string | null | undefined,
): boolean {
	if (!integrationType) {
		return false;
	}
	return !CONNECTIONLESS_INTEGRATIONS.has(integrationType);
}

export function getRequiredConnectionForAction(
	actionType: string | null | undefined,
): IntegrationType | undefined {
	if (!actionType) {
		return undefined;
	}
	const normalized = normalizePlannerActionType(actionType);
	return PLANNER_ACTION_REQUIRED_INTEGRATIONS[normalized];
}

export const PLANNER_PIECE: IntegrationDefinition = {
	type: PLANNER_INTEGRATION_TYPE,
	label: PLANNER_CATEGORY_LABEL,
	pieceName: PLANNER_INTEGRATION_TYPE,
	logoUrl: "",
	actions: [
		{
			slug: "clone",
			label: "Clone Repository",
			description:
				"Clone a repository into a workspace for planning and execution",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "repositoryOwner",
					label: "GitHub Owner",
					type: "dynamic-select",
					placeholder: "Select owner",
					required: true,
					dynamicOptions: {
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "clone",
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
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "clone",
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
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "clone",
						propName: "repositoryBranch",
						refreshers: ["repositoryOwner", "repositoryRepo"],
					},
				},
				{
					key: "repositoryToken",
					label: "GitHub Token (override)",
					type: "template-input",
					placeholder: "Uses GitHub integration token if blank",
				},
			],
			outputFields: [
				{
					field: "success",
					description: "Whether the clone completed successfully",
				},
				{
					field: "clonePath",
					description: "Path to the cloned repository",
				},
				{ field: "commitHash", description: "HEAD commit hash" },
				{ field: "repository", description: "owner/repo string" },
				{ field: "file_count", description: "Number of files in cloned repo" },
			],
		},
		{
			slug: "run-workflow",
			label: "Run Planner Workflow",
			description: "Run full planning, approval, and execution workflow",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "featureRequest",
					label: "Feature Request",
					type: "template-textarea",
					placeholder: "Describe the feature request",
					rows: 4,
					required: true,
				},
				{
					key: "cwd",
					label: "Working Directory",
					type: "template-input",
					placeholder: "/workspace",
					defaultValue: "/workspace",
				},
				{
					key: "autoApprove",
					label: "Auto-Approve Plan",
					type: "select",
					defaultValue: "false",
					options: [
						{ value: "false", label: "No - Require approval" },
						{ value: "true", label: "Yes - Auto-approve" },
					],
				},
			],
			outputFields: [
				{
					field: "success",
					description: "Whether the workflow completed successfully",
				},
				{ field: "workflow_id", description: "Planner workflow ID" },
				{ field: "task_count", description: "Number of tasks executed" },
				{ field: "tasks", description: "Array of task objects" },
				{
					field: "requires_approval",
					description: "Whether workflow is waiting for approval",
				},
			],
		},
		{
			slug: "plan",
			label: "Plan Tasks Only",
			description: "Create tasks without executing them",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "featureRequest",
					label: "Feature Request",
					type: "template-textarea",
					placeholder: "Describe the feature to plan",
					rows: 4,
					required: true,
				},
				{
					key: "cwd",
					label: "Working Directory",
					type: "template-input",
					placeholder: "/workspace",
					defaultValue: "/workspace",
				},
				{
					key: "planningTimeoutMinutes",
					label: "Planning Timeout (minutes)",
					type: "number",
					defaultValue: "30",
				},
			],
			outputFields: [
				{ field: "success", description: "Whether planning succeeded" },
				{ field: "workflow_id", description: "Planner workflow ID" },
				{ field: "tasks", description: "Array of planned tasks" },
				{ field: "task_count", description: "Number of tasks planned" },
				{ field: "phase", description: "Current phase" },
			],
		},
		{
			slug: "execute",
			label: "Execute Tasks Only",
			description: "Execute planned tasks after approval",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "workflowId",
					label: "Planner Workflow ID",
					type: "template-input",
					placeholder: "{{Plan.workflow_id}}",
					required: true,
				},
				{
					key: "cwd",
					label: "Working Directory",
					type: "template-input",
					placeholder: "{{Clone Repository.clonePath}}",
				},
				{
					key: "executionTimeoutMinutes",
					label: "Execution Timeout (minutes)",
					type: "number",
					defaultValue: "120",
				},
			],
			outputFields: [
				{ field: "success", description: "Whether execution succeeded" },
				{ field: "workflow_id", description: "Planner workflow ID" },
				{ field: "result", description: "Execution result object" },
				{ field: "tasks", description: "Array of executed tasks" },
				{ field: "task_count", description: "Number of tasks executed" },
				{ field: "phase", description: "Current phase" },
			],
		},
		{
			slug: "multi-step",
			label: "Clone, Plan & Execute in Sandbox",
			description:
				"Run clone, planning, approval, and sandboxed execution/testing",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "featureRequest",
					label: "Feature Request",
					type: "template-textarea",
					placeholder: "Describe the feature to implement",
					rows: 4,
					required: true,
				},
				{
					key: "repositoryOwner",
					label: "GitHub Owner",
					type: "dynamic-select",
					placeholder: "Select owner",
					dynamicOptions: {
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "multi-step",
						propName: "repositoryOwner",
						refreshers: [],
					},
				},
				{
					key: "repositoryRepo",
					label: "Repository Name",
					type: "dynamic-select",
					placeholder: "Select repository",
					dynamicOptions: {
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "multi-step",
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
						provider: "planner",
						pieceName: PLANNER_INTEGRATION_TYPE,
						actionName: "multi-step",
						propName: "repositoryBranch",
						refreshers: ["repositoryOwner", "repositoryRepo"],
					},
				},
				{
					key: "repositoryToken",
					label: "GitHub Token",
					type: "template-input",
					placeholder: "Optional token for private repos",
				},
				{
					key: "model",
					label: "Model",
					type: "template-input",
					defaultValue: "gpt-5.2-codex",
				},
				{
					key: "maxTurns",
					label: "Max Agent Turns",
					type: "number",
					defaultValue: "20",
				},
				{
					key: "maxTestRetries",
					label: "Max Test Retries",
					type: "number",
					defaultValue: "3",
				},
				{
					key: "autoApprove",
					label: "Auto-Approve Plan",
					type: "select",
					defaultValue: "false",
					options: [
						{ value: "false", label: "No - Require approval" },
						{ value: "true", label: "Yes - Auto-approve" },
					],
				},
			],
			outputFields: [
				{
					field: "success",
					description: "Whether the workflow completed successfully",
				},
				{ field: "workflow_id", description: "Planner workflow ID" },
				{ field: "tasks", description: "Array of planned/executed tasks" },
				{ field: "taskCount", description: "Number of tasks" },
				{ field: "output", description: "Combined workflow output" },
				{ field: "phase", description: "Final phase" },
			],
		},
		{
			slug: "approve",
			label: "Approve Plan",
			description: "Approve or reject a planner workflow",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "workflowId",
					label: "Planner Workflow ID",
					type: "template-input",
					placeholder: "{{Plan.workflow_id}}",
					required: true,
				},
				{
					key: "approved",
					label: "Approved",
					type: "select",
					defaultValue: "true",
					options: [
						{ value: "true", label: "Approve" },
						{ value: "false", label: "Reject" },
					],
				},
				{
					key: "reason",
					label: "Reason",
					type: "template-input",
					placeholder: "Optional reason for approval/rejection",
				},
			],
			outputFields: [
				{
					field: "success",
					description: "Whether the approval action succeeded",
				},
				{ field: "approved", description: "Whether the plan was approved" },
				{ field: "workflow_id", description: "Planner workflow ID" },
			],
		},
		{
			slug: "status",
			label: "Check Plan Status",
			description: "Get the current status of a planner workflow",
			category: PLANNER_CATEGORY_LABEL,
			configFields: [
				{
					key: "workflowId",
					label: "Planner Workflow ID",
					type: "template-input",
					placeholder: "{{Plan.workflow_id}}",
					required: true,
				},
			],
			outputFields: [
				{ field: "success", description: "Whether status check succeeded" },
				{ field: "workflow_id", description: "Planner workflow ID" },
				{ field: "runtime_status", description: "Dapr workflow status" },
				{ field: "phase", description: "Current workflow phase" },
				{ field: "progress", description: "Progress percentage" },
				{ field: "message", description: "Status message" },
			],
		},
	],
};

export function withPlannerPiece(
	pieces: IntegrationDefinition[],
): IntegrationDefinition[] {
	if (pieces.some((piece) => piece.type === PLANNER_INTEGRATION_TYPE)) {
		return pieces;
	}
	return [PLANNER_PIECE, ...pieces];
}
