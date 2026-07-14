import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

// Seeds the canonical "code-eval-item" workflow (services/code-eval-runner/
// code-eval-item.workflow.json) into the workflows table. HumanEval+/MBPP+/
// BigCodeBench evaluation templates set taskConfig.workflowId to this row's
// id so each eval item runs the same provision → write_test → solve → pytest
// chain. Editing the canonical JSON + re-running this script is the supported
// way to tune prompts/maxTurns without redeploying the BFF.

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_JSON_PATH = path.resolve(
	process.cwd(),
	'services/code-eval-runner/code-eval-item.workflow.json'
);
// Cutover P3 (item 15): with CODE_EVAL_SCRIPT_PRODUCER=true the SAME workflow
// id is seeded as a dynamic-script (spec = {engine, script, meta}) instead of
// the SW 1.0 document — so CODE_EVAL_WORKFLOW_ID and the humaneval/mbpp/
// bigcodebench template routes need zero changes. Flip the flag off + re-run
// to fall back to the SW spec while shadow parity is in flight.
const SCRIPT_PATH = path.resolve(
	process.cwd(),
	'scripts/fixtures/dynamic-scripts/code-eval-item.js'
);
function scriptProducerEnabled() {
	const raw = String(process.env.CODE_EVAL_SCRIPT_PRODUCER ?? '').trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
function extractMetaLiteral(source) {
	const m = /export\s+const\s+meta\s*=\s*\{/.exec(source);
	if (!m) throw new Error('code-eval script is missing `export const meta = {…}`');
	let i = source.indexOf('{', m.index);
	let depth = 0;
	let end = -1;
	for (let j = i; j < source.length; j += 1) {
		if (source[j] === '{') depth += 1;
		else if (source[j] === '}') {
			depth -= 1;
			if (depth === 0) {
				end = j + 1;
				break;
			}
		}
	}
	if (end < 0) throw new Error('unterminated meta literal in the code-eval script');
	// eslint-disable-next-line no-new-func
	return Function(`return (${source.slice(i, end)})`)();
}

function parseArgs(argv) {
	let userEmail = '';
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--user-email') {
			userEmail = String(argv[i + 1] || '').trim();
			i += 1;
		}
	}
	return { userEmail };
}

async function resolveOwner(sql, existingWorkflow, userEmail) {
	if (existingWorkflow?.user_id) {
		return {
			userId: existingWorkflow.user_id,
			projectId: existingWorkflow.project_id || null
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
				userId: rows[0].user_id,
				projectId: rows[0].project_id || null
			};
		}
	}

	const fallbackRows = await sql`
		select pm.user_id, pm.project_id
		from project_members pm
		order by pm.created_at asc
		limit 1
	`;
	if (fallbackRows[0]?.user_id) {
		return {
			userId: fallbackRows[0].user_id,
			projectId: fallbackRows[0].project_id || null
		};
	}

	const userRows = await sql`
		select id as user_id
		from users
		order by created_at asc
		limit 1
	`;
	if (userRows[0]?.user_id) {
		return { userId: userRows[0].user_id, projectId: null };
	}

	throw new Error('Could not resolve a workflow owner. Pass --user-email or seed a user first.');
}

async function main() {
	if (!DATABASE_URL) {
		throw new Error('DATABASE_URL is required');
	}

	const { userEmail } = parseArgs(process.argv.slice(2));
	const raw = await fs.readFile(WORKFLOW_JSON_PATH, 'utf8');
	const workflow = JSON.parse(raw);

	if (scriptProducerEnabled()) {
		// Same id/name/description; the SPEC becomes the dynamic-script envelope.
		const script = await fs.readFile(SCRIPT_PATH, 'utf8');
		const meta = extractMetaLiteral(script);
		workflow.engineType = 'dynamic-script';
		workflow.spec = { engine: 'dynamic-script', script, meta };
		workflow.nodes = [];
		workflow.edges = [];
		console.log(`[code-eval] seeding DYNAMIC-SCRIPT producer (${script.length} bytes)`);
	} else {
		console.log('[code-eval] seeding SW 1.0 spec (set CODE_EVAL_SCRIPT_PRODUCER=true for the script port)');
	}

	const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
	try {
		const existingRows = await sql`
			select id, user_id, project_id
			from workflows
			where id = ${workflow.id}
			limit 1
		`;
		const existing = existingRows[0] || null;
		const owner = await resolveOwner(sql, existing, userEmail);
		const now = new Date().toISOString();

		if (existing) {
			await sql`
				update workflows
				set
					name = ${workflow.name},
					description = ${workflow.description},
					user_id = ${owner.userId},
					project_id = ${owner.projectId},
					nodes = ${sql.json(workflow.nodes)},
					edges = ${sql.json(workflow.edges)},
					spec_version = ${workflow.specVersion},
					spec = ${sql.json(workflow.spec)},
					visibility = ${workflow.visibility},
					engine_type = ${workflow.engineType},
					updated_at = ${now}
				where id = ${workflow.id}
			`;
			console.log(`Updated workflow ${workflow.id}`);
		} else {
			await sql`
				insert into workflows (
					id,
					name,
					description,
					user_id,
					project_id,
					nodes,
					edges,
					spec_version,
					spec,
					visibility,
					engine_type,
					created_at,
					updated_at
				)
				values (
					${workflow.id},
					${workflow.name},
					${workflow.description},
					${owner.userId},
					${owner.projectId},
					${sql.json(workflow.nodes)},
					${sql.json(workflow.edges)},
					${workflow.specVersion},
					${sql.json(workflow.spec)},
					${workflow.visibility},
					${workflow.engineType},
					${now},
					${now}
				)
			`;
			console.log(`Created workflow ${workflow.id}`);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
