/**
 * Create the fresh "Kimi K3 3Blue1Brown-style Animation" workflow.
 *
 * Fresh dynamic-script workflow informed by the read-only script mirror's proven
 * action sequence:
 *
 *   action(workspace/profile) -> agent(Kimi K3) -> action(browser/validate)
 *                                                   -> action(browser/start-preview)
 *
 * It has a new workflow identity and a dedicated dapr-agent-py Kimi K3 agent.
 * It never updates either prior 3Blue1Brown workflow.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-kimi-k3-3blue1brown-animation-workflow.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/upsert-kimi-k3-3blue1brown-animation-workflow.ts \
 *     --user-email vinod@pittampalli.com \
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
export const WORKFLOW_ID = "kimi-k3-3blue1brown-animation";
export const WORKFLOW_NAME = "Kimi K3 3Blue1Brown-style Animation";
export const WORKFLOW_DESCRIPTION =
  "Use a dynamic-script workflow and Kimi K3 to generate a self-contained 3Blue1Brown-style browser animation in a retained sandbox, capture its play/restart states, and start a live preview.";

export const KIMI_AGENT_SLUG = "kimi-k3-dynamic-animation-builder";
export const KIMI_AGENT_NAME = "Kimi K3 Dynamic Animation Builder";
export const KIMI_AGENT_DESCRIPTION =
  "Dapr Agents coding agent for fresh dynamic-script mathematical browser animations with Kimi K3.";

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
          ${"Reconcile the dynamic animation agent to Kimi K3 with max reasoning and a 1M-token context window."},
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
        ${"Initial Kimi K3 definition for the fresh dynamic animation workflow."},
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
          select a.id, a.runtime, av.version, av.config
          from agents a
          join agent_versions av on av.agent_id = a.id
          where a.id = ${override.id} and av.version = ${override.version}
          limit 1
        `
      : await sql`
          select a.id, a.runtime, av.version, av.config
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
  const config =
    typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  if (
    row.runtime !== "dapr-agent-py" ||
    !config ||
    typeof config !== "object" ||
    config.modelSpec !== "kimi/kimi-k3" ||
    config.reasoningEffort !== "max" ||
    config.contextWindowTokens !== 1_048_576
  ) {
    throw new Error(
      "The K3 animation agent override must be dapr-agent-py with kimi/kimi-k3, max reasoning, and a 1,048,576-token context window",
    );
  }
  return { id: String(row.id), version: Number(row.version) };
}
// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

const DYNAMIC_SCRIPT_URL = new URL(
  "./fixtures/dynamic-scripts/kimi-k3-3blue1brown-animation.js",
  import.meta.url,
);

const DYNAMIC_SCRIPT_META = {
  name: WORKFLOW_ID,
  description:
    "Build a 3Blue1Brown-style Canvas or SVG animation with Kimi K3 in a retained sandbox, capture the play and restart states, and start a live preview.",
  phases: [
    { title: "Setup" },
    { title: "Build", model: "kimi/kimi-k3" },
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
          "Create a concise 3Blue1Brown-style derivative animation for x^2",
        description:
          "Describe the 3Blue1Brown-style animation the agent should build.",
      },
      sandboxTemplate: {
        type: "string",
        title: "Sandbox template",
        default: "dapr-agent",
      },
    },
  },
} as const;

export function buildSpec(agentRef: AgentRef): JsonRecord {
  const script = readFileSync(DYNAMIC_SCRIPT_URL, "utf8")
    .replaceAll("__KIMI_AGENT_ID_JSON__", JSON.stringify(agentRef.id))
    .replaceAll("__KIMI_AGENT_VERSION__", String(agentRef.version));
  if (/__KIMI_AGENT_(?:ID_JSON|VERSION)__/.test(script)) {
    throw new Error("Kimi agent placeholders were not fully resolved");
  }
  return {
    engine: "dynamic-script",
    script,
    meta: DYNAMIC_SCRIPT_META,
    defaults: {
      model: "kimi/kimi-k3",
      agentRuntime: "dapr-agent-py",
      timeoutMinutes: 60,
    },
  };
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
      `  agent source    = ${args.agentOverride ? "explicit override" : KIMI_AGENT_SLUG}`,
    );
    console.log(`  owner.userId    = ${owner.userId}`);
    console.log(`  owner.projectId = ${owner.projectId ?? "(none)"}`);
    console.log(`  visibility      = public`);
    console.log(`  engine          = dynamic-script`);
    console.log(`  UI route        : /workflows/${WORKFLOW_ID}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const DIRECT_ENTRY_BASENAME =
  "upsert-kimi-k3-3blue1brown-animation-workflow.ts";

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
      "[upsert-kimi-k3-3blue1brown-animation-workflow] Error:",
      error,
    );
    process.exitCode = 1;
  });
}
