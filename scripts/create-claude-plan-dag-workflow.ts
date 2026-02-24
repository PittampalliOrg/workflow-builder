/**
 * Create a full plan-then-execute-DAG workflow:
 * trigger -> workspace/profile -> workspace/clone -> durable/claude-plan
 *   -> durable/materialize-plan -> durable/execute-plan-dag
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-dag-workflow.ts --branch main
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-dag-workflow.ts --repo owner/name --branch dev
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-dag-workflow.ts --user-email admin@example.com --model claude-sonnet-4-20250514
 */

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";
import postgres from "postgres";
import {
	appConnections,
	projectMembers,
	projects,
	users,
	workflows,
} from "../lib/db/schema";
import { generateId } from "../lib/utils/id";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_REPO_OWNER = "PittampalliOrg";
const DEFAULT_REPO_NAME = "workflow-builder";
const DEFAULT_PLAN_PROMPT = `Produce an implementation-ready dependency task graph for this repository.

Requirements:
1) Analyze the current codebase and identify the minimal safe change set.
2) Return tasks as a DAG with explicit blockedBy dependencies.
3) Keep tasks concrete and scoped to file-level work.
4) Include validation tasks (type-check, lint/fix, focused tests).
5) Do not execute edits; plan only.`;

type Args = {
	userEmail?: string;
	name: string;
	prompt: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
	model: string;
	timeoutMinutes: string;
	taskTimeoutMinutes: string;
	overallTimeoutMinutes: string;
	maxTaskRetries: string;
};

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = "Claude Plan → DAG Execute";
	let prompt = DEFAULT_PLAN_PROMPT;
	let repositoryOwner = DEFAULT_REPO_OWNER;
	let repositoryRepo = DEFAULT_REPO_NAME;
	let repositoryBranch = "";
	let targetDir: string | undefined;
	let connectionExternalId: string | undefined;
	let model = "";
	let timeoutMinutes = "12";
	let taskTimeoutMinutes = "15";
	let overallTimeoutMinutes = "120";
	let maxTaskRetries = "1";

	const parseRepoRef = (
		repoRef: string,
	): { owner: string; repo: string } | null => {
		const [owner, ...repoParts] = repoRef.split("/");
		const repo = repoParts.join("/").trim();
		if (!owner?.trim() || !repo) return null;
		return { owner: owner.trim(), repo };
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user-email") {
			userEmail = argv[i + 1];
			i++;
		} else if (arg === "--name") {
			name = argv[i + 1] || name;
			i++;
		} else if (arg === "--prompt") {
			prompt = argv[i + 1] || prompt;
			i++;
		} else if (arg === "--repo-owner") {
			repositoryOwner = argv[i + 1] || repositoryOwner;
			i++;
		} else if (arg === "--repo-name" || arg === "--repo-repo") {
			repositoryRepo = argv[i + 1] || repositoryRepo;
			i++;
		} else if (arg === "--repo") {
			const parsed = parseRepoRef(argv[i + 1] || "");
			if (parsed) {
				repositoryOwner = parsed.owner;
				repositoryRepo = parsed.repo;
			}
			i++;
		} else if (arg === "--branch") {
			repositoryBranch = argv[i + 1] || repositoryBranch;
			i++;
		} else if (arg === "--target-dir") {
			targetDir = argv[i + 1] || targetDir;
			i++;
		} else if (arg === "--connection-external-id") {
			connectionExternalId = argv[i + 1] || connectionExternalId;
			i++;
		} else if (arg === "--model") {
			model = argv[i + 1] || model;
			i++;
		} else if (arg === "--timeout-minutes") {
			timeoutMinutes = argv[i + 1] || timeoutMinutes;
			i++;
		} else if (arg === "--task-timeout-minutes") {
			taskTimeoutMinutes = argv[i + 1] || taskTimeoutMinutes;
			i++;
		} else if (arg === "--overall-timeout-minutes") {
			overallTimeoutMinutes = argv[i + 1] || overallTimeoutMinutes;
			i++;
		} else if (arg === "--max-task-retries") {
			maxTaskRetries = argv[i + 1] || maxTaskRetries;
			i++;
		}
	}

	return {
		userEmail,
		name,
		prompt,
		repositoryOwner: repositoryOwner.trim(),
		repositoryRepo: repositoryRepo.trim(),
		repositoryBranch: repositoryBranch.trim(),
		targetDir: targetDir?.trim() || undefined,
		connectionExternalId: connectionExternalId?.trim() || undefined,
		model: model.trim(),
		timeoutMinutes: timeoutMinutes.trim(),
		taskTimeoutMinutes: taskTimeoutMinutes.trim(),
		overallTimeoutMinutes: overallTimeoutMinutes.trim(),
		maxTaskRetries: maxTaskRetries.trim(),
	};
}

