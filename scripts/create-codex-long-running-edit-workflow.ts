/**
 * Create a long-running codex edit workflow with explicit UI-visible diff outputs:
 * trigger -> workspace/profile -> workspace/clone -> durable/run (execute_direct) -> review commands
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-codex-long-running-edit-workflow.ts --branch dev
 *   DATABASE_URL=... pnpm tsx scripts/create-codex-long-running-edit-workflow.ts --repo owner/name --branch feature/my-branch
 *   DATABASE_URL=... pnpm tsx scripts/create-codex-long-running-edit-workflow.ts --name "Codex Long Running Edit"
 *   DATABASE_URL=... pnpm tsx scripts/create-codex-long-running-edit-workflow.ts --user-email admin@example.com --branch dev
 *   DATABASE_URL=... pnpm tsx scripts/create-codex-long-running-edit-workflow.ts --connection-external-id github-main --branch dev
 */

import { desc, eq } from "drizzle-orm";
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

const DEFAULT_PROMPT = `Perform a complex coding task in this repository:
1) identify duplicated implementation patterns and consolidate them into reusable functions/modules
2) update all callsites to use the refactor
3) add or update tests for the changed behavior
4) update docs/changelog notes for the refactor
5) run available validation commands (type-check/lint/test/build) and fix issues before finishing

Return a concise summary of edits and validation results.`;

const DEFAULT_REPO_OWNER = "PittampalliOrg";
const DEFAULT_REPO_NAME = "codex";
const DEFAULT_MODEL = "openai/gpt-5.2-codex";
const DATABASE_URL = process.env.DATABASE_URL;

type Args = {
	userEmail?: string;
	name: string;
	prompt: string;
	agentProfileTemplateId?: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
	model: string;
	maxTurns: number;
	timeoutMinutes: number;
	diffPreviewLines: number;
};

