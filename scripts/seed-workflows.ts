/**
 * Seed canonical workflows after cluster/database recreation.
 *
 * Current scope:
 * - Upsert workflow lazxidq045szbb9ke4dny (Opencode Agent Plan Then Execute PR)
 * - Reconcile workflow_resource_refs for durable plan/execute nodes
 *
 * User/project targeting:
 * - Prefer SEED_GITHUB_USER_ID
 * - Fallback to SEED_GITHUB_USER_EMAIL
 * - Fallback to single GitHub identity in DB
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	agentProfileTemplateVersions,
	projectMembers,
	projects,
	userIdentities,
	users,
	workflowResourceRefs,
	workflows,
} from "../lib/db/schema";
import { generateId } from "../lib/utils/id";
import { normalizeWorkflowNodes } from "../lib/workflows/normalize-nodes";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

const WORKFLOW_ID = "lazxidq045szbb9ke4dny";
const WORKFLOW_NAME = "Opencode Agent Plan Then Execute PR";
const WORKFLOW_DESCRIPTION =
	"Two-step opencode flow: planning first, execution second, then commit/push/PR";
const AGENT_PROFILE_TEMPLATE_ID = "tpl_coding_agent";

const IDs = {
	trigger: "tr_1771706813719",
	profile: "pf_1771706813719",
	clone: "cl_1771706813719",
	branch: "br_1771706813719",
	plan: "pl_1771706813719",
	execute: "ex_1771706813719",
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
];

const AGENT_INSTRUCTIONS =
	"You are an autonomous coding agent operating on a real git workspace. Inspect relevant files before changing code, then make concrete file edits instead of returning only a plan. When code changes are requested, run targeted validation commands and iterate until failures are addressed. Prefer direct replacement of stale legacy code when a better implementation is required. Before finishing, confirm git diff is non-empty and report changed files, validation commands, and any remaining risks.";

async function resolveGithubUserId(db: ReturnType<typeof drizzle>) {
	const configuredUserId = process.env.SEED_GITHUB_USER_ID?.trim();
	const configuredEmail = process.env.SEED_GITHUB_USER_EMAIL?.trim();

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
					repositoryRepo: "feature-flags",
					repositoryOwner: "PittampalliOrg",
					repositoryToken: "developer",
					repositoryBranch: "main",
					repositoryUsername: "giteaAdmin",
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
					model: "openai/gpt-5.2-codex",
					prompt:
						"Analyze the repository and produce a concise implementation plan to create OPENCODE_PLAN_EXECUTION_E2E.md at repository root. The file must contain: title 'Opencode Plan+Execute E2E', one sentence saying it was produced by plan+execute workflow, and exactly 3 bullets: plan-summary, edits-performed, validation-note. Return a clear, step-by-step plan in <proposed_plan> format.",
					maxTurns: "260",
					timeoutMinutes: "120",
					workspaceRef,
					cwd: clonePath,
					agentConfig: {
						name: "Coding Agent",
						tools: ["glob", "grep", "read", "edit", "write", "bash"],
						maxTurns: 260,
						modelSpec: "openai/gpt-5.2-codex",
						instructions: AGENT_INSTRUCTIONS,
						timeoutMinutes: 120,
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
					model: "openai/gpt-5.2-codex",
					prompt:
						"Execute the approved plan below and perform real file edits in the repository.\n\n<plan>\n{{@pl_1771706813719:Plan Changes.result.planMarkdown}}\n</plan>\n\nRequired outcome: OPENCODE_PLAN_EXECUTION_E2E.md exists at repo root with the requested title, sentence, and exactly three bullets.",
					maxTurns: "260",
					timeoutMinutes: "120",
					workspaceRef,
					cwd: clonePath,
					stopCondition:
						"Stop when OPENCODE_PLAN_EXECUTION_E2E.md exists with required content.",
					cleanupWorkspace: "false",
					requireFileChanges: "true",
					agentConfig: {
						name: "Coding Agent",
						tools: ["glob", "grep", "read", "edit", "write", "bash"],
						maxTurns: 260,
						modelSpec: "openai/gpt-5.2-codex",
						instructions: AGENT_INSTRUCTIONS,
						timeoutMinutes: 120,
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
			id: IDs.commitPushPr,
			type: "action",
			position: { x: 800, y: 0 },
			data: {
				label: "Commit Push PR",
				description: "Commit changes, push branch, create PR to main",
				type: "action",
				config: {
					command:
						'set -euo pipefail; BR=opencode-planexec-{{@pf_1771706813719:Workspace Profile.executionId}}; git add -A; if git diff --cached --quiet; then echo "No staged changes after execute step"; exit 2; fi; git commit -m "feat: add plan+execute opencode e2e note"; git remote set-url origin http://giteaAdmin:developer@my-gitea-http.gitea.svc.cluster.local:3000/giteaAdmin/feature-flags.git; git push -u origin "$BR"; PR=$(curl -sS -u giteaAdmin:developer -H "Content-Type: application/json" -X POST http://my-gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/giteaAdmin/feature-flags/pulls -d "{\\"title\\":\\"Opencode plan+execute workflow: opencode-planexec-{{@pf_1771706813719:Workspace Profile.executionId}}\\",\\"head\\":\\"$BR\\",\\"base\\":\\"main\\",\\"body\\":\\"Automated workflow run with separate planning and execution steps.\\"}"); echo "$PR" | jq -r \'["PR_NUMBER="+(.number|tostring),"PR_URL="+(.html_url//""),"PR_STATE="+(.state//"")] | .[]\'; echo BRANCH=$BR; echo COMMIT=$(git rev-parse HEAD); echo REMOTE=$(git remote get-url origin)',
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
			position: { x: 1060, y: 0 },
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
			target: IDs.commitPushPr,
			sourceHandle: null,
			targetHandle: null,
		},
		{
			id: EDGE_IDS[6],
			type: "animated",
			source: IDs.commitPushPr,
			target: IDs.cleanup,
			sourceHandle: null,
			targetHandle: null,
		},
	];
}

async function seedWorkflow() {
	console.log("[seed-workflows] Starting workflow seed...");
	const sql = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(sql, {
		schema: {
			agentProfileTemplateVersions,
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
		const profileVersion = await resolveAgentProfileVersion(db);
		const nodes = buildNodes(profileVersion);
		const edges = buildEdges();

		const existing = await db.query.workflows.findFirst({
			where: eq(workflows.id, WORKFLOW_ID),
		});

		if (!existing) {
			await db.insert(workflows).values({
				id: WORKFLOW_ID,
				name: WORKFLOW_NAME,
				description: WORKFLOW_DESCRIPTION,
				userId,
				projectId,
				nodes,
				edges,
				visibility: "private",
				engineType: "dapr",
			});
			console.log(
				`[seed-workflows] Created workflow ${WORKFLOW_ID} for user ${userId}`,
			);
		} else {
			await db
				.update(workflows)
				.set({
					name: WORKFLOW_NAME,
					description: WORKFLOW_DESCRIPTION,
					userId,
					projectId,
					nodes,
					edges,
					visibility: "private",
					engineType: "dapr",
					updatedAt: new Date(),
				})
				.where(eq(workflows.id, WORKFLOW_ID));
			console.log(
				`[seed-workflows] Reconciled workflow ${WORKFLOW_ID} for user ${userId}`,
			);
		}

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
		console.log("[seed-workflows] Completed successfully");
	} finally {
		await sql.end();
	}
}

seedWorkflow().catch((error) => {
	console.error("[seed-workflows] Failed:", error);
	process.exit(1);
});
