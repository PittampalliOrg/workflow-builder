/**
 * Create a workflow that uses the Claude planning node with workspace sandbox prep:
 * trigger -> workspace/profile -> workspace/clone -> durable/claude-plan -> durable/materialize-plan
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-workflow.ts --branch main
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-workflow.ts --repo owner/name --branch dev
 *   DATABASE_URL=... pnpm tsx scripts/create-claude-plan-workflow.ts --user-email admin@example.com --connection-external-id github-main
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
	approvalTimeoutMinutes: string;
	maxTurns: string;
};

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = "Claude Plan Sandbox Flow";
	let prompt = DEFAULT_PLAN_PROMPT;
	let repositoryOwner = DEFAULT_REPO_OWNER;
	let repositoryRepo = DEFAULT_REPO_NAME;
	let repositoryBranch = "";
	let targetDir: string | undefined;
	let connectionExternalId: string | undefined;
	let model = "";
	let timeoutMinutes = "12";
	let approvalTimeoutMinutes = "60";
	let maxTurns = "60";

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
			continue;
		}
		if (arg === "--name") {
			name = argv[i + 1] || name;
			i++;
			continue;
		}
		if (arg === "--prompt") {
			prompt = argv[i + 1] || prompt;
			i++;
			continue;
		}
		if (arg === "--repo-owner") {
			repositoryOwner = argv[i + 1] || repositoryOwner;
			i++;
			continue;
		}
		if (arg === "--repo-name" || arg === "--repo-repo") {
			repositoryRepo = argv[i + 1] || repositoryRepo;
			i++;
			continue;
		}
		if (arg === "--repo") {
			const parsed = parseRepoRef(argv[i + 1] || "");
			if (parsed) {
				repositoryOwner = parsed.owner;
				repositoryRepo = parsed.repo;
			}
			i++;
			continue;
		}
		if (arg === "--branch") {
			repositoryBranch = argv[i + 1] || repositoryBranch;
			i++;
			continue;
		}
		if (arg === "--target-dir") {
			targetDir = argv[i + 1] || targetDir;
			i++;
			continue;
		}
		if (arg === "--connection-external-id") {
			connectionExternalId = argv[i + 1] || connectionExternalId;
			i++;
			continue;
		}
		if (arg === "--model") {
			model = argv[i + 1] || model;
			i++;
			continue;
		}
		if (arg === "--timeout-minutes") {
			timeoutMinutes = argv[i + 1] || timeoutMinutes;
			i++;
			continue;
		}
		if (arg === "--approval-timeout-minutes") {
			approvalTimeoutMinutes = argv[i + 1] || approvalTimeoutMinutes;
			i++;
			continue;
		}
		if (arg === "--max-turns") {
			maxTurns = argv[i + 1] || maxTurns;
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
		approvalTimeoutMinutes: approvalTimeoutMinutes.trim(),
		maxTurns: maxTurns.trim(),
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
	approvalTimeoutMinutes: string;
	maxTurns: string;
}) {
	const triggerId = nanoid();
	const profileId = nanoid();
	const cloneId = nanoid();
	const claudePlanId = nanoid();
	const materializePlanId = nanoid();

	const workspaceRefTemplate = `{{@${profileId}:Workspace Profile.workspaceRef}}`;
	const clonePathTemplate = `{{@${cloneId}:Workspace Clone.clonePath}}`;

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
					name: "claude-plan-workspace",
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
			id: claudePlanId,
			type: "action",
			position: { x: 420, y: 0 },
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
					approvalTimeoutMinutes: input.approvalTimeoutMinutes,
					executeAfterApproval: "false",
					maxTurns: input.maxTurns,
				},
				status: "idle",
			},
		},
		{
			id: materializePlanId,
			type: "action",
			position: { x: 720, y: 0 },
			data: {
				label: "Materialize Plan Files",
				description:
					"Write tasks.json/plan.json/metadata.json into workspace for downstream task runners",
				type: "action",
				config: {
					actionType: "durable/materialize-plan",
					artifactRef: `{{@${claudePlanId}:Claude Plan.artifactRef}}`,
					workspaceRef: workspaceRefTemplate,
					outputDir: `{{@${cloneId}:Workspace Clone.clonePath}}/.workflow/plans/{{@${claudePlanId}:Claude Plan.artifactRef}}`,
				},
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
			approvalTimeoutMinutes: args.approvalTimeoutMinutes,
			maxTurns: args.maxTurns,
		});

		const workflowId = generateId();
		const [created] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: args.name,
				description:
					"Programmatically created workflow using workspace sandbox + clone + durable/claude-plan + durable/materialize-plan",
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
		console.log(`  open: /workflows/${created.id}`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create Claude planning workflow:", error);
	process.exit(1);
});
