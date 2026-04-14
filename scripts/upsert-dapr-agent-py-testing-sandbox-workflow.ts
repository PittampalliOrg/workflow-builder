import postgres from "postgres";
import {
  createDefaultAgentTaskBody,
  normalizeAgentTaskConfig,
} from "../src/lib/types/agent-graph";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID =
  process.env.WORKFLOW_ID || "dapr-agent-py-testing-sandbox-smoke";
const WORKFLOW_NAME =
  process.env.WORKFLOW_NAME || "Dapr Agent Py Testing Sandbox Smoke";
const WORKFLOW_DESCRIPTION =
  process.env.WORKFLOW_DESCRIPTION ||
  "Validate the sandbox-hosted dapr-agent-py-testing runtime, Dapr cross-namespace invocation, local sandbox tools, and bundled MCP testing profile.";
const DEFAULT_PROMPT =
  process.env.WORKFLOW_PROMPT ||
  [
    "Use the execute_command tool to run this exact command:",
    "pwd && printf 'dapr-agent-py-testing-ok'",
    "Return only the command output.",
  ].join("\n");

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
  existingWorkflow: {
    user_id?: string | null;
    project_id?: string | null;
  } | null,
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
  const agentLabel = "Testing Sandbox Agent";
  const defaultBody = createDefaultAgentTaskBody(agentLabel);
  const agentBody = {
    ...defaultBody,
    prompt: DEFAULT_PROMPT,
    agentRuntime: "dapr-agent-py-testing",
    workspaceRef: "",
    sandboxName: "",
    cwd: "/sandbox",
    maxTurns: 3,
    timeoutMinutes: 5,
    stopCondition:
      "Stop after the command output includes dapr-agent-py-testing-ok.",
    agentConfig: {
      ...(defaultBody.agentConfig as Record<string, unknown>),
      name: "dapr-agent-py-testing-sandbox-smoke",
      runtime: "dapr-agent-py-testing",
      instructions:
        "Use the sandbox-local tools. For this smoke workflow, call execute_command exactly as requested and return the concise command output.",
      tools: ["execute_command"],
      mcpConnectionMode: "runtime",
      loop: {
        strategy: "graph_v1",
      },
      memory: {
        backend: "dapr_state",
        sessionId: "dapr-agent-py-testing-sandbox-smoke",
      },
    },
  };

  const agentTask = normalizeAgentTaskConfig(
    {
      call: "durable/run",
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
      id: "testing-sandbox-agent",
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
    {
      id: "__start__-testing-sandbox-agent",
      source: "__start__",
      target: "testing-sandbox-agent",
    },
    {
      id: "testing-sandbox-agent-__end__",
      source: "testing-sandbox-agent",
      target: "__end__",
    },
  ];

  const spec = {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder",
      name: WORKFLOW_ID,
      version: "1.0.0",
      title: WORKFLOW_NAME,
      summary: WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture: "sandbox-hosted-dapr-agent-py-testing",
        runtimeAppId: "dapr-agent-py-testing.openshell",
      },
    },
    do: [
      {
        testing_sandbox_agent: agentTask,
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
    const nodesJson = nodes as unknown as postgres.JSONValue;
    const edgesJson = edges as unknown as postgres.JSONValue;
    const specJson = spec as unknown as postgres.JSONValue;
    const now = new Date().toISOString();

    if (existing) {
      await sql`
				update workflows
				set
					name = ${WORKFLOW_NAME},
					description = ${WORKFLOW_DESCRIPTION},
					user_id = ${owner.userId},
					project_id = ${owner.projectId},
					nodes = ${sql.json(nodesJson)},
					edges = ${sql.json(edgesJson)},
					spec_version = ${"1.0.0"},
					spec = ${sql.json(specJson)},
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
					${sql.json(nodesJson)},
					${sql.json(edgesJson)},
					${"1.0.0"},
					${sql.json(specJson)},
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
  console.error(
    "[upsert-dapr-agent-py-testing-sandbox-workflow] Error:",
    error,
  );
  process.exitCode = 1;
});
