/**
 * Create or update a workflow that exercises the canonical OpenShell agent path:
 * trigger -> workspace/profile -> workspace/clone -> openshell/run (plan)
 * -> openshell/run (execute)
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-agent-workflow.ts
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-agent-workflow.ts --repo PittampalliOrg/workflow-builder --branch main
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-agent-workflow.ts --agent-profile-template-id profile_xxx
 */

import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
	appConnections,
	projectMembers,
	projects,
	users,
	workflows,
} from "../lib/db/schema";
import {
	applyResourcePresetsToNodes,
	persistWorkflowResourceRefs,
} from "../lib/workflows/apply-resource-presets";
import { generateId } from "../lib/utils/id";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_NAME = "OpenShell Agent Smoke";
const DEFAULT_REPOSITORY_OWNER = "PittampalliOrg";
const DEFAULT_REPOSITORY_REPO = "workflow-builder";
const DEFAULT_REPOSITORY_BRANCH = "main";
const DEFAULT_TARGET_DIR = "workflow-builder";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_VERIFY_COMMANDS = `python -m py_compile scripts/langgraph_smoke_report.py
python scripts/langgraph_smoke_report.py`;
const DEFAULT_PROMPT = `Plan how to add a new Python script at scripts/langgraph_smoke_report.py. The script should recursively scan the services directory for files named app.py, print a JSON object with a sorted list of matching relative file paths, and include a count. Use only the Python standard library, add a clear main entrypoint, and avoid modifying unrelated files.

Return a concrete implementation plan only. Do not modify files during this planning step.

## Stop Condition
The final response is a concise implementation plan with the target files, main steps, and verification commands needed for the execute step.`;