async function resolveUser(
	db: ReturnType<typeof drizzle>,
	userEmail?: string,
): Promise<{ userId: string; email: string | null }> {
	if (userEmail) {
		const user = await db.query.users.findFirst({
			where: eq(users.email, userEmail),
		});
		if (!user) {
			throw new Error(`User not found for email: ${userEmail}`);
		}
		return { userId: user.id, email: user.email };
	}

	const [latestWorkflow] = await db
		.select({ userId: workflows.userId })
		.from(workflows)
		.orderBy(desc(workflows.updatedAt))
		.limit(1);
	if (latestWorkflow?.userId) {
		const user = await db.query.users.findFirst({
			where: eq(users.id, latestWorkflow.userId),
		});
		return {
			userId: latestWorkflow.userId,
			email: user?.email ?? null,
		};
	}

	const [fallbackUser] = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.orderBy(desc(users.updatedAt))
		.limit(1);
	if (!fallbackUser) {
		throw new Error("No users found in database");
	}
	return { userId: fallbackUser.id, email: fallbackUser.email };
}

async function resolveProjectId(
	db: ReturnType<typeof drizzle>,
	userId: string,
): Promise<string> {
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
		`No project found for user ${userId}. Create or join a project first.`,
	);
}

async function resolveConnection(
	db: ReturnType<typeof drizzle>,
	userId: string,
	connectionExternalId: string | undefined,
): Promise<{ connectionId?: string; connectionExternalId?: string }> {
	if (connectionExternalId) {
		const row = await db.query.appConnections.findFirst({
			where: eq(appConnections.externalId, connectionExternalId),
		});
		if (!row || row.ownerId !== userId) {
			throw new Error(
				`GitHub connection not found for external ID: ${connectionExternalId}`,
			);
		}
		if (!row.pieceName.toLowerCase().includes("github")) {
			throw new Error(
				`Connection ${connectionExternalId} is not a GitHub connection`,
			);
		}
		return { connectionId: row.id, connectionExternalId };
	}

	const latestConnection = await db.query.appConnections.findFirst({
		where: eq(appConnections.ownerId, userId),
		orderBy: [desc(appConnections.updatedAt)],
	});
	if (latestConnection?.pieceName.toLowerCase().includes("github")) {
		return {
			connectionId: latestConnection.id,
			connectionExternalId: latestConnection.externalId,
		};
	}

	return {};
}

