/**
 * Create the fresh Pydantic AI K3 3Blue1Brown-style animation workflow.
 *
 * The Pydantic agent builds on the execution-scoped JuiceFS workspace. The
 * dynamic script then copies the four bounded text assets into its own retained
 * OpenShell workspace so browser validation and preview use their native
 * backend without pretending the two workspace families share bytes.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts \
 *     --user-email vinod@pittampalli.com \
 *     --project-id project_default \
 *     --agent-id agnt_existing_override --agent-version 1
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nanoid } from "nanoid";
import postgres from "postgres";
import { hashAgentConfig } from "../src/lib/server/agents/config-hash";
import type { AgentConfig } from "../src/lib/types/agents";

const DATABASE_URL = process.env.DATABASE_URL;
export const WORKFLOW_ID = "pydantic-ai-k3-3blue1brown-animation";
export const WORKFLOW_NAME = "Pydantic AI K3 3Blue1Brown-style Animation";
export const WORKFLOW_DESCRIPTION =
  "Use Pydantic AI and Kimi K3 to generate a self-contained mathematical animation on shared JuiceFS, materialize it into a retained browser sandbox, capture its interaction states, and start a live preview.";

export const PYDANTIC_AGENT_SLUG = "pydantic-ai-k3-dynamic-animation-builder";
export const PYDANTIC_AGENT_NAME = "Pydantic AI K3 Dynamic Animation Builder";
export const PYDANTIC_AGENT_DESCRIPTION =
  "Pydantic AI coding agent for dynamic mathematical browser animations with Kimi K3.";
const PYDANTIC_AGENT_TAGS = [
  "pydantic-ai-agent-py",
  "pydantic-ai",
  "kimi-k3",
  "animation",
  "3b1b",
] as const;

// KIMI_API_KEY is injected into the Pydantic runtime environment. Provider
// credentials never belong in saved agent definitions or workflow specs.
export const PYDANTIC_AGENT_CONFIG = {
  systemPrompt:
    "You build polished, compact, self-contained mathematical browser animations. Work directly in the shared /sandbox/work filesystem with the Pydantic AI harness tools, prefer Canvas or SVG with plain HTML/CSS/JavaScript, preserve required stable DOM ids, and verify generated files before finishing.",
  runtime: "pydantic-ai-agent-py",
  runtimeClass: "coding",
  runtimeIsolation: "shared",
  modelSpec: "kimi/kimi-k3",
  reasoningEffort: "max",
  contextWindowTokens: 1_048_576,
  maxTurns: 40,
  timeoutMinutes: 60,
  cwd: "/sandbox/work",
  builtinTools: [
    "read_file",
    "write_file",
    "edit_file",
    "list_directory",
    "search_files",
    "find_files",
    "create_directory",
    "file_info",
    "ReadMediaFile",
    "run_command",
    "start_command",
    "check_command",
    "stop_command",
  ],
  tools: [],
  mcpConnectionMode: "explicit",
  mcpServers: [],
  skills: [],
  memory: { backend: "none" },
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
  projectId: string;
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

export interface WorkflowOwner {
  userId: string;
  projectId: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let userEmail = "";
  let projectId = "";
  let agentId = "";
  let agentVersion: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user-email") {
      userEmail = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (argv[i] === "--project-id") {
      projectId = String(argv[i + 1] || "").trim();
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
    projectId,
    ...(agentId
      ? { agentOverride: { id: agentId, version: agentVersion } }
      : {}),
  };
}

function requiredOwner(
  userId: unknown,
  projectId: unknown,
  source: string,
): WorkflowOwner {
  const resolvedUserId = String(userId || "").trim();
  const resolvedProjectId = String(projectId || "").trim();
  if (!resolvedUserId || !resolvedProjectId) {
    throw new Error(`${source} must have both a user and a project`);
  }
  return { userId: resolvedUserId, projectId: resolvedProjectId };
}

export function assertResourceOwner(
  resource: string,
  actual: { userId: unknown; projectId: unknown },
  expected: WorkflowOwner,
): void {
  const owner = requiredOwner(
    actual.userId,
    actual.projectId,
    `${resource} ownership`,
  );
  if (
    owner.userId !== expected.userId ||
    owner.projectId !== expected.projectId
  ) {
    throw new Error(
      `${resource} belongs to user ${owner.userId} project ${owner.projectId}; refusing to reuse it for user ${expected.userId} project ${expected.projectId}`,
    );
  }
}

export async function resolveOwner(
  sql: postgres.Sql,
  existing: postgres.Row | undefined,
  userEmail: string,
  requestedProjectId = "",
): Promise<WorkflowOwner> {
  if (existing?.user_id) {
    const owner = requiredOwner(
      existing.user_id,
      existing.project_id,
      `Existing workflow ${WORKFLOW_ID}`,
    );
    if (requestedProjectId && requestedProjectId !== owner.projectId) {
      throw new Error(
        `Existing workflow ${WORKFLOW_ID} belongs to project ${owner.projectId}, not requested project ${requestedProjectId}`,
      );
    }
    const membershipRows = await sql`
      select 1
      from project_members
      where user_id = ${owner.userId}
        and project_id = ${owner.projectId}
      limit 1
    `;
    if (!membershipRows[0]) {
      throw new Error(
        `Existing workflow ${WORKFLOW_ID} owner is not a member of project ${owner.projectId}`,
      );
    }
    if (userEmail) {
      const rows = await sql`
        select id as user_id
        from users
        where lower(email) = lower(${userEmail})
        limit 1
      `;
      if (!rows[0]?.user_id) {
        throw new Error(`Could not resolve user ${userEmail}`);
      }
      if (String(rows[0].user_id) !== owner.userId) {
        throw new Error(
          `Existing workflow ${WORKFLOW_ID} belongs to a different user than ${userEmail}`,
        );
      }
    }
    return owner;
  }

  if (!userEmail) {
    throw new Error(
      `--user-email is required when workflow ${WORKFLOW_ID} does not already exist`,
    );
  }
  const userRows = await sql`
    select id as user_id
    from users
    where lower(email) = lower(${userEmail})
    limit 1
  `;
  if (!userRows[0]?.user_id) {
    throw new Error(`Could not resolve user ${userEmail}`);
  }
  const userId = String(userRows[0].user_id);
  const memberRows = requestedProjectId
    ? await sql`
        select pm.project_id
        from project_members pm
        where pm.user_id = ${userId}
          and pm.project_id = ${requestedProjectId}
        limit 1
      `
    : await sql`
        select pm.project_id
        from project_members pm
        where pm.user_id = ${userId}
        order by pm.created_at asc
        limit 2
      `;
  if (!memberRows[0]?.project_id) {
    throw new Error(
      requestedProjectId
        ? `User ${userEmail} is not a member of project ${requestedProjectId}`
        : `User ${userEmail} does not belong to a project`,
    );
  }
  if (!requestedProjectId && memberRows.length > 1) {
    throw new Error(
      `User ${userEmail} belongs to multiple projects; pass --project-id explicitly`,
    );
  }
  return { userId, projectId: String(memberRows[0].project_id) };
}

function hashConfig(config: JsonRecord): string {
  return hashAgentConfig(config as AgentConfig);
}

export async function ensurePydanticAgent(
  sql: postgres.Sql,
  owner: WorkflowOwner,
): Promise<AgentRef> {
  const config = PYDANTIC_AGENT_CONFIG as unknown as JsonRecord;
  const configHash = hashConfig(config);
  const existingRows = await sql`
    select a.id, a.created_by, a.project_id,
           av.version, av.config_hash, jsonb_typeof(av.config) as config_type
    from agents a
    left join agent_versions av on av.id = a.current_version_id
    where a.slug = ${PYDANTIC_AGENT_SLUG}
    limit 1
  `;
  const existing = existingRows[0];
  if (existing?.id) {
    assertResourceOwner(
      `Agent slug ${PYDANTIC_AGENT_SLUG}`,
      { userId: existing.created_by, projectId: existing.project_id },
      owner,
    );
  }

  if (
    existing?.id &&
    existing.config_hash === configHash &&
    existing.config_type === "object"
  ) {
    await sql`
      update agents
      set
        name = ${PYDANTIC_AGENT_NAME},
        description = ${PYDANTIC_AGENT_DESCRIPTION},
        tags = ${sql.json([...PYDANTIC_AGENT_TAGS])},
        runtime = ${"pydantic-ai-agent-py"},
        registry_status = ${"registered"},
        is_archived = false,
        updated_at = now()
      where id = ${existing.id}
        and (
          name is distinct from ${PYDANTIC_AGENT_NAME}
          or description is distinct from ${PYDANTIC_AGENT_DESCRIPTION}
          or tags is distinct from ${sql.json([...PYDANTIC_AGENT_TAGS])}
          or runtime is distinct from ${"pydantic-ai-agent-py"}
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
          ${"Reconcile the Pydantic AI animation builder to Kimi K3, max reasoning, and the 1M-token context contract."},
          now(), ${owner.userId}, now()
        )
      `;
      await tx`
        update agents
        set
          name = ${PYDANTIC_AGENT_NAME},
          description = ${PYDANTIC_AGENT_DESCRIPTION},
          tags = ${tx.json([...PYDANTIC_AGENT_TAGS])},
          runtime = ${"pydantic-ai-agent-py"},
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
        ${agentId}, ${PYDANTIC_AGENT_SLUG}, ${PYDANTIC_AGENT_NAME},
        ${PYDANTIC_AGENT_DESCRIPTION},
        ${tx.json([...PYDANTIC_AGENT_TAGS])},
        ${"pydantic-ai-agent-py"}, ${owner.userId}, ${owner.projectId},
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
        ${"Initial Pydantic AI Kimi K3 definition for the fresh dynamic animation workflow."},
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
  owner: WorkflowOwner,
): Promise<AgentRef> {
  const rows =
    override.version !== undefined
      ? await sql`
          select a.id, a.created_by, a.project_id, a.runtime, av.version, av.config
          from agents a
          join agent_versions av on av.agent_id = a.id
          where a.id = ${override.id} and av.version = ${override.version}
          limit 1
        `
      : await sql`
          select a.id, a.created_by, a.project_id, a.runtime, av.version, av.config
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
  const row = rows[0];
  assertResourceOwner(
    `Agent override ${override.id}`,
    { userId: row.created_by, projectId: row.project_id },
    owner,
  );
  const config =
    typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  if (
    row.runtime !== "pydantic-ai-agent-py" ||
    !config ||
    typeof config !== "object" ||
    config.runtime !== "pydantic-ai-agent-py" ||
    config.modelSpec !== "kimi/kimi-k3" ||
    config.reasoningEffort !== "max" ||
    config.contextWindowTokens !== 1_048_576
  ) {
    throw new Error(
      "The animation agent override must use pydantic-ai-agent-py with kimi/kimi-k3, max reasoning, and a 1,048,576-token context window",
    );
  }
  return { id: String(row.id), version: Number(row.version) };
}

const DYNAMIC_SCRIPT_URL = new URL(
  "./fixtures/dynamic-scripts/pydantic-ai-k3-3blue1brown-animation.js",
  import.meta.url,
);

const DYNAMIC_SCRIPT_META = {
  name: WORKFLOW_ID,
  description:
    "Build a 3Blue1Brown-style browser animation with Pydantic AI and Kimi K3, materialize it into a retained browser sandbox, capture its interaction states, and start a live preview.",
  phases: [
    { title: "Setup" },
    { title: "Build", model: "kimi/kimi-k3" },
    { title: "Materialize" },
    { title: "Validate" },
    { title: "Preview" },
  ],
  input: {
    type: "object",
    required: ["animationDescription"],
    additionalProperties: false,
    properties: {
      animationDescription: {
        type: "string",
        title: "Animation description",
        minLength: 1,
        maxLength: 12000,
        default:
          "Create a concise 3Blue1Brown-style animation explaining the derivative of sin(x), with a moving point, clipped tangent line, and synchronized cos(x) slope readout from x=0 to 2*pi.",
        description:
          "Describe the 3Blue1Brown-style animation the agent should build.",
      },
      sandboxTemplate: {
        type: "string",
        title: "Browser sandbox template",
        default: "dapr-agent",
      },
    },
  },
} as const;

export function buildSpec(agentRef: AgentRef): JsonRecord {
  const script = readFileSync(DYNAMIC_SCRIPT_URL, "utf8")
    .replaceAll("__PYDANTIC_AGENT_ID_JSON__", JSON.stringify(agentRef.id))
    .replaceAll("__PYDANTIC_AGENT_VERSION__", String(agentRef.version));
  if (/__PYDANTIC_AGENT_(?:ID_JSON|VERSION)__/.test(script)) {
    throw new Error("Pydantic agent placeholders were not fully resolved");
  }
  return {
    engine: "dynamic-script",
    script,
    meta: DYNAMIC_SCRIPT_META,
    defaults: {
      model: "kimi/kimi-k3",
      agentRuntime: "pydantic-ai-agent-py",
      timeoutMinutes: 60,
    },
  };
}

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
    const owner = await resolveOwner(
      sql,
      existingRows[0],
      args.userEmail,
      args.projectId,
    );
    const agentRef = args.agentOverride
      ? await resolveAgentOverride(sql, args.agentOverride, owner)
      : await ensurePydanticAgent(sql, owner);

    const spec = buildSpec(agentRef);
    const nodes: JsonRecord[] = [];
    const edges: JsonRecord[] = [];
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
        ${"dynamic-script"},
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
      `  agent source    = ${args.agentOverride ? "explicit override" : PYDANTIC_AGENT_SLUG}`,
    );
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log("  visibility      = public");
    console.log("  engine          = dynamic-script");
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const DIRECT_ENTRY_BASENAME =
  "upsert-pydantic-ai-k3-3blue1brown-animation-workflow.ts";

export function isDirectExecution(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  if (!argvPath || moduleUrl !== pathToFileURL(argvPath).href) return false;
  return basename(fileURLToPath(moduleUrl)) === DIRECT_ENTRY_BASENAME;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(
      "[upsert-pydantic-ai-k3-3blue1brown-animation-workflow] Error:",
      error,
    );
    process.exitCode = 1;
  });
}
