/**
 * Seed sample workflows the Runs page / canvas UX can show on a fresh DB.
 *
 * Reads `scripts/fixtures/sample-workflows.json` (captured from the source
 * cluster) and upserts four canonical workflows plus their one referenced
 * agent + agent_version:
 *
 *   - Browser Use · Web Navigator     (browser-use-web-navigator)
 *   - PowerPoint Agent Smoke          (powerpoint-agent-smoke)
 *   - Excel Agent Smoke               (excel-agent-smoke)
 *   - 3B1B Skill Animation Example    (3pvh53PpHSiz-OoEeSW4z)
 *
 * Idempotent: rerunning on a populated DB UPSERTs by primary key and leaves
 * unrelated rows alone.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   SEED_WORKFLOW_USER_EMAIL=vpittamp@gmail.com \
 *   pnpm tsx scripts/seed-sample-workflows.ts
 *
 * Target resolution order:
 *   user    — SEED_WORKFLOW_USER_ID → SEED_WORKFLOW_USER_EMAIL → single ADMIN
 *             user in `users` → first row in `users`
 *   project — SEED_WORKFLOW_PROJECT_ID → single project owned by resolved user
 *             (via project_members where role='ADMIN') → first project for user
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

type FixtureWorkflow = {
	id: string;
	name: string;
	description: string | null;
	nodes: unknown[];
	edges: unknown[];
	spec_version: string | null;
	spec: unknown;
	visibility: string;
	engine_type: string;
	dapr_workflow_name: string | null;
};

type FixtureAgent = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	avatar: string | null;
	tags: unknown[];
	runtime: string;
	current_version_id: string | null;
	environment_id: string | null;
	environment_version: number | null;
	default_vault_ids: unknown[];
	registry_status: string;
	is_archived: boolean;
};

type FixtureAgentVersion = {
	id: string;
	agent_id: string;
	version: number;
	config_hash: string | null;
	config: unknown;
	published_by: string | null;
};

type Fixtures = {
	workflows: FixtureWorkflow[];
	agents: FixtureAgent[];
	agent_versions: FixtureAgentVersion[];
};

function loadFixtures(): Fixtures {
	const path = resolve(process.cwd(), "scripts/fixtures/sample-workflows.json");
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as Fixtures;
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
		throw new Error(
			`SEED_WORKFLOW_USER_ID=${explicitId} not found in users table`,
		);
	}
	const email = process.env.SEED_WORKFLOW_USER_EMAIL;
	if (email) {
		const rows = await sql<
			{ id: string; email: string | null }[]
		>`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`;
		if (rows.length > 0) return rows[0];
		throw new Error(
			`SEED_WORKFLOW_USER_EMAIL=${email} not found in users table`,
		);
	}
	// Prefer a single ADMIN user, else fall back to the earliest user.
	const admins = await sql<
		{ id: string; email: string | null }[]
	>`SELECT id, email FROM users WHERE platform_role = 'ADMIN' ORDER BY created_at LIMIT 2`;
	if (admins.length === 1) return admins[0];
	if (admins.length > 1) {
		throw new Error(
			"Multiple ADMIN users present — set SEED_WORKFLOW_USER_ID or SEED_WORKFLOW_USER_EMAIL explicitly",
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
		throw new Error(
			`SEED_WORKFLOW_PROJECT_ID=${explicit} not found in projects table`,
		);
	}
	// ADMIN membership first, then any membership, then owned project.
	const admin = await sql<
		{ id: string; display_name: string | null }[]
	>`
		SELECT p.id, p.display_name
		FROM projects p
		JOIN project_members m ON m.project_id = p.id
		WHERE m.user_id = ${userId} AND m.role = 'ADMIN'
		ORDER BY p.created_at
		LIMIT 1
	`;
	if (admin.length > 0)
		return { id: admin[0].id, displayName: admin[0].display_name };
	const any = await sql<
		{ id: string; display_name: string | null }[]
	>`
		SELECT p.id, p.display_name
		FROM projects p
		JOIN project_members m ON m.project_id = p.id
		WHERE m.user_id = ${userId}
		ORDER BY p.created_at
		LIMIT 1
	`;
	if (any.length > 0)
		return { id: any[0].id, displayName: any[0].display_name };
	const owned = await sql<
		{ id: string; display_name: string | null }[]
	>`SELECT id, display_name FROM projects WHERE owner_id = ${userId} ORDER BY created_at LIMIT 1`;
	if (owned.length > 0)
		return { id: owned[0].id, displayName: owned[0].display_name };
	throw new Error(
		`No project found for user ${userId} — set SEED_WORKFLOW_PROJECT_ID`,
	);
}

async function upsertWorkflow(
	sql: postgres.Sql,
	wf: FixtureWorkflow,
	userId: string,
	projectId: string,
): Promise<"created" | "updated"> {
	const existing = await sql<
		{ id: string }[]
	>`SELECT id FROM workflows WHERE id = ${wf.id} LIMIT 1`;
	// postgres-js auto-serializes JS values for jsonb columns when wrapped
	// in sql.json(). An earlier draft stringified + cast to ::jsonb which
	// double-encoded the value (stored as a JSON *string* containing the
	// serialized array). Use sql.json to keep the on-disk shape correct.
	const nodesParam = sql.json(wf.nodes ?? []);
	const edgesParam = sql.json(wf.edges ?? []);
	const specParam = wf.spec == null ? null : sql.json(wf.spec);

	if (existing.length === 0) {
		await sql`
			INSERT INTO workflows (
				id, name, description, user_id, project_id, nodes, edges,
				spec_version, spec, visibility, engine_type, dapr_workflow_name,
				created_at, updated_at
			) VALUES (
				${wf.id}, ${wf.name}, ${wf.description}, ${userId}, ${projectId},
				${nodesParam}, ${edgesParam},
				${wf.spec_version}, ${specParam},
				${wf.visibility}, ${wf.engine_type}, ${wf.dapr_workflow_name},
				now(), now()
			)
		`;
		return "created";
	}
	await sql`
		UPDATE workflows SET
			name = ${wf.name},
			description = ${wf.description},
			user_id = ${userId},
			project_id = ${projectId},
			nodes = ${nodesParam},
			edges = ${edgesParam},
			spec_version = ${wf.spec_version},
			spec = ${specParam},
			visibility = ${wf.visibility},
			engine_type = ${wf.engine_type},
			dapr_workflow_name = ${wf.dapr_workflow_name},
			updated_at = now()
		WHERE id = ${wf.id}
	`;
	return "updated";
}

async function upsertAgent(
	sql: postgres.Sql,
	agent: FixtureAgent,
	userId: string,
	projectId: string,
): Promise<"created" | "updated"> {
	const existing = await sql<
		{ id: string }[]
	>`SELECT id FROM agents WHERE id = ${agent.id} LIMIT 1`;
	const tagsParam = sql.json(agent.tags ?? []);
	const vaultIdsParam = sql.json(agent.default_vault_ids ?? []);

	if (existing.length === 0) {
		await sql`
			INSERT INTO agents (
				id, slug, name, description, avatar, tags, runtime,
				current_version_id, environment_id, environment_version,
				default_vault_ids, registry_status, is_archived, created_by,
				project_id, created_at, updated_at, runtime_status
			) VALUES (
				${agent.id}, ${agent.slug}, ${agent.name}, ${agent.description},
				${agent.avatar}, ${tagsParam}, ${agent.runtime},
				${agent.current_version_id}, ${agent.environment_id}, ${agent.environment_version},
				${vaultIdsParam}, ${agent.registry_status}, ${agent.is_archived},
				${userId}, ${projectId}, now(), now(), 'pending'
			)
		`;
		return "created";
	}
	await sql`
		UPDATE agents SET
			slug = ${agent.slug},
			name = ${agent.name},
			description = ${agent.description},
			avatar = ${agent.avatar},
			tags = ${tagsParam},
			runtime = ${agent.runtime},
			current_version_id = ${agent.current_version_id},
			environment_id = ${agent.environment_id},
			environment_version = ${agent.environment_version},
			default_vault_ids = ${vaultIdsParam},
			registry_status = ${agent.registry_status},
			is_archived = ${agent.is_archived},
			project_id = ${projectId},
			updated_at = now()
		WHERE id = ${agent.id}
	`;
	return "updated";
}

async function upsertAgentVersion(
	sql: postgres.Sql,
	version: FixtureAgentVersion,
): Promise<"created" | "updated"> {
	const existing = await sql<
		{ id: string }[]
	>`SELECT id FROM agent_versions WHERE id = ${version.id} LIMIT 1`;
	const configParam =
		version.config == null ? null : sql.json(version.config);

	if (existing.length === 0) {
		await sql`
			INSERT INTO agent_versions (
				id, agent_id, version, config_hash, config, published_by, published_at
			) VALUES (
				${version.id}, ${version.agent_id}, ${version.version}, ${version.config_hash},
				${configParam}, ${version.published_by}, now()
			)
		`;
		return "created";
	}
	await sql`
		UPDATE agent_versions SET
			version = ${version.version},
			config_hash = ${version.config_hash},
			config = ${configParam},
			published_by = ${version.published_by}
		WHERE id = ${version.id}
	`;
	return "updated";
}

async function main() {
	console.log("[seed-sample-workflows] starting");
	const fixtures = loadFixtures();
	console.log(
		`[seed-sample-workflows] fixtures: ${fixtures.workflows.length} workflows, ${fixtures.agents.length} agents, ${fixtures.agent_versions.length} versions`,
	);

	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		const user = await resolveTargetUser(sql);
		const project = await resolveTargetProject(sql, user.id);
		console.log(
			`[seed-sample-workflows] target user=${user.id} (${user.email ?? "no-email"}) project=${project.id} (${project.displayName ?? "no-name"})`,
		);

		// Agents + agent_versions first so the browser-use workflow's implicit
		// reference resolves cleanly even when the row is inserted fresh.
		for (const agent of fixtures.agents) {
			const result = await upsertAgent(sql, agent, user.id, project.id);
			console.log(
				`[seed-sample-workflows] agent ${result}: ${agent.id} (${agent.slug})`,
			);
		}
		for (const version of fixtures.agent_versions) {
			const result = await upsertAgentVersion(sql, version);
			console.log(
				`[seed-sample-workflows] agent_version ${result}: ${version.id} (agent=${version.agent_id} v${version.version})`,
			);
		}
		for (const wf of fixtures.workflows) {
			const result = await upsertWorkflow(sql, wf, user.id, project.id);
			console.log(
				`[seed-sample-workflows] workflow ${result}: ${wf.id} — ${wf.name}`,
			);
		}

		console.log("[seed-sample-workflows] done");
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error("[seed-sample-workflows] failed:", err);
	process.exit(1);
});
