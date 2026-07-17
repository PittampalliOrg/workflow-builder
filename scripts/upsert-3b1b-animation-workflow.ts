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
 * published agent's per-agent runtime pod. By default this script creates or
 * reconciles a dedicated dapr-agent-py Kimi K3 agent and binds the workflow to
 * its exact published version. Override with --agent-id / --agent-version.
 * Mirrors the modern shape
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
 *     the script owns a stable Kimi K3 agent definition while retaining an
 *     explicit --agent-id/--agent-version escape hatch.
 *   - Drops the `3b1b-style-animation` agent_skill_registry reference; the
 *     prompt is self-contained enough to produce the animation from the
 *     instructions alone.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-3b1b-animation-workflow.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-3b1b-animation-workflow.ts \
 *     --user-email vinod@pittampalli.com \
 *     --agent-id agnt_existing_override --agent-version 1
 */

import { pathToFileURL } from "node:url";
import { nanoid } from "nanoid";
import postgres from "postgres";
import { hashAgentConfig } from "../src/lib/server/agents/config-hash";
import type { AgentConfig } from "../src/lib/types/agents";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_ID = process.env.WORKFLOW_ID || "three-b-one-b-skill-animation";
const WORKFLOW_NAME =
  process.env.WORKFLOW_NAME || "3Blue1Brown-style Animation";
const WORKFLOW_DESCRIPTION =
  process.env.WORKFLOW_DESCRIPTION ||
  "Generate a self-contained browser animation in the 3Blue1Brown style (Canvas/SVG, no Manim) inside a retained per-run sandbox, then capture screenshots of the play/restart interaction via browser/validate.";

export const KIMI_AGENT_SLUG = "kimi-k3-3b1b-animation-builder";
export const KIMI_AGENT_NAME = "Kimi K3 3B1B Animation Builder";
export const KIMI_AGENT_DESCRIPTION =
  "Dapr Agents coding agent for building self-contained 3Blue1Brown-style browser animations with Kimi K3.";

// Provider credentials stay on the llm-kimi-k3 Dapr component via
// KIMI_API_KEY; agent definitions never persist provider secrets.
export const KIMI_AGENT_CONFIG = {
  systemPrompt:
    "You build polished, self-contained mathematical browser animations. Work directly in the supplied sandbox, prefer Canvas or SVG with plain HTML/CSS/JavaScript, preserve the requested stable DOM ids, and verify the generated files before finishing.",
  runtime: "dapr-agent-py",
  runtimeClass: "coding",
  runtimeIsolation: "shared",
  modelSpec: "kimi/kimi-k3",
  reasoningEffort: "max",
  contextWindowTokens: 1_048_576,
  maxTurns: 60,
  timeoutMinutes: 60,
  cwd: "/sandbox",
  builtinTools: [
    "execute_command",
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "glob_files",
    "grep_search",
  ],
  tools: [],
  mcpConnectionMode: "explicit",
  mcpServers: [],
  skills: [],
  memory: { backend: "dapr_state" },
  runtimeOverridePolicy: {
    allowToolNarrowing: true,
    allowServerAdditions: false,
    allowCredentialBinding: true,
    allowSkillAdditions: false,
    allowSkillNarrowing: true,
  },
} as const;

type JsonRecord = Record<string, unknown>;

interface ParsedArgs {
  userEmail: string;
  agentOverride?: AgentOverride;
}

export interface AgentRef {
  id: string;
  version: number;
}

