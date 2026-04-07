import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID = process.env.WORKFLOW_ID || "durableagentdurabilitydemo1";
const WORKFLOW_NAME =
	process.env.WORKFLOW_NAME || "Durable Agent Durability Demo";
const WORKFLOW_DESCRIPTION =
	process.env.WORKFLOW_DESCRIPTION ||
	"Single-agent OpenShell durable workflow that survives a durable-agent pod restart during execution.";
const DEFAULT_PROMPT =
	process.env.WORKFLOW_PROMPT ||
	[
		"You have a ready OpenShell workspace.",
		"Use the execute_command tool exactly once.",
		"Run this command:",
		"bash -lc 'sleep 120; printf DURABILITY_DEMO_OK'",
		"Wait for the command to finish.",
		"After it completes, call the done tool with answer set to DURABILITY_DEMO_OK.",
		"Do not call execute_command more than once.",
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
					label: "Run Command",
					stepType: "tool_batch",
					config: {
						activeTools: ["execute_command"],
						toolChoice: "required",
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

function createAgentTask(label) {
	const body = {
		prompt: DEFAULT_PROMPT,
		mode: "execute_direct",
		maxTurns: 3,
		timeoutMinutes: 15,
		loopPolicy: {
			doneTool: {
				enabled: true,
				name: "done",
				description:
					"Signal final completion after the required command has finished.",
				responseField: "answer",
			},
			prepareStep: {
				activeTools: ["execute_command"],
				appendInstructions:
					"Use execute_command exactly once. After the command succeeds, do not call any more executable tools. Call the done tool with answer set to DURABILITY_DEMO_OK.",
			},
		},
		agentGraph: createAgentGraph(),
		agentConfig: {
			name: "durable-agent-durability-demo",
			instructions:
				"Follow the workflow prompt exactly. Use execute_command exactly once, then finish by calling the done tool with answer DURABILITY_DEMO_OK.",
			modelSpec: "",
			tools: ["execute_command"],
			loop: {
				strategy: "graph_v1",
			},
			memory: {
				backend: "dapr_state",
				sessionId: "durable-agent-durability-demo-session",
			},
			configuration: {
				storeName: "",
				configName: "durable-agent-durability-demo",
				keys: [],
			},
		},
	};

	return {
		call: "openshell/run",
		with: {
			workspaceRef: "${ .workspace_profile.workspaceRef }",
			prompt: body.prompt,
			mode: body.mode,
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
	const workspaceLabel = "Workspace Profile";
	const agentLabel = "Durable Durability Agent";
	const workspaceTask = {
		call: "workspace/profile",
		with: {
			name: "durable-agent-durability-workspace",
			rootPath: "/sandbox",
			enabledTools: ["execute_command"],
			timeoutMs: 120000,
			commandTimeoutMs: 120000,
			sandboxTemplate: "dapr-agent",
		},
	};
	const agentTask = createAgentTask(agentLabel);

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
			id: "durability-demo-task",
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
		{ id: "__start__-workspace-profile", source: "__start__", target: "workspace-profile" },
		{ id: "workspace-profile-durability-demo-task", source: "workspace-profile", target: "durability-demo-task" },
		{
			id: "durability-demo-task-__end__",
			source: "durability-demo-task",
			target: "__end__",
		},
	];

	const spec = {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder",
			name: "durable-agent-durability-demo",
			version: "1.0.0",
			title: WORKFLOW_NAME,
			summary: WORKFLOW_DESCRIPTION,
		},
		do: [
			{
				workspace_profile: workspaceTask,
			},
			{
				durable_agent_durability_demo: agentTask,
			},
		],
	};

	return { nodes, edges, spec };
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is required");
	}

	const { userEmail } = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

	try {
		const existingRows = await sql`
			select id, user_id, project_id
			from workflows
			where id = ${WORKFLOW_ID}
			limit 1
		`;
		const existing = existingRows[0] || null;
		const owner = await resolveOwner(sql, existing, userEmail);
		const { nodes, edges, spec } = buildWorkflowPayload();
		const now = new Date().toISOString();

		if (existing) {
			await sql`
				update workflows
				set
					name = ${WORKFLOW_NAME},
					description = ${WORKFLOW_DESCRIPTION},
					user_id = ${owner.userId},
					project_id = ${owner.projectId},
					nodes = ${JSON.stringify(nodes)}::jsonb,
					edges = ${JSON.stringify(edges)}::jsonb,
					spec_version = ${"1.0.0"},
					spec = ${JSON.stringify(spec)}::jsonb,
					visibility = ${"public"},
					engine_type = ${"dapr"},
					updated_at = ${now}
				where id = ${WORKFLOW_ID}
			`;
			console.log(`Updated workflow ${WORKFLOW_ID}`);
		} else {
			await sql`
				insert into workflows (
					id,
					name,
					description,
					user_id,
					project_id,
					nodes,
					edges,
					spec_version,
					spec,
					visibility,
					engine_type,
					created_at,
					updated_at
				)
				values (
					${WORKFLOW_ID},
					${WORKFLOW_NAME},
					${WORKFLOW_DESCRIPTION},
					${owner.userId},
					${owner.projectId},
					${JSON.stringify(nodes)}::jsonb,
					${JSON.stringify(edges)}::jsonb,
					${"1.0.0"},
					${JSON.stringify(spec)}::jsonb,
					${"public"},
					${"dapr"},
					${now},
					${now}
				)
			`;
			console.log(`Created workflow ${WORKFLOW_ID}`);
		}

		console.log(`UI route: /workflows/${WORKFLOW_ID}`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error("[upsert-durable-agent-durability-workflow] Error:", error);
	process.exitCode = 1;
});
