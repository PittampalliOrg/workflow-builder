/**
 * Create or update a reusable OpenShell feature-delivery workflow:
 * trigger -> workspace/profile -> workspace/clone -> openshell/run (plan)
 * -> openshell/run (execute) -> workspace/command (review)
 *
 * The manual trigger input is treated as the user feature request.
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-feature-delivery-workflow.ts
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-feature-delivery-workflow.ts --branch main
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-feature-delivery-workflow.ts --user-email you@example.com
 *   DATABASE_URL=... pnpm tsx scripts/create-langgraph-feature-delivery-workflow.ts --agent-profile-template-id tpl_coding_agent
 */

import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";
import postgres from "postgres";
import {
	agentProfileTemplates,
	appConnections,
	projectMembers,
	projects,
	users,
	workflows,
} from "../lib/db/schema";
import { generateId } from "../lib/utils/id";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";
import {
	applyResourcePresetsToNodes,
	persistWorkflowResourceRefs,
} from "../lib/workflows/apply-resource-presets";

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_NAME = "OpenShell Feature Delivery";
const DEFAULT_REPO_OWNER = "PittampalliOrg";
const DEFAULT_REPO_NAME = "workflow-builder";
const DEFAULT_REPO_BRANCH = "main";
const DEFAULT_TARGET_DIR = "workflow-builder";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_VERIFY_COMMANDS = `pnpm type-check
pnpm fix`;

function buildPlanPrompt(triggerId: string): string {
	return `You are planning a repository feature delivery task for this specific codebase.

User feature request:
{{@${triggerId}:Manual Trigger.feature_request}}

Planning requirements:
- Inspect the repository first and stay read-only during this step.
- Build a concrete implementation plan for this exact repository, not a generic solution.
- Prefer the smallest cohesive change set that satisfies the request.
- Identify the likely files/modules to touch, tests to add or update, validation commands to run, and any important risks or assumptions.
- If the request is underspecified, make the minimum necessary assumptions and state them explicitly.

Return only the final implementation plan for approval.`;
}

function buildExecutePrompt(triggerId: string): string {
	return `Implement the approved feature plan for this repository.

Original user feature request:
{{@${triggerId}:Manual Trigger.feature_request}}

Execution requirements:
- Follow the approved plan artifact as the primary source of truth.
- Match existing repository patterns and architecture.
- Keep the change set cohesive and avoid unrelated edits.
- Add or update tests when behavior changes.
- Run the provided validation commands and any targeted checks needed for the changed code.
- If the approved plan needs a small adaptation based on repository realities, make the smallest justified adjustment and explain it clearly in the final summary.

Return a concise engineering summary that includes changed files, verification results, and residual risks.`;
}

type Args = {
	userEmail?: string;
	name: string;
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
	let verifyCommands = DEFAULT_VERIFY_COMMANDS;
	let agentProfileTemplateId: string | undefined;
	let repositoryOwner = DEFAULT_REPO_OWNER;
	let repositoryRepo = DEFAULT_REPO_NAME;
	let repositoryBranch = DEFAULT_REPO_BRANCH;
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
			continue;
		}
		if (arg === "--name") {
			name = argv[i + 1] || name;
			i++;
			continue;
		}
		if (arg === "--verify-commands") {
			verifyCommands = argv[i + 1] || verifyCommands;
			i++;
			continue;
		}
		if (arg === "--agent-profile-template-id") {
			agentProfileTemplateId = argv[i + 1]?.trim() || undefined;
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
		}
	}

	return {
		userEmail,
		name,
		verifyCommands,
		agentProfileTemplateId,
		repositoryOwner: repositoryOwner.trim(),
		repositoryRepo: repositoryRepo.trim(),
		repositoryBranch: repositoryBranch.trim(),
		targetDir: targetDir?.trim() || undefined,
		connectionExternalId: connectionExternalId?.trim() || undefined,
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

async function resolveProject(
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

	const rows = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
		})
		.from(appConnections)
		.where(eq(appConnections.ownerId, userId))
		.orderBy(desc(appConnections.updatedAt));

	for (const row of rows) {
		if (!row.pieceName.toLowerCase().includes("github")) continue;
		return {
			connectionId: row.id,
			connectionExternalId: row.externalId,
		};
	}

	return {};
}

