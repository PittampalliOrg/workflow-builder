/**
 * Restore the SWE-bench smoke/canary fixtures needed after disposable dev
 * rebuilds. The fixture is exported from current dev with secrets, runs,
 * leases, sessions, logs, traces, and artifacts excluded.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   SEED_WORKFLOW_USER_EMAIL=vpittamp@gmail.com \
 *   pnpm tsx scripts/seed-swebench-fixtures.ts
 *
 * Deployment hooks should set SEED_SWEBENCH_FIXTURES_SKIP_WHEN_ACTIVE=true so
 * an active benchmark run does not turn a safe no-op into a failed sync hook.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { SWE_BENCH_SOLVER_SYSTEM_PROMPT } from "../src/lib/server/benchmarks/agent-prompts";
import { hashAgentConfig } from "../src/lib/server/agents/config-hash";
import type { AgentConfig } from "../src/lib/types/agents";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const FIXTURE_PATH = resolve(
  process.cwd(),
  "scripts/fixtures/swebench-dev-fixtures.json",
);
const ROLLBACK_AFTER_SEED =
  (process.env.SEED_SWEBENCH_FIXTURES_ROLLBACK || "false").toLowerCase() ===
  "true";
const SKIP_WHEN_ACTIVE =
  (
    process.env.SEED_SWEBENCH_FIXTURES_SKIP_WHEN_ACTIVE || "false"
  ).toLowerCase() === "true";

class RollbackSeed extends Error {
  constructor() {
    super("rollback requested");
  }
}

type Row = Record<string, unknown>;
type Fixtures = {
  agents: Row[];
  agent_versions: Row[];
  workflows: Row[];
  benchmark_suites: Row[];
  benchmark_instances: Row[];
  environment_image_builds: Row[];
  environments: Row[];
  environment_versions: Row[];
};

const TABLE_COLUMNS = {
  environments: [
    "id",
    "slug",
    "name",
    "description",
    "avatar",
    "tags",
    "runtime",
    "current_version_id",
    "created_by",
    "project_id",
    "is_archived",
    "is_builtin",
    "base_env_slug",
    "created_at",
    "updated_at",
  ],
  environment_versions: [
    "id",
    "environment_id",
    "version",
    "config",
    "config_hash",
    "changelog",
    "published_at",
    "published_by",
    "image_tag",
    "dockerfile_path",
    "last_build_sha",
    "last_build_at",
    "last_build_status",
    "last_build_error",
    "created_at",
  ],
  agents: [
    "id",
    "slug",
    "name",
    "description",
    "avatar",
    "tags",
    "runtime",
    "runtime_app_id",
    "runtime_status",
    "runtime_status_synced_at",
    "current_version_id",
    "environment_id",
    "environment_version",
    "default_vault_ids",
    "source_template_slug",
    "source_template_version",
    "created_by",
    "project_id",
    "is_archived",
    "registry_status",
    "registry_synced_at",
    "registry_error",
    "created_at",
    "updated_at",
  ],
  agent_versions: [
    "id",
    "agent_id",
    "version",
    "config",
    "config_hash",
    "changelog",
    "published_at",
    "published_by",
    "created_at",
  ],
  workflows: [
    "id",
    "name",
    "description",
    "user_id",
    "project_id",
    "nodes",
    "edges",
    "spec_version",
    "spec",
    "visibility",
    "engine_type",
    "dapr_workflow_name",
    "created_at",
    "updated_at",
  ],
  benchmark_suites: [
    "id",
    "slug",
    "name",
    "description",
    "dataset_name",
    "dataset_split",
    "source_url",
    "default_instance_limit",
    "metadata",
    "created_at",
    "updated_at",
  ],
  benchmark_instances: [
    "id",
    "suite_id",
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "hints_text",
    "test_metadata",
    "gold_patch",
    "metadata",
    "created_at",
    "updated_at",
  ],
  environment_image_builds: [
    "id",
    "dataset",
    "suite",
    "repo",
    "version",
    "environment_setup_commit",
    "base_commit",
    "environment_key",
    "env_spec_hash",
    "build_strategy",
    "status",
    "sandbox_template",
    "sandbox_image",
    "digest",
    "image_name",
    "image_tag",
    "dockerfile_path",
    "validation_command",
    "validation_status",
    "validation_log_ref",
    "build_log_ref",
    "pipeline_run_name",
    "pipeline_run_namespace",
    "spec",
    "metadata",
    "error",
    "requested_at",
    "started_at",
    "completed_at",
    "built_at",
    "created_at",
    "updated_at",
  ],
} as const satisfies Record<string, readonly string[]>;

const JSON_COLUMNS = new Set([
  "tags",
  "default_vault_ids",
  "nodes",
  "edges",
  "spec",
  "metadata",
  "test_metadata",
  "config",
]);

const REQUIRED_AGENT_MODEL_SPECS = {
  "alibaba-qwen3-coder-swebench": "alibaba/qwen3-coder-plus",
  "claude-code-agent-sdk-smoke": "anthropic/claude-opus-4-8",
  "claude-code-swebench-smoke": "anthropic/claude-opus-4-8",
  "claude-code-cli-swebench-smoke": "anthropic/claude-opus-4-8",
  "codex-cli-swebench-smoke": "openai/gpt-5.5",
  "agy-cli-swebench-smoke": "googleai/gemini-3.1-pro-preview",
  "deepseek-v4-pro-swebench": "deepseek/deepseek-v4-pro",
  "kimi-k26-swebench-canary": "kimi/kimi-k2.6",
} as const;

const CLAUDE_AGENT_SEED_TIMESTAMP = "2026-06-06T14:26:53.520075";
const CLAUDE_AGENT_RUNTIME = "claude-agent-py";
const CLAUDE_AGENT_RUNTIME_APP_ID = "agent-runtime-pool-coding";
const CLAUDE_AGENT_ENVIRONMENT_ID = "env_builtin_dapr_agent";
const CLAUDE_AGENT_MODEL_SPEC = "anthropic/claude-opus-4-8";
const CLI_AGENT_SEED_TIMESTAMP = "2026-06-14T03:12:00.000000";
const CLI_AGENT_RUNTIME_APP_ID = "agent-runtime-pool-coding";
const CLI_AGENT_ENVIRONMENT_ID = "env_builtin_dapr_agent";

function claudeAgentConfig(overrides: {
  systemPrompt: string;
  maxTurns: number;
  cacheTtl?: "5m" | "1h";
}): AgentConfig {
  return {
    memory: { backend: "dapr_state" },
    skills: [],
    runtime: CLAUDE_AGENT_RUNTIME,
    cacheTtl: overrides.cacheTtl,
    maxTurns: overrides.maxTurns,
    modelSpec: CLAUDE_AGENT_MODEL_SPEC,
    mcpServers: [],
    runtimePool: undefined,
    builtinTools: [],
    runtimeClass: "coding",
    systemPrompt: overrides.systemPrompt,
    timeoutMinutes: 60,
    runtimeIsolation: "shared",
    mcpConnectionMode: "explicit",
    runtimeOverridePolicy: {
      allowToolNarrowing: true,
      allowSkillAdditions: false,
      allowSkillNarrowing: true,
      allowServerAdditions: false,
      allowCredentialBinding: true,
    },
  };
}

function cliSwebenchAgentConfig(params: {
  runtime: "claude-code-cli" | "codex-cli" | "agy-cli";
  modelSpec: string;
}): AgentConfig {
  return {
    memory: { backend: "dapr_state" },
    skills: [],
    runtime: params.runtime,
    maxTurns: 50,
    modelSpec: params.modelSpec,
    mcpServers: [],
    runtimePool: undefined,
    builtinTools: [],
    runtimeClass: "coding",
    systemPrompt: SWE_BENCH_SOLVER_SYSTEM_PROMPT,
    timeoutMinutes: 60,
    permissionMode: "bypassPermissions",
    runtimeIsolation: "shared",
    mcpConnectionMode: "explicit",
    runtimeOverridePolicy: {
      allowToolNarrowing: true,
      allowSkillAdditions: false,
      allowSkillNarrowing: true,
      allowServerAdditions: false,
      allowCredentialBinding: true,
    },
  };
}

function claudeAgentRow(params: {
  id: string;
  name: string;
  slug: string;
  tags: string[];
  description: string;
  currentVersionId: string;
  sourceTemplateSlug: string;
}): Row {
  return {
    id: params.id,
    name: params.name,
    slug: params.slug,
    tags: params.tags,
    avatar: null,
    runtime: CLAUDE_AGENT_RUNTIME,
    created_at: CLAUDE_AGENT_SEED_TIMESTAMP,
    created_by: "dev-admin-user",
    project_id: "dev-default-project",
    updated_at: CLAUDE_AGENT_SEED_TIMESTAMP,
    description: params.description,
    is_archived: false,
    environment_id: CLAUDE_AGENT_ENVIRONMENT_ID,
    registry_error: null,
    runtime_app_id: CLAUDE_AGENT_RUNTIME_APP_ID,
    runtime_status: "ready",
    registry_status: "registered",
    default_vault_ids: [],
    current_version_id: params.currentVersionId,
    registry_synced_at: `${CLAUDE_AGENT_SEED_TIMESTAMP}+00:00`,
    environment_version: 1,
    source_template_slug: params.sourceTemplateSlug,
    source_template_version: 1,
    runtime_status_synced_at: `${CLAUDE_AGENT_SEED_TIMESTAMP}+00:00`,
  };
}

function claudeAgentVersionRow(params: {
  id: string;
  agentId: string;
  config: AgentConfig;
  changelog: string;
  createdAt?: string;
}): Row {
  const createdAt = params.createdAt ?? CLAUDE_AGENT_SEED_TIMESTAMP;
  return {
    id: params.id,
    config: params.config,
    version: 1,
    agent_id: params.agentId,
    changelog: params.changelog,
    created_at: createdAt,
    config_hash: hashAgentConfig(params.config),
    published_at: createdAt,
    published_by: "dev-admin-user",
  };
}

function cliSwebenchAgentRow(params: {
  id: string;
  name: string;
  slug: string;
  runtime: "claude-code-cli" | "codex-cli" | "agy-cli";
  tags: string[];
  description: string;
  currentVersionId: string;
}): Row {
  return {
    id: params.id,
    name: params.name,
    slug: params.slug,
    tags: params.tags,
    avatar: null,
    runtime: params.runtime,
    created_at: CLI_AGENT_SEED_TIMESTAMP,
    created_by: "dev-admin-user",
    project_id: "dev-default-project",
    updated_at: CLI_AGENT_SEED_TIMESTAMP,
    description: params.description,
    is_archived: false,
    environment_id: CLI_AGENT_ENVIRONMENT_ID,
    registry_error: null,
    runtime_app_id: CLI_AGENT_RUNTIME_APP_ID,
    runtime_status: "ready",
    registry_status: "registered",
    default_vault_ids: [],
    current_version_id: params.currentVersionId,
    registry_synced_at: `${CLI_AGENT_SEED_TIMESTAMP}+00:00`,
    environment_version: 1,
    source_template_slug: params.slug,
    source_template_version: 1,
    runtime_status_synced_at: `${CLI_AGENT_SEED_TIMESTAMP}+00:00`,
  };
}

function cliSwebenchAgentVersionRow(params: {
  id: string;
  agentId: string;
  config: AgentConfig;
  changelog: string;
}): Row {
  return {
    id: params.id,
    config: params.config,
    version: 1,
    agent_id: params.agentId,
    changelog: params.changelog,
    created_at: CLI_AGENT_SEED_TIMESTAMP,
    config_hash: hashAgentConfig(params.config),
    published_at: CLI_AGENT_SEED_TIMESTAMP,
    published_by: "dev-admin-user",
  };
}

function appendMissingRows(rows: Row[], additions: Row[]): Row[] {
  const existing = new Set(rows.map((row) => String(row.id)));
  const missing = additions.filter((row) => !existing.has(String(row.id)));
  return missing.length > 0 ? [...rows, ...missing] : rows;
}

function withClaudeAgentFixtures(fixtures: Fixtures): Fixtures {
  const sdkConfig = claudeAgentConfig({
    systemPrompt:
      "You are a pragmatic coding agent. Inspect the workspace, make focused edits, run targeted validation, and report the exact outcome.",
    maxTurns: 80,
    cacheTtl: "1h",
  });
  const swebenchConfig = claudeAgentConfig({
    systemPrompt: SWE_BENCH_SOLVER_SYSTEM_PROMPT,
    maxTurns: 50,
    cacheTtl: "1h",
  });
  return {
    ...fixtures,
    agents: appendMissingRows(fixtures.agents, [
      claudeAgentRow({
        id: "agnt_claude_code_sdk_smoke",
        name: "Claude Code Agent SDK smoke",
        slug: "claude-code-agent-sdk-smoke",
        tags: ["claude-agent-py", "smoke", "coding"],
        description: "Claude Agent SDK runtime smoke agent for workflow-builder demos.",
        currentVersionId: "av_claude_code_sdk_smoke_v1",
        sourceTemplateSlug: "claude-code-agent-sdk",
      }),
      claudeAgentRow({
        id: "agnt_claude_code_swebench_smoke",
        name: "Claude Code SWE-bench smoke",
        slug: "claude-code-swebench-smoke",
        tags: ["claude-agent-py", "swebench", "smoke"],
        description: "Claude Agent SDK runtime smoke agent for SWE-bench canaries.",
        currentVersionId: "av_claude_code_swebench_smoke_v1",
        sourceTemplateSlug: "claude-code-swebench-solver",
      }),
    ]),
    agent_versions: appendMissingRows(fixtures.agent_versions, [
      claudeAgentVersionRow({
        id: "av_claude_code_sdk_smoke_v1",
        agentId: "agnt_claude_code_sdk_smoke",
        config: sdkConfig,
        changelog: "Claude Agent SDK smoke runtime setup",
      }),
      claudeAgentVersionRow({
        id: "av_claude_code_swebench_smoke_v1",
        agentId: "agnt_claude_code_swebench_smoke",
        config: swebenchConfig,
        changelog: "Claude Agent SDK smoke runtime setup",
        createdAt: "2026-06-06T14:26:53.525705",
      }),
    ]),
  };
}

function withCliSwebenchAgentFixtures(fixtures: Fixtures): Fixtures {
  const claudeCliConfig = cliSwebenchAgentConfig({
    runtime: "claude-code-cli",
    modelSpec: "anthropic/claude-opus-4-8",
  });
  const codexCliConfig = cliSwebenchAgentConfig({
    runtime: "codex-cli",
    modelSpec: "openai/gpt-5.5",
  });
  const agyCliConfig = cliSwebenchAgentConfig({
    runtime: "agy-cli",
    modelSpec: "googleai/gemini-3.1-pro-preview",
  });
  return {
    ...fixtures,
    agents: appendMissingRows(fixtures.agents, [
      cliSwebenchAgentRow({
        id: "agnt_claude_code_cli_swebench_smoke",
        name: "Claude Code CLI SWE-bench smoke",
        slug: "claude-code-cli-swebench-smoke",
        runtime: "claude-code-cli",
        tags: ["claude-code-cli", "interactive-cli", "swebench", "smoke"],
        description: "Claude Code CLI runtime smoke agent for SWE-bench canaries.",
        currentVersionId: "av_claude_code_cli_swebench_smoke_v1",
      }),
      cliSwebenchAgentRow({
        id: "agnt_codex_cli_swebench_smoke",
        name: "Codex CLI SWE-bench smoke",
        slug: "codex-cli-swebench-smoke",
        runtime: "codex-cli",
        tags: ["codex-cli", "interactive-cli", "swebench", "smoke"],
        description: "Codex CLI runtime smoke agent for SWE-bench canaries.",
        currentVersionId: "av_codex_cli_swebench_smoke_v1",
      }),
      cliSwebenchAgentRow({
        id: "agnt_agy_cli_swebench_smoke",
        name: "AGY CLI SWE-bench smoke",
        slug: "agy-cli-swebench-smoke",
        runtime: "agy-cli",
        tags: ["agy-cli", "interactive-cli", "swebench", "smoke"],
        description: "Antigravity CLI runtime smoke agent for SWE-bench canaries.",
        currentVersionId: "av_agy_cli_swebench_smoke_v1",
      }),
    ]),
    agent_versions: appendMissingRows(fixtures.agent_versions, [
      cliSwebenchAgentVersionRow({
        id: "av_claude_code_cli_swebench_smoke_v1",
        agentId: "agnt_claude_code_cli_swebench_smoke",
        config: claudeCliConfig,
        changelog: "Claude Code CLI SWE-bench smoke runtime setup",
      }),
      cliSwebenchAgentVersionRow({
        id: "av_codex_cli_swebench_smoke_v1",
        agentId: "agnt_codex_cli_swebench_smoke",
        config: codexCliConfig,
        changelog: "Codex CLI SWE-bench smoke runtime setup",
      }),
      cliSwebenchAgentVersionRow({
        id: "av_agy_cli_swebench_smoke_v1",
        agentId: "agnt_agy_cli_swebench_smoke",
        config: agyCliConfig,
        changelog: "AGY CLI SWE-bench smoke runtime setup",
      }),
    ]),
  };
}

function loadFixtures(): Fixtures {
  const raw = JSON.parse(
    readFileSync(FIXTURE_PATH, "utf-8"),
  ) as Partial<Fixtures>;
  const required = [
    "agents",
    "agent_versions",
    "workflows",
    "benchmark_suites",
    "benchmark_instances",
    "environment_image_builds",
    "environments",
    "environment_versions",
  ] as const;
  for (const key of required) {
    if (!Array.isArray(raw[key])) {
      throw new Error(`SWE-bench fixture is missing array "${key}"`);
    }
  }
  return withCliSwebenchAgentFixtures(withClaudeAgentFixtures(raw as Fixtures));
}

async function resolveTargetUser(
  sql: postgres.Sql,
): Promise<{ id: string; email: string | null }> {
  const explicitId = process.env.SEED_WORKFLOW_USER_ID;
  if (explicitId) {
    const rows = await sql<
      { id: string; email: string | null }[]
    >`SELECT id, email FROM users WHERE id = ${explicitId} LIMIT 1`;
    if (rows.length > 0) return rows[0];
    throw new Error(`SEED_WORKFLOW_USER_ID=${explicitId} not found`);
  }
  const email = process.env.SEED_WORKFLOW_USER_EMAIL;
  if (email) {
    const rows = await sql<
      { id: string; email: string | null }[]
    >`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`;
    if (rows.length > 0) return rows[0];
    throw new Error(`SEED_WORKFLOW_USER_EMAIL=${email} not found`);
  }
  const githubEmail = process.env.SEED_GITHUB_USER_EMAIL;
  if (githubEmail) {
    const rows = await sql<
      { id: string; email: string | null }[]
    >`SELECT id, email FROM users WHERE email = ${githubEmail} LIMIT 1`;
    if (rows.length > 0) return rows[0];
  }
  const admins = await sql<
    { id: string; email: string | null }[]
  >`SELECT id, email FROM users WHERE platform_role = 'ADMIN' ORDER BY created_at LIMIT 2`;
  if (admins.length === 1) return admins[0];
  if (admins.length > 1) {
    throw new Error(
      "Multiple ADMIN users present; set SEED_WORKFLOW_USER_ID or SEED_WORKFLOW_USER_EMAIL",
    );
  }
  const fallback = await sql<
    { id: string; email: string | null }[]
  >`SELECT id, email FROM users ORDER BY created_at LIMIT 1`;
  if (fallback.length === 0) throw new Error("No users found in DB");
  return fallback[0];
}

async function resolveTargetProject(
  sql: postgres.Sql,
  userId: string,
): Promise<{ id: string; displayName: string | null }> {
  const explicit = process.env.SEED_WORKFLOW_PROJECT_ID;
  if (explicit) {
    const rows = await sql<
      { id: string; display_name: string | null }[]
    >`SELECT id, display_name FROM projects WHERE id = ${explicit} LIMIT 1`;
    if (rows.length > 0)
      return { id: rows[0].id, displayName: rows[0].display_name };
    throw new Error(`SEED_WORKFLOW_PROJECT_ID=${explicit} not found`);
  }
  const rows = await sql<{ id: string; display_name: string | null }[]>`
		SELECT p.id, p.display_name
		FROM projects p
		JOIN project_members m ON m.project_id = p.id
		WHERE m.user_id = ${userId}
		ORDER BY (m.role = 'ADMIN') DESC, p.created_at
		LIMIT 1
	`;
  if (rows.length > 0)
    return { id: rows[0].id, displayName: rows[0].display_name };
  throw new Error(`No project found for user ${userId}`);
}

function pick(sql: postgres.Sql, row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const column of columns) {
    const value = row[column] ?? null;
    out[column] =
      value !== null && JSON_COLUMNS.has(column) ? sql.json(value) : value;
  }
  return out;
}

type EnvironmentIdMaps = {
  environmentIds: Map<string, string>;
  environmentVersionIds: Map<string, string>;
};

async function buildEnvironmentIdMaps(
  sql: postgres.Sql,
  fixtures: Fixtures,
): Promise<EnvironmentIdMaps> {
  const environmentIds = new Map<string, string>();
  const environmentVersionIds = new Map<string, string>();
  const slugToEnvironmentId = new Map<string, string>();

  for (const environment of fixtures.environments) {
    const fixtureId = String(environment.id);
    const slug = String(environment.slug);
    const existing = await sql<{ id: string }[]>`
			SELECT id FROM environments WHERE slug = ${slug} LIMIT 1
		`;
    const targetId = existing[0]?.id ?? fixtureId;
    environmentIds.set(fixtureId, targetId);
    slugToEnvironmentId.set(slug, targetId);
  }

  for (const version of fixtures.environment_versions) {
    const fixtureId = String(version.id);
    const fixtureEnvironmentId = String(version.environment_id);
    const targetEnvironmentId =
      environmentIds.get(fixtureEnvironmentId) ?? fixtureEnvironmentId;
    const existing = await sql<{ id: string }[]>`
			SELECT id
			FROM environment_versions
			WHERE environment_id = ${targetEnvironmentId}
				AND version = ${Number(version.version)}
			LIMIT 1
		`;
    environmentVersionIds.set(fixtureId, existing[0]?.id ?? fixtureId);
  }

  for (const environment of fixtures.environments) {
    const currentVersionId = environment.current_version_id;
    if (typeof currentVersionId === "string") {
      environmentVersionIds.set(
        currentVersionId,
        environmentVersionIds.get(currentVersionId) ?? currentVersionId,
      );
    }
    const slug = String(environment.slug);
    const targetId = slugToEnvironmentId.get(slug);
    if (targetId) environmentIds.set(String(environment.id), targetId);
  }

  return { environmentIds, environmentVersionIds };
}

function retarget(
  row: Row,
  userId: string,
  projectId: string,
  environmentMaps?: EnvironmentIdMaps,
): Row {
  const environmentId =
    typeof row.environment_id === "string"
      ? (environmentMaps?.environmentIds.get(row.environment_id) ??
        row.environment_id)
      : row.environment_id;
  const currentVersionId =
    typeof row.current_version_id === "string"
      ? (environmentMaps?.environmentVersionIds.get(row.current_version_id) ??
        row.current_version_id)
      : row.current_version_id;
  const id =
    typeof row.id === "string"
      ? (environmentMaps?.environmentIds.get(row.id) ??
        environmentMaps?.environmentVersionIds.get(row.id) ??
        row.id)
      : row.id;
  return {
    ...row,
    id,
    environment_id: environmentId,
    current_version_id: currentVersionId,
    created_by: row.created_by === undefined ? row.created_by : userId,
    published_by: row.published_by === undefined ? row.published_by : userId,
    user_id: row.user_id === undefined ? row.user_id : userId,
    project_id: row.project_id === undefined ? row.project_id : projectId,
    registry_status:
      row.registry_status === undefined ? row.registry_status : "registered",
  };
}

function validateFixtures(fixtures: Fixtures) {
  const envIds = new Set(fixtures.environments.map((row) => String(row.id)));
  const agentIds = new Set(fixtures.agents.map((row) => String(row.id)));
  const agentsBySlug = new Map(
    fixtures.agents.map((row) => [String(row.slug), row]),
  );
  const agentVersionsById = new Map(
    fixtures.agent_versions.map((row) => [String(row.id), row]),
  );
  const agentVersionIds = new Set(
    fixtures.agent_versions.map((row) => String(row.id)),
  );
  const suiteIds = new Set(
    fixtures.benchmark_suites.map((row) => String(row.id)),
  );

  for (const agent of fixtures.agents) {
    if (typeof agent.id !== "string" || typeof agent.slug !== "string") {
      throw new Error("Agent fixture row is missing id or slug");
    }
    if (
      typeof agent.environment_id === "string" &&
      !envIds.has(agent.environment_id)
    ) {
      throw new Error(
        `Agent ${agent.id} references missing environment ${agent.environment_id}`,
      );
    }
    if (
      typeof agent.current_version_id === "string" &&
      !agentVersionIds.has(agent.current_version_id)
    ) {
      throw new Error(
        `Agent ${agent.id} references missing current_version_id ${agent.current_version_id}`,
      );
    }
  }
  for (const [slug, expectedModelSpec] of Object.entries(
    REQUIRED_AGENT_MODEL_SPECS,
  )) {
    const agent = agentsBySlug.get(slug);
    if (!agent) {
      throw new Error(`Required SWE-bench canary agent is missing: ${slug}`);
    }
    const version = agentVersionsById.get(String(agent.current_version_id));
    if (!version) {
      throw new Error(
        `Required SWE-bench canary agent ${slug} references missing current version ${String(agent.current_version_id)}`,
      );
    }
    const rawConfig = version.config;
    const config =
      typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
    if (
      typeof config !== "object" ||
      config === null ||
      (config as { modelSpec?: unknown }).modelSpec !== expectedModelSpec
    ) {
      throw new Error(
        `Required SWE-bench canary agent ${slug} expected modelSpec=${expectedModelSpec}`,
      );
    }
  }
  for (const version of fixtures.agent_versions) {
    if (!agentIds.has(String(version.agent_id))) {
      throw new Error(
        `Agent version ${version.id} references missing agent ${version.agent_id}`,
      );
    }
  }
  for (const instance of fixtures.benchmark_instances) {
    if (!suiteIds.has(String(instance.suite_id))) {
      throw new Error(
        `Benchmark instance ${instance.id} references missing suite ${instance.suite_id}`,
      );
    }
  }
  for (const build of fixtures.environment_image_builds) {
    if (
      build.status !== "validated" ||
      build.validation_status !== "validated"
    ) {
      throw new Error(
        `Environment image build ${build.id} is not validated/validated`,
      );
    }
  }
}

async function upsertRows(
  sql: postgres.Sql,
  table: keyof typeof TABLE_COLUMNS,
  rows: Row[],
  conflictTarget: string,
  columns = TABLE_COLUMNS[table],
) {
  if (rows.length === 0) return;
  const quotedTable = sql(table);
  const conflictColumns = new Set(
    conflictTarget
      .replace(/[()]/g, "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean),
  );
  const updateColumns = columns.filter(
    (column) => !conflictColumns.has(column),
  );
  const updateSet = updateColumns
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(", ");
  for (const source of rows) {
    const row = pick(sql, source, columns);
    await sql`
			INSERT INTO ${quotedTable} ${sql(row, columns)}
			ON CONFLICT ${sql.unsafe(conflictTarget)} DO UPDATE SET ${sql.unsafe(updateSet)}
		`;
  }
}

async function readActiveBenchmarkState(sql: postgres.Sql) {
  const [runs, leases] = await Promise.all([
    sql<{ count: string }[]>`
			SELECT count(*)::text AS count
			FROM benchmark_runs
			WHERE status IN ('queued', 'inferencing', 'evaluating')
		`,
    sql<{ count: string }[]>`
			SELECT count(*)::text AS count
			FROM benchmark_resource_leases
			WHERE status = 'active'
		`,
  ]);
  const activeRuns = Number(runs[0]?.count ?? 0);
  const activeLeases = Number(leases[0]?.count ?? 0);
  return { activeRuns, activeLeases };
}

async function assertNoActiveBenchmarkState(sql: postgres.Sql) {
  const { activeRuns, activeLeases } = await readActiveBenchmarkState(sql);
  if (activeRuns > 0 || activeLeases > 0) {
    throw new Error(
      `Refusing to seed SWE-bench fixtures over active benchmark state: activeRuns=${activeRuns} activeLeases=${activeLeases}`,
    );
  }
}

async function main() {
  console.log("[seed-swebench-fixtures] starting");
  const fixtures = loadFixtures();
  validateFixtures(fixtures);
  console.log(
    `[seed-swebench-fixtures] fixtures: ${fixtures.agents.length} agents, ${fixtures.workflows.length} workflows, ${fixtures.benchmark_instances.length} instances, ${fixtures.environment_image_builds.length} image builds`,
  );

  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const activeState = await readActiveBenchmarkState(sql);
    if (activeState.activeRuns > 0 || activeState.activeLeases > 0) {
      if (SKIP_WHEN_ACTIVE) {
        console.log(
          `[seed-swebench-fixtures] active benchmark state detected; skipping fixture seed: activeRuns=${activeState.activeRuns} activeLeases=${activeState.activeLeases}`,
        );
        return;
      }
      throw new Error(
        `Refusing to seed SWE-bench fixtures over active benchmark state: activeRuns=${activeState.activeRuns} activeLeases=${activeState.activeLeases}`,
      );
    }
    const user = await resolveTargetUser(sql);
    const project = await resolveTargetProject(sql, user.id);
    console.log(
      `[seed-swebench-fixtures] target user=${user.id} (${user.email ?? "no-email"}) project=${project.id} (${project.displayName ?? "no-name"})`,
    );

    const environmentMaps = await buildEnvironmentIdMaps(sql, fixtures);
    const target = (rows: Row[]) =>
      rows.map((row) => retarget(row, user.id, project.id, environmentMaps));

    const applySeed = async (tx: postgres.Sql) => {
      await upsertRows(
        tx,
        "environments",
        target(fixtures.environments),
        "(slug)",
      );
      await upsertRows(
        tx,
        "environment_versions",
        target(fixtures.environment_versions),
        "(environment_id, version)",
      );
      await upsertRows(tx, "agents", target(fixtures.agents), "(id)");
      await upsertRows(
        tx,
        "agent_versions",
        target(fixtures.agent_versions),
        "(id)",
      );
      await upsertRows(tx, "workflows", target(fixtures.workflows), "(id)");
      await upsertRows(
        tx,
        "benchmark_suites",
        fixtures.benchmark_suites,
        "(slug)",
      );
      await upsertRows(
        tx,
        "benchmark_instances",
        fixtures.benchmark_instances,
        "(suite_id, instance_id)",
      );
      await upsertRows(
        tx,
        "environment_image_builds",
        fixtures.environment_image_builds,
        "(env_spec_hash)",
      );
      await assertNoActiveBenchmarkState(tx);
      if (ROLLBACK_AFTER_SEED) throw new RollbackSeed();
    };

    if (ROLLBACK_AFTER_SEED) {
      try {
        await sql.begin(applySeed);
      } catch (error) {
        if (error instanceof RollbackSeed) {
          console.log(
            "[seed-swebench-fixtures] rollback requested; no rows committed",
          );
          return;
        }
        throw error;
      }
    } else {
      await applySeed(sql);
    }
    console.log("[seed-swebench-fixtures] done");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[seed-swebench-fixtures] failed:", error);
  process.exit(1);
});
