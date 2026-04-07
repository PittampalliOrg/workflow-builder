/**
 * Upsert the "Claude Code Agent Loop Demo" workflow into the database.
 *
 * Modeled on scripts/upsert-durable-agent-loop-workflow.mjs — uses the same
 * visual workflow structure but routes through "claude/run" instead of
 * "openshell/run", exercising the claude-code-agent service.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-claude-code-agent-loop-workflow.mjs
 *   DATABASE_URL=... node scripts/upsert-claude-code-agent-loop-workflow.mjs --user-email admin@example.com
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID = process.env.WORKFLOW_ID || "claudecodeagentloopdemo1";
const WORKFLOW_NAME =
	process.env.WORKFLOW_NAME || "Claude Code Agent Loop Demo";
const WORKFLOW_DESCRIPTION =
	process.env.WORKFLOW_DESCRIPTION ||
	"Single-agent Claude Code durable workflow that performs a moderate multi-step autonomous loop before stopping.";
const DEFAULT_PROMPT =
	process.env.WORKFLOW_PROMPT ||
	[
		"You have a ready workspace rooted at /sandbox.",
		"Complete this task autonomously using the available tools.",
		"",
		"Task:",
		"1. Inspect the workspace to identify the top-level project structure.",
		"2. Determine the primary package manager / workspace files in the repository root.",
		"3. Create a markdown report at /sandbox/agent-loop-analysis.md with these sections:",
		"   - Workspace Summary",
		"   - Top-Level Directories",
		"   - Build / Package Signals",
		"   - Verification",
		"4. In the report, include a short bullet summary of what you found.",
		"5. Verify the file exists and contains those headings.",
		"6. Only after verification succeeds, provide a concise answer summarizing what you created and verified.",
		"",
		"Constraints:",
		"- Use multiple steps if needed; do not try to do everything in one giant shell command.",
		"- Do not modify project source files other than the report file in /sandbox.",
		"- If verification fails, fix the report and verify again before stopping.",
	].join("\n");

function parseArgs(argv) {
	let userEmail = "";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--user-email") {
			userEmail = String(argv[i + 1] || "").trim();
			i += 1;
		}
	}
	return { userEmail };
}

async function resolveOwner(sql, existingWorkflow, userEmail) {
	if (existingWorkflow?.user_id) {
		return {
			userId: existingWorkflow.user_id,
			projectId: existingWorkflow.project_id || null,
		};
	}

	if (userEmail) {
		const rows = await sql`
			select u.id as user_id, pm.project_id
			from users u
			left join project_members pm on pm.user_id = u.id
			where lower(u.email) = lower(${userEmail})
			order by pm.created_at asc nulls last
			limit 1
		`;
		if (rows[0]?.user_id) {
			return {
				userId: rows[0].user_id,
				projectId: rows[0].project_id || null,
			};
		}
	}

	const memberRows = await sql`
		select pm.user_id, pm.project_id
		from project_members pm
		order by pm.created_at asc
		limit 1
	`;
	if (memberRows[0]?.user_id) {
		return {
			userId: memberRows[0].user_id,
			projectId: memberRows[0].project_id || null,
		};
	}

	const userRows = await sql`
		select id as user_id
		from users
		order by created_at asc
		limit 1
	`;
	if (userRows[0]?.user_id) {
		return { userId: userRows[0].user_id, projectId: null };
	}

	throw new Error("Could not resolve a workflow owner.");
}

function createAgentTask() {
	return {
		call: "claude/run",
		with: {
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			prompt: DEFAULT_PROMPT,
			mode: "execute_direct",
			maxTurns: 8,
			timeoutMinutes: 20,
			agentConfig: {
				name: "claude-code-agent-loop-demo",
				instructions:
					"Reason step by step about what to do next. Use tools for inspection, file creation, and verification. Stop only after successful verification.",
				modelSpec: "",
				tools: [
					"Bash",
					"Read",
					"Write",
					"Edit",
					"Glob",
					"Grep",
				],
				memory: {
					backend: "dapr_state",
					sessionId: "claude-code-agent-loop-demo-session",
				},
			},
		},
	};
}

function buildWorkflowPayload() {
	const workspaceLabel = "Workspace Profile";
	const agentLabel = "Claude Code Loop Agent";
	const workspaceTask = {
		call: "workspace/profile",
		with: {
			name: "claude-code-agent-loop-workspace",
			rootPath: "/sandbox",
			enabledTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
			timeoutMs: 120000,
			commandTimeoutMs: 120000,
			sandboxTemplate: "dapr-agent",
		},
	};
	const agentTask = createAgentTask();

	const nodes = [
		{
			id: "__start__",
			type: "start",
			position: { x: 240, y: 60 },
			data: {
				label: "Start",
				type: "start",
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "workspace-profile",
			type: "call",
			position: { x: 240, y: 180 },
			data: {
				label: workspaceLabel,
				type: "call",
				taskConfig: workspaceTask,
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "claude-code-task",
			type: "agent",
			position: { x: 240, y: 340 },
			data: {
				label: agentLabel,
				type: "agent",
				taskConfig: agentTask,
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "__end__",
			type: "end",
			position: { x: 240, y: 500 },
			data: {
				label: "End",
				type: "end",
				status: "idle",
				enabled: true,
			},
		},
	];

	const edges = [
		{
			id: "edge-start-workspace",
			source: "__start__",
			target: "workspace-profile",
		},
		{
			id: "edge-workspace-agent",
			source: "workspace-profile",
			target: "claude-code-task",
		},
		{
			id: "edge-agent-end",
			source: "claude-code-task",
			target: "__end__",
		},
	];

	const state = {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder",
			name: "claude-code-agent-loop-demo",
			version: "1.0.0",
			title: WORKFLOW_NAME,
			summary: WORKFLOW_DESCRIPTION,
		},
		do: [
			{ workspace_profile: { ...workspaceTask } },
			{ claude_code_agent_loop_demo: { ...agentTask } },
		],
	};

	return {
		name: WORKFLOW_NAME,
		description: WORKFLOW_DESCRIPTION,
		nodes,
		edges,
		visibility: "public",
		spec: state,
	};
}

async function upsertWorkflow(sql, owner) {
	const payload = buildWorkflowPayload();

	const existingRows = await sql`
		select id, user_id, project_id
		from workflows
		where id = ${WORKFLOW_ID}
		limit 1
	`;
	const existing = existingRows[0] ?? null;

	if (existing) {
		await sql`
			update workflows
			set
				name = ${payload.name},
				description = ${payload.description},
				nodes = ${sql.json(payload.nodes)},
				edges = ${sql.json(payload.edges)},
				visibility = ${payload.visibility},
				spec = ${sql.json(payload.spec)},
				updated_at = now()
			where id = ${WORKFLOW_ID}
		`;
		return { workflowId: WORKFLOW_ID, created: false };
	}

	await sql`
		insert into workflows (
			id, name, description, nodes, edges, visibility, spec,
			user_id, project_id, created_at, updated_at
		) values (
			${WORKFLOW_ID}, ${payload.name}, ${payload.description},
			${sql.json(payload.nodes)}, ${sql.json(payload.edges)},
			${payload.visibility}, ${sql.json(payload.spec)},
			${owner.userId}, ${owner.projectId}, now(), now()
		)
	`;
	return { workflowId: WORKFLOW_ID, created: true };
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is required");
	}
	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		const existingRows = await sql`
			select id, user_id, project_id
			from workflows
			where id = ${WORKFLOW_ID}
			limit 1
		`;
		const owner = await resolveOwner(
			sql,
			existingRows[0] ?? null,
			args.userEmail,
		);
		const result = await upsertWorkflow(sql, owner);
		console.log(
			JSON.stringify(
				{
					workflowId: result.workflowId,
					created: result.created,
					name: WORKFLOW_NAME,
				},
				null,
				2,
			),
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error("[upsert-claude-code-agent-loop-workflow] Error:", error);
	process.exitCode = 1;
});
