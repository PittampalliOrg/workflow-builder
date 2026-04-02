/**
 * Function Catalog: Maps Dapr service action types to CNCF Serverless Workflow 1.0
 * `use.functions` definitions.
 *
 * Each function definition describes how to invoke a Dapr service via the sidecar's
 * service invocation API (localhost:3500). The `call` task references these by name.
 *
 * The function-router service dispatches actions by actionType pattern to backend services:
 *   - system/*       -> fn-system
 *   - workspace/*    -> openshell-agent-runtime
 *   - browser/*      -> openshell-agent-runtime
 *   - openshell/*    -> openshell-agent-runtime
 *   - openshell-langgraph*  -> openshell-langgraph-observable
 *   - durable/*      -> durable-agent
 *   - mcp/*          -> workflow-orchestrator
 *   - dapr-swe/*     -> dapr-swe
 *   - * (default)    -> fn-activepieces
 */

import type { FunctionDefinition } from "./types";

// ---------------------------------------------------------------------------
// Dapr sidecar base URL
// ---------------------------------------------------------------------------

const DAPR_SIDECAR = "http://localhost:3500";

function daprInvokeUrl(appId: string, method: string): string {
	return `${DAPR_SIDECAR}/v1.0/invoke/${appId}/method/${method}`;
}

// ---------------------------------------------------------------------------
// Function definitions by category
// ---------------------------------------------------------------------------

export interface CatalogFunctionAuthoringDetails {
	whenToUse: string;
	avoidWhen: string;
	requiredInputs: string[];
	outputs: string[];
	examplePayload?: Record<string, unknown>;
	longRunning?: boolean;
	idempotent?: boolean;
}

export interface CatalogFunction {
	/** SW 1.0 function name (used in `call: <name>`) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for UI/LLM context */
	description: string;
	/** Category for grouping in UI */
	category: string;
	/** The SW 1.0 function definition */
	definition: FunctionDefinition;
	/** Whether this action runs as a long-running child workflow */
	isChildWorkflow?: boolean;
	/** Rich metadata for authoring prompts and generation tools */
	authoring?: CatalogFunctionAuthoringDetails;
}

// -- Workspace actions (routed to openshell-agent-runtime) ---

const workspaceActions: CatalogFunction[] = [
	{
		name: "workspaceProfile",
		label: "Workspace Profile",
		description: "Create or resolve an execution-scoped workspace profile",
		category: "Workspace",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "workspace/profile"),
				},
			},
		},
	},
	{
		name: "workspaceClone",
		label: "Clone Repository",
		description: "Clone a repository into the execution workspace",
		category: "Workspace",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "workspace/clone"),
				},
			},
		},
	},
	{
		name: "workspaceCommand",
		label: "Run Command",
		description: "Execute a shell command in the workspace",
		category: "Workspace",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "workspace/command"),
				},
			},
		},
	},
	{
		name: "workspaceFile",
		label: "File Operation",
		description: "Read, write, or edit files in the workspace",
		category: "Workspace",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "workspace/file"),
				},
			},
		},
	},
	{
		name: "workspaceCreatePR",
		label: "Create Pull Request",
		description: "Create a pull request in the repository",
		category: "Workspace",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl(
						"openshell-agent-runtime",
						"workspace/create-pull-request",
					),
				},
			},
		},
	},
	{
		name: "workspaceCleanup",
		label: "Cleanup Workspace",
		description: "Cleanup the workspace session",
		category: "Workspace",
		authoring: {
			whenToUse:
				"Use after repo or browser work is complete and you want to release workspace resources.",
			avoidWhen:
				"Do not use before follow-up steps still need the workspace or sandbox.",
			requiredInputs: ["workspaceRef or sandbox identifier"],
			outputs: ["cleanup status"],
			examplePayload: { workspaceRef: "${ .sandbox.workspaceRef }" },
			idempotent: true,
			longRunning: false,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "workspace/cleanup"),
				},
			},
		},
	},
];

// -- Browser actions (routed to openshell-agent-runtime) ---

const browserActions: CatalogFunction[] = [
	{
		name: "browserProfile",
		label: "Browser Profile",
		description: "Create an OpenShell-backed browser validation workspace",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/profile"),
				},
			},
		},
	},
	{
		name: "browserClone",
		label: "Browser Clone",
		description: "Clone repository into browser workspace",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/clone"),
				},
			},
		},
	},
	{
		name: "browserCommand",
		label: "Browser Command",
		description: "Execute shell command in browser workspace",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/command"),
				},
			},
		},
	},
	{
		name: "browserValidate",
		label: "Browser Validate",
		description: "Validate changes in browser workspace",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/validate"),
				},
			},
		},
	},
	{
		name: "browserCaptureFlow",
		label: "Capture Browser Flow",
		description: "Capture browser interactions",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/capture-flow"),
				},
			},
		},
	},
	{
		name: "browserCleanup",
		label: "Browser Cleanup",
		description: "Cleanup browser workspace",
		category: "Browser",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "browser/cleanup"),
				},
			},
		},
	},
];