type Args = {
	userEmail?: string;
	name: string;
	prompt: string;
	verifyCommands: string;
	agentProfileTemplateId?: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
};

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = DEFAULT_NAME;
	let prompt = DEFAULT_PROMPT;
	let verifyCommands = DEFAULT_VERIFY_COMMANDS;
	let agentProfileTemplateId: string | undefined;
	let repositoryOwner = DEFAULT_REPOSITORY_OWNER;
	let repositoryRepo = DEFAULT_REPOSITORY_REPO;
	let repositoryBranch = DEFAULT_REPOSITORY_BRANCH;
	let targetDir = DEFAULT_TARGET_DIR;
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
		} else if (arg === "--verify-commands") {
			verifyCommands = argv[i + 1] || verifyCommands;
			i++;
		} else if (arg === "--agent-profile-template-id") {
			agentProfileTemplateId = argv[i + 1] || agentProfileTemplateId;
			i++;
		} else if (arg === "--repo") {
			const parsed = parseRepoRef(argv[i + 1] || "");
			if (parsed) {
				repositoryOwner = parsed.owner;
				repositoryRepo = parsed.repo;
			}
			i++;
		} else if (arg === "--repo-owner") {
			repositoryOwner = argv[i + 1] || repositoryOwner;
			i++;
		} else if (arg === "--repo-name" || arg === "--repo-repo") {
			repositoryRepo = argv[i + 1] || repositoryRepo;
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
		verifyCommands,
		agentProfileTemplateId: agentProfileTemplateId?.trim() || undefined,
		repositoryOwner: repositoryOwner.trim(),
		repositoryRepo: repositoryRepo.trim(),
		repositoryBranch: repositoryBranch.trim(),
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

function buildWorkflowNodes(input: {
	prompt: string;
	verifyCommands: string;
	agentProfileTemplateId?: string;
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
	const planId = nanoid();
	const executeId = nanoid();

	const enabledTools = JSON.stringify([
		"read",
		"write",
		"edit",
		"list",
		"bash",
	]);
	const workspaceRefTemplate = `{{@${workspaceProfileId}:Workspace Profile.workspaceRef}}`;
	const clonePathTemplate = `{{@${cloneId}:Workspace Clone.clonePath}}`;
	const artifactRefTemplate = `{{@${planId}:LangGraph Plan.artifactRef}}`;

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

	const commonAgentConfig: Record<string, string> = {
		actionType: "durable/run",
		engine: "langgraph",
		model: DEFAULT_MODEL,
		workspaceRef: workspaceRefTemplate,
		cwd: clonePathTemplate,
		expectedOutput:
			"A concise implementation summary, changed-file list, and verification results.",
		verifyCommands: input.verifyCommands,
		toolPolicy: "all",
		writePolicy: "workspace-only",
		shellPolicy: "workspace-safe",
		timeoutMinutes: "45",
		maxTurns: "60",
		stopCondition:
			"The requested smoke-task change exists, verification passes, and the final response includes changed files plus a concise summary.",
	};
	if (input.agentProfileTemplateId) {
		commonAgentConfig.agentProfileTemplateId = input.agentProfileTemplateId;
	}

	const nodes = normalizeWorkflowNodes([
		{
			id: triggerId,
			type: "trigger",
			position: { x: -640, y: 0 },
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
			position: { x: -340, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create an execution-scoped workspace session",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "openshell-langgraph-smoke",
					enabledTools,
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: cloneId,
			type: "action",
			position: { x: -40, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone the target repository into the workspace",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: planId,
			type: "action",
			position: { x: 260, y: 0 },
			data: {
				label: "LangGraph Plan",
				description:
					"Generate the LangGraph-backed implementation plan and persist the artifact for execution.",
				type: "action",
				config: {
					...commonAgentConfig,
					mode: "plan_mode",
					profile: "feature-delivery",
					prompt: input.prompt,
					maxTurns: "20",
					autoApprovePlan: "true",
					autoApproveReason:
						"Auto-approved for LangGraph plan-and-execute smoke testing",
					autoApproveActor: "system:langgraph-smoke",
					executeAfterApproval: "false",
					approvalTimeoutMinutes: "30",
				},
				status: "idle",
			},
		},
		{
			id: executeId,
			type: "action",
			position: { x: 580, y: 0 },
			data: {
				label: "LangGraph Execute",
				description:
					"Execute the approved plan with the same LangGraph Dapr agent runtime.",
				type: "action",
				config: {
					...commonAgentConfig,
					mode: "execute_direct",
					profile: "implement",
					prompt:
						"Implement the approved smoke-task plan in the repository clone.",
					artifactRef: artifactRefTemplate,
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
			target: planId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: planId,
			target: executeId,
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
	const client = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(client, {
		schema: { users, projects, projectMembers, workflows, appConnections },
	});

	try {
		const { userId, email } = await resolveUserId(db, args.userEmail);
		const projectId = await resolveProjectId(db, userId);
		const connectionId = await resolveConnectionId(
			db,
			userId,
			args.connectionExternalId,
		);
		const built = buildWorkflowNodes({
			prompt: args.prompt,
			verifyCommands: args.verifyCommands,
			agentProfileTemplateId: args.agentProfileTemplateId,
			repositoryOwner: args.repositoryOwner,
			repositoryRepo: args.repositoryRepo,
			repositoryBranch: args.repositoryBranch,
			targetDir: args.targetDir,
			connectionExternalId: args.connectionExternalId,
			connectionId,
		});

		const presetApplied = await applyResourcePresetsToNodes({
			nodes: built.nodes,
			userId,
			projectId,
		});

		const existing = await db.query.workflows.findFirst({
			where: and(eq(workflows.userId, userId), eq(workflows.name, args.name)),
		});

		if (existing) {
			const [updated] = await db
				.update(workflows)
				.set({
					description:
						"Smoke workflow for the LangGraph-backed Dapr agent plan-and-execute path.",
					nodes: presetApplied.nodes,
					edges: built.edges,
					updatedAt: new Date(),
				})
				.where(eq(workflows.id, existing.id))
				.returning();
			await persistWorkflowResourceRefs({
				workflowId: updated.id,
				refs: presetApplied.refs,
			});
			console.log(
				JSON.stringify(
					{
						action: "updated",
						workflowId: updated.id,
						name: updated.name,
						userId,
						userEmail: email,
					},
					null,
					2,
				),
			);
			return;
		}

		const [created] = await db
			.insert(workflows)
			.values({
				id: generateId(),
				name: args.name,
				description:
					"Smoke workflow for the LangGraph-backed Dapr agent plan-and-execute path.",
				nodes: presetApplied.nodes,
				edges: built.edges,
				userId,
				projectId,
			})
			.returning();

		await persistWorkflowResourceRefs({
			workflowId: created.id,
			refs: presetApplied.refs,
		});

		console.log(
			JSON.stringify(
				{
					action: "created",
					workflowId: created.id,
					name: created.name,
					userId,
					userEmail: email,
				},
				null,
				2,
			),
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error("[create-langgraph-agent-workflow] Error:", error);
	process.exit(1);
});
