import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const SOURCE_WORKFLOW_ID =
  process.env.SOURCE_WORKFLOW_ID || "v8rmNXaM_3WDqgLVYOul1";
const WORKFLOW_ID =
  process.env.WORKFLOW_ID || "dapr-agent-py-plan-execute-browser-demo";
const WORKFLOW_NAME =
  process.env.WORKFLOW_NAME || "Dapr Agent Py Plan Execute Browser Demo";
const WORKFLOW_DESCRIPTION =
  process.env.WORKFLOW_DESCRIPTION ||
  "Plan, execute, test with dapr-agent-py-testing, and capture browser demo artifacts in the retained per-run sandbox.";

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function repoExpr(defaultName = "plan-execute-browser-demo-app") {
  return `.trigger.repo // "${defaultName}"`;
}

function appCwdExpr() {
  return `\${ "/sandbox/" + (${repoExpr()}) }`;
}

function makeTestingAgentTask(): JsonRecord {
  const cwd = appCwdExpr();
  const prompt = `\${ "PHASE 3: TESTING AGENT REPORT\\nValidate the generated SvelteKit app from the same per-run sandbox workspace.\\n\\nOriginal user request:\\n" + .trigger.prompt + "\\n\\nRules:\\n- Work only in " + (${repoExpr()}) + " under /sandbox.\\n- Do not use browser MCP tools in this step; the following browser/validate step performs browser automation and screenshot capture.\\n- Read PLAN.md and validation-output/plan-execute-result.json if present.\\n- Run npm run build and report whether it passes.\\n- Verify src/routes/+page.svelte contains data-demo=\\\\\\"app-shell\\\\\\", data-demo=\\\\\\"primary-action\\\\\\", and data-demo=\\\\\\"demo-state\\\\\\".\\n- Write validation-output/browser-demo-report.json with valid JSON containing status, checks, issues, appPath, buildCommand, and validatedAt.\\n- Keep the report concise.\\n- Final answer must include BROWSER DEMO AGENT CHECK COMPLETE." }`;

  const withBlock: JsonRecord = {
    cwd,
    body: {
      cwd,
      mode: "execute_direct",
      prompt,
      maxTurns: 8,
      metadata: {
        model: "${ .trigger.model }",
        architecture:
          "per-run-openshell-sandbox-dapr-agent-py-testing-browser-demo",
      },
      agentConfig: {
        name: "sandbox-browser-demo-tester",
        runtime: "dapr-agent-py-testing",
        modelSpec: "${ .trigger.model }",
        instructions:
          "Testing phase. Inspect files, run deterministic validation commands, write validation-output/browser-demo-report.json, and leave browser automation to the browser/validate step.",
        tools: [
          "execute_command",
          "read_file",
          "write_file",
          "list_files",
        ],
        mcpServers: [],
        mcpConnectionMode: "runtime",
        loop: { strategy: "graph_v1" },
        memory: {
          backend: "dapr_state",
          sessionId:
            '${ "dapr-agent-py-testing-browser-demo-" + (.trigger.repo // "default") }',
        },
      },
      sandboxName: "",
      agentRuntime: "dapr-agent-py-testing",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      sandboxPolicy: {
        mode: "per-run",
        template: "dapr-agent",
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
      stopCondition:
        "Stop after validation-output/browser-demo-report.json exists and the final response includes BROWSER DEMO AGENT CHECK COMPLETE.",
      timeoutMinutes: 10,
      cleanupWorkspace: false,
      requireFileChanges: false,
    },
    mode: "execute_direct",
    prompt,
    maxTurns: 8,
    metadata: {
      model: "${ .trigger.model }",
      architecture:
        "per-run-openshell-sandbox-dapr-agent-py-testing-browser-demo",
    },
    agentConfig: {
      name: "sandbox-browser-demo-tester",
      runtime: "dapr-agent-py-testing",
      modelSpec: "${ .trigger.model }",
      instructions:
        "Testing phase. Inspect files, run deterministic validation commands, write validation-output/browser-demo-report.json, and leave browser automation to the browser/validate step.",
      tools: ["execute_command", "read_file", "write_file", "list_files"],
      mcpServers: [],
      mcpConnectionMode: "runtime",
      loop: { strategy: "graph_v1" },
      memory: {
        backend: "dapr_state",
        sessionId:
          '${ "dapr-agent-py-testing-browser-demo-" + (.trigger.repo // "default") }',
      },
    },
    sandboxName: "",
    agentRuntime: "dapr-agent-py-testing",
    workspaceRef: "${ .workspace_profile.workspaceRef }",
    sandboxPolicy: {
      mode: "per-run",
      template: "dapr-agent",
      ttlSeconds: 7200,
      keepAfterRun: true,
    },
    stopCondition:
      "Stop after validation-output/browser-demo-report.json exists and the final response includes BROWSER DEMO AGENT CHECK COMPLETE.",
    timeoutMinutes: 10,
    cleanupWorkspace: false,
    requireFileChanges: false,
  };

  return { call: "durable/run", with: withBlock };
}

function makeBrowserValidateTask(): JsonRecord {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      repoPath: appCwdExpr(),
      installCommand: "npm install --no-audit --no-fund --loglevel=warn",
      devServerCommand: "npm run dev -- --host 0.0.0.0 --port 3009",
      baseUrl: "http://127.0.0.1:3009",
      steps: [
        {
          id: "initial",
          label: "Initial app state",
          action: "visit",
          path: "/",
          goal: "Show the generated app shell before interaction.",
          waitForSelector: '[data-demo="app-shell"]',
          pauseMs: 1200,
          fullPage: true,
        },
        {
          id: "after-one",
          label: "After one interaction",
          action: "click",
          selector: '[data-demo="primary-action"]',
          goal: "Trigger the primary interaction once.",
          waitForSelector: '[data-demo="demo-state"]',
          pauseMs: 1200,
          fullPage: true,
        },
        {
          id: "after-two",
          label: "After second interaction",
          action: "click",
          selector: '[data-demo="primary-action"]',
          goal: "Trigger the primary interaction a second time.",
          waitForSelector: '[data-demo="demo-state"]',
          pauseMs: 900,
          fullPage: true,
        },
        {
          id: "after-three",
          label: "After repeated interaction",
          action: "click",
          selector: '[data-demo="primary-action"]',
          goal: "Capture the final changed state after three interactions.",
          waitForSelector: '[data-demo="demo-state"]',
          pauseMs: 1200,
          fullPage: true,
        },
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle: '${ "Browser demo: " + (.trigger.repo // "generated app") }',
      demoSummary:
        "Plan/execute generated the SvelteKit app, dapr-agent-py-testing recorded a validation report, and browser/validate captured this demo walkthrough from the retained per-run sandbox.",
      metadata: {
        testedBy: "dapr-agent-py-testing",
        appPath: appCwdExpr(),
        workflowStage: "post-plan-execute-browser-demo",
      },
      timeoutMs: 600000,
    },
  };
}