interface AgentOverride {
  id: string;
  version?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let userEmail = "";
  let agentId = "";
  let agentVersion: number | undefined;
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
  if (
    agentVersion !== undefined &&
    (!Number.isInteger(agentVersion) || agentVersion <= 0)
  ) {
    throw new Error("--agent-version must be a positive integer");
  }
  if (agentVersion !== undefined && !agentId) {
    throw new Error("--agent-version requires --agent-id");
  }
  return {
    userEmail,
    ...(agentId
      ? { agentOverride: { id: agentId, version: agentVersion } }
      : {}),
  };
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

function hashConfig(config: JsonRecord): string {
  return hashAgentConfig(config as AgentConfig);
}

export async function ensureKimiAgent(
  sql: postgres.Sql,
  owner: { userId: string; projectId: string | null },
): Promise<AgentRef> {
  const config = KIMI_AGENT_CONFIG as unknown as JsonRecord;
  const configHash = hashConfig(config);
  const existingRows = await sql`
    select a.id, av.version, av.config_hash, jsonb_typeof(av.config) as config_type
    from agents a
    left join agent_versions av on av.id = a.current_version_id
    where a.slug = ${KIMI_AGENT_SLUG}
    limit 1
  `;
  const existing = existingRows[0];

  if (
    existing?.id &&
    existing.config_hash === configHash &&
    existing.config_type === "object"
  ) {
    await sql`
      update agents
      set
        name = ${KIMI_AGENT_NAME},
        description = ${KIMI_AGENT_DESCRIPTION},
        tags = ${sql.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
        runtime = ${"dapr-agent-py"},
        registry_status = ${"registered"},
        is_archived = false,
        updated_at = now()
      where id = ${existing.id}
        and (
          name is distinct from ${KIMI_AGENT_NAME}
          or description is distinct from ${KIMI_AGENT_DESCRIPTION}
          or tags is distinct from ${sql.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])}
          or runtime is distinct from ${"dapr-agent-py"}
          or registry_status is distinct from ${"registered"}
          or is_archived is distinct from false
        )
    `;
    return { id: String(existing.id), version: Number(existing.version) };
  }

  if (existing?.id) {
    const versionRows = await sql`
      select coalesce(max(version), 0)::int as version
      from agent_versions
      where agent_id = ${existing.id}
    `;
    const nextVersion = Number(versionRows[0]?.version ?? 0) + 1;
    const versionId = nanoid();
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as postgres.Sql;
      await tx`
        insert into agent_versions (
          id, agent_id, version, config, config_hash,
          changelog, published_at, published_by, created_at
        ) values (
          ${versionId}, ${existing.id}, ${nextVersion},
          ${tx.json(config as postgres.JSONValue)}, ${configHash},
          ${"Reconcile the 3B1B animation agent to Kimi K3 with max reasoning and a 1M-token context window."},
          now(), ${owner.userId}, now()
        )
      `;
      await tx`
        update agents
        set
          name = ${KIMI_AGENT_NAME},
          description = ${KIMI_AGENT_DESCRIPTION},
          tags = ${tx.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
          runtime = ${"dapr-agent-py"},
          registry_status = ${"registered"},
          is_archived = false,
          current_version_id = ${versionId},
          updated_at = now()
        where id = ${existing.id}
      `;
    });
    return { id: String(existing.id), version: nextVersion };
  }

  const agentId = nanoid();
  const versionId = nanoid();
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    await tx`
      insert into agents (
        id, slug, name, description, tags, runtime,
        created_by, project_id, registry_status, is_archived,
        default_vault_ids, created_at, updated_at
      ) values (
        ${agentId}, ${KIMI_AGENT_SLUG}, ${KIMI_AGENT_NAME},
        ${KIMI_AGENT_DESCRIPTION},
        ${tx.json(["dapr-agent-py", "kimi-k3", "animation", "3b1b"])},
        ${"dapr-agent-py"}, ${owner.userId}, ${owner.projectId},
        ${"registered"}, false, ${tx.json([])}, now(), now()
      )
    `;
    await tx`
      insert into agent_versions (
        id, agent_id, version, config, config_hash,
        changelog, published_at, published_by, created_at
      ) values (
        ${versionId}, ${agentId}, 1,
        ${tx.json(config as postgres.JSONValue)}, ${configHash},
        ${"Initial Kimi K3 definition for the 3B1B animation workflow."},
        now(), ${owner.userId}, now()
      )
    `;
    await tx`
      update agents
      set current_version_id = ${versionId}, updated_at = now()
      where id = ${agentId}
    `;
  });
  return { id: agentId, version: 1 };
}

async function resolveAgentOverride(
  sql: postgres.Sql,
  override: AgentOverride,
): Promise<AgentRef> {
  const rows =
    override.version !== undefined
      ? await sql`
          select a.id, av.version
          from agents a
          join agent_versions av on av.agent_id = a.id
          where a.id = ${override.id} and av.version = ${override.version}
          limit 1
        `
      : await sql`
          select a.id, av.version
          from agents a
          join agent_versions av on av.id = a.current_version_id
          where a.id = ${override.id}
          limit 1
        `;
  if (!rows[0]?.id) {
    throw new Error(
      `Could not resolve published agent ${override.id}${
        override.version !== undefined ? ` version ${override.version}` : ""
      }`,
    );
  }
  return { id: String(rows[0].id), version: Number(rows[0].version) };
}

// ---------------------------------------------------------------------------
// SW 1.0 spec builders
// ---------------------------------------------------------------------------

const APP_DIR = "/sandbox/3b1b-style-animation-example";
const BUILD_OUTPUT_SANDBOX_NAME = '${ .workspace_profile.sandboxName // "" }';
const BUILD_OUTPUT_WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";
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

