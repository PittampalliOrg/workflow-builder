/**
 * Create a workflow that uses the new workspace + durable agent pattern:
 * trigger -> workspace/profile -> workspace/clone -> durable/run (plan mode)
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name --user-email admin@example.com
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name --name "Workspace Agent Starter"
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name --prompt "Implement X"
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name --agent-profile-template-id profile_xxx
 *   DATABASE_URL=... pnpm tsx scripts/create-workspace-agent-workflow.ts --repo owner/name --connection-external-id github-main
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

const DEFAULT_PROMPT =
	"Use workspace tools to inspect the repo, make the required changes, and summarize what changed.";

const DATABASE_URL = process.env.DATABASE_URL;

type Args = {
	userEmail?: string;
	name: string;
	prompt: string;
	agentProfileTemplateId: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
};

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = "Workspace Agent Starter";
	let prompt = DEFAULT_PROMPT;
	let agentProfileTemplateId = "";
	let repositoryOwner = "";
	let repositoryRepo = "";
	let repositoryBranch = "main";
	let targetDir: string | undefined;
	let connectionExternalId: string | undefined;

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
		} else if (arg === "--agent-profile-template-id") {
			agentProfileTemplateId = argv[i + 1] || agentProfileTemplateId;
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
		}
	}

	return {
		userEmail,
		name,
		prompt,
		agentProfileTemplateId: agentProfileTemplateId.trim(),
		repositoryOwner: repositoryOwner.trim(),
		repositoryRepo: repositoryRepo.trim(),
		repositoryBranch: repositoryBranch.trim() || "main",
		targetDir: targetDir?.trim() || undefined,
		connectionExternalId: connectionExternalId?.trim() || undefined,
	};
}

async function resolveUserId(
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

function buildWorkflowNodes(input: {
	prompt: string;
	agentProfileTemplateId: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
	connectionId?: string;
}) {
	const triggerId = nanoid();
	const workspaceProfileId = nanoid();
	const cloneId = nanoid();
	const durableAgentId = nanoid();

	const enabledTools = JSON.stringify([
		"read",
		"write",
		"edit",
		"list",
		"bash",
	]);

	const workspaceRefTemplate = `{{@${workspaceProfileId}:Workspace Profile.workspaceRef}}`;
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
			id: workspaceProfileId,
			type: "action",
			position: { x: -160, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create an execution-scoped workspace session",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "repo-workspace",
					enabledTools,
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "30000",
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
				description: "Clone repository into workspace",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: durableAgentId,
			type: "action",
			position: { x: 400, y: 0 },
			data: {
				label: "Durable Agent",
				description:
					"Create a plan, wait for approval, then execute in a single durable run",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "plan_mode",
					agentProfileTemplateId: input.agentProfileTemplateId,
					prompt: input.prompt,
					workspaceRef: workspaceRefTemplate,
					cwd: clonePathTemplate,
					approvalTimeoutMinutes: "60",
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
			target: workspaceProfileId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: workspaceProfileId,
			target: cloneId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: cloneId,
			target: durableAgentId,
			sourceHandle: null,
			targetHandle: null,
		},
	];

	return { nodes, edges };
}

async function resolveConnectionId(
	db: ReturnType<typeof drizzle>,
	userId: string,
	connectionExternalId: string | undefined,
): Promise<string | undefined> {
	if (!connectionExternalId) return undefined;

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

	return row.id;
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error(
			"DATABASE_URL is required. Provide a production connection string.",
		);
	}

	const args = parseArgs(process.argv.slice(2));
	const client = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(client, {
		schema: { users, projects, projectMembers, workflows, appConnections },
	});

	try {
		if (!args.repositoryOwner || !args.repositoryRepo) {
			throw new Error(
				"Repository is required. Provide --repo owner/name (or --repo-owner + --repo-name).",
			);
		}
		if (!args.agentProfileTemplateId) {
			throw new Error(
				"Agent profile template is required. Provide --agent-profile-template-id <templateId>.",
			);
		}

		const { userId, email } = await resolveUserId(db, args.userEmail);
		const projectId = await resolveProjectId(db, userId);
		const connectionId = await resolveConnectionId(
			db,
			userId,
			args.connectionExternalId,
		);
		const { nodes, edges } = buildWorkflowNodes({
			prompt: args.prompt,
			agentProfileTemplateId: args.agentProfileTemplateId,
			repositoryOwner: args.repositoryOwner,
			repositoryRepo: args.repositoryRepo,
			repositoryBranch: args.repositoryBranch,
			targetDir: args.targetDir,
			connectionExternalId: args.connectionExternalId,
			connectionId,
		});

		const workflowId = generateId();
		const [created] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: args.name,
				description:
					"Programmatically created workspace-agent workflow (profile -> clone -> durable plan mode)",
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
		console.log(`  open: /workflows/${created.id}`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create workspace-agent workflow:", error);
	process.exit(1);
});
