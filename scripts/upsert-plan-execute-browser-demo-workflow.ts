/**
 * Upsert the "Plan / Execute / Browser Demo" workflow into the database.
 *
 * Self-contained: builds the complete SW 1.0 spec inline (no source-clone
 * dependency). Adapted to the per-agent-runtime architecture — every
 * `durable/run` step dispatches via the workflow→session bridge:
 * `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>")`,
 * with the slug resolved from .trigger.<phase>AgentRef (per-phase overrides
 * fall through to .trigger.agentRef).
 *
 * Modeled on services/code-eval-runner/code-eval-item.workflow.json — see
 * CLAUDE.md "Workflow → Session Bridge" + the per-agent-runtime model.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-plan-execute-browser-demo-workflow.ts
 *   DATABASE_URL=... node scripts/upsert-plan-execute-browser-demo-workflow.ts --user-email vinod@pittampalli.com
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID =
  process.env.WORKFLOW_ID || "dapr-agent-py-plan-execute-browser-demo";
const WORKFLOW_NAME =
  process.env.WORKFLOW_NAME || "Dapr Agent Py Plan Execute Browser Demo";
const WORKFLOW_DESCRIPTION =
  process.env.WORKFLOW_DESCRIPTION ||
  "Plan, execute, test, and capture a browser demo of a generated SvelteKit app inside a retained per-run sandbox. Each agent step dispatches to a published agent via the workflow→session bridge; the final browser/validate captures screenshots from the live dev server.";

type JsonRecord = Record<string, unknown>;

interface ParsedArgs {
  userEmail: string;
}

function parseArgs(argv: string[]): ParsedArgs {
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
  existing: postgres.Row | undefined,
  userEmail: string,
): Promise<{ userId: string; projectId: string | null }> {
  if (existing?.user_id) {
    return {
      userId: String(existing.user_id),
      projectId: existing.project_id ? String(existing.project_id) : null,
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
        userId: String(rows[0].user_id),
        projectId: rows[0].project_id ? String(rows[0].project_id) : null,
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
      userId: String(memberRows[0].user_id),
      projectId: memberRows[0].project_id
        ? String(memberRows[0].project_id)
        : null,
    };
  }
  const userRows = await sql`
    select id as user_id
    from users
    order by created_at asc
    limit 1
  `;
  if (userRows[0]?.user_id) {
    return { userId: String(userRows[0].user_id), projectId: null };
  }
  throw new Error("Could not resolve a workflow owner.");
}

// ---------------------------------------------------------------------------
// SW 1.0 spec builders
// ---------------------------------------------------------------------------

const REPO_EXPR = '.trigger.repo // "plan-execute-browser-demo-app"';
const APP_CWD_EXPR = `\${ "/sandbox/" + (${REPO_EXPR}) }`;

function makeWorkspaceProfileTask(): JsonRecord {
  return {
    call: "workspace/profile",
    with: {
      name: `\${ "plan-execute-demo-" + (${REPO_EXPR}) }`,
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 7200,
      keepAfterRun: true,
      managedBy: "workflow-builder:plan-execute-browser-demo",
      commandTimeoutMs: 180000,
      timeoutMs: 240000,
      enabledTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "mkdir",
        "file_stat",
      ],
      sandboxPolicy: {
        keepAfterRun: true,
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
      },
    },
  };
}

function makeAgentPhaseTask(phase: {
  agentRefKey: string;
  prompt: string;
  maxTurns: number;
  timeoutMinutes: number;
}): JsonRecord {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: APP_CWD_EXPR,
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
      body: {
        agentRef: `\${ .trigger.${phase.agentRefKey} // .trigger.agentRef }`,
        prompt: phase.prompt,
        overrides: {
          cwd: APP_CWD_EXPR,
          maxTurns: phase.maxTurns,
          timeoutMinutes: phase.timeoutMinutes,
        },
      },
    },
  };
}

function makeBrowserValidateTask(): JsonRecord {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      repoPath: APP_CWD_EXPR,
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
      demoTitle: `\${ "Browser demo: " + (${REPO_EXPR}) }`,
      demoSummary:
        "Plan/execute generated the SvelteKit app, the testing agent recorded a validation report, and browser/validate captured this demo walkthrough from the retained per-run sandbox.",
      metadata: {
        appPath: APP_CWD_EXPR,
        workflowStage: "post-plan-execute-browser-demo",
      },
      timeoutMs: 600000,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase prompts
// ---------------------------------------------------------------------------

const PLAN_PROMPT = `\${ "PHASE 1: PLAN\\nProduce a concrete implementation plan for a small SvelteKit demo app.\\n\\nUser request:\\n" + .trigger.prompt + "\\n\\nRules:\\n- Work only in " + (${REPO_EXPR}) + " under /sandbox.\\n- Write your plan to PLAN.md at the repository root.\\n- The plan must include: (1) the file tree you intend to create, (2) the SvelteKit route layout, (3) the demo state mechanic, (4) the data-demo attributes you will add, (5) test/build commands.\\n- Required data-demo attributes for src/routes/+page.svelte: data-demo=\\\\\\"app-shell\\\\\\", data-demo=\\\\\\"primary-action\\\\\\", data-demo=\\\\\\"demo-state\\\\\\".\\n- Do not implement anything in this phase; only the plan.\\n- Final answer must include PLAN COMPLETE." }`;

const EXECUTE_PROMPT = `\${ "PHASE 2: EXECUTE\\nImplement PLAN.md exactly. Generate a working SvelteKit app that npm run build can build.\\n\\nUser request:\\n" + .trigger.prompt + "\\n\\nRules:\\n- Work only in " + (${REPO_EXPR}) + " under /sandbox.\\n- Read PLAN.md first; treat it as the source of truth.\\n- Run npm install, write all source files described in PLAN.md, and run npm run build at the end.\\n- src/routes/+page.svelte MUST contain data-demo=\\\\\\"app-shell\\\\\\", data-demo=\\\\\\"primary-action\\\\\\", data-demo=\\\\\\"demo-state\\\\\\".\\n- npm run dev -- --host 0.0.0.0 --port 3009 must be runnable (the next phase verifies this with a real browser).\\n- Final answer must include EXECUTE COMPLETE." }`;

const TESTING_PROMPT = `\${ "PHASE 3: TESTING AGENT REPORT\\nValidate the generated SvelteKit app from the same per-run sandbox workspace.\\n\\nOriginal user request:\\n" + .trigger.prompt + "\\n\\nRules:\\n- Work only in " + (${REPO_EXPR}) + " under /sandbox.\\n- Do NOT use browser MCP tools in this step; the following browser/validate step performs browser automation and screenshot capture.\\n- Read PLAN.md and validation-output/plan-execute-result.json if present.\\n- Run npm run build and report whether it passes.\\n- Verify src/routes/+page.svelte contains data-demo=\\\\\\"app-shell\\\\\\", data-demo=\\\\\\"primary-action\\\\\\", and data-demo=\\\\\\"demo-state\\\\\\".\\n- Write validation-output/browser-demo-report.json with valid JSON containing status, checks, issues, appPath, buildCommand, and validatedAt.\\n- Keep the report concise.\\n- Final answer must include BROWSER DEMO AGENT CHECK COMPLETE." }`;

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

function buildSpec(): JsonRecord {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder.demos",
      name: WORKFLOW_ID,
      version: "1.0.0",
      title: WORKFLOW_NAME,
      summary: WORKFLOW_DESCRIPTION,
      "x-workflow-builder": {
        architecture:
          "per-agent-runtime+session-workflow-bridge+browser-validate-capture",
        notes:
          "Each agent phase (plan/execute/testing) dispatches via durable/run to a published agent's per-agent runtime pod. Per-phase agent overrides fall through to .trigger.agentRef. The final browser/validate captures the demo walkthrough from the retained per-run sandbox; start the live preview from the run page or /api/workflows/executions/<execId>/sandbox-preview/<previewId>/.",
        triggerInputs: {
          agentRef: "Default agent for all phases (required if per-phase refs missing).",
          planAgentRef: "Optional override for plan phase.",
          executeAgentRef: "Optional override for execute phase.",
          testingAgentRef: "Optional override for testing phase.",
          repo: "Repo folder name under /sandbox (default plan-execute-browser-demo-app).",
          prompt: "User request that drives all phases.",
          model: "Optional model spec hint.",
          sandboxTemplate: "Optional sandbox template override (default dapr-agent).",
        },
      },
    },
    do: [
      { workspace_profile: makeWorkspaceProfileTask() },
      {
        plan_phase: makeAgentPhaseTask({
          agentRefKey: "planAgentRef",
          prompt: PLAN_PROMPT,
          maxTurns: 6,
          timeoutMinutes: 8,
        }),
      },
      {
        execute_phase: makeAgentPhaseTask({
          agentRefKey: "executeAgentRef",
          prompt: EXECUTE_PROMPT,
          maxTurns: 12,
          timeoutMinutes: 20,
        }),
      },
      {
        testing_agent_review: makeAgentPhaseTask({
          agentRefKey: "testingAgentRef",
          prompt: TESTING_PROMPT,
          maxTurns: 8,
          timeoutMinutes: 10,
        }),
      },
      { browser_demo_capture: makeBrowserValidateTask() },
    ],
    output: {
      as: {
        appPath: APP_CWD_EXPR,
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        sandboxName: "${ .workspace_profile.sandboxName }",
        plan: "${ .plan_phase }",
        execute: "${ .execute_phase }",
        testing: "${ .testing_agent_review }",
        browserDemo: "${ .browser_demo_capture }",
      },
    },
  };
}

function buildNodes(): JsonRecord[] {
  return [
    {
      id: "trigger",
      type: "trigger",
      position: { x: 80, y: 60 },
      data: {
        label: "Plan / Execute / Browser demo trigger",
        description:
          "Receives agentRef, prompt, repo, and optional per-phase overrides (planAgentRef / executeAgentRef / testingAgentRef).",
      },
    },
    {
      id: "workspace_profile",
      type: "action",
      position: { x: 80, y: 200 },
      data: {
        label: "Provision retained sandbox",
        actionType: "workspace/profile",
        description:
          "Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview proxy can attach after completion.",
      },
    },
    {
      id: "plan_phase",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Plan",
        actionType: "durable/run",
        description:
          "Agent generates PLAN.md describing the SvelteKit app to scaffold (file tree, routes, data-demo attributes, build commands).",
      },
    },
    {
      id: "execute_phase",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Execute",
        actionType: "durable/run",
        description:
          "Agent implements PLAN.md — npm install, source files, data-demo attributes, then npm run build.",
      },
    },
    {
      id: "testing_agent_review",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Testing agent report",
        actionType: "durable/run",
        description:
          "Agent runs deterministic validation (build + selector checks) and writes validation-output/browser-demo-report.json.",
      },
    },
    {
      id: "browser_demo_capture",
      type: "action",
      position: { x: 80, y: 760 },
      data: {
        label: "Browser demo capture",
        actionType: "browser/validate",
        description:
          "Boot the dev server in the retained sandbox and capture screenshots / video / trace of the demo walkthrough.",
      },
    },
  ];
}

function buildEdges(): JsonRecord[] {
  return [
    { id: "e1", source: "trigger", target: "workspace_profile", type: "default" },
    { id: "e2", source: "workspace_profile", target: "plan_phase", type: "default" },
    { id: "e3", source: "plan_phase", target: "execute_phase", type: "default" },
    { id: "e4", source: "execute_phase", target: "testing_agent_review", type: "default" },
    { id: "e5", source: "testing_agent_review", target: "browser_demo_capture", type: "default" },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    const existingRows = await sql`
      select user_id, project_id
      from workflows
      where id = ${WORKFLOW_ID}
      limit 1
    `;
    const owner = await resolveOwner(sql, existingRows[0], args.userEmail);

    const spec = buildSpec();
    const nodes = buildNodes();
    const edges = buildEdges();
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
        ${owner.userId},
        ${owner.projectId},
        ${sql.json(nodes as postgres.JSONValue)},
        ${sql.json(edges as postgres.JSONValue)},
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
        nodes = excluded.nodes,
        edges = excluded.edges,
        visibility = excluded.visibility,
        engine_type = excluded.engine_type,
        spec_version = excluded.spec_version,
        spec = excluded.spec,
        updated_at = excluded.updated_at
    `;

    console.log(`Upserted workflow ${WORKFLOW_ID}`);
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log(`  visibility      = public`);
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[upsert-plan-execute-browser-demo-workflow] Error:", error);
  process.exitCode = 1;
});