// Build a literal jq expression as a string concat. Avoids template-literal
// escape collisions (TypeScript ${ vs jq ${ vs JSON \").
const BUILD_PROMPT_PARTS = [
  '${ .trigger.animationDescription + " — Build a self-contained browser animation in ',
  APP_DIR,
  " with index.html, styles.css, script.js, and README.md. ",
  "Use Canvas or SVG so the result runs via a simple static file server. ",
  "The browser animation is the required deliverable. ",
  'Use stable DOM ids for validation: the main canvas must be <canvas id=\\"canvas\\">, ',
  'the play/pause control <button id=\\"btn-play\\">, ',
  'the restart control <button id=\\"btn-restart\\">. ',
  "Do NOT install Manim — if a scene is useful, include scene.py as optional source only. ",
  "Do not start any preview server; the downstream browser/validate and ",
  "browser/start-preview steps will do that. ",
  "The page must work when served as static files (no module imports outside relative script.js). ",
  "Do NOT create a package.json — that triggers the runtime's npm-run-dev fallback ",
  "which expects flags python3's http.server doesn't recognize. ",
  'Final answer: list the files created and a one-paragraph outline of the animation logic." }',
];
const BUILD_PROMPT = BUILD_PROMPT_PARTS.join("");

function makeBuildAnimationTask(agentRef: AgentRef): JsonRecord {
  return {
    call: "durable/run",
    with: {
      mode: "execute_direct",
      cwd: "/sandbox",
      sandboxName: "${ .workspace_profile.sandboxName }",
      workspaceRef: "${ .workspace_profile.workspaceRef }",
      outputSync: {
        workspaceRef: "${ .workspace_profile.workspaceRef }",
        paths: [
          {
            source: APP_DIR,
            target: APP_DIR,
          },
        ],
        timeoutMs: 120000,
      },
      sandboxPolicy: {
        mode: "per-run",
        template: '${ .trigger.sandboxTemplate // "dapr-agent" }',
        ttlSeconds: 7200,
        keepAfterRun: true,
      },
      body: {
        agentRef,
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

function makeStartPreviewTask(): JsonRecord {
  // Pre-create the live-preview during the workflow (after browser/validate
  // proves the files render). The UI's "live preview" button connects to
  // this previewId instead of spawning a racy lazy preview that hits
  // ENOENT on package.json before rsync completes.
  return {
    call: "browser/start-preview",
    with: {
      body: {
        input: {
          previewId:
            '${ "3b1b-animation-preview-" + (.runtime.dbExecutionId // .workspace_profile.workspaceRef) }',
          repoPath: APP_DIR,
          rootPath: "/sandbox",
          workingDir: "/sandbox",
          // Same omit-devServerCommand pattern as browser/validate — runtime
          // detects index.html and runs `python3 -m http.server {port} --bind 0.0.0.0`.
          baseUrl: "http://127.0.0.1:0",
          keepAlive: true,
          timeoutSeconds: 7200,
          timeoutMs: 7200000,
          sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
          workspaceRef: BUILD_OUTPUT_WORKSPACE_REF,
        },
      },
    },
  };
}

function makeBrowserValidateTask(): JsonRecord {
  return {
    call: "browser/validate",
    with: {
      workspaceRef: BUILD_OUTPUT_WORKSPACE_REF,
      sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
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
        runtimeSandboxName:
          "${ .build_3b1b_animation.runtimeSandboxName // null }",
      },
      timeoutMs: 900000,
    },
  };
}

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

export function buildSpec(agentRef: AgentRef): JsonRecord {
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
      { build_3b1b_animation: makeBuildAnimationTask(agentRef) },
      { browser_validate_capture: makeBrowserValidateTask() },
      { start_preview: makeStartPreviewTask() },
    ],
    output: {
      as: {
        appPath: APP_DIR,
        workspaceRef: BUILD_OUTPUT_WORKSPACE_REF,
        sandboxName: BUILD_OUTPUT_SANDBOX_NAME,
        runtimeSandboxName:
          "${ .build_3b1b_animation.runtimeSandboxName // null }",
        animation: "${ .build_3b1b_animation }",
        screenshots: "${ .browser_validate_capture }",
        preview: "${ .start_preview }",
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
    {
      id: "start_preview",
      type: "action",
      position: { x: 80, y: 620 },
      data: {
        label: "Start live preview",
        actionType: "browser/start-preview",
        description:
          "Pre-create the live-preview proxy with correct repoPath/rootPath so the UI's preview button connects to a ready-to-serve instance instead of spawning a racy lazy one.",
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
    {
      id: "e4",
      source: "browser_validate_capture",
      target: "start_preview",
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
    const agentRef = args.agentOverride
      ? await resolveAgentOverride(sql, args.agentOverride)
      : await ensureKimiAgent(sql, owner);

    const spec = buildSpec(agentRef);
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
    console.log(
      `  agentRef        = { id: '${agentRef.id}', version: ${agentRef.version} }`,
    );
    console.log(
      `  agent source    = ${args.agentOverride ? "explicit override" : KIMI_AGENT_SLUG}`,
    );
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log(`  visibility      = public`);
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error("[upsert-3b1b-animation-workflow] Error:", error);
    process.exitCode = 1;
  });
}
