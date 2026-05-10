/**
 * Upsert the "3Blue1Brown-style Animation" workflow into the database.
 *
 * Self-contained adaptation of the legacy 3pvh53PpHSiz-OoEeSW4z fixture
 * (scripts/fixtures/sample-workflows.json:577) for the per-agent-runtime
 * architecture:
 *
 *   trigger -> workspace_profile -> build_3b1b_animation
 *                                -> browser_validate_capture
 *
 * Each `durable/run` step dispatches via the workflow→session bridge to a
 * published agent's per-agent runtime pod (defaults to deepseek-v4-pro,
 * override with --agent-id / --agent-version). Mirrors the modern shape
 * established by services/code-eval-runner/code-eval-item.workflow.json
 * and scripts/upsert-plan-execute-browser-demo-workflow.ts.
 *
 * Differences from the legacy fixture:
 *   - Uses `dapr-agent` sandbox template (the prompt is browser-only —
 *     Canvas/SVG, no Manim install required, so the dev cluster's existing
 *     templates are sufficient; no stacks bump needed).
 *   - Replaces the legacy `start_preview` + `validate_with_browser_agent`
 *     pair (the latter required Playwright MCP on the agent, which the
 *     SWE-bench coding agents on dev don't have) with a single direct
 *     `browser/validate` step that runs `python3 -m http.server` against
 *     the generated static files and captures screenshots end-to-end.
 *   - Drops the legacy hardcoded `9mg45nG313FLp1u82zqOP` agent reference;
 *     the script accepts --agent-id/--agent-version with deepseek defaults.
 *   - Drops the `3b1b-style-animation` agent_skill_registry reference; the
 *     prompt is self-contained enough to produce the animation from the
 *     instructions alone.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-3b1b-animation-workflow.ts
 *   DATABASE_URL=... node scripts/upsert-3b1b-animation-workflow.ts \
 *     --user-email vinod@pittampalli.com \
 *     --agent-id agnt_deepseek_v4_pro_swe_smoke --agent-version 3
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID = process.env.WORKFLOW_ID || "three-b-one-b-skill-animation";
const WORKFLOW_NAME =
  process.env.WORKFLOW_NAME || "3Blue1Brown-style Animation";
const WORKFLOW_DESCRIPTION =
  process.env.WORKFLOW_DESCRIPTION ||
  "Generate a self-contained browser animation in the 3Blue1Brown style (Canvas/SVG, no Manim) inside a retained per-run sandbox, then capture screenshots of the play/restart interaction via browser/validate.";

type JsonRecord = Record<string, unknown>;

interface ParsedArgs {
  userEmail: string;
  agentId: string;
  agentVersion: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let userEmail = "";
  let agentId = "agnt_deepseek_v4_pro_swe_smoke";
  let agentVersion = 3;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user-email") {
      userEmail = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (argv[i] === "--agent-id") {
      agentId = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (argv[i] === "--agent-version") {
      agentVersion = Number(String(argv[i + 1] || "").trim());
      i += 1;
    }
  }
  return { userEmail, agentId, agentVersion };
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

const APP_DIR = "/sandbox/3b1b-style-animation-example";
// Port is allocated by openshell-agent-runtime's `_allocate_local_port()`
// per-run, not by us — so we don't pick one. Hardcoding a port collides
// with the runtime's internal probe URL (the readiness check uses the
// runtime-allocated port, not whatever we put in baseUrl). The default
// runner detects `index.html` in repoPath and runs
// `python3 -m http.server {port} --bind 0.0.0.0` automatically. We let
// it.

function makeWorkspaceProfileTask(): JsonRecord {
  return {
    call: "workspace/profile",
    with: {
      name: "three-b-one-b-animation",
      rootPath: "/sandbox",
      sandboxTemplate: '${ .trigger.sandboxTemplate // "dapr-agent" }',
      ttlSeconds: 7200,
      keepAfterRun: true,
      managedBy: "workflow-builder:demos:3b1b-animation",
      commandTimeoutMs: 900000,
      timeoutMs: 1200000,
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
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
    },
  };
}

const BUILD_PROMPT = `\${ .trigger.animationDescription + " — Build a self-contained browser animation in ${APP_DIR} with index.html, styles.css, script.js, and README.md. Use Canvas or SVG so the result runs via a simple static file server. The browser animation is the required deliverable. Use stable DOM ids for validation: the main canvas must be <canvas id=\\\\\\"canvas\\\\\\">, the play/pause control <button id=\\\\\\"btn-play\\\\\\">, the restart control <button id=\\\\\\"btn-restart\\\\\\">. Do NOT install Manim — if a scene is useful, include scene.py as optional source only. Do not start any preview server; the downstream browser/validate step will do that. The page must work when served as static files (no module imports outside relative script.js). Final answer: list the files created and a one-paragraph outline of the animation logic." }`;

function makeBuildAnimationTask(args: ParsedArgs): JsonRecord {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
      body: {
        agentRef: { id: args.agentId, version: args.agentVersion },
        prompt: BUILD_PROMPT,
        overrides: {
          cwd: "/sandbox",
          maxTurns: 60,
          timeoutMinutes: 60,
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
      repoPath: APP_DIR,
      // Skip installCommand + devServerCommand. The runtime's default
      // `_local_devserver_runner` detects index.html in repoPath and runs
      // `python3 -m http.server {port} --bind 0.0.0.0` against a port it
      // allocates itself. baseUrl's port is rewritten to match. Mirrors
      // the canonical animation-3b1b-v2-managed.workflow.json shape and
      // avoids the runtime/command port mismatch that broke our prior
      // canaries OQK3 / FSOMOoo9 / Z1ebywvI / X3EZ5moY / Oa8AnQiR.
      installCommand: "",
      baseUrl: "http://127.0.0.1:0",
      steps: [
        {
          id: "initial",
          label: "Animation loaded",
          action: "visit",
          path: "/",
          goal: "Initial render of the canvas before any interaction.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true,
        },
        {
          id: "after-play",
          label: "After play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control once.",
          waitForSelector: "canvas#canvas",
          pauseMs: 2000,
          fullPage: true,
        },
        {
          id: "after-second-play",
          label: "After second play",
          action: "click",
          selector: "button#btn-play",
          goal: "Trigger the play control again to capture mid-animation state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true,
        },
        {
          id: "after-restart",
          label: "After restart",
          action: "click",
          selector: "button#btn-restart",
          goal: "Restart the animation and capture the reset state.",
          waitForSelector: "canvas#canvas",
          pauseMs: 1500,
          fullPage: true,
        },
      ],
      captureVideo: true,
      captureTrace: true,
      viewportPreset: "desktop",
      captureMode: "demo",
      demoTitle:
        '${ "3Blue1Brown-style animation: " + .trigger.animationDescription }',
      demoSummary:
        "Generated 3Blue1Brown-style browser animation; browser/validate captured initial / play / second play / restart states from the retained per-run sandbox.",
      metadata: {
        appPath: APP_DIR,
        workflowStage: "post-3b1b-animation",
      },
      timeoutMs: 900000,
    },
  };
}

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

function buildSpec(args: ParsedArgs): JsonRecord {
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
          "Adapted from the legacy 3pvh53PpHSiz-OoEeSW4z fixture for the per-agent-runtime architecture. Single agent step builds index.html / styles.css / script.js / README.md; browser/validate boots `python3 -m http.server` and captures a 4-screenshot demo (initial / play×2 / restart). Sandbox is retained (keepAfterRun=true) so the live preview proxy can attach after completion.",
        triggerInputs: {
          animationDescription:
            "Required. Plain-language description of the 3Blue1Brown-style animation to build (e.g. 'derivative of x^2', 'epsilon-delta limit visualization').",
          sandboxTemplate:
            "Optional override (default 'dapr-agent'). Only set this if the cluster has a dedicated animation template installed.",
        },
        input: {
          fields: {
            animationDescription: {
              type: "textarea",
              label: "Animation description",
              description:
                "Describe the 3Blue1Brown-style animation the agent should build.",
              defaultValue:
                "Create a concise 3Blue1Brown-style derivative animation for x^2",
            },
          },
        },
      },
    },
    do: [
      { workspace_profile: makeWorkspaceProfileTask() },
      { build_3b1b_animation: makeBuildAnimationTask(args) },
      { browser_validate_capture: makeBrowserValidateTask() },
    ],
    output: {
      as: {
        appPath: APP_DIR,
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        sandboxName: "${ .workspace_profile.sandboxName }",
        animation: "${ .build_3b1b_animation }",
        screenshots: "${ .browser_validate_capture }",
      },
    },
    input: {
      schema: {
        document: {
          type: "object",
          required: ["animationDescription"],
          properties: {
            animationDescription: {
              type: "string",
              title: "Animation description",
              description:
                "Describe the 3Blue1Brown-style animation the agent should build.",
              default:
                "Create a concise 3Blue1Brown-style derivative animation for x^2",
            },
          },
        },
        format: "json",
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
        label: "Animation request trigger",
        description:
          "Receives animationDescription (plain-language description of the 3Blue1Brown-style animation to build).",
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
          "Stand up a per-run sandbox with file/exec tools; keepAfterRun=true so the live preview can attach after the run.",
      },
    },
    {
      id: "build_3b1b_animation",
      type: "action",
      position: { x: 80, y: 340 },
      data: {
        label: "Build 3B1B animation",
        actionType: "durable/run",
        description:
          "Agent generates index.html / styles.css / script.js / README.md in /sandbox/3b1b-style-animation-example with stable DOM ids (canvas#canvas, button#btn-play, button#btn-restart) so browser/validate can wire screenshots reliably.",
      },
    },
    {
      id: "browser_validate_capture",
      type: "action",
      position: { x: 80, y: 480 },
      data: {
        label: "Capture animation walkthrough",
        actionType: "browser/validate",
        description:
          "Boot `python3 -m http.server` against the generated static files and capture initial / play×2 / restart screenshots.",
      },
    },
  ];
}

function buildEdges(): JsonRecord[] {
  return [
    {
      id: "e1",
      source: "trigger",
      target: "workspace_profile",
      type: "default",
    },
    {
      id: "e2",
      source: "workspace_profile",
      target: "build_3b1b_animation",
      type: "default",
    },
    {
      id: "e3",
      source: "build_3b1b_animation",
      target: "browser_validate_capture",
      type: "default",
    },
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

    const spec = buildSpec(args);
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
    console.log(`  agentRef        = { id: '${args.agentId}', version: ${args.agentVersion} }`);
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log(`  visibility      = public`);
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[upsert-3b1b-animation-workflow] Error:", error);
  process.exitCode = 1;
});