// -- Agent actions (long-running child workflows) ---

const agentActions: CatalogFunction[] = [
	{
		name: "openshellRun",
		label: "OpenShell Agent",
		description: "Run an OpenShell coding agent (plan mode)",
		category: "Agent",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("openshell-agent-runtime", "openshell/run"),
				},
			},
		},
	},
	{
		name: "openshellSessionStart",
		label: "OpenShell Session",
		description: "Start an OpenShell interactive session",
		category: "Agent",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl(
						"openshell-agent-runtime",
						"openshell/session-start",
					),
				},
			},
		},
	},
	{
		name: "langgraphRun",
		label: "LangGraph Agent",
		description: "Run a LangGraph observable agent",
		category: "Agent",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl(
						"openshell-langgraph-observable",
						"openshell-langgraph-observable/run",
					),
				},
			},
		},
	},
	{
		name: "durableRun",
		label: "Durable Agent",
		description: "Run a durable LLM agent with tool-calling",
		category: "Agent",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("durable-agent", "durable/run") },
			},
		},
	},
	{
		name: "durableClaudePlan",
		label: "Claude Plan",
		description: "Generate a Claude execution plan",
		category: "Agent",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("durable-agent", "durable/claude-plan"),
				},
			},
		},
	},
	{
		name: "durableMaterializePlan",
		label: "Materialize Plan",
		description: "Write plan artifacts to workspace",
		category: "Agent",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("durable-agent", "durable/materialize-plan"),
				},
			},
		},
	},
	{
		name: "durableExecutePlanDag",
		label: "Execute Plan DAG",
		description: "Execute a plan DAG structure",
		category: "Agent",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("durable-agent", "durable/execute-plan-dag"),
				},
			},
		},
	},
	{
		name: "daprSweInitialize",
		label: "Initialize Sandbox",
		description:
			"Create OpenShell sandbox, clone repository, configure git identity",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use first for GitHub issue resolution workflows that need a coding sandbox and repository context.",
			avoidWhen:
				"Do not use for workflows that only transform existing data or emit an event.",
			requiredInputs: ["owner", "repo", "issue_number"],
			outputs: ["sandbox_id", "working_dir", "agents_md", "github_token"],
			examplePayload: {
				owner: "PittampalliOrg",
				repo: "open-swe",
				issue_number: 1,
			},
			idempotent: false,
			longRunning: true,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/initialize") },
			},
		},
	},
	{
		name: "daprSwePlan",
		label: "Create Plan",
		description:
			"Run PlannerAgent to analyze codebase and produce structured implementation plan with steps",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use after initialize when the workflow needs a structured implementation plan for a coding task.",
			avoidWhen:
				"Do not use for trivial single-step automations that can go straight to implementation.",
			requiredInputs: [
				"sandbox_id",
				"working_dir",
				"agents_md",
				"github_token",
				"issue context",
			],
			outputs: ["plan", "summary", "step_count"],
			examplePayload: {
				sandbox_id: "${ .initialize.sandbox_id }",
				title: "${ .input.title }",
			},
			idempotent: false,
			longRunning: true,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/plan") },
			},
		},
	},
	{
		name: "daprSweDevelop",
		label: "Implement Step",
		description:
			"Run DeveloperAgent to implement a plan step with tool calls (read, write, execute)",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use to execute one implementation step or apply review feedback inside an existing dapr-swe session.",
			avoidWhen:
				"Do not use before initialize, and avoid many nested develop loops unless the user explicitly asks for multi-agent behavior.",
			requiredInputs: [
				"sandbox_id",
				"working_dir",
				"provider-specific repository credentials",
				"plan or step context",
			],
			outputs: ["status", "files_changed", "summary"],
			examplePayload: {
				sandbox_id: "${ .initialize.sandbox_id }",
				plan: "${ .createPlan.plan }",
			},
			idempotent: false,
			longRunning: true,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/develop") },
			},
		},
	},
	{
		name: "daprSweReview",
		label: "Review Changes",
		description:
			"Run ReviewerAgent to analyze git diff and provide approval/feedback",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use after implementation when the workflow needs an approval signal or review feedback before creating a PR.",
			avoidWhen: "Do not use before any code changes have been made.",
			requiredInputs: ["sandbox_id", "working_dir", "plan or change context"],
			outputs: ["approved", "status", "feedback", "suggestions"],
			examplePayload: {
				sandbox_id: "${ .initialize.sandbox_id }",
				working_dir: "${ .initialize.working_dir }",
			},
			idempotent: true,
			longRunning: true,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/review") },
			},
		},
	},
	{
		name: "daprSweCommitPR",
		label: "Commit & Open PR",
		description:
			"Stage changes, create a branch, push it, and open a draft pull request through the active SCM provider",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use only when the workflow is expected to create a branch and pull request after changes are approved, typically behind a switch or other explicit review gate.",
			avoidWhen:
				"Do not use if the user explicitly does not want a PR or if the workflow never changes code.",
			requiredInputs: [
				"sandbox_id",
				"working_dir",
				"provider-specific repository credentials",
				"owner",
				"repo",
				"issue_number",
			],
			outputs: ["branch", "pr_url", "status"],
			examplePayload: {
				sandbox_id: "${ .initialize.sandbox_id }",
				issue_number: "${ .input.issue_number }",
			},
			idempotent: false,
			longRunning: true,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/commit-pr") },
			},
		},
	},
	{
		name: "daprSweNotify",
		label: "Notify Issue",
		description:
			"Post a result-specific completion comment back to the issue tracker through the active SCM provider",
		category: "Dapr SWE",
		authoring: {
			whenToUse:
				"Use after a no-op, review rejection, or successful PR creation so the issue thread receives one final outcome comment.",
			avoidWhen:
				"Do not use for intermediate progress updates or before the workflow has reached a terminal outcome.",
			requiredInputs: [
				"provider-specific repository credentials",
				"owner",
				"repo",
				"issue_number",
				"status",
			],
			outputs: ["status", "pr_url", "notified"],
			examplePayload: {
				owner: "${ .input.owner }",
				repo: "${ .input.repo }",
				issue_number: "${ .input.issue_number }",
				status: "no_changes",
			},
			idempotent: false,
			longRunning: false,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/notify") },
			},
		},
	},
	{
		name: "daprSweSolve",
		label: "Solve Issue (Full Agent)",
		description:
			"Run the full CodingAgent end-to-end: explore, plan, implement, test, commit, PR",
		category: "Dapr SWE",
		isChildWorkflow: true,
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("dapr-swe", "dapr-swe/solve") },
			},
		},
	},
];

