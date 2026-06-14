/**
 * Seed canonical workflows after cluster/database recreation.
 *
 * Current scope:
 * - Upsert workflow lazxidq045szbb9ke4dny (Opencode Agent Plan Then Execute PR)
 * - Upsert workflow aicodingagent001 (AI Coding Agent)
 * - Upsert workflow three-b-one-b-skill-animation (3Blue1Brown-style Animation)
 * - Upsert workflow three-b-one-b-skill-animation-cli (3Blue1Brown CLI agents)
 * - Upsert GitHub sandbox clone proof workflow
 * - Reconcile workflow_resource_refs for canonical OpenShell plan/execute nodes
 *
 * User/project targeting:
 * - Prefer SEED_WORKFLOW_USER_ID
 * - Fallback to SEED_WORKFLOW_USER_EMAIL
 * - Fallback to SEED_GITHUB_USER_ID / SEED_GITHUB_USER_EMAIL
 * - Fallback to single GitHub identity in DB
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	agentProfileTemplateVersions,
	appConnections,
	projectMembers,
	projects,
	userIdentities,
	users,
	workflowResourceRefs,
	workflows,
} from "../lib/db/schema";
import { generateId } from "../lib/utils/id";
import { resolveCanonicalWorkflowSpec } from "../lib/workflow-contract";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

const WORKFLOW_ID = "lazxidq045szbb9ke4dny";
const WORKFLOW_NAME = "Opencode Agent Plan Then Execute PR";
const WORKFLOW_DESCRIPTION =
	"Multi-step opencode flow: planning, execution, change verification, then commit/push/PR";
const AI_CODING_AGENT_WORKFLOW_ID = "aicodingagent001";
const AI_CODING_AGENT_WORKFLOW_NAME = "AI Coding Agent";
const AI_CODING_AGENT_WORKFLOW_DESCRIPTION =
	"System workflow for ai/main coding sessions. Clones the selected repository into a sandbox, creates an OpenShell coding plan, waits for approval, and then executes the approved plan in the same run.";
const OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID =
	"2mjd2mrptkf8zaxembsbp";
const OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_NAME =
	"OpenShell Feature Delivery";
const OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_DESCRIPTION =
	"Reusable OpenShell plan-first coding workflow for user-supplied feature requests.";
const OPENSHELL_LANGGRAPH_BROWSER_VALIDATION_REPOSITORY_URL =
	"https://github.com/PittampalliOrg/next-learn.git";
const GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_ID = "ghsbxcloneproof001";
const GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_NAME = "GitHub Sandbox Clone Proof";
const GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_DESCRIPTION =
	"Reference workflow that clones PittampalliOrg/workflow-builder into a Kubernetes sandbox and prints a directory tree.";
const GITHUB_SANDBOX_REVIEW_WORKFLOW_ID = "ghsbxreviewproof001";
const GITHUB_SANDBOX_REVIEW_WORKFLOW_NAME = "GitHub Sandbox Project Review";
const GITHUB_SANDBOX_REVIEW_WORKFLOW_DESCRIPTION =
	"Reference workflow that clones PittampalliOrg/workflow-builder into a Kubernetes sandbox, prints a directory tree, and asks the OpenShell coding agent to review and summarize the project.";
const AGENT_SYSTEM_DEMO_WORKFLOW_ID = "agentsysdemo001";
const AGENT_SYSTEM_DEMO_WORKFLOW_NAME = "OpenShell Feature Delivery Demo";
const AGENT_SYSTEM_DEMO_WORKFLOW_DESCRIPTION =
	"Demo workflow for the Workflow Builder UI that clones PittampalliOrg/stacks and runs an OpenShell-backed plan, approval, and implementation loop that emits code artifacts.";
const THREE_B_ONE_B_WORKFLOW_ID = "three-b-one-b-skill-animation";
const THREE_B_ONE_B_WORKFLOW_NAME = "3Blue1Brown-style Animation";
const THREE_B_ONE_B_WORKFLOW_DESCRIPTION =
	"Generate a self-contained browser animation in the 3Blue1Brown style (Canvas/SVG, no Manim) inside a retained per-run sandbox, then capture screenshots of the play/restart interaction via browser/validate.";
const THREE_B_ONE_B_CLI_WORKFLOW_ID =
	process.env.SEED_3B1B_CLI_WORKFLOW_ID?.trim() ||
	"three-b-one-b-skill-animation-cli";
const THREE_B_ONE_B_CLI_WORKFLOW_NAME =
	process.env.SEED_3B1B_CLI_WORKFLOW_NAME?.trim() ||
	"3Blue1Brown-style Animation (CLI agents)";
const THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION =
	process.env.SEED_3B1B_CLI_WORKFLOW_DESCRIPTION?.trim() ||
	"Generate a self-contained browser animation in the 3Blue1Brown style using a runtime-selected CLI agent, then verify, capture, and preview the copied app files from the retained workspace.";
const THREE_B_ONE_B_APP_DIR = "/sandbox/3b1b-style-animation-example";
const THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME =
	'${ .workspace_profile.sandboxName // "" }';
const THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF =
	"${ .workspace_profile.workspaceRef }";
const THREE_B_ONE_B_DEFAULT_AGENT_ID =
	process.env.SEED_3B1B_AGENT_ID?.trim() || "agnt_claude_code_sdk_smoke";
const THREE_B_ONE_B_DEFAULT_AGENT_VERSION = Number(
	process.env.SEED_3B1B_AGENT_VERSION?.trim() || "1",
);
const AGENT_PROFILE_TEMPLATE_ID = "tpl_coding_agent";
const PLANNER_MAX_TURNS = 120;
const PLANNER_TIMEOUT_MINUTES = 45;
const EXECUTOR_MAX_TURNS = 260;
const EXECUTOR_TIMEOUT_MINUTES = 120;

const IDs = {
	trigger: "tr_1771706813719",
	profile: "pf_1771706813719",
	clone: "cl_1771706813719",
	branch: "br_1771706813719",
	plan: "pl_1771706813719",
	execute: "ex_1771706813719",
	verifyChanges: "vr_1771706813719",
	commitPushPr: "cp_1771706813719",
	cleanup: "cu_1771706813719",
};

const EDGE_IDS = [
	"e1_1771706813719",
	"e2_1771706813719",
	"e3_1771706813719",
	"e4_1771706813719",
	"e5_1771706813719",
	"e6_1771706813719",
	"e7_1771706813719",
	"e8_1771706813719",
];

const PLANNER_INSTRUCTIONS =
	"You are a planning agent. Inspect repository context with read-only actions and produce an execution-ready plan only. Do not modify files, do not run mutating commands, and do not claim edits were made. Return concise, ordered steps that can be executed directly.";

const EXECUTOR_INSTRUCTIONS =
	"You are an autonomous coding agent operating on a real git workspace. Inspect relevant files before changing code, then make concrete file edits instead of returning only a plan. When code changes are requested, run targeted validation commands and iterate until failures are addressed. Prefer direct replacement of stale legacy code when a better implementation is required. Before finishing, confirm git diff is non-empty and report changed files, validation commands, and any remaining risks.";

const OPENSHELL_FEATURE_IDS = {
	trigger: "pyfRyGXMGC4XjyAsuUqHP",
	profile: "bsvzX1JV4drJaHWrqJ0X6",
	clone: "kd2jQ1LXuPulwa6DYrYcS",
	plan: "UQTpn3KVZ_6Zv7uzA6ril",
	execute: "084qYyW7OIG9R6ro3v2kR",
	review: "0uS-4imBYrFvz81G63Lq5",
	browserProfile: "z5fbA93GEu6nWZDbtS3da",
	browserClone: "udqANW2lP7cL93Kk6qhTf",
	browserMaterialize: "mspYoB2o7FhDb1n9kXjLp",
	browserInstall: "i4yQm3GpR8sLd6Nx1eVcw",
	browserServer: "s8uRt4KdP2nVm6Xa0bQje",
	browserCapture: "c1vUy5LgT9qZn3Hr4pWms",
} as const;

const OPENSHELL_FEATURE_EDGE_IDS = [
	"fivLJSWp--wp9jk60o3Zv",
	"D-6Bw2hYnFuiv_iFPLnTJ",
	"1scYFdFp6dscbGiMlWI7g",
	"qa4XLL54R6_eKdss58ZRF",
	"YpUGC9sdpzb2dcLzJQQ5f",
	"Br7NMXDbWg4xT1y2zQ3Cp",
	"Rk4JHzdPq9mLs2vNc8Twf",
	"Vx3QbLmRk8sNf1yHp6Dca",
	"Nq7PwXeLr2tVm5hJc9Bsd",
	"Hm5QsTnXv4cLp8rZd1Wkb",
	"Jt8LyPnQr3vHb6xMs2Cde",
] as const;

async function resolveGithubUserId(db: ReturnType<typeof drizzle>) {
	const configuredUserId =
		process.env.SEED_WORKFLOW_USER_ID?.trim() ||
		process.env.SEED_GITHUB_USER_ID?.trim();
	const configuredEmail =
		process.env.SEED_WORKFLOW_USER_EMAIL?.trim() ||
		process.env.SEED_GITHUB_USER_EMAIL?.trim();

	if (configuredUserId) {
		const identity = await db.query.userIdentities.findFirst({
			where: and(
				eq(userIdentities.userId, configuredUserId),
				eq(userIdentities.provider, "GITHUB"),
			),
		});
		if (!identity) {
			throw new Error(
				`SEED_GITHUB_USER_ID (${configuredUserId}) does not map to a GITHUB identity.`,
			);
		}
		return configuredUserId;
	}

	if (configuredEmail) {
		const matches = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, configuredEmail))
			.limit(2);

		if (matches.length === 0) {
			throw new Error(
				`SEED_GITHUB_USER_EMAIL (${configuredEmail}) does not match a user.`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`SEED_GITHUB_USER_EMAIL (${configuredEmail}) is ambiguous. Set SEED_GITHUB_USER_ID.`,
			);
		}

		const resolvedUserId = matches[0].id;
		const identity = await db.query.userIdentities.findFirst({
			where: and(
				eq(userIdentities.userId, resolvedUserId),
				eq(userIdentities.provider, "GITHUB"),
			),
		});
		if (!identity) {
			throw new Error(
				`User resolved from SEED_GITHUB_USER_EMAIL (${configuredEmail}) has no GITHUB identity.`,
			);
		}
		return resolvedUserId;
	}

	const githubUsers = await db
		.select({ userId: userIdentities.userId })
		.from(userIdentities)
		.where(eq(userIdentities.provider, "GITHUB"))
		.limit(2);

	if (githubUsers.length === 0) {
		throw new Error(
			"No GITHUB users found. Set SEED_GITHUB_USER_ID/SEED_GITHUB_USER_EMAIL or sign in with GitHub first.",
		);
	}
	if (githubUsers.length > 1) {
		throw new Error(
			"Multiple GITHUB users found. Set SEED_GITHUB_USER_ID (preferred) or SEED_GITHUB_USER_EMAIL.",
		);
	}
	return githubUsers[0].userId;
}

async function resolveProjectId(
	db: ReturnType<typeof drizzle>,
	userId: string,
) {
	const configuredProjectId = process.env.SEED_WORKFLOW_PROJECT_ID?.trim();
	if (configuredProjectId) {
		const explicitProject = await db.query.projects.findFirst({
			where: eq(projects.id, configuredProjectId),
		});
		if (!explicitProject) {
			throw new Error(
				`SEED_WORKFLOW_PROJECT_ID (${configuredProjectId}) does not match a project.`,
			);
		}
		const membership = await db.query.projectMembers.findFirst({
			where: and(
				eq(projectMembers.projectId, configuredProjectId),
				eq(projectMembers.userId, userId),
			),
		});
		if (explicitProject.ownerId !== userId && !membership) {
			throw new Error(
				`SEED_WORKFLOW_PROJECT_ID (${configuredProjectId}) is not owned by or shared with user ${userId}.`,
			);
		}
		return explicitProject.id;
	}

	const canonicalExternalId = `project-${userId}`;
	const canonicalProject = await db.query.projects.findFirst({
		where: eq(projects.externalId, canonicalExternalId),
	});
	if (canonicalProject) return canonicalProject.id;

	const ownedProject = await db.query.projects.findFirst({
		where: eq(projects.ownerId, userId),
		orderBy: [desc(projects.updatedAt)],
	});
	if (ownedProject) return ownedProject.id;

	const membership = await db.query.projectMembers.findFirst({
		where: eq(projectMembers.userId, userId),
		orderBy: [desc(projectMembers.updatedAt)],
	});
	if (membership) return membership.projectId;

	throw new Error(
		`No project found for user ${userId}. Seed user/project first via db-seed.`,
	);
}

async function resolveAgentProfileVersion(db: ReturnType<typeof drizzle>) {
	try {
		const preferred = await db.query.agentProfileTemplateVersions.findFirst({
			where: and(
				eq(agentProfileTemplateVersions.templateId, AGENT_PROFILE_TEMPLATE_ID),
				eq(agentProfileTemplateVersions.isDefault, true),
			),
			orderBy: [desc(agentProfileTemplateVersions.version)],
		});
		if (preferred) return preferred.version;

		const latest = await db.query.agentProfileTemplateVersions.findFirst({
			where: eq(
				agentProfileTemplateVersions.templateId,
				AGENT_PROFILE_TEMPLATE_ID,
			),
			orderBy: [desc(agentProfileTemplateVersions.version)],
		});
		if (!latest) {
			throw new Error(
				`No versions found for agent profile template ${AGENT_PROFILE_TEMPLATE_ID}.`,
			);
		}
		return latest.version;
	} catch (error) {
		const code = (error as { cause?: { code?: string } }).cause?.code;
		if (code === "42P01") {
			console.warn(
				`[seed-workflows] Agent profile template tables are missing; using ${AGENT_PROFILE_TEMPLATE_ID} version 1.`,
			);
			return 1;
		}
		throw error;
	}
}

async function resolveLatestGithubConnection(
	db: ReturnType<typeof drizzle>,
	userId: string,
) {
	const connections = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
		})
		.from(appConnections)
		.where(eq(appConnections.ownerId, userId))
		.orderBy(desc(appConnections.updatedAt), desc(appConnections.createdAt))
		.limit(25);

	const connection = connections.find((row) =>
		row.pieceName.toLowerCase().includes("github"),
	);
	if (!connection) {
		return undefined;
	}
	return {
		connectionId: connection.id,
		connectionExternalId: connection.externalId,
	};
}

function buildOpenShellFeatureReviewCommand() {
	return `cat <<'__WF_OPEN_SHELL_REVIEW__'
OpenShell LangGraph execution review
===================================
Sandbox name:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.sandboxName}}

Provider:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.provider}}

File changes:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.fileChanges}}

Change summary:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.changeSummary}}

Snapshot refs:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.snapshotRefs}}

Patch:
{{@${OPENSHELL_FEATURE_IDS.execute}:OpenShell LangGraph Execute.patch}}
__WF_OPEN_SHELL_REVIEW__`;
}

function buildOpenShellValidationInstallCommand() {
	// Detect lock file to pick the right package manager
	return (
		"(while true; do echo install-heartbeat; sleep 25; done &) ; cd basics/basics-final && attempt=1; until [ $attempt -gt 3 ]; do " +
		"if [ -f pnpm-lock.yaml ] || [ -f ../../pnpm-lock.yaml ]; then " +
		"corepack enable pnpm 2>/dev/null; pnpm install --no-frozen-lockfile --prefer-offline; " +
		"elif [ -f package-lock.json ]; then " +
		"npm ci --no-audit --no-fund --loglevel=warn --prefer-offline; " +
		"else " +
		"npm install --no-audit --no-fund --loglevel=warn --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 --prefer-offline; " +
		"fi && exit 0; " +
		"if [ $attempt -eq 3 ]; then exit 1; fi; echo retrying-install-attempt-$attempt; attempt=$((attempt + 1)); sleep 5; done"
	);
}

function buildOpenShellValidationDevServerCommand() {
	return 'cd basics/basics-final && mkdir -p .wf-preview && rm -f .wf-preview/dev-server.log .wf-preview/dev-server.pid && setsid sh -c "npm run dev -- --hostname 0.0.0.0 --port 3000 > .wf-preview/dev-server.log 2>&1 < /dev/null" >/dev/null 2>&1 & pid=$!; echo $pid > .wf-preview/dev-server.pid; echo waiting-for-port-3000; for i in $(seq 1 90); do if curl -sf -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then echo server-ready-on-port-3000; exit 0; fi; if ! kill -0 $pid 2>/dev/null; then echo server-exited-early; cat .wf-preview/dev-server.log; exit 1; fi; sleep 2; done; echo server-timeout-waiting-for-port; tail -30 .wf-preview/dev-server.log; exit 1';
}

function buildOpenShellValidationCaptureSteps() {
	return JSON.stringify(
		[
			{
				id: "dashboard-home",
				label: "Dashboard Home",
				path: "/",
				waitForSelector: "body",
				delayMs: 3000,
			},
		],
		null,
		2,
	);
}

function buildOpenShellLangGraphFeatureDeliveryNodes(input?: {
	connectionId?: string;
	connectionExternalId?: string;
	agentProfileVersion?: number;
}) {
	const connectionId = input?.connectionId;
	const connectionExternalId = input?.connectionExternalId;
	const agentProfileVersion = input?.agentProfileVersion ?? 2;
	const workspaceRef = `{{@${OPENSHELL_FEATURE_IDS.profile}:Workspace Profile.workspaceRef}}`;
	const clonePath = `{{@${OPENSHELL_FEATURE_IDS.clone}:Workspace Clone.clonePath}}`;
	const executionId = `{{@${OPENSHELL_FEATURE_IDS.profile}:Workspace Profile.executionId}}`;
	const browserWorkspaceRef = `{{@${OPENSHELL_FEATURE_IDS.browserProfile}:Browser Validation Workspace.workspaceRef}}`;
	const authValue = connectionExternalId
		? `{{connections['${connectionExternalId}']}}`
		: "{{connections['github']}}";
	const agentProfileRef = JSON.stringify({
		id: AGENT_PROFILE_TEMPLATE_ID,
		slug: "coding-agent",
		name: "Coding Agent",
		version: agentProfileVersion,
	});
	const agentConfig = JSON.stringify({
		name: "Coding Agent",
		instructions: EXECUTOR_INSTRUCTIONS,
		modelSpec: "gpt-5.5",
		maxTurns: 260,
		timeoutMinutes: 120,
		tools: ["glob", "grep", "read", "edit", "write", "bash"],
		requiredCapabilities: ["git", "bash"],
		preferredExecutionProfile: "node-npm",
		preferredSandboxProfile: "node-npm",
		workspaceBackend: "openshell",
	});

	return normalizeWorkflowNodes([
		{
			id: OPENSHELL_FEATURE_IDS.trigger,
			type: "trigger",
			position: { x: 12, y: 12 },
			data: {
				type: "trigger",
				label: "Manual Trigger",
				description:
					"Run this workflow and paste the feature request into the Run Workflow form.",
				config: {
					triggerType: "Manual",
					inputSchema: JSON.stringify([
						{
							name: "feature_request",
							type: "TEXT",
							required: true,
							description:
								"Describe the feature, bug fix, or implementation task for this run.",
						},
					]),
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.profile,
			type: "action",
			position: { x: 12, y: 224 },
			data: {
				type: "action",
				label: "Workspace Profile",
				description: "Create an execution-scoped workspace session.",
				config: {
					name: "openshell-langgraph-feature-delivery",
					actionType: "workspace/profile",
					enabledTools: JSON.stringify([
						"read",
						"write",
						"edit",
						"list",
						"bash",
					]),
					commandTimeoutMs: "120000",
					requireReadBeforeWrite: "true",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.clone,
			type: "action",
			position: { x: 12, y: 436 },
			data: {
				type: "action",
				label: "Workspace Clone",
				description: "Clone the target repository into the workspace.",
				config: {
					auth: authValue,
					targetDir: "next-learn",
					actionType: "workspace/clone",
					workspaceRef,
					repositoryOwner: "PittampalliOrg",
					repositoryRepo: "next-learn",
					repositoryBranch: "main",
					...(connectionId ? { integrationId: connectionId } : {}),
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.plan,
			type: "action",
			position: { x: 12, y: 648 },
			data: {
				type: "action",
				label: "OpenShell LangGraph Plan",
				description:
					"Inspect the repository inside OpenShell, build a concrete implementation plan, and wait for approval.",
				config: {
					cwd: clonePath,
					mode: "plan_mode",
					model: "gpt-5.5",
					tools: JSON.stringify([
						"glob",
						"grep",
						"read",
						"edit",
						"write",
						"bash",
					]),
					engine: "langgraph",
					prompt:
						"You are planning a repository feature delivery task for this specific codebase.\n\nUser feature request:\n{{@trigger:Manual.feature_request}}\n\nPlanning requirements:\n- Inspect the repository first and stay read-only during this step.\n- Build a concrete implementation plan for this exact repository, not a generic solution.\n- Prefer the smallest cohesive change set that satisfies the request.\n- Identify the likely files/modules to touch, tests to add or update, validation commands to run, and any important risks or assumptions.\n- If the request is underspecified, make the minimum necessary assumptions and state them explicitly.\n\nReturn only the final implementation plan for approval.",
					profile: "feature-delivery",
					maxTurns: "24",
					actionType: "durable/run",
					toolPolicy: "all",
					agentConfig,
					shellPolicy: "workspace-safe",
					writePolicy: "workspace-only",
					workspaceRef,
					repositoryUrl: "https://github.com/PittampalliOrg/next-learn.git",
					stopCondition:
						"An implementation plan exists for the user request and is ready for review and approval.",
					expectedOutput:
						"An approved implementation plan with impacted files, validation steps, assumptions, and risks.",
					repositoryRepo: "next-learn",
					timeoutMinutes: "60",
					verifyCommands: "npm run build",
					agentProfileRef,
					repositoryOwner: "PittampalliOrg",
					sandboxRepoPath: "/sandbox/repo",
					planningThreadId: `lg:plan:${executionId}`,
					repositoryBranch: "main",
					workspaceBackend: "openshell",
					executionThreadId: `lg:exec:${executionId}`,
					instructionsOverlay: `${EXECUTOR_INSTRUCTIONS}\n\nAdditional workflow instructions:\n${EXECUTOR_INSTRUCTIONS}\n\nAdditional workflow instructions:\n${EXECUTOR_INSTRUCTIONS}`,
					executeAfterApproval: "false",
					requiredCapabilities: JSON.stringify(["git", "bash"]),
					agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
					approvalTimeoutMinutes: "1440",
					preferredSandboxProfile: "node-npm",
					preferredExecutionProfile: "node-npm",
					agentProfileTemplateVersion: String(agentProfileVersion),
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.execute,
			type: "action",
			position: { x: 12, y: 860 },
			data: {
				type: "action",
				label: "OpenShell LangGraph Execute",
				description:
					"Implement the approved plan inside OpenShell, validate the changes, and summarize the result.",
				config: {
					cwd: clonePath,
					mode: "execute_direct",
					model: "gpt-5.5",
					tools: JSON.stringify([
						"glob",
						"grep",
						"read",
						"edit",
						"write",
						"bash",
					]),
					engine: "langgraph",
					prompt:
						"Implement the approved feature plan for this repository.\n\nOriginal user feature request:\n{{@trigger:Manual.feature_request}}\n\nExecution requirements:\n- Follow the approved plan artifact as the primary source of truth.\n- Match existing repository patterns and architecture.\n- Keep the change set cohesive and avoid unrelated edits.\n- Add or update tests when behavior changes.\n- Run the provided validation commands and any targeted checks needed for the changed code.\n- If the approved plan needs a small adaptation based on repository realities, make the smallest justified adjustment and explain it clearly in the final summary.\n\nReturn a concise engineering summary that includes changed files, verification results, and residual risks.",
					profile: "implement",
					maxTurns: "80",
					actionType: "durable/run",
					toolPolicy: "all",
					agentConfig,
					artifactRef: `{{@${OPENSHELL_FEATURE_IDS.plan}:OpenShell LangGraph Plan.artifactRef}}`,
					shellPolicy: "workspace-safe",
					writePolicy: "workspace-only",
					workspaceRef,
					repositoryUrl: "https://github.com/PittampalliOrg/next-learn.git",
					stopCondition:
						"The requested feature is implemented, relevant verification has been run, and the final response includes changed files, verification results, and residual risks.",
					expectedOutput:
						"A concise engineering summary, changed-file list, verification results, and residual risks.",
					repositoryRepo: "next-learn",
					timeoutMinutes: "60",
					verifyCommands: "npm run build",
					agentProfileRef,
					repositoryOwner: "PittampalliOrg",
					sandboxRepoPath: "/sandbox/repo",
					planningThreadId: `lg:plan:${executionId}`,
					repositoryBranch: "main",
					workspaceBackend: "openshell",
					executionThreadId: `lg:exec:${executionId}`,
					instructionsOverlay: `${EXECUTOR_INSTRUCTIONS}\n\nAdditional workflow instructions:\n${EXECUTOR_INSTRUCTIONS}\n\nAdditional workflow instructions:\n${EXECUTOR_INSTRUCTIONS}`,
					requiredCapabilities: JSON.stringify(["git", "bash"]),
					agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
					preferredSandboxProfile: "node-npm",
					preferredExecutionProfile: "node-npm",
					agentProfileTemplateVersion: String(agentProfileVersion),
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.review,
			type: "action",
			position: { x: 12, y: 1072 },
			data: {
				type: "action",
				label: "Review Workspace Changes",
				description:
					"Show persisted OpenShell file change context from the execute step output.",
				config: {
					command: buildOpenShellFeatureReviewCommand(),
					timeoutMs: "120000",
					actionType: "workspace/command",
					workspaceRef,
					continueOnError: "true",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserProfile,
			type: "action",
			position: { x: 12, y: 1284 },
			data: {
				type: "action",
				label: "Browser Validation Workspace",
				description:
					"Provision an OpenShell browser validation workspace for dev-server validation and screenshots.",
				config: {
					name: "browser-validation",
					actionType: "browser/profile",
					commandTimeoutMs: "360000",
					sandboxTemplate: "openshell-browser",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserClone,
			type: "action",
			position: { x: 12, y: 1496 },
			data: {
				type: "action",
				label: "Browser Validation Clone",
				description:
					"Clone the target repository into the browser validation workspace.",
				config: {
					targetDir: "next-learn",
					actionType: "browser/clone",
					workspaceRef: browserWorkspaceRef,
					repositoryUrl: OPENSHELL_LANGGRAPH_BROWSER_VALIDATION_REPOSITORY_URL,
					repositoryOwner: "PittampalliOrg",
					repositoryRepo: "next-learn",
					repositoryBranch: "main",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserMaterialize,
			type: "action",
			position: { x: 12, y: 1708 },
			data: {
				type: "action",
				label: "Browser Materialize Changes",
				description:
					"Restore the latest execute-step code changes into the browser validation clone.",
				config: {
					actionType: "browser/materialize-change-artifact",
					workspaceRef: browserWorkspaceRef,
					preferredOperation: "agent-execute",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserInstall,
			type: "action",
			position: { x: 12, y: 1920 },
			data: {
				type: "action",
				label: "Browser Install Dependencies",
				description: "Install app dependencies inside the validation clone.",
				config: {
					actionType: "browser/command",
					workspaceRef: browserWorkspaceRef,
					command: buildOpenShellValidationInstallCommand(),
					timeoutMs: "3600000",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserServer,
			type: "action",
			position: { x: 12, y: 2132 },
			data: {
				type: "action",
				label: "Browser Start Dev Server",
				description:
					"Start the Next.js dev server and wait until the app responds on port 3000.",
				config: {
					actionType: "browser/command",
					workspaceRef: browserWorkspaceRef,
					command: buildOpenShellValidationDevServerCommand(),
					timeoutMs: "900000",
				},
				status: "idle",
			},
		},
		{
			id: OPENSHELL_FEATURE_IDS.browserCapture,
			type: "action",
			position: { x: 12, y: 2344 },
			data: {
				type: "action",
				label: "Browser Capture Flow",
				description:
					"Navigate the dashboard UI and persist screenshots as durable browser artifacts.",
				config: {
					actionType: "browser/capture-flow",
					workspaceRef: browserWorkspaceRef,
					baseUrl: "http://127.0.0.1:3000",
					steps: buildOpenShellValidationCaptureSteps(),
					timeoutMs: "180000",
				},
				status: "idle",
			},
		},
	]);
}

function buildOpenShellLangGraphFeatureDeliveryEdges() {
	return [
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[0],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.trigger,
			target: OPENSHELL_FEATURE_IDS.profile,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[1],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.profile,
			target: OPENSHELL_FEATURE_IDS.clone,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[2],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.clone,
			target: OPENSHELL_FEATURE_IDS.plan,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[3],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.plan,
			target: OPENSHELL_FEATURE_IDS.execute,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[4],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.execute,
			target: OPENSHELL_FEATURE_IDS.review,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[5],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.review,
			target: OPENSHELL_FEATURE_IDS.browserProfile,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[6],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.browserProfile,
			target: OPENSHELL_FEATURE_IDS.browserClone,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[7],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.browserClone,
			target: OPENSHELL_FEATURE_IDS.browserMaterialize,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[8],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.browserMaterialize,
			target: OPENSHELL_FEATURE_IDS.browserInstall,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[9],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.browserInstall,
			target: OPENSHELL_FEATURE_IDS.browserServer,
		},
		{
			id: OPENSHELL_FEATURE_EDGE_IDS[10],
			type: "animated",
			source: OPENSHELL_FEATURE_IDS.browserServer,
			target: OPENSHELL_FEATURE_IDS.browserCapture,
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

function buildNodes(profileVersion: number) {
	const workspaceRef = `{{@${IDs.profile}:Workspace Profile.workspaceRef}}`;
	const clonePath = `{{@${IDs.clone}:Workspace Clone.clonePath}}`;
	const executionId = `{{@${IDs.profile}:Workspace Profile.executionId}}`;

	return normalizeWorkflowNodes([
		{
			id: IDs.trigger,
			type: "trigger",
			position: { x: -740, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: IDs.profile,
			type: "action",
			position: { x: -500, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create execution-scoped workspace session",
				type: "action",
				config: {
					name: "opencode-planexec-profile",
					actionType: "workspace/profile",
					enabledTools: '["read","write","edit","list","bash"]',
					commandTimeoutMs: "120000",
					requireReadBeforeWrite: "true",
				},
				status: "idle",
			},
		},
		{
			id: IDs.clone,
			type: "action",
			position: { x: -240, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone target repository",
				type: "action",
				config: {
					actionType: "workspace/clone",
					workspaceRef,
					repositoryUrl:
						"http://gitea-http.gitea.svc.cluster.local:3000/giteaadmin/workflow-smoke.git",
					repositoryRepo: "workflow-smoke",
					repositoryOwner: "giteaadmin",
					repositoryBranch: "main",
					repositoryUsername: "giteaadmin",
					repositoryToken: "developer",
				},
				status: "idle",
			},
		},
		{
			id: IDs.branch,
			type: "action",
			position: { x: 20, y: 0 },
			data: {
				label: "Create Branch",
				description: "Create branch for this run",
				type: "action",
				config: {
					command: `set -euo pipefail; BR=opencode-planexec-${executionId}; git checkout -b "$BR"; echo BRANCH=$BR; git status --short`,
					timeoutMs: "120000",
					actionType: "workspace/command",
					workspaceRef,
				},
				status: "idle",
			},
		},
		{
			id: IDs.plan,
			type: "action",
			position: { x: 280, y: 0 },
			data: {
				label: "Plan Changes",
				description: "Generate plan only (no execution)",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "plan_mode",
					model: "openai/gpt-5.5",
					prompt:
						"Analyze this minimal workflow-smoke repository and produce an execution-ready plan for a small but real multi-file repository improvement.\n\nCurrent repository context:\n- The repository is intentionally minimal.\n- It currently contains a README and is used for workflow smoke tests.\n\nRequired deliverables:\n1) scripts/generate-report.sh\n   - bash script that writes docs/report.md summarizing the repository purpose and current branch.\n2) scripts/verify-repo.sh\n   - bash script that checks required files exist and that docs/report.md contains the expected heading.\n3) docs/report.md\n   - generated project report with at least:\n     - title\n     - repository purpose\n     - workflow smoke note\n4) docs/usage.md\n   - short usage instructions for the two scripts.\n\nValidation expectation for execute step:\n- bash -n scripts/generate-report.sh scripts/verify-repo.sh\n- bash scripts/generate-report.sh\n- bash scripts/verify-repo.sh\n\nReturn a concise, ordered plan in <proposed_plan> format.",
					maxTurns: String(PLANNER_MAX_TURNS),
					timeoutMinutes: String(PLANNER_TIMEOUT_MINUTES),
					contextPolicyPreset: "conservative",
					autoApprovePlan: "true",
					autoApproveReason: "Auto-approved for workflow smoke execution",
					autoApproveActor: "system:workflow-smoke",
					workspaceRef,
					cwd: clonePath,
					agentConfig: {
						name: "Planning Agent",
						tools: ["glob", "grep", "read"],
						modelSpec: "openai/gpt-5.5",
						maxTurns: PLANNER_MAX_TURNS,
						instructions: PLANNER_INSTRUCTIONS,
						timeoutMinutes: PLANNER_TIMEOUT_MINUTES,
					},
					agentProfileRef: {
						id: AGENT_PROFILE_TEMPLATE_ID,
						name: "Planning Agent",
						slug: "coding-agent",
						version: profileVersion,
					},
					agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
					agentProfileTemplateVersion: profileVersion,
				},
				status: "idle",
			},
		},
		{
			id: IDs.execute,
			type: "action",
			position: { x: 540, y: 0 },
			data: {
				label: "Execute Plan",
				description: "Execute plan with concrete file edits",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "execute_direct",
					model: "openai/gpt-5.5",
					prompt:
						"Execute the approved plan artifact and implement the repository improvement in this minimal workflow-smoke repo.\n\nYou must create or update exactly these repository files:\n- scripts/generate-report.sh\n- scripts/verify-repo.sh\n- docs/report.md\n- docs/usage.md\n\nHard requirements:\n- Use mutating file tools to create or update those files. Reading files or creating empty directories is not sufficient.\n- scripts/generate-report.sh must write docs/report.md with a '# Repository Report' heading, repository purpose, workflow smoke note, and current branch.\n- scripts/verify-repo.sh must fail if any required file is missing or if docs/report.md does not start with '# Repository Report'.\n- docs/usage.md must explain how to run both scripts.\n- Run and report these commands before finishing:\n  - bash -n scripts/generate-report.sh scripts/verify-repo.sh\n  - bash scripts/generate-report.sh\n  - bash scripts/verify-repo.sh\n- Do not stop after planning, inspection, or directory creation. Finish only after the four required files exist and validation commands pass.",
					maxTurns: String(EXECUTOR_MAX_TURNS),
					timeoutMinutes: String(EXECUTOR_TIMEOUT_MINUTES),
					contextPolicyPreset: "balanced",
					workspaceRef,
					cwd: clonePath,
					artifactRef: `{{@${IDs.plan}:Plan Changes.artifactRef}}`,
					stopCondition:
						"Stop only when scripts/generate-report.sh, scripts/verify-repo.sh, docs/report.md, and docs/usage.md have been created or updated with file-writing tools, and the validation commands pass.",
					cleanupWorkspace: "false",
					requireFileChanges: "true",
					agentConfig: {
						name: "Coding Agent",
						tools: ["glob", "grep", "read", "edit", "write", "bash"],
						modelSpec: "openai/gpt-5.5",
						maxTurns: EXECUTOR_MAX_TURNS,
						instructions: EXECUTOR_INSTRUCTIONS,
						timeoutMinutes: EXECUTOR_TIMEOUT_MINUTES,
					},
					agentProfileRef: {
						id: AGENT_PROFILE_TEMPLATE_ID,
						name: "Coding Agent",
						slug: "coding-agent",
						version: profileVersion,
					},
					agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
					agentProfileTemplateVersion: profileVersion,
				},
				status: "idle",
			},
		},
		{
			id: IDs.verifyChanges,
			type: "action",
			position: { x: 800, y: 0 },
			data: {
				label: "Verify Multi-file Changes",
				description: "Ensure complex task produced required file edits",
				type: "action",
				config: {
					command: `set -euo pipefail
REQUIRED_FILES="scripts/generate-report.sh scripts/verify-repo.sh docs/report.md docs/usage.md"
for f in $REQUIRED_FILES; do
	if [ ! -f "$f" ]; then
		echo "Missing required file: $f"
		exit 2
	fi
done
CHANGED=$(git status --porcelain -- scripts/generate-report.sh scripts/verify-repo.sh docs/report.md docs/usage.md | awk '{print $2}' | sort -u)
echo "--- changed required files ---"
printf '%s\n' "$CHANGED"
COUNT=$(printf '%s\n' "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ')
echo "CHANGED_COUNT=$COUNT"
if [ "$COUNT" -lt 4 ]; then
	echo "Expected changes across all 4 required files."
	exit 2
fi
bash -n scripts/generate-report.sh scripts/verify-repo.sh
bash scripts/generate-report.sh
bash scripts/verify-repo.sh
FORBIDDEN=$(git status --porcelain | awk '{print $2}' | grep -E '(^|/)(__pycache__/|.*\\.pyc$|.*\\.pyo$)' || true)
if [ -n "$FORBIDDEN" ]; then
	echo "Generated Python cache files detected (must not be committed):"
	echo "$FORBIDDEN"
	exit 2
fi`,
					timeoutMs: "120000",
					actionType: "workspace/command",
					workspaceRef,
				},
				status: "idle",
			},
		},
		{
			id: IDs.commitPushPr,
			type: "action",
			position: { x: 1060, y: 0 },
			data: {
				label: "Commit Push PR",
				description: "Commit changes, push branch, create PR to main",
				type: "action",
				config: {
					command: `set -euo pipefail
BR=opencode-planexec-{{@pf_1771706813719:Workspace Profile.executionId}}

# Clean common Python cache artifacts before staging.
find . -type d -name "__pycache__" -prune -exec rm -rf {} +
find . -type f \\( -name "*.pyc" -o -name "*.pyo" \\) -delete

git add -A
BAD=$(git diff --cached --name-only | grep -E '(^|/)(__pycache__/|.*\\.pyc$|.*\\.pyo$)' || true)
if [ -n "$BAD" ]; then
	echo "Refusing to commit generated Python cache artifacts:"
	echo "$BAD"
	exit 2
fi
if git diff --cached --quiet; then
	echo "No staged changes after execute step"
	exit 2
fi

git commit -m "feat: add workflow smoke support files"
git remote set-url origin http://giteaadmin:developer@gitea-http.gitea.svc.cluster.local:3000/giteaadmin/workflow-smoke.git
git push -u origin "$BR"

PR_PAYLOAD=$(jq -nc \
	--arg title "Opencode workflow: workflow-smoke support files ({{@pf_1771706813719:Workspace Profile.executionId}})" \
	--arg head "$BR" \
	--arg base "main" \
	--arg body "Automated plan+execute workflow implementing workflow-smoke support files." \
	'{title:$title,head:$head,base:$base,body:$body}')
PR=$(curl -sS -u giteaadmin:developer \
	-H "Content-Type: application/json" \
	-X POST \
	http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/giteaadmin/workflow-smoke/pulls \
	-d "$PR_PAYLOAD")
echo "$PR" | jq -r '["PR_NUMBER="+(.number|tostring),"PR_URL="+(.html_url//""),"PR_STATE="+(.state//"")] | .[]'
echo BRANCH=$BR
echo COMMIT=$(git rev-parse HEAD)
echo REMOTE=$(git remote get-url origin)`,
					timeoutMs: "180000",
					actionType: "workspace/command",
					workspaceRef,
				},
				status: "idle",
			},
		},
		{
			id: IDs.cleanup,
			type: "action",
			position: { x: 1320, y: 0 },
			data: {
				label: "Workspace Cleanup",
				description: "Cleanup workspace",
				type: "action",
				config: {
					actionType: "workspace/cleanup",
					workspaceRef,
				},
				status: "idle",
			},
		},
	]);
}

function buildEdges() {
	return [
		{
			id: EDGE_IDS[0],
			type: "animated",
			source: IDs.trigger,
			target: IDs.profile,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[1],
			type: "animated",
			source: IDs.profile,
			target: IDs.clone,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[2],
			type: "animated",
			source: IDs.clone,
			target: IDs.branch,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[3],
			type: "animated",
			source: IDs.branch,
			target: IDs.plan,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[4],
			type: "animated",
			source: IDs.plan,
			target: IDs.execute,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[5],
			type: "animated",
			source: IDs.execute,
			target: IDs.verifyChanges,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[6],
			type: "animated",
			source: IDs.verifyChanges,
			target: IDs.commitPushPr,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[7],
			type: "animated",
			source: IDs.commitPushPr,
			target: IDs.cleanup,
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

function buildGithubSandboxCloneProofNodes(input?: {
	connectionId?: string;
	connectionExternalId?: string;
}) {
	const workspaceRef =
		"{{@pf_github_sandbox_clone:Workspace Profile.workspaceRef}}";
	const clonePath = "{{@cl_github_sandbox_clone:Workspace Clone.clonePath}}";
	const cloneConfig: Record<string, string> = {
		actionType: "workspace/clone",
		workspaceRef,
		repositoryOwner: "PittampalliOrg",
		repositoryRepo: "workflow-builder",
		repositoryBranch: "main",
	};

	if (input?.connectionExternalId) {
		cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input?.connectionId) {
		cloneConfig.integrationId = input.connectionId;
	}

	const sharedPrompt =
		"Analyze this repository for an engineer onboarding to the project. Summarize the project purpose, the main subsystems and directories, the deployment or operations model, the key docs to read first, and the highest-priority technical or operational risks. Keep the response concise and reference concrete files or directories when relevant.";

	return normalizeWorkflowNodes([
		{
			id: "tr_github_sandbox_clone",
			type: "trigger",
			position: { x: -500, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: "pf_github_sandbox_clone",
			type: "action",
			position: { x: -220, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create a Kubernetes-backed sandbox workspace.",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "github-sandbox-clone-proof",
					enabledTools: '["read","list","bash"]',
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: "cl_github_sandbox_clone",
			type: "action",
			position: { x: 60, y: 0 },
			data: {
				label: "Workspace Clone",
				description:
					"Clone the default GitHub repository into the execution-scoped sandbox.",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: "cm_github_sandbox_tree",
			type: "action",
			position: { x: 360, y: 0 },
			data: {
				label: "Show Repo Tree",
				description:
					"Print a tree-style listing of the cloned repository to prove the clone succeeded.",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef,
					timeoutMs: "120000",
					command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`,
				},
				status: "idle",
			},
		},
	]);
}

function buildGithubSandboxCloneProofEdges() {
	return [
		{
			id: "e_github_sandbox_clone_1",
			type: "animated",
			source: "tr_github_sandbox_clone",
			target: "pf_github_sandbox_clone",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_github_sandbox_clone_2",
			type: "animated",
			source: "pf_github_sandbox_clone",
			target: "cl_github_sandbox_clone",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_github_sandbox_clone_3",
			type: "animated",
			source: "cl_github_sandbox_clone",
			target: "cm_github_sandbox_tree",
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

function buildGithubSandboxReviewNodes(input?: {
	connectionId?: string;
	connectionExternalId?: string;
}) {
	const workspaceRef =
		"{{@pf_github_sandbox_review:Workspace Profile.workspaceRef}}";
	const clonePath = "{{@cl_github_sandbox_review:Workspace Clone.clonePath}}";
	const cloneConfig: Record<string, string> = {
		actionType: "workspace/clone",
		workspaceRef,
		repositoryOwner: "PittampalliOrg",
		repositoryRepo: "workflow-builder",
		repositoryBranch: "main",
	};
	const durableTools = JSON.stringify(["read", "list", "bash"]);

	if (input?.connectionExternalId) {
		cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input?.connectionId) {
		cloneConfig.integrationId = input.connectionId;
	}

	return normalizeWorkflowNodes([
		{
			id: "tr_github_sandbox_review",
			type: "trigger",
			position: { x: -740, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: "pf_github_sandbox_review",
			type: "action",
			position: { x: -460, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create a Kubernetes-backed sandbox workspace.",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "github-sandbox-project-review",
					enabledTools: durableTools,
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: "cl_github_sandbox_review",
			type: "action",
			position: { x: -180, y: 0 },
			data: {
				label: "Workspace Clone",
				description:
					"Clone the default GitHub repository into the execution-scoped sandbox.",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: "cm_github_sandbox_review_tree",
			type: "action",
			position: { x: 120, y: 0 },
			data: {
				label: "Show Repo Tree",
				description:
					"Print a tree-style listing of the cloned repository to prove the clone succeeded.",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef,
					timeoutMs: "120000",
					command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`,
				},
				status: "idle",
			},
		},
		{
			id: "da_github_sandbox_review",
			type: "action",
			position: { x: 460, y: 0 },
			data: {
				label: "Coding Agent Review",
				description:
					"Use the durable coding agent to review the repository and summarize the project.",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "execute_direct",
					agentProfileTemplateId: AGENT_PROFILE_TEMPLATE_ID,
					model: "openai/gpt-5.5",
					tools: durableTools,
					workspaceRef,
					cwd: clonePath,
					maxTurns: "20",
					timeoutMinutes: "20",
					cleanupWorkspace: "false",
					instructions:
						"Review the repository in read-only mode. Inspect files as needed, but do not modify anything and do not ask clarifying questions. Return a concise project summary with the most important risks first.",
					stopCondition:
						"A concise project review and summary has been produced with no file modifications.",
					prompt:
						"Review this repository and summarize the project. Cover: the project purpose, the main subsystems or directories, how it is deployed or operated, the key docs a new contributor should read, and the highest-priority technical or operational risks. Keep the answer concise and structured for an engineer onboarding to the repo.",
				},
				status: "idle",
			},
		},
	]);
}

function buildGithubSandboxReviewEdges() {
	return [
		{
			id: "e_github_sandbox_review_1",
			type: "animated",
			source: "tr_github_sandbox_review",
			target: "pf_github_sandbox_review",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_github_sandbox_review_2",
			type: "animated",
			source: "pf_github_sandbox_review",
			target: "cl_github_sandbox_review",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_github_sandbox_review_3",
			type: "animated",
			source: "cl_github_sandbox_review",
			target: "cm_github_sandbox_review_tree",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_github_sandbox_review_4",
			type: "animated",
			source: "cm_github_sandbox_review_tree",
			target: "da_github_sandbox_review",
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

function buildAiCodingAgentNodes() {
	const workspaceRef = "{{@pf_ai_coding_agent:Workspace Profile.workspaceRef}}";
	const clonePath = "{{@cl_ai_coding_agent:Workspace Clone.clonePath}}";
	const sandboxRepoPath = "/sandbox/repo";

	return normalizeWorkflowNodes([
		{
			id: "tr_ai_coding_agent",
			type: "trigger",
			position: { x: -760, y: 0 },
			data: {
				label: "API Trigger",
				description:
					"Receives repo selection and task input from the ai/main coding-agent flow.",
				type: "trigger",
				config: {
					triggerType: "Manual",
					inputSchema: JSON.stringify([
						{
							name: "owner",
							type: "TEXT",
							required: true,
							description: "Repository owner or organization name.",
						},
						{
							name: "repo",
							type: "TEXT",
							required: true,
							description: "Repository name to clone into the sandbox.",
						},
						{
							name: "branch",
							type: "TEXT",
							required: false,
							description:
								"Repository branch to clone. Defaults to 'main' when omitted.",
						},
						{
							name: "task",
							type: "TEXT",
							required: true,
							description: "Implementation task for the coding agent.",
						},
						{
							name: "token",
							type: "TEXT",
							required: false,
							description:
								"Optional token used when the target repository requires authentication.",
						},
					]),
				},
				status: "idle",
			},
		},
		{
			id: "pf_ai_coding_agent",
			type: "action",
			position: { x: -480, y: 0 },
			data: {
				label: "Workspace Profile",
				description:
					"Create an execution-scoped sandbox workspace for the coding session.",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "ai-coding-agent",
					enabledTools: '["read","write","edit","list","bash"]',
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: "cl_ai_coding_agent",
			type: "action",
			position: { x: -180, y: 0 },
			data: {
				label: "Workspace Clone",
				description:
					"Clone the selected repository into the execution workspace.",
				type: "action",
				config: {
					actionType: "workspace/clone",
					workspaceRef,
					repositoryOwner: "{{trigger.owner}}",
					repositoryRepo: "{{trigger.repo}}",
					repositoryBranch: "{{trigger.branch}}",
					repositoryToken: "{{trigger.token}}",
					githubToken: "{{trigger.token}}",
				},
				status: "idle",
			},
		},
		{
			id: "da_ai_coding_agent",
			type: "action",
			position: { x: 160, y: 0 },
			data: {
				label: "OpenShell Coding Agent",
				description:
					"Create the implementation plan, wait for approval, then execute the approved plan in the same OpenShell sandbox flow.",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "plan_mode",
					profile: "feature-delivery",
					provider: "",
					keepSandbox: "true",
					prompt: "{{trigger.task}}",
					expectedOutput:
						"A concise implementation summary, changed-file list, and verification results.",
					toolPolicy: "all",
					writePolicy: "workspace-only",
					shellPolicy: "workspace-safe",
					executeAfterApproval: "true",
					approvalTimeoutMinutes: "60",
					workspaceRef,
					repoUrl: "https://github.com/{{trigger.owner}}/{{trigger.repo}}.git",
					repoBranch: "{{trigger.branch}}",
					repoToken: "{{trigger.token}}",
					sandboxRepoPath,
					cwd: sandboxRepoPath,
					maxTurns: "80",
					timeoutMinutes: "60",
					stopCondition:
						"The requested change is implemented in the selected repository, verification is complete, and the final response includes changed files and a concise summary.",
				},
				status: "idle",
			},
		},
	]);
}

function buildAiCodingAgentEdges() {
	return [
		{
			id: "e_ai_coding_agent_1",
			type: "animated",
			source: "tr_ai_coding_agent",
			target: "pf_ai_coding_agent",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_ai_coding_agent_2",
			type: "animated",
			source: "pf_ai_coding_agent",
			target: "cl_ai_coding_agent",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_ai_coding_agent_3",
			type: "animated",
			source: "cl_ai_coding_agent",
			target: "da_ai_coding_agent",
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

function buildAgentSystemDemoNodes(input?: {
	connectionId?: string;
	connectionExternalId?: string;
}) {
	const workspaceRef =
		"{{@pf_agent_system_demo:Workspace Profile.workspaceRef}}";
	const clonePath = "{{@cl_agent_system_demo:Workspace Clone.clonePath}}";
	const sandboxRepoPath = "/sandbox/stacks";
	const cloneConfig: Record<string, string> = {
		actionType: "workspace/clone",
		workspaceRef,
		repositoryOwner: "PittampalliOrg",
		repositoryRepo: "stacks",
		repositoryBranch: "main",
	};

	if (input?.connectionExternalId) {
		cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input?.connectionId) {
		cloneConfig.integrationId = input.connectionId;
	}

	const featureDeliveryPrompt = `Repository root: ${sandboxRepoPath}
Always operate relative to this repository root for file and directory paths.

Plan and implement a small developer utility in this repository. Create a new Python script at scripts/workflow_builder_demo_report.py. The script should recursively scan packages/components/active-development/manifests for YAML files whose filename contains any of: workflow-builder, workflow-orchestrator, function-router, openshell-agent-runtime, or openshell-langgraph-dapr. Print a JSON object with a sorted list of matching relative file paths and a count. Use only the Python standard library, add a clear main entrypoint, and avoid modifying unrelated files.

## Stop Condition
The new Python utility exists, verification commands pass, and the final response includes changed files and a concise implementation summary.

Execute autonomously until the stop condition is satisfied. Do not ask for confirmation before proceeding.`;

	return normalizeWorkflowNodes([
		{
			id: "tr_agent_system_demo",
			type: "trigger",
			position: { x: -760, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: "pf_agent_system_demo",
			type: "action",
			position: { x: -480, y: 0 },
			data: {
				label: "Workspace Profile",
				description:
					"Create an execution-scoped sandbox for the agent system demo.",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "workflow-agent-system-demo",
					enabledTools: '["read","list","bash"]',
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: "cl_agent_system_demo",
			type: "action",
			position: { x: -180, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone PittampalliOrg/stacks into the sandbox.",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: "cm_agent_system_demo_tree",
			type: "action",
			position: { x: 140, y: 0 },
			data: {
				label: "Show Repo Tree",
				description:
					"Print a repo tree before the agents start so the run has a visible sandbox step.",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef,
					timeoutMs: "120000",
					command: `set -euo pipefail
TARGET='${clonePath}'
echo "CLONE_PATH=$TARGET"
if command -v tree >/dev/null 2>&1; then
	tree -a -L 3 "$TARGET"
else
	find "$TARGET" -maxdepth 3 -print | LC_ALL=C sort | sed "s#^$TARGET#.#"
fi`,
				},
				status: "idle",
			},
		},
		{
			id: "da_agent_system_demo",
			type: "action",
			position: { x: 500, y: 0 },
			data: {
				label: "OpenShell Feature Delivery",
				description:
					"Run the OpenShell coding agent through plan, approval, implementation, and verification.",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "plan_mode",
					profile: "feature-delivery",
					provider: "",
					keepSandbox: "true",
					prompt: featureDeliveryPrompt,
					expectedOutput:
						"A verified Python utility plus plan artifact, patch artifact, snapshot refs, and changed-file summary.",
					verifyCommands: `python -m py_compile scripts/workflow_builder_demo_report.py
python scripts/workflow_builder_demo_report.py`,
					toolPolicy: "all",
					writePolicy: "workspace-only",
					shellPolicy: "workspace-safe",
					executeAfterApproval: "true",
					approvalTimeoutMinutes: "60",
					workspaceRef,
					repoUrl: "https://github.com/PittampalliOrg/stacks.git",
					repoBranch: "main",
					sandboxRepoPath,
					cwd: sandboxRepoPath,
					maxTurns: "60",
					timeoutMinutes: "45",
					stopCondition:
						"The new Python utility exists, verification commands pass, and the final response includes changed files and a concise implementation summary.",
				},
				status: "idle",
			},
		},
	]);
}

function buildAgentSystemDemoEdges() {
	return [
		{
			id: "e_agent_system_demo_1",
			type: "animated",
			source: "tr_agent_system_demo",
			target: "pf_agent_system_demo",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_agent_system_demo_2",
			type: "animated",
			source: "pf_agent_system_demo",
			target: "cl_agent_system_demo",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_agent_system_demo_3",
			type: "animated",
			source: "cl_agent_system_demo",
			target: "cm_agent_system_demo_tree",
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: "e_agent_system_demo_4",
			type: "animated",
			source: "cm_agent_system_demo_tree",
			target: "da_agent_system_demo",
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

type JsonRecord = Record<string, unknown>;
type CliRuntime = "codex-cli" | "claude-code-cli" | "agy-cli";

interface CliRuntimeDescriptor {
	runtime: CliRuntime;
	label: string;
}

const THREE_B_ONE_B_CLI_RUNTIMES: readonly CliRuntimeDescriptor[] = [
	{
		runtime: "codex-cli",
		label: "Codex CLI",
	},
	{
		runtime: "claude-code-cli",
		label: "Claude Code CLI",
	},
	{
		runtime: "agy-cli",
		label: "Antigravity CLI",
	},
];

const THREE_B_ONE_B_CLI_RUNTIME_OPTIONS = THREE_B_ONE_B_CLI_RUNTIMES.map(
	(item) => ({
		label: item.label,
		value: item.runtime,
	}),
);

const THREE_B_ONE_B_CLI_DEFAULT_RUNTIME = parseCliRuntime(
	process.env.SEED_3B1B_CLI_DEFAULT_RUNTIME?.trim() || "codex-cli",
);

const THREE_B_ONE_B_CLI_SELECTED_BUILD_OUTPUT = "${ .build_3b1b_animation }";
const THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME =
	"${ .build_3b1b_animation.runtimeSandboxName // null }";

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function parseCliRuntime(value: string): CliRuntime {
	if (value === "codex-cli" || value === "claude-code-cli" || value === "agy-cli") {
		return value;
	}
	throw new Error(
		`Invalid SEED_3B1B_CLI_DEFAULT_RUNTIME "${value}". Expected codex-cli, claude-code-cli, or agy-cli.`,
	);
}

function selectedCliRuntimeExpression(): string {
	return `\${ .trigger.cliRuntime // "${THREE_B_ONE_B_CLI_DEFAULT_RUNTIME}" }`;
}

const THREE_B_ONE_B_BUILD_PROMPT = [
	'${ .trigger.animationDescription + " - Build a self-contained browser animation in ',
	THREE_B_ONE_B_APP_DIR,
	" with index.html, styles.css, script.js, and README.md. ",
	"Use Canvas or SVG so the result runs via a simple static file server. ",
	"The browser animation is the required deliverable. ",
	'Use stable DOM ids for validation: the main canvas must be <canvas id=\\"canvas\\">, ',
	'the play/pause control <button id=\\"btn-play\\">, ',
	'the restart control <button id=\\"btn-restart\\">. ',
	"Do NOT install Manim; if a scene is useful, include scene.py as optional source only. ",
	"Do not start any preview server; the downstream browser/validate and ",
	"browser/start-preview steps will do that. ",
	"The page must work when served as static files (no module imports outside relative script.js). ",
	"Do NOT create a package.json; that triggers the runtime's npm-run-dev fallback ",
	"which expects flags python3's http.server doesn't recognize. ",
	'Final answer: list the files created and a one-paragraph outline of the animation logic." }',
].join("");

const THREE_B_ONE_B_CLI_BUILD_STOP_CONDITION = [
	`Stop only when ${THREE_B_ONE_B_APP_DIR} exists with index.html, styles.css, script.js, and README.md `,
	"created or updated through file-writing tools. ",
	"index.html must include canvas#canvas, button#btn-play, and button#btn-restart. ",
	"The final answer must list the files created and outline the animation logic.",
].join("");

function makeThreeBOneBWorkspaceProfileTask(): JsonRecord {
	return {
		call: "workspace/profile",
		with: {
			name: "three-b-one-b-animation",
			rootPath: "/sandbox",
			sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
			ttlSeconds: 7200,
			keepAfterRun: true,
			managedBy: "workflow-builder:demos:3b1b-animation",
			commandTimeoutMs: 900000,
			timeoutMs: 1200000,
			enabledTools: [
				"execute_command",
				"read_file",
				"write_file",
				"edit_file",
				"list_files",
				"mkdir",
				"file_stat",
			],
			sandboxPolicy: {
				mode: "per-run",
				template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
				ttlSeconds: 7200,
				keepAfterRun: true,
			},
		},
	};
}

function makeThreeBOneBBuildTask(): JsonRecord {
	if (!Number.isInteger(THREE_B_ONE_B_DEFAULT_AGENT_VERSION)) {
		throw new Error(
			`SEED_3B1B_AGENT_VERSION must be an integer; got ${process.env.SEED_3B1B_AGENT_VERSION}`,
		);
	}
	return {
		call: "durable/run",
		with: {
			mode: "execute_direct",
			cwd: "/sandbox",
			sandboxName: "${ .workspace_profile.sandboxName }",
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			outputSync: {
				workspaceRef: "${ .workspace_profile.workspaceRef }",
				paths: [
					{
						source: THREE_B_ONE_B_APP_DIR,
						target: THREE_B_ONE_B_APP_DIR,
					},
				],
				timeoutMs: 120000,
			},
			sandboxPolicy: {
				mode: "per-run",
				template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
				ttlSeconds: 7200,
				keepAfterRun: true,
			},
			body: {
				agentRef: {
					id: THREE_B_ONE_B_DEFAULT_AGENT_ID,
					version: THREE_B_ONE_B_DEFAULT_AGENT_VERSION,
				},
				prompt: THREE_B_ONE_B_BUILD_PROMPT,
				overrides: {
					cwd: "/sandbox",
					maxTurns: 60,
					timeoutMinutes: 60,
				},
			},
		},
	};
}

function makeThreeBOneBBrowserValidateTask(): JsonRecord {
	return {
		call: "browser/validate",
		with: {
			workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
			sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
			repoPath: THREE_B_ONE_B_APP_DIR,
			installCommand: "",
			baseUrl: "http://127.0.0.1:0",
			steps: [
				{
					id: "initial",
					label: "Animation loaded",
					action: "visit",
					path: "/",
					goal: "Initial render of the canvas before any interaction.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-play",
					label: "After play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control once.",
					waitForSelector: "canvas#canvas",
					pauseMs: 2000,
					fullPage: true,
				},
				{
					id: "after-second-play",
					label: "After second play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control again to capture mid-animation state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-restart",
					label: "After restart",
					action: "click",
					selector: "button#btn-restart",
					goal: "Restart the animation and capture the reset state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
			],
			captureVideo: true,
			captureTrace: true,
			viewportPreset: "desktop",
			captureMode: "demo",
			demoTitle:
				'${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
			demoSummary:
				"Generated 3Blue1Brown-style browser animation; browser/validate captured initial / play / second play / restart states from the retained per-run sandbox.",
			metadata: {
				appPath: THREE_B_ONE_B_APP_DIR,
				workflowStage: "post-3b1b-animation",
				runtimeSandboxName:
					"${ .build_3b1b_animation.runtimeSandboxName // null }",
			},
			timeoutMs: 900000,
		},
	};
}

function makeThreeBOneBStartPreviewTask(): JsonRecord {
	return {
		call: "browser/start-preview",
		with: {
			body: {
				input: {
					previewId:
						'${ "3b1b-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
					repoPath: THREE_B_ONE_B_APP_DIR,
					rootPath: "/sandbox",
					workingDir: "/sandbox",
					baseUrl: "http://127.0.0.1:0",
					keepAlive: true,
					timeoutSeconds: 7200,
					timeoutMs: 7200000,
					sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
					workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
				},
			},
		},
	};
}

function buildThreeBOneBWorkflowSpec(): JsonRecord {
	return {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder.demos",
			name: THREE_B_ONE_B_WORKFLOW_ID,
			version: "1.0.0",
			title: THREE_B_ONE_B_WORKFLOW_NAME,
			summary: THREE_B_ONE_B_WORKFLOW_DESCRIPTION,
			"x-workflow-builder": {
				architecture:
					"per-agent-runtime+session-workflow-bridge+browser-validate-capture",
				notes:
					"Adapted from the legacy 3pvh53PpHSiz-OoEeSW4z fixture for the per-agent-runtime architecture. Single agent step builds index.html / styles.css / script.js / README.md; browser/validate boots the static-file server and captures a 4-screenshot demo. Sandbox is retained so the live preview proxy can attach after completion.",
				triggerInputs: {
					animationDescription:
						"Required. Plain-language description of the 3Blue1Brown-style animation to build.",
					sandboxTemplate:
						"Optional override (default 'dapr-agent'). Only set this if the cluster has a dedicated animation template installed.",
				},
				input: {
					fields: {
						animationDescription: {
							type: "textarea",
							label: "Animation description",
							description:
								"Describe the 3Blue1Brown-style animation the agent should build.",
							defaultValue:
								"Create a concise 3Blue1Brown-style derivative animation for x^2",
						},
					},
				},
			},
		},
		do: [
			{ workspace_profile: makeThreeBOneBWorkspaceProfileTask() },
			{ build_3b1b_animation: makeThreeBOneBBuildTask() },
			{ browser_validate_capture: makeThreeBOneBBrowserValidateTask() },
			{ start_preview: makeThreeBOneBStartPreviewTask() },
		],
		output: {
			as: {
				appPath: THREE_B_ONE_B_APP_DIR,
				workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
				sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
				runtimeSandboxName: "${ .build_3b1b_animation.runtimeSandboxName // null }",
				animation: "${ .build_3b1b_animation }",
				screenshots: "${ .browser_validate_capture }",
				preview: "${ .start_preview }",
			},
		},
		input: {
			schema: {
				document: {
					type: "object",
					required: ["animationDescription"],
					properties: {
						animationDescription: {
							type: "string",
							title: "Animation description",
							description:
								"Describe the 3Blue1Brown-style animation the agent should build.",
							default:
								"Create a concise 3Blue1Brown-style derivative animation for x^2",
						},
					},
				},
				format: "json",
			},
		},
	};
}

function buildThreeBOneBWorkflowNodes(): JsonRecord[] {
	return [
		{
			id: "trigger",
			type: "trigger",
			position: { x: 80, y: 60 },
			data: {
				label: "Animation request trigger",
				description:
					"Receives animationDescription for the 3Blue1Brown-style animation.",
			},
		},
		{
			id: "workspace_profile",
			type: "action",
			position: { x: 80, y: 200 },
			data: {
				label: "Provision retained sandbox",
				actionType: "workspace/profile",
				description:
					"Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run.",
			},
		},
		{
			id: "build_3b1b_animation",
			type: "action",
			position: { x: 80, y: 340 },
			data: {
				label: "Build 3B1B animation",
				actionType: "durable/run",
				description:
					"Agent generates index.html / styles.css / script.js / README.md with stable DOM ids for validation.",
			},
		},
		{
			id: "browser_validate_capture",
			type: "action",
			position: { x: 80, y: 480 },
			data: {
				label: "Capture animation walkthrough",
				actionType: "browser/validate",
				description:
					"Boot the generated static files and capture initial / play / second play / restart screenshots.",
			},
		},
		{
			id: "start_preview",
			type: "action",
			position: { x: 80, y: 620 },
			data: {
				label: "Start live preview",
				actionType: "browser/start-preview",
				description:
					"Pre-create the live-preview proxy with correct repoPath/rootPath.",
			},
		},
	];
}

function buildThreeBOneBWorkflowEdges(): JsonRecord[] {
	return [
		{
			id: "e_three_b_one_b_1",
			source: "trigger",
			target: "workspace_profile",
			type: "default",
		},
		{
			id: "e_three_b_one_b_2",
			source: "workspace_profile",
			target: "build_3b1b_animation",
			type: "default",
		},
		{
			id: "e_three_b_one_b_3",
			source: "build_3b1b_animation",
			target: "browser_validate_capture",
			type: "default",
		},
		{
			id: "e_three_b_one_b_4",
			source: "browser_validate_capture",
			target: "start_preview",
			type: "default",
		},
	];
}

function makeThreeBOneBCliWorkspaceProfileTask(): JsonRecord {
	const task = cloneJson(makeThreeBOneBWorkspaceProfileTask());
	const withBlock = isRecord(task.with) ? task.with : {};
	task.with = withBlock;
	withBlock.sandboxTemplate = "dapr-agent";
	const sandboxPolicy = isRecord(withBlock.sandboxPolicy)
		? withBlock.sandboxPolicy
		: {};
	withBlock.sandboxPolicy = sandboxPolicy;
	sandboxPolicy.template = "dapr-agent";
	return task;
}

function makeThreeBOneBCliBuildTask(): JsonRecord {
	return {
		call: "durable/run",
		with: {
			mode: "execute_direct",
			cwd: "/sandbox",
			sandboxName: "${ .workspace_profile.sandboxName }",
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			outputSync: {
				workspaceRef: "${ .workspace_profile.workspaceRef }",
				paths: [
					{
						source: THREE_B_ONE_B_APP_DIR,
						target: THREE_B_ONE_B_APP_DIR,
					},
				],
				timeoutSeconds: 120,
			},
			sandboxPolicy: {
				mode: "per-run",
				template: "dapr-agent",
				ttlSeconds: 7200,
				keepAfterRun: true,
			},
			body: {
				agentRef: {
					slug: selectedCliRuntimeExpression(),
				},
				prompt: THREE_B_ONE_B_BUILD_PROMPT,
				stopCondition: THREE_B_ONE_B_CLI_BUILD_STOP_CONDITION,
				requireFileChanges: true,
				overrides: {
					cwd: "/sandbox",
					maxTurns: 60,
					timeoutMinutes: 60,
				},
			},
		},
	};
}

function makeThreeBOneBCliVerifyTask(): JsonRecord {
	return {
		call: "workspace/command",
		with: {
			workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
			cwd: "/sandbox",
			timeoutMs: 120000,
			command: [
				"set -eu",
				`app=${JSON.stringify(THREE_B_ONE_B_APP_DIR)}`,
				'test -f "$app/index.html"',
				'test -f "$app/styles.css"',
				'test -f "$app/script.js"',
				'test -f "$app/README.md"',
				'node --check "$app/script.js"',
				'grep -q "id=\\"canvas\\"" "$app/index.html"',
				'grep -q "id=\\"btn-play\\"" "$app/index.html"',
				'grep -q "id=\\"btn-restart\\"" "$app/index.html"',
				'find "$app" -maxdepth 1 -type f -printf "%f %s bytes\\n" | sort',
			].join("\n"),
		},
	};
}

function makeThreeBOneBCliBrowserValidateTask(): JsonRecord {
	return {
		call: "browser/validate",
		with: {
			workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
			sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
			repoPath: THREE_B_ONE_B_APP_DIR,
			rootPath: "/sandbox",
			workingDir: "/sandbox",
			installCommand: "",
			baseUrl: "http://127.0.0.1:0",
			steps: [
				{
					id: "initial",
					label: "Animation loaded",
					action: "visit",
					path: "/",
					goal: "Initial render of the canvas before any interaction.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-play",
					label: "After play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control once.",
					waitForSelector: "canvas#canvas",
					pauseMs: 2000,
					fullPage: true,
				},
				{
					id: "after-second-play",
					label: "After second play",
					action: "click",
					selector: "button#btn-play",
					goal: "Trigger the play control again to capture mid-animation state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
				{
					id: "after-restart",
					label: "After restart",
					action: "click",
					selector: "button#btn-restart",
					goal: "Restart the animation and capture the reset state.",
					waitForSelector: "canvas#canvas",
					pauseMs: 1500,
					fullPage: true,
				},
			],
			captureVideo: true,
			captureTrace: true,
			viewportPreset: "desktop",
			captureMode: "demo",
			demoTitle:
				'${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
			demoSummary:
				"Generated 3Blue1Brown-style browser animation from a CLI-agent run; browser/validate captured initial / play / second play / restart states from the retained workspace.",
			metadata: {
				appPath: THREE_B_ONE_B_APP_DIR,
				workflowStage: "post-cli-3b1b-animation",
				runtimeSandboxName:
					THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME,
				selectedCliRuntime: selectedCliRuntimeExpression(),
			},
			timeoutMs: 900000,
		},
	};
}

function makeThreeBOneBCliStartPreviewTask(): JsonRecord {
	return {
		call: "browser/start-preview",
		with: {
			body: {
				input: {
					previewId:
						'${ "3b1b-cli-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
					repoPath: THREE_B_ONE_B_APP_DIR,
					rootPath: "/sandbox",
					workingDir: "/sandbox",
					baseUrl: "http://127.0.0.1:0",
					keepAlive: true,
					timeoutSeconds: 7200,
					timeoutMs: 7200000,
					sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
					workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
					installCommand: "",
					devServerCommand: "",
				},
			},
		},
	};
}

function buildThreeBOneBCliWorkflowSpec(): JsonRecord {
	return {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder.demos",
			name: THREE_B_ONE_B_CLI_WORKFLOW_ID,
			version: "1.0.0",
			title: THREE_B_ONE_B_CLI_WORKFLOW_NAME,
			summary: THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION,
			"x-workflow-builder": {
				architecture:
					"per-agent-runtime+cli-runtime-selector+session-workflow-bridge+browser-validate-capture+live-preview",
				notes:
					"CLI variant of the canonical 3Blue1Brown workflow. The cliRuntime trigger input resolves one durable/run agentRef.slug before dispatch; outputSync copies the app into the retained OpenShell workspace for verification, browser capture, and live preview.",
				triggerInputs: {
					animationDescription:
						"Required. Plain-language description of the 3Blue1Brown-style animation to build.",
					cliRuntime:
						"Optional. Selects the CLI agent runtime: codex-cli, claude-code-cli, or agy-cli.",
				},
				input: {
					fields: {
						cliRuntime: {
							type: "select",
							label: "CLI agent",
							description: "Choose which CLI agent builds the animation.",
							defaultValue: THREE_B_ONE_B_CLI_DEFAULT_RUNTIME,
							options: THREE_B_ONE_B_CLI_RUNTIME_OPTIONS,
						},
						animationDescription: {
							type: "textarea",
							label: "Animation description",
							description:
								"Describe the 3Blue1Brown-style animation the agent should build.",
							defaultValue:
								"Create a concise 3Blue1Brown-style derivative animation for x^2",
						},
					},
				},
			},
		},
		do: [
			{ workspace_profile: makeThreeBOneBCliWorkspaceProfileTask() },
			{ build_3b1b_animation: makeThreeBOneBCliBuildTask() },
			{ verify_copied_animation: makeThreeBOneBCliVerifyTask() },
			{ browser_validate_capture: makeThreeBOneBCliBrowserValidateTask() },
			{ start_preview: makeThreeBOneBCliStartPreviewTask() },
		],
		output: {
			as: {
				appPath: THREE_B_ONE_B_APP_DIR,
				workspaceRef: THREE_B_ONE_B_BUILD_OUTPUT_WORKSPACE_REF,
				sandboxName: THREE_B_ONE_B_BUILD_OUTPUT_SANDBOX_NAME,
				runtimeSandboxName:
					THREE_B_ONE_B_CLI_SELECTED_BUILD_RUNTIME_SANDBOX_NAME,
				selectedCliRuntime: selectedCliRuntimeExpression(),
				animation: THREE_B_ONE_B_CLI_SELECTED_BUILD_OUTPUT,
				verification: "${ .verify_copied_animation }",
				screenshots: "${ .browser_validate_capture }",
				preview: "${ .start_preview }",
			},
		},
		input: {
			schema: {
				document: {
					type: "object",
					required: ["animationDescription"],
					properties: {
						cliRuntime: {
							type: "string",
							title: "CLI agent",
							description: "Selects the CLI agent runtime for the build step.",
							enum: THREE_B_ONE_B_CLI_RUNTIMES.map((item) => item.runtime),
							default: THREE_B_ONE_B_CLI_DEFAULT_RUNTIME,
						},
						animationDescription: {
							type: "string",
							title: "Animation description",
							description:
								"Describe the 3Blue1Brown-style animation the agent should build.",
							default:
								"Create a concise 3Blue1Brown-style derivative animation for x^2",
						},
					},
				},
				format: "json",
			},
		},
	};
}

function buildThreeBOneBCliWorkflowNodes(): JsonRecord[] {
	return [
		{
			id: "trigger",
			type: "trigger",
			position: { x: 80, y: 60 },
			data: {
				label: "Animation request trigger",
				description:
					"Receives animationDescription and cliRuntime for the 3Blue1Brown-style animation.",
			},
		},
		{
			id: "workspace_profile",
			type: "action",
			position: { x: 80, y: 200 },
			data: {
				label: "Provision retained sandbox",
				actionType: "workspace/profile",
				description:
					"Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run.",
			},
		},
		{
			id: "build_3b1b_animation",
			type: "action",
			position: { x: 80, y: 340 },
			data: {
				label: "Build with selected CLI",
				actionType: "durable/run",
				description:
					"Resolve cliRuntime to a managed CLI agent and generate the browser animation.",
			},
		},
		{
			id: "verify_copied_animation",
			type: "action",
			position: { x: 80, y: 480 },
			data: {
				label: "Verify copied animation",
				actionType: "workspace/command",
				description:
					"Run file and syntax checks against the retained workspace after CLI output sync.",
			},
		},
		{
			id: "browser_validate_capture",
			type: "action",
			position: { x: 80, y: 620 },
			data: {
				label: "Capture animation walkthrough",
				actionType: "browser/validate",
				description:
					"Boot a static server against the copied files and capture initial / play / second play / restart screenshots.",
			},
		},
		{
			id: "start_preview",
			type: "action",
			position: { x: 80, y: 760 },
			data: {
				label: "Start live preview",
				actionType: "browser/start-preview",
				description:
					"Start a keep-alive preview proxy for the retained workspace so the run page can open the generated animation.",
			},
		},
	];
}

function buildThreeBOneBCliWorkflowEdges(): JsonRecord[] {
	const ordered = [
		"trigger",
		"workspace_profile",
		"build_3b1b_animation",
		"verify_copied_animation",
		"browser_validate_capture",
		"start_preview",
	];
	return ordered.slice(0, -1).map((source, index) => ({
		id: `e_cli_3b1b_${index + 1}`,
		source,
		target: ordered[index + 1],
		type: "default",
	}));
}

async function upsertRawWorkflow(params: {
	db: ReturnType<typeof drizzle>;
	workflowId: string;
	name: string;
	description: string;
	userId: string;
	projectId: string;
	spec: JsonRecord;
	nodes: JsonRecord[];
	edges: JsonRecord[];
	visibility?: "private" | "public";
}) {
	const visibility = params.visibility ?? "private";
	const existing = await params.db.query.workflows.findFirst({
		where: eq(workflows.id, params.workflowId),
	});

	if (!existing) {
		await params.db.insert(workflows).values({
			id: params.workflowId,
			name: params.name,
			description: params.description,
			userId: params.userId,
			projectId: params.projectId,
			nodes: params.nodes,
			edges: params.edges,
			specVersion: "1.0.0",
			spec: params.spec,
			visibility,
			engineType: "dapr",
		});
		console.log(
			`[seed-workflows] Created workflow ${params.workflowId} for user ${params.userId}`,
		);
		return;
	}

	if (
		existing.userId !== params.userId ||
		(existing.projectId ?? null) !== params.projectId
	) {
		throw new Error(
			`Workflow ${params.workflowId} already exists for user ${existing.userId} project ${existing.projectId ?? "null"}; set a targeted seed owner or move the existing workflow first.`,
		);
	}

	await params.db
		.update(workflows)
		.set({
			name: params.name,
			description: params.description,
			userId: params.userId,
			projectId: params.projectId,
			nodes: params.nodes,
			edges: params.edges,
			specVersion: "1.0.0",
			spec: params.spec,
			visibility,
			engineType: "dapr",
			updatedAt: new Date(),
		})
		.where(eq(workflows.id, params.workflowId));
	console.log(
		`[seed-workflows] Reconciled workflow ${params.workflowId} for user ${params.userId}`,
	);
}

async function upsertWorkflow(params: {
	db: ReturnType<typeof drizzle>;
	workflowId: string;
	name: string;
	description: string;
	userId: string;
	projectId: string;
	nodes: ReturnType<typeof normalizeWorkflowNodes>;
	edges: ReturnType<typeof buildEdges>;
	visibility?: "private" | "public";
}) {
	const resolved = resolveCanonicalWorkflowSpec({
		name: params.name,
		description: params.description,
		nodes: params.nodes as never,
		edges: params.edges as never,
	});
	const visibility = params.visibility ?? "private";
	const existing = await params.db.query.workflows.findFirst({
		where: eq(workflows.id, params.workflowId),
	});

	if (!existing) {
		await params.db.insert(workflows).values({
			id: params.workflowId,
			name: params.name,
			description: params.description,
			userId: params.userId,
			projectId: params.projectId,
			nodes: params.nodes,
			edges: params.edges,
			specVersion: resolved.specVersion,
			spec: resolved.spec,
			visibility,
			engineType: "dapr",
		});
		console.log(
			`[seed-workflows] Created workflow ${params.workflowId} for user ${params.userId}`,
		);
		return;
	}

	if (
		existing.userId !== params.userId ||
		(existing.projectId ?? null) !== params.projectId
	) {
		throw new Error(
			`Workflow ${params.workflowId} already exists for user ${existing.userId} project ${existing.projectId ?? "null"}; set a targeted seed owner or move the existing workflow first.`,
		);
	}

	await params.db
		.update(workflows)
		.set({
			name: params.name,
			description: params.description,
			userId: params.userId,
			projectId: params.projectId,
			nodes: params.nodes,
			edges: params.edges,
			specVersion: resolved.specVersion,
			spec: resolved.spec,
			visibility,
			engineType: "dapr",
			updatedAt: new Date(),
		})
		.where(eq(workflows.id, params.workflowId));
	console.log(
		`[seed-workflows] Reconciled workflow ${params.workflowId} for user ${params.userId}`,
	);
}

async function seedWorkflow() {
	console.log("[seed-workflows] Starting workflow seed...");
	const sql = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(sql, {
		schema: {
			agentProfileTemplateVersions,
			appConnections,
			projectMembers,
			projects,
			userIdentities,
			users,
			workflowResourceRefs,
			workflows,
		},
	});

	try {
		const userId = await resolveGithubUserId(db);
		const projectId = await resolveProjectId(db, userId);
		const githubConnection = await resolveLatestGithubConnection(db, userId);
		console.log(
			`[seed-workflows] Target owner userId=${userId} projectId=${projectId}`,
		);
		if (githubConnection) {
			console.log(
				`[seed-workflows] Using GitHub connection ${githubConnection.connectionId} (${githubConnection.connectionExternalId})`,
			);
		}
		if (!githubConnection) {
			console.warn(
				"[seed-workflows] No GitHub connection found for the resolved user; the clone proof workflow will require manual connection selection before it can run.",
			);
		}
		const profileVersion = await resolveAgentProfileVersion(db);
		const nodes = buildNodes(profileVersion);
		const edges = buildEdges();
		await upsertWorkflow({
			db,
			workflowId: WORKFLOW_ID,
			name: WORKFLOW_NAME,
			description: WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes,
			edges,
		});

		await db
			.delete(workflowResourceRefs)
			.where(eq(workflowResourceRefs.workflowId, WORKFLOW_ID));

		await db.insert(workflowResourceRefs).values([
			{
				id: generateId(),
				workflowId: WORKFLOW_ID,
				nodeId: IDs.plan,
				resourceType: "agent_profile",
				resourceId: AGENT_PROFILE_TEMPLATE_ID,
				resourceVersion: profileVersion,
			},
			{
				id: generateId(),
				workflowId: WORKFLOW_ID,
				nodeId: IDs.execute,
				resourceType: "agent_profile",
				resourceId: AGENT_PROFILE_TEMPLATE_ID,
				resourceVersion: profileVersion,
			},
		]);

		console.log(
			`[seed-workflows] Reconciled workflow_resource_refs for ${WORKFLOW_ID} (profile version ${profileVersion})`,
		);

		await upsertWorkflow({
			db,
			workflowId: AI_CODING_AGENT_WORKFLOW_ID,
			name: AI_CODING_AGENT_WORKFLOW_NAME,
			description: AI_CODING_AGENT_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildAiCodingAgentNodes(),
			edges: buildAiCodingAgentEdges(),
		});

		await upsertRawWorkflow({
			db,
			workflowId: THREE_B_ONE_B_WORKFLOW_ID,
			name: THREE_B_ONE_B_WORKFLOW_NAME,
			description: THREE_B_ONE_B_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			spec: buildThreeBOneBWorkflowSpec(),
			nodes: buildThreeBOneBWorkflowNodes(),
			edges: buildThreeBOneBWorkflowEdges(),
			visibility: "public",
		});

		await upsertRawWorkflow({
			db,
			workflowId: THREE_B_ONE_B_CLI_WORKFLOW_ID,
			name: THREE_B_ONE_B_CLI_WORKFLOW_NAME,
			description: THREE_B_ONE_B_CLI_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			spec: buildThreeBOneBCliWorkflowSpec(),
			nodes: buildThreeBOneBCliWorkflowNodes(),
			edges: buildThreeBOneBCliWorkflowEdges(),
			visibility: "public",
		});

		await upsertWorkflow({
			db,
			workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
			name: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_NAME,
			description: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildOpenShellLangGraphFeatureDeliveryNodes({
				connectionId: githubConnection?.connectionId,
				connectionExternalId: githubConnection?.connectionExternalId,
				agentProfileVersion: profileVersion,
			}),
			edges: buildOpenShellLangGraphFeatureDeliveryEdges(),
			visibility: "public",
		});

		await db
			.delete(workflowResourceRefs)
			.where(
				eq(
					workflowResourceRefs.workflowId,
					OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
				),
			);

		await db.insert(workflowResourceRefs).values([
			{
				id: generateId(),
				workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
				nodeId: OPENSHELL_FEATURE_IDS.plan,
				resourceType: "agent_profile",
				resourceId: AGENT_PROFILE_TEMPLATE_ID,
				resourceVersion: profileVersion,
			},
			{
				id: generateId(),
				workflowId: OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID,
				nodeId: OPENSHELL_FEATURE_IDS.execute,
				resourceType: "agent_profile",
				resourceId: AGENT_PROFILE_TEMPLATE_ID,
				resourceVersion: profileVersion,
			},
		]);

		console.log(
			`[seed-workflows] Reconciled workflow_resource_refs for ${OPENSHELL_LANGGRAPH_FEATURE_DELIVERY_WORKFLOW_ID} (profile version ${profileVersion})`,
		);

		await upsertWorkflow({
			db,
			workflowId: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_ID,
			name: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_NAME,
			description: GITHUB_SANDBOX_CLONE_PROOF_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildGithubSandboxCloneProofNodes(githubConnection),
			edges: buildGithubSandboxCloneProofEdges(),
		});

		await upsertWorkflow({
			db,
			workflowId: GITHUB_SANDBOX_REVIEW_WORKFLOW_ID,
			name: GITHUB_SANDBOX_REVIEW_WORKFLOW_NAME,
			description: GITHUB_SANDBOX_REVIEW_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildGithubSandboxReviewNodes(githubConnection),
			edges: buildGithubSandboxReviewEdges(),
		});

		await upsertWorkflow({
			db,
			workflowId: AGENT_SYSTEM_DEMO_WORKFLOW_ID,
			name: AGENT_SYSTEM_DEMO_WORKFLOW_NAME,
			description: AGENT_SYSTEM_DEMO_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildAgentSystemDemoNodes(githubConnection),
			edges: buildAgentSystemDemoEdges(),
		});

		console.log("[seed-workflows] Completed successfully");
	} finally {
		await sql.end();
	}
}

seedWorkflow().catch((error) => {
	console.error("[seed-workflows] Failed:", error);
	process.exit(1);
});
