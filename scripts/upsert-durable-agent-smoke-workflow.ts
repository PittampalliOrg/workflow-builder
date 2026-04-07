import postgres from "postgres";
import {
	createDefaultAgentTaskBody,
	normalizeAgentTaskConfig,
} from "../src/lib/types/agent-graph";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID = process.env.WORKFLOW_ID || "durableagentsmoke1";
const WORKFLOW_NAME = process.env.WORKFLOW_NAME || "Durable Agent Smoke";
const WORKFLOW_DESCRIPTION =
	process.env.WORKFLOW_DESCRIPTION ||
	"Minimal single-loop OpenShell durable-agent workflow for UI and end-to-end validation.";
const DEFAULT_PROMPT =
	process.env.WORKFLOW_PROMPT ||
	"Reply with exactly LIVE_DURABLE_AGENT_OK. Do not use tools unless required.";

function parseArgs(argv: string[]) {
	let userEmail = "";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--user-email") {
			userEmail = String(argv[i + 1] || "").trim();
			i += 1;
		}
	}
	return { userEmail };
}

async function resolveOwner(
	sql: postgres.Sql,
	existingWorkflow: { user_id?: string | null; project_id?: string | null } | null,
	userEmail: string,
) {
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

function buildWorkflowPayload() {
	const agentLabel = "Durable Agent";
	const agentBody = {
		...createDefaultAgentTaskBody(agentLabel),
		prompt: DEFAULT_PROMPT,
		maxTurns: 4,
		timeoutMinutes: 10,
		agentConfig: {
			...createDefaultAgentTaskBody(agentLabel).agentConfig,
			name: "durable-agent-smoke",
			instructions:
				"Respond directly. If the prompt asks for an exact token, return exactly that token.",
			loop: {
				strategy: "graph_v1",
			},
			memory: {
				backend: "dapr_state",
				sessionId: "durable-agent-smoke-session",
			},
		},
	};

	const agentTask = normalizeAgentTaskConfig(
		{
			call: "openshell/run",
			with: {
				body: agentBody,
			},
		},
		agentLabel,
	);

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
			id: "durable-agent-task",
			type: "agent",
			position: { x: 240, y: 220 },
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
			position: { x: 240, y: 380 },
			data: {
				label: "End",
				type: "end",
				status: "idle",
				enabled: true,
			},
		},
	];

	const edges = [
		{ id: "__start__-durable-agent-task", source: "__start__", target: "durable-agent-task" },
		{ id: "durable-agent-task-__end__", source: "durable-agent-task", target: "__end__" },
	];

	const spec = {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder",
			name: "durable-agent-smoke",
			version: "1.0.0",
			title: WORKFLOW_NAME,
			summary: WORKFLOW_DESCRIPTION,
		},
		do: [
			{
				durable_agent_smoke: agentTask,
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
	console.error("[upsert-durable-agent-smoke-workflow] Error:", error);
	process.exitCode = 1;
});