// -- System actions ---

const systemActions: CatalogFunction[] = [
	{
		name: "httpRequest",
		label: "HTTP Request",
		description: "Make an HTTP request to any API endpoint",
		category: "System",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("fn-system", "system/http-request") },
			},
		},
	},
	{
		name: "databaseQuery",
		label: "Database Query",
		description: "Execute a SQL query",
		category: "System",
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: { uri: daprInvokeUrl("fn-system", "system/database-query") },
			},
		},
	},
];

// -- MCP actions ---

const mcpActions: CatalogFunction[] = [
	{
		name: "mcpReplyToClient",
		label: "MCP Reply",
		description: "Reply to an MCP client with a response",
		category: "MCP",
		authoring: {
			whenToUse:
				"Use only in workflows exposed as MCP tools that must return a final response to the caller.",
			avoidWhen:
				"Do not use in background issue-resolution workflows unless the workflow started from an MCP trigger.",
			requiredInputs: ["runId", "response payload"],
			outputs: ["reply status", "runId"],
			examplePayload: {
				runId: "${ .input.runId }",
				content: { success: true },
			},
			idempotent: false,
			longRunning: false,
		},
		definition: {
			call: "http",
			with: {
				method: "POST",
				endpoint: {
					uri: daprInvokeUrl("workflow-orchestrator", "mcp/reply-to-client"),
				},
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Full catalog
// ---------------------------------------------------------------------------

export const FUNCTION_CATALOG: CatalogFunction[] = [
	...workspaceActions,
	...browserActions,
	...agentActions,
	...systemActions,
	...mcpActions,
];

/** Build SW 1.0 `use.functions` record from the catalog */
export function buildUseFunctions(
	functionNames?: string[],
): Record<string, FunctionDefinition> {
	const functions: Record<string, FunctionDefinition> = {};
	const items = functionNames
		? FUNCTION_CATALOG.filter((f) => functionNames.includes(f.name))
		: FUNCTION_CATALOG;
	for (const fn of items) {
		functions[fn.name] = fn.definition;
	}
	return functions;
}

/** Look up a catalog function by name */
export function getCatalogFunction(name: string): CatalogFunction | undefined {
	return FUNCTION_CATALOG.find((f) => f.name === name);
}

/** Get catalog functions grouped by category */
export function getCatalogByCategory(): Record<string, CatalogFunction[]> {
	const result: Record<string, CatalogFunction[]> = {};
	for (const fn of FUNCTION_CATALOG) {
		const list = result[fn.category] || [];
		list.push(fn);
		result[fn.category] = list;
	}
	return result;
}

export function getCatalogFunctionAuthoringDetails(
	fn: CatalogFunction,
): Required<CatalogFunctionAuthoringDetails> {
	return {
		whenToUse:
			fn.authoring?.whenToUse ??
			`Use ${fn.name} when the workflow needs ${fn.description.toLowerCase()}.`,
		avoidWhen:
			fn.authoring?.avoidWhen ??
			"Avoid this function if the workflow can complete without calling the external service behind it.",
		requiredInputs: fn.authoring?.requiredInputs ?? [],
		outputs: fn.authoring?.outputs ?? [],
		examplePayload: fn.authoring?.examplePayload ?? {},
		longRunning: fn.authoring?.longRunning ?? Boolean(fn.isChildWorkflow),
		idempotent: fn.authoring?.idempotent ?? false,
	};
}