async function resolveAgentProfileTemplateId(
	db: ReturnType<typeof drizzle>,
	explicitTemplateId: string | undefined,
): Promise<string | undefined> {
	if (explicitTemplateId) return explicitTemplateId;

	const templates = await db
		.select({
			id: agentProfileTemplates.id,
			slug: agentProfileTemplates.slug,
			isEnabled: agentProfileTemplates.isEnabled,
		})
		.from(agentProfileTemplates)
		.where(eq(agentProfileTemplates.isEnabled, true))
		.orderBy(agentProfileTemplates.sortOrder, agentProfileTemplates.name);

	if (!templates.length) return undefined;

	const preferredSlugs = ["coding-agent", "feature-delivery", "implement"];
	for (const slug of preferredSlugs) {
		const match = templates.find((template) => template.slug === slug);
		if (match) return match.id;
	}

	return templates[0]?.id;
}

function buildReviewCommand(clonePathTemplate: string) {
	return `if [ -d .git ]; then
echo "--- git status --short ---"
git status --short || true
echo
echo "--- git diff --stat ---"
git diff --stat || true
else
echo "No .git metadata found. Listing likely changed project files instead."
find ${clonePathTemplate} -type f | sort | head -200 || true
fi`;
}

function buildWorkflowGraph(input: {
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
	const profileId = nanoid();
	const cloneId = nanoid();
	const planId = nanoid();
	const executeId = nanoid();
	const reviewId = nanoid();

	const workspaceRefTemplate = `{{@${profileId}:Workspace Profile.workspaceRef}}`;
	const clonePathTemplate = `{{@${cloneId}:Workspace Clone.clonePath}}`;
	const artifactRefTemplate = `{{@${planId}:LangGraph Plan.artifactRef}}`;
	const executionIdTemplate = `{{@${profileId}:Workspace Profile.executionId}}`;
	const planningThreadTemplate = `lg:plan:${executionIdTemplate}`;
	const executionThreadTemplate = `lg:exec:${executionIdTemplate}`;
	const planPrompt = buildPlanPrompt(triggerId);
	const executePrompt = buildExecutePrompt(triggerId);
	const enabledTools = JSON.stringify([
		"read",
		"write",
		"edit",
		"list",
		"bash",
	]);

	const cloneConfig: Record<string, string> = {
		actionType: "workspace/clone",
		workspaceRef: workspaceRefTemplate,
		repositoryOwner: input.repositoryOwner,
		repositoryRepo: input.repositoryRepo,
		repositoryBranch: input.repositoryBranch,
	};
	if (input.targetDir) cloneConfig.targetDir = input.targetDir;
	if (input.connectionExternalId) {
		cloneConfig.auth = `{{connections['${input.connectionExternalId}']}}`;
	}
	if (input.connectionId) {
		cloneConfig.integrationId = input.connectionId;
	}

	const commonAgentConfig: Record<string, string> = {
		actionType: "openshell/run",
		engine: "langgraph",
		model: DEFAULT_MODEL,
		workspaceRef: workspaceRefTemplate,
		cwd: clonePathTemplate,
		expectedOutput:
			"A concise engineering summary, changed-file list, verification results, and residual risks.",
		verifyCommands: input.verifyCommands,
		toolPolicy: "all",
		writePolicy: "workspace-only",
		shellPolicy: "workspace-safe",
		timeoutMinutes: "60",
		maxTurns: "80",
		stopCondition:
			"The requested feature is implemented, relevant verification has been run, and the final response includes changed files, verification results, and residual risks.",
		planningThreadId: planningThreadTemplate,
		executionThreadId: executionThreadTemplate,
	};
	if (input.agentProfileTemplateId) {
		commonAgentConfig.agentProfileTemplateId = input.agentProfileTemplateId;
	}

	const nodes = normalizeWorkflowNodes([
		{
			id: triggerId,
			type: "trigger",
			position: { x: -620, y: 0 },
			data: {
				label: "Manual Trigger",
				description:
					"Run this workflow and paste the feature request into the Run Workflow form.",
				type: "trigger",
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
			id: profileId,
			type: "action",
			position: { x: -320, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create an execution-scoped workspace session.",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "langgraph-feature-delivery",
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
			position: { x: -20, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone the target repository into the workspace.",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: planId,
			type: "action",
			position: { x: 300, y: -20 },
			data: {
				label: "LangGraph Plan",
				description:
					"Inspect the repository, build a concrete implementation plan, and wait for approval.",
				type: "action",
				config: {
					...commonAgentConfig,
					mode: "plan_mode",
					profile: "feature-delivery",
					prompt: planPrompt,
					maxTurns: "24",
					executeAfterApproval: "false",
					approvalTimeoutMinutes: "1440",
					expectedOutput:
						"An approved implementation plan with impacted files, validation steps, assumptions, and risks.",
					stopCondition:
						"An implementation plan exists for the user request and is ready for review and approval.",
				},
				status: "idle",
			},
		},
		{
			id: executeId,
			type: "action",
			position: { x: 640, y: -20 },
			data: {
				label: "LangGraph Execute",
				description:
					"Implement the approved plan, validate the changes, and summarize the result.",
				type: "action",
				config: {
					...commonAgentConfig,
					mode: "execute_direct",
					profile: "implement",
					prompt: executePrompt,
					artifactRef: artifactRefTemplate,
				},
				status: "idle",
			},
		},
		{
			id: reviewId,
			type: "action",
			position: { x: 980, y: -20 },
			data: {
				label: "Review Workspace Changes",
				description:
					"Show git-based file change context after the LangGraph execution step.",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: buildReviewCommand(clonePathTemplate),
					timeoutMs: "120000",
					continueOnError: true,
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
		{
			id: nanoid(),
			type: "animated",
			source: executeId,
			target: reviewId,
			sourceHandle: null,
			targetHandle: null,
		},
	];

	return { nodes, edges };
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is required.");
	}

	const args = parseArgs(process.argv.slice(2));
	const client = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(client, {
		schema: {
			agentProfileTemplates,
			appConnections,
			projectMembers,
			projects,
			users,
			workflows,
		},
	});

	try {
		const { userId, email } = await resolveUser(db, args.userEmail);
		const projectId = await resolveProject(db, userId);
		const { connectionId, connectionExternalId } = await resolveConnection(
			db,
			userId,
			args.connectionExternalId,
		);
		const agentProfileTemplateId = await resolveAgentProfileTemplateId(
			db,
			args.agentProfileTemplateId,
		);

		const built = buildWorkflowGraph({
			verifyCommands: args.verifyCommands,
			agentProfileTemplateId,
			repositoryOwner: args.repositoryOwner,
			repositoryRepo: args.repositoryRepo,
			repositoryBranch: args.repositoryBranch,
			targetDir: args.targetDir,
			connectionExternalId,
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
						"Reusable LangGraph plan-first coding workflow for user-supplied feature requests.",
					nodes: presetApplied.nodes,
					edges: built.edges,
					engineType: "dapr",
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
						projectId,
						repository: `${args.repositoryOwner}/${args.repositoryRepo}`,
						branch: args.repositoryBranch,
						agentProfileTemplateId: agentProfileTemplateId ?? null,
						githubConnection: connectionExternalId ?? null,
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
					"Reusable LangGraph plan-first coding workflow for user-supplied feature requests.",
				userId,
				projectId,
				nodes: presetApplied.nodes,
				edges: built.edges,
				visibility: "private",
				engineType: "dapr",
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
					projectId,
					repository: `${args.repositoryOwner}/${args.repositoryRepo}`,
					branch: args.repositoryBranch,
					agentProfileTemplateId: agentProfileTemplateId ?? null,
					githubConnection: connectionExternalId ?? null,
				},
				null,
				2,
			),
		);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create LangGraph feature-delivery workflow:", error);
	process.exit(1);
});
