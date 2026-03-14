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
	"Multi-step opencode flow: planning, execution, change verification, then commit/push/PR";
const MS_AGENT_WORKFLOW_ID = "msagtwf0travelplnr001";
const MS_AGENT_WORKFLOW_NAME = "Microsoft Agent Travel Planner";
const MS_AGENT_WORKFLOW_DESCRIPTION =
	"Reference workflow that runs the Python Dapr + Microsoft Agent Framework travel planner.";
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
					model: "openai/gpt-5.2-codex",
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
						modelSpec: "openai/gpt-5.2-codex",
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
					model: "openai/gpt-5.2-codex",
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
						modelSpec: "openai/gpt-5.2-codex",
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

function buildMsAgentNodes() {
	return normalizeWorkflowNodes([
		{
			id: "tr_msagent_1",
			type: "trigger",
			position: { x: -220, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: "ac_msagent_1",
			type: "action",
			position: { x: 60, y: 0 },
			data: {
				label: "Travel Planner",
				description:
					"Run the Python Dapr workflow backed by Microsoft Agent Framework agents.",
				type: "action",
				config: {
					actionType: "ms-agent/run",
					workflowTemplateId: "travel-planner",
					prompt:
						"Plan a 3-day trip to Kyoto with temples, local food, and one relaxed evening.",
					timeoutMinutes: "10",
				},
				status: "idle",
			},
		},
	]);
}

function buildMsAgentEdges() {
	return [
		{
			id: "e_msagent_1",
			type: "animated",
			source: "tr_msagent_1",
			target: "ac_msagent_1",
			sourceHandle: null,
			targetHandle: null,
		},
	];
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
}) {
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
			visibility: "private",
			engineType: "dapr",
		});
		console.log(
			`[seed-workflows] Created workflow ${params.workflowId} for user ${params.userId}`,
		);
		return;
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
			visibility: "private",
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
			workflowId: MS_AGENT_WORKFLOW_ID,
			name: MS_AGENT_WORKFLOW_NAME,
			description: MS_AGENT_WORKFLOW_DESCRIPTION,
			userId,
			projectId,
			nodes: buildMsAgentNodes(),
			edges: buildMsAgentEdges(),
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