function parseIntArg(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function parseArgs(argv: string[]): Args {
	let userEmail: string | undefined;
	let name = "Codex Long Running Edit + Diff Review";
	let prompt = DEFAULT_PROMPT;
	let agentProfileTemplateId: string | undefined;
	let repositoryOwner = DEFAULT_REPO_OWNER;
	let repositoryRepo = DEFAULT_REPO_NAME;
	let repositoryBranch = "";
	let targetDir: string | undefined;
	let connectionExternalId: string | undefined;
	let model = DEFAULT_MODEL;
	let maxTurns = 260;
	let timeoutMinutes = 60;
	let diffPreviewLines = 800;

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
		if (arg === "--agent-profile-template-id") {
			agentProfileTemplateId = argv[i + 1]?.trim() || undefined;
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
		if (arg === "--max-turns") {
			maxTurns = parseIntArg(argv[i + 1], maxTurns);
			i++;
			continue;
		}
		if (arg === "--timeout-minutes") {
			timeoutMinutes = parseIntArg(argv[i + 1], timeoutMinutes);
			i++;
			continue;
		}
		if (arg === "--diff-preview-lines") {
			diffPreviewLines = parseIntArg(argv[i + 1], diffPreviewLines);
			i++;
		}
	}

	return {
		userEmail,
		name,
		prompt,
		agentProfileTemplateId,
		repositoryOwner: repositoryOwner.trim(),
		repositoryRepo: repositoryRepo.trim(),
		repositoryBranch: repositoryBranch.trim(),
		targetDir: targetDir?.trim() || undefined,
		connectionExternalId: connectionExternalId?.trim() || undefined,
		model: model.trim() || DEFAULT_MODEL,
		maxTurns,
		timeoutMinutes,
		diffPreviewLines,
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
		if (!user) throw new Error(`User not found for email: ${userEmail}`);
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
	if (!fallbackUser) throw new Error("No users found in database");
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

	const connections = await db.query.appConnections.findMany({
		where: eq(appConnections.ownerId, userId),
		orderBy: [desc(appConnections.updatedAt)],
		limit: 50,
	});
	const latestGithubConnection = connections.find((row) =>
		row.pieceName.toLowerCase().includes("github"),
	);
	if (latestGithubConnection) {
		return {
			connectionId: latestGithubConnection.id,
			connectionExternalId: latestGithubConnection.externalId,
		};
	}

	return {};
}

async function resolveAgentProfileTemplateId(
	db: ReturnType<typeof drizzle>,
	explicitTemplateId: string | undefined,
): Promise<string> {
	if (explicitTemplateId) return explicitTemplateId;

	const template = await db.query.agentProfileTemplates.findFirst({
		where: eq(agentProfileTemplates.isEnabled, true),
		orderBy: [
			agentProfileTemplates.sortOrder,
			desc(agentProfileTemplates.updatedAt),
		],
	});
	if (!template) {
		throw new Error(
			"No enabled agent profile templates found. Provide --agent-profile-template-id.",
		);
	}
	return template.id;
}

function buildWorkflowGraph(input: {
	prompt: string;
	agentProfileTemplateId: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	targetDir?: string;
	connectionExternalId?: string;
	connectionId?: string;
	model: string;
	maxTurns: number;
	timeoutMinutes: number;
	diffPreviewLines: number;
}) {
	const triggerId = nanoid();
	const profileId = nanoid();
	const cloneId = nanoid();
	const durableRunId = nanoid();
	const reviewNamesId = nanoid();
	const reviewStatsId = nanoid();
	const reviewPatchId = nanoid();

	const workspaceRefTemplate = `{{@${profileId}:Workspace Profile.workspaceRef}}`;
	const clonePathTemplate = `{{@${cloneId}:Workspace Clone.clonePath}}`;
	const enabledTools = JSON.stringify([
		"read",
		"write",
		"edit",
		"list",
		"bash",
	]);
	const durableTools = JSON.stringify([
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

	const reviewNamesCommand = `if [ -d .git ]; then
	echo "--- git status --short ---"
	git status --short || true
	echo "--- changed files ---"
	CHANGED="$(git diff --name-only || true)"
	if [ -z "$CHANGED" ]; then
	  echo "No file changes detected after durable run."
	else
	  printf '%s\n' "$CHANGED"
	  echo "--- changed file count ---"
	  printf '%s\n' "$CHANGED" | wc -l | tr -d ' '
	fi
else
	echo "No .git metadata found (clone strips git metadata)."
	echo "Listing files as fallback review:"
	find . -type f | sort | head -200 || true
fi`;

	const reviewStatsCommand = `if [ -d .git ]; then
	echo "--- diff stat ---"
	git diff --stat --no-color || true
	echo "--- short stat ---"
	git diff --shortstat --no-color || true
else
	echo "No .git metadata found (clone strips git metadata)."
	echo "Cannot compute git diff stats without repository metadata."
fi`;

	const reviewPatchCommand = `if [ -d .git ]; then
	echo "--- unified diff preview (first ${input.diffPreviewLines} lines) ---"
	git diff --no-color | sed -n '1,${input.diffPreviewLines}p' || true
else
	echo "No .git metadata found (clone strips git metadata)."
	echo "Cannot render unified diff preview without repository metadata."
fi`;

	const nodes = normalizeWorkflowNodes([
		{
			id: triggerId,
			type: "trigger",
			position: { x: -560, y: 0 },
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
			position: { x: -280, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create execution-scoped workspace session",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "codex-long-running-workspace",
					enabledTools,
					requireReadBeforeWrite: "true",
					commandTimeoutMs: "180000",
				},
				status: "idle",
			},
		},
		{
			id: cloneId,
			type: "action",
			position: { x: 20, y: 0 },
			data: {
				label: "Workspace Clone",
				description: "Clone target repository",
				type: "action",
				config: cloneConfig,
				status: "idle",
			},
		},
		{
			id: durableRunId,
			type: "action",
			position: { x: 320, y: 0 },
			data: {
				label: "Durable Agent Edit (Long Run)",
				description: "Long-running direct execution with required file edits",
				type: "action",
				config: {
					actionType: "durable/run",
					mode: "execute_direct",
					agentProfileTemplateId: input.agentProfileTemplateId,
					prompt: input.prompt,
					model: input.model,
					tools: durableTools,
					instructions:
						"Work directly in the repository. Do not ask clarifying questions. Make concrete file edits and run validations before finalizing.",
					stopCondition:
						"File changes are complete, validation commands have been run, and a concise change summary is ready.",
					workspaceRef: workspaceRefTemplate,
					cwd: clonePathTemplate,
					maxTurns: String(input.maxTurns),
					timeoutMinutes: String(input.timeoutMinutes),
					requireFileChanges: "true",
					cleanupWorkspace: "false",
				},
				status: "idle",
			},
		},
		{
			id: reviewNamesId,
			type: "action",
			position: { x: 620, y: -120 },
			data: {
				label: "Review Changed Files",
				description: "UI-visible list of changed files",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: reviewNamesCommand,
					timeoutMs: "180000",
					continueOnError: true,
				},
				status: "idle",
			},
		},
		{
			id: reviewStatsId,
			type: "action",
			position: { x: 920, y: -120 },
			data: {
				label: "Review Diff Stats",
				description: "UI-visible diff stat summary",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: reviewStatsCommand,
					timeoutMs: "180000",
					continueOnError: true,
				},
				status: "idle",
			},
		},
		{
			id: reviewPatchId,
			type: "action",
			position: { x: 1220, y: -120 },
			data: {
				label: "Review Diff Preview",
				description: "UI-visible unified diff preview",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: workspaceRefTemplate,
					command: reviewPatchCommand,
					timeoutMs: "180000",
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
			target: durableRunId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: durableRunId,
			target: reviewNamesId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: reviewNamesId,
			target: reviewStatsId,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: nanoid(),
			type: "animated",
			source: reviewStatsId,
			target: reviewPatchId,
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
	if (!args.repositoryBranch) {
		throw new Error(
			"repository branch is required. Pass --branch <name> to avoid implicit defaults.",
		);
	}

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

		const { nodes, edges } = buildWorkflowGraph({
			prompt: args.prompt,
			agentProfileTemplateId,
			repositoryOwner: args.repositoryOwner,
			repositoryRepo: args.repositoryRepo,
			repositoryBranch: args.repositoryBranch,
			targetDir: args.targetDir,
			connectionExternalId,
			connectionId,
			model: args.model,
			maxTurns: args.maxTurns,
			timeoutMinutes: args.timeoutMinutes,
			diffPreviewLines: args.diffPreviewLines,
		});

		const workflowId = generateId();
		const [created] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: args.name,
				description:
					"Long-running codex edit workflow with explicit changed-files and diff review outputs for UI inspection.",
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
		console.log(`  model: ${args.model}`);
		console.log(`  maxTurns: ${args.maxTurns}`);
		console.log(`  timeoutMinutes: ${args.timeoutMinutes}`);
		console.log(`  diffPreviewLines: ${args.diffPreviewLines}`);
		console.log(`  agentProfileTemplateId: ${agentProfileTemplateId}`);
		console.log(`  githubConnection: ${connectionExternalId ?? "none"}`);
		console.log(`  open: /workflows/${created.id}`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("Failed to create long-running codex workflow:", error);
	process.exit(1);
});
