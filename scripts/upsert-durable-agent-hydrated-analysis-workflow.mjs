import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID =
	process.env.WORKFLOW_ID || "durableagenthydratedanalysisdemo1";
const WORKFLOW_NAME =
	process.env.WORKFLOW_NAME || "Durable Agent Hydrated Analysis Demo";
const WORKFLOW_DESCRIPTION =
	process.env.WORKFLOW_DESCRIPTION ||
	"Single-agent OpenShell durable workflow that clones a real repository, analyzes it iteratively, verifies a report, and stops explicitly.";
const REPOSITORY_OWNER = process.env.REPOSITORY_OWNER || "PittampalliOrg";
const REPOSITORY_REPO = process.env.REPOSITORY_REPO || "workflow-builder";
const REPOSITORY_BRANCH = process.env.REPOSITORY_BRANCH || "main";
const TARGET_DIR = process.env.TARGET_DIR || "repo";
const MODEL_SPEC = process.env.MODEL_SPEC || process.env.WORKFLOW_MODEL || "";
const MAX_TURNS = Number.parseInt(process.env.MAX_TURNS || "10", 10) || 10;
const TIMEOUT_MINUTES =
	Number.parseInt(process.env.TIMEOUT_MINUTES || "25", 10) || 25;
const DEFAULT_PROMPT =
	process.env.WORKFLOW_PROMPT ||
	[
		"You have a ready OpenShell workspace and a cloned repository available at /sandbox/repo.",
		"Decide what to do next until the task is finished. Use execute_command as needed.",
		"",
		"Task:",
		"1. Inspect the real repository at /sandbox/repo.",
		"2. Review these areas at minimum:",
		"   - /sandbox/repo/src/lib/components/observability",
		"   - /sandbox/repo/services/durable-agent/src/workflow",
		"   - /sandbox/repo/src/lib/server/observability",
		"3. Create a markdown report at /sandbox/repo/agent-hydrated-analysis-report.md with these sections:",
		"   - Scope",
		"   - Key Files Reviewed",
		"   - Architecture Summary",
		"   - Risks / Gaps",
		"   - Recommended Next Improvements",
		"   - Verification",
		"4. In Key Files Reviewed, include at least 8 concrete file paths from the real repository.",
		"5. In Risks / Gaps, include at least 3 specific technical risks or weaknesses based on the files you inspected.",
		"6. In Recommended Next Improvements, include at least 3 concrete next steps.",
		"7. Run verification commands that confirm the report exists, contains all required headings, and includes at least 8 file paths.",
		"8. Only after verification succeeds, call the done tool with a concise answer summarizing what you reviewed and verified.",
		"",
		"Constraints:",
		"- Work iteratively and inspect actual files before writing conclusions.",
		"- Do not do everything in one giant shell command.",
		"- Do not modify repository source files other than creating the report.",
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

function createAgentGraph() {
	return {
		version: "v1",
		nodes: [
			{
				id: "input",
				position: { x: 120, y: 60 },
				data: { label: "Input", stepType: "input", config: {} },
			},
			{
				id: "decide",
				position: { x: 120, y: 200 },
				data: { label: "Decide", stepType: "decide", config: {} },
			},
			{
				id: "tool-batch",
				position: { x: 120, y: 340 },
				data: {
					label: "Run Commands",
					stepType: "tool_batch",
					config: {
						activeTools: ["execute_command"],
						toolChoice: "auto",
					},
				},
			},
			{
				id: "memory-write",
				position: { x: 120, y: 480 },
				data: {
					label: "Persist Memory",
					stepType: "memory_write",
					config: {},
				},
			},
			{
				id: "finish",
				position: { x: 120, y: 620 },
				data: { label: "Finish", stepType: "finish", config: {} },
			},
		],
		edges: [
			{ id: "input->decide", source: "input", target: "decide" },
			{ id: "decide->tool-batch", source: "decide", target: "tool-batch" },
			{
				id: "tool-batch->memory-write",
				source: "tool-batch",
				target: "memory-write",
			},
			{
				id: "memory-write->finish",
				source: "memory-write",
				target: "finish",
			},
		],
	};
}

function createAgentTask() {
	const cwdExpression = "${ .workspace_clone.clonePath }";
	const body = {
		prompt: DEFAULT_PROMPT,
		mode: "execute_direct",
		cwd: cwdExpression,
		model: MODEL_SPEC,
		maxTurns: MAX_TURNS,
		timeoutMinutes: TIMEOUT_MINUTES,
		loopPolicy: {
			doneTool: {
				enabled: true,
				name: "done",
				description:
					"Signal final completion only after the analysis report has been created and verified.",
				responseField: "answer",
			},
			prepareStep: {
				activeTools: ["execute_command"],
				appendInstructions:
					"Work in clear stages: inspect real files, synthesize findings, write the report, run explicit verification commands, then call done. Prefer several focused shell commands over one giant pipeline.",
			},
		},
		agentGraph: createAgentGraph(),
		agentConfig: {
			name: "durable-agent-hydrated-analysis-demo",
			instructions:
				"Reason step by step from real repository contents. Inspect actual files before making claims. Stop only after the report has been verified successfully.",
			modelSpec: MODEL_SPEC,
			tools: ["execute_command"],
			loop: {
				strategy: "graph_v1",
			},
			memory: {
				backend: "dapr_state",
				sessionId: `${WORKFLOW_ID}-session`,
			},
			configuration: {
				storeName: "",
				configName: WORKFLOW_ID,
				keys: [],
			},
		},
	};

	return {
		call: "openshell/run",
		with: {
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			cwd: cwdExpression,
			prompt: body.prompt,
			mode: body.mode,
			model: body.model,
			maxTurns: body.maxTurns,
			timeoutMinutes: body.timeoutMinutes,
			loopPolicy: body.loopPolicy,
			agentGraph: body.agentGraph,
			agentConfig: body.agentConfig,
			body,
		},
	};
}

function buildWorkflowPayload() {
	const workspaceProfileTask = {
		call: "workspace/profile",
		with: {
			name: `${WORKFLOW_ID}-workspace`,
			rootPath: "/sandbox",
			enabledTools: ["execute_command"],
			timeoutMs: 120000,
			commandTimeoutMs: 120000,
			sandboxTemplate: "dapr-agent",
		},
	};

	const workspaceCloneTask = {
		call: "workspace/clone",
		with: {
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			repositoryOwner: REPOSITORY_OWNER,
			repositoryRepo: REPOSITORY_REPO,
			repositoryBranch: REPOSITORY_BRANCH,
			targetDir: TARGET_DIR,
		},
	};

	const agentTask = createAgentTask();

	const nodes = [
		{
			id: "__start__",
			type: "start",
			position: { x: 280, y: 60 },
			data: { label: "Start", type: "start", status: "idle", enabled: true },
		},
		{
			id: "workspace-profile",
			type: "call",
			position: { x: 280, y: 180 },
			data: {
				label: "Workspace Profile",
				type: "call",
				taskConfig: workspaceProfileTask,
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "workspace-clone",
			type: "call",
			position: { x: 280, y: 320 },
			data: {
				label: "Workspace Clone",
				type: "call",
				taskConfig: workspaceCloneTask,
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "hydrated-analysis-task",
			type: "agent",
			position: { x: 280, y: 470 },
			data: {
				label: "Hydrated Analysis Agent",
				type: "agent",
				taskConfig: agentTask,
				status: "idle",
				enabled: true,
			},
		},
		{
			id: "__end__",
			type: "end",
			position: { x: 280, y: 630 },
			data: { label: "End", type: "end", status: "idle", enabled: true },
		},
	];

	const edges = [
		{
			id: "edge-start-workspace-profile",
			source: "__start__",
			target: "workspace-profile",
		},
		{
			id: "edge-workspace-profile-workspace-clone",
			source: "workspace-profile",
			target: "workspace-clone",
		},
		{
			id: "edge-workspace-clone-agent",
			source: "workspace-clone",
			target: "hydrated-analysis-task",
		},
		{
			id: "edge-agent-end",
			source: "hydrated-analysis-task",
			target: "__end__",
		},
	];

	const spec = {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder",
			name: "durable-agent-hydrated-analysis-demo",
			version: "1.0.0",
			title: WORKFLOW_NAME,
			summary: WORKFLOW_DESCRIPTION,
		},
		do: [
			{
				workspace_profile: {
					...workspaceProfileTask,
				},
			},
			{
				workspace_clone: {
					...workspaceCloneTask,
				},
			},
			{
				durable_agent_hydrated_analysis_demo: {
					...agentTask,
				},
			},
		],
	};

	return {
		name: WORKFLOW_NAME,
		description: WORKFLOW_DESCRIPTION,
		nodes,
		edges,
		visibility: "public",
		spec,
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
			id,
			name,
			description,
			nodes,
			edges,
			visibility,
			spec,
			user_id,
			project_id,
			created_at,
			updated_at
		) values (
			${WORKFLOW_ID},
			${payload.name},
			${payload.description},
			${sql.json(payload.nodes)},
			${sql.json(payload.edges)},
			${payload.visibility},
			${sql.json(payload.spec)},
			${owner.userId},
			${owner.projectId},
			now(),
			now()
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
		const owner = await resolveOwner(sql, existingRows[0] ?? null, args.userEmail);
		const result = await upsertWorkflow(sql, owner);
		console.log(
			JSON.stringify(
				{
					workflowId: result.workflowId,
					created: result.created,
					name: WORKFLOW_NAME,
					repository: `${REPOSITORY_OWNER}/${REPOSITORY_REPO}`,
					branch: REPOSITORY_BRANCH,
					targetDir: TARGET_DIR,
					model: MODEL_SPEC || null,
					maxTurns: MAX_TURNS,
					timeoutMinutes: TIMEOUT_MINUTES,
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
	console.error("[upsert-durable-agent-hydrated-analysis-workflow] Error:", error);
	process.exitCode = 1;
});