function makeActionNode(
  id: string,
  label: string,
  position: { x: number; y: number },
  taskConfig: JsonRecord,
  type = "action",
): JsonRecord {
  const withBlock = (taskConfig.with ?? {}) as JsonRecord;
  return {
    id,
    type,
    position,
    data: {
      type,
      label,
      config: {
        actionType: taskConfig.call,
        ...clone(withBlock),
      },
      status: "idle",
      enabled: true,
      taskConfig: clone(taskConfig),
    },
  };
}

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    const rows = await sql`
      select *
      from workflows
      where id = ${SOURCE_WORKFLOW_ID}
      limit 1
    `;
    const source = rows[0];
    if (!source) {
      throw new Error(`Source workflow not found: ${SOURCE_WORKFLOW_ID}`);
    }

    const spec = clone(source.spec as JsonRecord);
    const nodes = clone(source.nodes as JsonRecord[]);
    const edges = clone(source.edges as JsonRecord[]);

    spec.document = {
      ...((spec.document as JsonRecord) ?? {}),
      name: WORKFLOW_ID,
      title: WORKFLOW_NAME,
      summary: WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        ...(((spec.document as JsonRecord)?.["x-workflow-builder"] as JsonRecord) ?? {}),
        clonedFrom: SOURCE_WORKFLOW_ID,
        architecture:
          "per-run-openshell-sandbox-dapr-agent-py-plan-execute-browser-demo",
        notes:
          "Adds a dapr-agent-py-testing validation report and browser/validate demo capture. Start the retained sandbox preview from the run page or sandbox-preview API after completion.",
      },
    };

    const doArray = Array.isArray(spec.do) ? (spec.do as JsonRecord[]) : [];
    doArray.push({ testing_agent_review: makeTestingAgentTask() });
    doArray.push({ browser_demo_capture: makeBrowserValidateTask() });
    spec.do = doArray;

    const doneNode = nodes.find((node) => node.id === "done");
    if (doneNode) {
      doneNode.position = { x: 2040, y: 160 };
    }
    nodes.push(
      makeActionNode(
        "testing_agent_review",
        "Testing Agent Report",
        { x: 1400, y: 160 },
        makeTestingAgentTask(),
        "agent",
      ),
      makeActionNode(
        "browser_demo_capture",
        "Browser Demo Capture",
        { x: 1720, y: 160 },
        makeBrowserValidateTask(),
      ),
    );

    const filteredEdges = edges.filter(
      (edge) =>
        !(
          edge.source === "sandbox_agent_execute" &&
          edge.target === "done"
        ),
    );
    filteredEdges.push(
      {
        id: "sandbox_agent_execute-testing_agent_review",
        type: "default",
        source: "sandbox_agent_execute",
        target: "testing_agent_review",
      },
      {
        id: "testing_agent_review-browser_demo_capture",
        type: "default",
        source: "testing_agent_review",
        target: "browser_demo_capture",
      },
      {
        id: "browser_demo_capture-done",
        type: "default",
        source: "browser_demo_capture",
        target: "done",
      },
    );

    const now = new Date().toISOString();
    await sql`
      insert into workflows (
        id,
        name,
        description,
        user_id,
        project_id,
        nodes,
        edges,
        visibility,
        engine_type,
        spec_version,
        spec,
        created_at,
        updated_at
      )
      values (
        ${WORKFLOW_ID},
        ${WORKFLOW_NAME},
        ${WORKFLOW_DESCRIPTION},
        ${source.user_id},
        ${source.project_id},
        ${sql.json(nodes as postgres.JSONValue)},
        ${sql.json(filteredEdges as postgres.JSONValue)},
        ${"public"},
        ${"dapr"},
        ${"1.0.0"},
        ${sql.json(spec as postgres.JSONValue)},
        ${now},
        ${now}
      )
      on conflict (id) do update
      set
        name = excluded.name,
        description = excluded.description,
        user_id = excluded.user_id,
        project_id = excluded.project_id,
        nodes = excluded.nodes,
        edges = excluded.edges,
        visibility = excluded.visibility,
        engine_type = excluded.engine_type,
        spec_version = excluded.spec_version,
        spec = excluded.spec,
        updated_at = excluded.updated_at
    `;

    console.log(`Upserted workflow ${WORKFLOW_ID}`);
    console.log(`UI route: /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[upsert-plan-execute-browser-demo-workflow] Error:", error);
  process.exitCode = 1;
});
