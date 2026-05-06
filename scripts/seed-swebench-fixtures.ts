/**
 * Restore the SWE-bench smoke/canary fixtures needed after disposable dev
 * rebuilds. The fixture is exported from current dev with secrets, runs,
 * leases, sessions, logs, traces, and artifacts excluded.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   SEED_WORKFLOW_USER_EMAIL=vpittamp@gmail.com \
 *   pnpm tsx scripts/seed-swebench-fixtures.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";
const FIXTURE_PATH = resolve(
	process.cwd(),
	"scripts/fixtures/swebench-dev-fixtures.json",
);
const ROLLBACK_AFTER_SEED =
	(process.env.SEED_SWEBENCH_FIXTURES_ROLLBACK || "false").toLowerCase() ===
	"true";

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

function loadFixtures(): Fixtures {
	const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Partial<Fixtures>;
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
	return raw as Fixtures;
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
	const rows = await sql<
		{ id: string; display_name: string | null }[]
	>`
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

function retarget(row: Row, userId: string, projectId: string): Row {
	return {
		...row,
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
	const agentVersionIds = new Set(
		fixtures.agent_versions.map((row) => String(row.id)),
	);
	const suiteIds = new Set(fixtures.benchmark_suites.map((row) => String(row.id)));

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
		if (build.status !== "validated" || build.validation_status !== "validated") {
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
	const updateColumns = columns.filter((column) => !conflictColumns.has(column));
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

async function assertNoActiveBenchmarkState(sql: postgres.Sql) {
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
		await assertNoActiveBenchmarkState(sql);
		const user = await resolveTargetUser(sql);
		const project = await resolveTargetProject(sql, user.id);
		console.log(
			`[seed-swebench-fixtures] target user=${user.id} (${user.email ?? "no-email"}) project=${project.id} (${project.displayName ?? "no-name"})`,
		);

		const target = (rows: Row[]) =>
			rows.map((row) => retarget(row, user.id, project.id));

		const applySeed = async (tx: postgres.Sql) => {
			await upsertRows(tx, "environments", target(fixtures.environments), "(id)");
			await upsertRows(
				tx,
				"environment_versions",
				target(fixtures.environment_versions),
				"(id)",
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
					console.log("[seed-swebench-fixtures] rollback requested; no rows committed");
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