function buildWorkflowGraph(input: {
	prompt: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
	connectionId?: string;
	model: string;
	timeoutMinutes: string;
	taskTimeoutMinutes: string;
	overallTimeoutMinutes: string;
	maxTaskRetries: string;
}) {
	const triggerId = nanoid();
	const profileId = nanoid();
	const cloneId = nanoid();
	const checkoutBranchId = nanoid();
	const claudePlanId = nanoid();
	const materializePlanId = nanoid();
	const executeDagId = nanoid();
	const commitId = nanoid();
	const pullRequestId = nanoid();

	const workspaceRefTemplate = `{{@${profileId}:Workspace Profile.workspaceRef}}`;
	const clonePathTemplate = `{{@${cloneId}:Workspace Clone.clonePath}}`;
	const artifactRefTemplate = `{{@${claudePlanId}:Claude Plan.artifactRef}}`;
	const featureBranchTemplate = `feature/ai-update-{{Trigger.__execution.id}}`;

	const cloneConfig: Record<string, string> = {
		actionType: "workspace/clone",
		workspaceRef: workspaceRefTemplate,
		repositoryOwner: input.repositoryOwner,
		repositoryRepo: input.repositoryRepo,
		repositoryBranch: input.repositoryBranch,
	};
	if (input.targetDir) {
		cloneConfig.targetDir = input.targetDir;
	}
	if (input.connectionExternalId) {
		cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input.connectionId) {
		cloneConfig.integrationId = input.connectionId;
	}

	const prConfig: Record<string, string> = {
		actionType: "workspace/create-pull-request",
		repositoryOwner: input.repositoryOwner,
		repositoryRepo: input.repositoryRepo,
		headBranch: featureBranchTemplate,
		baseBranch: input.repositoryBranch,
		title: `AI Automated Updates ({{Trigger.__execution.id}})`,
		body: `Automated PR generated by Claude Plan DAG Workflow.\n\nPrompt:\n> ${input.prompt}`,
	};
	if (input.connectionExternalId) {
		prConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input.connectionId) {
		prConfig.integrationId = input.connectionId;
	}

	const nodes = normalizeWorkflowNodes([
		{
			id: triggerId,
			type: "trigger",
			position: { x: -480, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: profileId,
			type: "action",
			position: { x: -160, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create execution-scoped workspace sandbox session",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "claude-plan-dag-workspace",
					enabledTools: '["read","write","edit","list","bash"]',
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: cloneId,
			type: "action",
			position: { x: 120, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone repository into workspace sandbox",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: checkoutBranchId,
			type: "action",
			position: { x: 420, y: 0 },
			data: {
				label: "Create Feature Branch",
				description: "Checkout a new feature branch",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: `cd ${clonePathTemplate} && git config user.name "AI Agent" && git config user.email "agent@pittampalli.com" && git checkout -b "${featureBranchTemplate}"`,
					timeoutMs: "30000",
				},
				status: "idle",
			},
		},
		{
			id: claudePlanId,
			type: "action",
			position: { x: 720, y: 0 },
			data: {
				label: "Claude Plan",
				description:
					"Generate dependency DAG plan (blocked/blockedBy) via Claude Code headless planning",
				type: "action",
				config: {
					actionType: "durable/claude-plan",
					prompt: input.prompt,
					workspaceRef: workspaceRefTemplate,
					cwd: clonePathTemplate,
					model: input.model,
					timeoutMinutes: input.timeoutMinutes,
					executeAfterApproval: "false",
				},
				status: "idle",
			},
		},
		{
			id: materializePlanId,
			type: "action",
			position: { x: 1020, y: 0 },
			data: {
				label: "Materialize Plan Files",
				description:
					"Write tasks.json/plan.json/metadata.json into workspace for downstream task runners",
				type: "action",
				config: {
					actionType: "durable/materialize-plan",
					artifactRef: artifactRefTemplate,
					workspaceRef: workspaceRefTemplate,
					outputDir: `${clonePathTemplate}/.workflow/plans/${artifactRefTemplate}`,
				},
				status: "idle",
			},
		},
		{
			id: executeDagId,
			type: "action",
			position: { x: 1320, y: 0 },
			data: {
				label: "Execute Plan (DAG)",
				description:
					"Execute the plan as a DAG workflow — each task runs Claude Code CLI with dependency scheduling",
				type: "action",
				config: {
					actionType: "durable/execute-plan-dag",
					artifactRef: artifactRefTemplate,
					workspaceRef: workspaceRefTemplate,
					cwd: clonePathTemplate,
					model: input.model,
					maxTaskRetries: input.maxTaskRetries,
					taskTimeoutMinutes: input.taskTimeoutMinutes,
					overallTimeoutMinutes: input.overallTimeoutMinutes,
					cleanupWorkspace: "false",
				},
				status: "idle",
			},
		},
		{
			id: commitId,
			type: "action",
			position: { x: 1620, y: 0 },
			data: {
				label: "Commit & Push",
				description: "Commit AI changes and push to origin",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: `cd ${clonePathTemplate} && git add . && git commit -m "chore: AI automated updates" && git push -u origin "${featureBranchTemplate}"`,
					timeoutMs: "60000",
				},
				status: "idle",
			},
		},
		{
			id: pullRequestId,
			type: "action",
			position: { x: 1920, y: 0 },
			data: {
				label: "Create Pull Request",
				description: "Create a PR in Gitea",
				type: "action",
				config: prConfig,
				status: "idle",
			},
		},
	]);

	const edges = [
		{
			id: nanoid(),
			type: "animated",
			source: triggerId,
			target: profileId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: profileId,
			target: cloneId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: cloneId,
			target: checkoutBranchId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: checkoutBranchId,
			target: claudePlanId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: claudePlanId,
			target: materializePlanId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: materializePlanId,
			target: executeDagId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: executeDagId,
			target: commitId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: commitId,
			target: pullRequestId,
			sourceHandle: null,
			targetHandle: null,
		},
	];

	return { nodes, edges };
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error(
			"DATABASE_URL is required. Provide a production connection string.",
		);
	}

	const args = parseArgs(process.argv.slice(2));
	if (!args.repositoryBranch) {
		throw new Error("Repository branch is required. Provide --branch <name>.");
	}

	const client = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(client, {
		schema: { users, projects, projectMembers, workflows, appConnections },
	});

	try {
		const { userId, email } = await resolveUser(db, args.userEmail);
		const projectId = await resolveProjectId(db, userId);
		const { connectionId, connectionExternalId } = await resolveConnection(
			db,
			userId,
			args.connectionExternalId,
		);

		const { nodes, edges } = buildWorkflowGraph({
			prompt: args.prompt,
			repositoryOwner: args.repositoryOwner,
			repositoryRepo: args.repositoryRepo,
			repositoryBranch: args.repositoryBranch,
			targetDir: args.targetDir,
			connectionExternalId,
			connectionId,
			model: args.model,
			timeoutMinutes: args.timeoutMinutes,
			taskTimeoutMinutes: args.taskTimeoutMinutes,
			overallTimeoutMinutes: args.overallTimeoutMinutes,
			maxTaskRetries: args.maxTaskRetries,
		});

		const workflowId = generateId();
		const [created] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: args.name,
				description:
					"Plan-then-execute workflow: workspace/profile -> workspace/clone -> durable/claude-plan -> durable/materialize-plan -> durable/execute-plan-dag",
				userId,
				projectId,
				nodes,
				edges,
				visibility: "private",
				engineType: "dapr",
			})
			.returning({
				id: workflows.id,
				name: workflows.name,
				userId: workflows.userId,
				projectId: workflows.projectId,
				updatedAt: workflows.updatedAt,
			});

		console.log("Workflow created");
		console.log(`  id: ${created.id}`);
		console.log(`  name: ${created.name}`);
		console.log(`  userId: ${created.userId}`);
		console.log(`  userEmail: ${email ?? "unknown"}`);
		console.log(`  projectId: ${created.projectId}`);
		console.log(`  updatedAt: ${created.updatedAt.toISOString()}`);
		console.log(`  repo: ${args.repositoryOwner}/${args.repositoryRepo}`);
		console.log(`  branch: ${args.repositoryBranch}`);
		console.log(
			`  nodes: trigger -> workspace/profile -> workspace/clone -> durable/claude-plan -> durable/materialize-plan -> durable/execute-plan-dag`,
		);
		console.log(`  open: /workflows/${created.id}`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create Claude plan DAG workflow:", error);
	process.exit(1);
});
