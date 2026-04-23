/**
 * Create the pre-registered `browser-use-web-navigator` agent + its companion
 * parameterized workflow. Idempotent: re-running bumps the agent version if
 * the config hash changed and upserts the workflow row.
 *
 * Must be run inside the BFF pod (DATABASE_URL env already populated there,
 * and $PWD/src/... is reachable). Example:
 *
 *   kubectl -n workflow-builder exec deploy/workflow-builder -c workflow-builder -- \
 *     node scripts/create-browser-use-web-navigator.mjs --user-email admin@example.com
 *
 * The `--user-email` arg is optional; without it we fall back to the first
 * user+project_member found (same pattern as upsert-workflow-json.mjs).
 *
 * Unlike the ephemeral agentConfig used by the smoke workflow, this creates
 * a real agents row so the agent appears in the Agents page and gets its
 * own AgentRuntime CR + per-agent pod. The companion workflow references
 * the agent via `agentRef.slug = "browser-use-web-navigator"`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import crypto from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

function parseArgs(argv) {
	let userEmail = "";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--user-email") {
			userEmail = String(argv[i + 1] || "").trim();
			i += 1;
		}
	}
	return { userEmail };
}

function generateId() {
	// Matches nanoid-style 21 chars used elsewhere in the schema.
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
	const bytes = crypto.randomBytes(21);
	return Array.from(bytes, (x) => alphabet[x & 63]).join("");
}

function hashConfig(config) {
	return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

async function resolveOwner(sql, userEmail) {
	if (userEmail) {
		const rows = await sql`
			select u.id as user_id, pm.project_id
			from users u left join project_members pm on pm.user_id = u.id
			where lower(u.email) = lower(${userEmail})
			order by pm.created_at asc nulls last limit 1`;
		if (rows[0]?.user_id)
			return { userId: rows[0].user_id, projectId: rows[0].project_id ?? null };
	}
	const rows = await sql`
		select pm.user_id, pm.project_id
		from project_members pm
		order by pm.created_at asc
		limit 1`;
	if (rows[0]?.user_id)
		return { userId: rows[0].user_id, projectId: rows[0].project_id ?? null };
	const userRows = await sql`select id as user_id from users order by created_at asc limit 1`;
	if (userRows[0]?.user_id) return { userId: userRows[0].user_id, projectId: null };
	throw new Error("Could not resolve an owner (no users / project_members).");
}

const AGENT_SLUG = "browser-use-web-navigator";

const AGENT_CONFIG = {
	role: "Web navigator",
	goal: "Navigate live websites in a real browser and report back what you saw.",
	instructions: [
		"Use the browser-use runtime (Browserstation backend) to open URLs and interact with pages.",
		"Wait for the page to finish loading before acting on it.",
		"Describe what you observe: page title, final URL, visible content.",
		"End every final response with the marker `TASK COMPLETE` so the workflow's stopCondition matches.",
	],
	styleGuidelines: [
		"Be concise. Prefer bullet points and short sentences.",
		"Quote the page title verbatim; don't paraphrase.",
	],

	modelSpec: "openai/gpt-4.1-mini",
	maxTurns: 15,
	timeoutMinutes: 10,

	builtinTools: [],
	mcpConnectionMode: "explicit",
	mcpServers: [],
	skills: [],

	memory: {
		backend: "dapr_state",
		sessionId: "browser-use-web-navigator",
	},
	browserArtifacts: {
		screenshots: true,
		video: true,
	},

	runtime: "browser-use-agent",
	runtimeOverridePolicy: {
		allowToolNarrowing: true,
		allowServerAdditions: false,
		allowCredentialBinding: true,
		allowSkillAdditions: false,
		allowSkillNarrowing: true,
	},
};

async function upsertAgent(sql, owner) {
	const configHash = hashConfig(AGENT_CONFIG);

	const existing = await sql`
		select id, current_version_id, project_id
		from agents
		where slug = ${AGENT_SLUG}
		limit 1`;

	if (existing[0]) {
		const agentId = existing[0].id;
		// Check if version already matches
		const lastVer = await sql`
			select version, config_hash
			from agent_versions
			where agent_id = ${agentId}
			order by version desc
			limit 1`;
		if (lastVer[0]?.config_hash === configHash) {
			console.log(
				`agent "${AGENT_SLUG}" unchanged (version ${lastVer[0].version})`,
			);
			return { agentId, created: false, bumped: false };
		}
		const nextVersion = (lastVer[0]?.version ?? 0) + 1;
		const versionId = generateId();
		await sql`
			insert into agent_versions (id, agent_id, version, config, config_hash, published_at, published_by, created_at)
			values (${versionId}, ${agentId}, ${nextVersion}, ${sql.json(AGENT_CONFIG)}, ${configHash}, now(), ${owner.userId}, now())`;
		await sql`
			update agents set
				current_version_id = ${versionId},
				runtime = ${"browser-use-agent"},
				name = ${"Browser Use · Web Navigator"},
				description = ${"Reusable browser-use agent: opens URLs in a real browser and reports what it sees. Screenshots + video capture enabled."},
				updated_at = now()
			where id = ${agentId}`;
		console.log(`agent "${AGENT_SLUG}" bumped to version ${nextVersion}`);
		return { agentId, created: false, bumped: true };
	}

	// Create fresh
	const agentId = generateId();
	const versionId = generateId();
	await sql.begin(async (tx) => {
		await tx`
			insert into agents (
				id, slug, name, description, runtime,
				created_by, project_id, tags, default_vault_ids,
				created_at, updated_at
			) values (
				${agentId}, ${AGENT_SLUG},
				${"Browser Use · Web Navigator"},
				${"Reusable browser-use agent: opens URLs in a real browser and reports what it sees. Screenshots + video capture enabled."},
				${"browser-use-agent"},
				${owner.userId}, ${owner.projectId},
				${sql.json(["browser-use", "navigation"])},
				${sql.json([])},
				now(), now()
			)`;
		await tx`
			insert into agent_versions (id, agent_id, version, config, config_hash, published_at, published_by, created_at)
			values (${versionId}, ${agentId}, 1, ${sql.json(AGENT_CONFIG)}, ${hashConfig(AGENT_CONFIG)}, now(), ${owner.userId}, now())`;
		await tx`update agents set current_version_id = ${versionId}, updated_at = now() where id = ${agentId}`;
	});

	console.log(`agent "${AGENT_SLUG}" created (id=${agentId})`);
	return { agentId, created: true, bumped: false };
}

async function upsertWorkflow(sql, owner, agentId) {
	const wfPath = path.resolve(
		process.cwd(),
		"services/browser-use-agent/browser-use-web-navigator.workflow.json",
	);
	const wf = JSON.parse(await fs.readFile(wfPath, "utf-8"));

	// agentRef uses slug (portable); the node.data.agent.slug stays the same.
	// Optionally stamp agentRef.id too so resolver short-circuits slug lookup.
	const spec = wf.spec;
	const step = spec.do[0].browser_use_agent.with;
	step.agentRef = { ...step.agentRef, id: agentId };
	wf.nodes.find((n) => n.id === "browser_use_agent").data.agent.id = agentId;

	const existing = await sql`
		select id, user_id, project_id
		from workflows where id = ${wf.id} limit 1`;
	if (existing[0]) {
		await sql`
			update workflows set
				name = ${wf.name},
				description = ${wf.description ?? ""},
				nodes = ${sql.json(wf.nodes)},
				edges = ${sql.json(wf.edges)},
				visibility = ${wf.visibility || "public"},
				spec = ${sql.json(spec)},
				updated_at = now()
			where id = ${wf.id}`;
		console.log(`workflow "${wf.id}" updated`);
		return { workflowId: wf.id, created: false };
	}
	await sql`
		insert into workflows (id, name, description, nodes, edges, visibility, spec, user_id, project_id, created_at, updated_at)
		values (
			${wf.id}, ${wf.name}, ${wf.description ?? ""},
			${sql.json(wf.nodes)}, ${sql.json(wf.edges)},
			${wf.visibility || "public"}, ${sql.json(spec)},
			${owner.userId}, ${owner.projectId}, now(), now()
		)`;
	console.log(`workflow "${wf.id}" created`);
	return { workflowId: wf.id, created: true };
}

async function main() {
	const { userEmail } = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		const owner = await resolveOwner(sql, userEmail);
		const agent = await upsertAgent(sql, owner);
		const workflow = await upsertWorkflow(sql, owner, agent.agentId);
		console.log(
			JSON.stringify(
				{
					agent: { id: agent.agentId, slug: AGENT_SLUG, ...agent },
					workflow,
				},
				null,
				2,
			),
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error("[create-browser-use-web-navigator] error:", err);
	process.exitCode = 1;
});
