/**
 * Upsert the "Durable Agent Embedded Validation" workflow from its spec-first JSON file.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-durable-agent-embedded-validation-workflow.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_JSON_PATH = path.resolve(
	process.cwd(),
	'services/durable-agent/durable-agent-embedded-validation.workflow.json'
);

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
			from users u left join project_members pm on pm.user_id = u.id
			where lower(u.email) = lower(${userEmail})
			order by pm.created_at asc nulls last limit 1`;
		if (rows[0]?.user_id) {
			return {
				userId: rows[0].user_id,
				projectId: rows[0].project_id || null
			};
		}
	}
	const rows = await sql`
		select pm.user_id, pm.project_id
		from project_members pm
		order by pm.created_at asc
		limit 1
	`;
	if (rows[0]?.user_id) {
		return {
			userId: rows[0].user_id,
			projectId: rows[0].project_id || null
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
	throw new Error('Could not resolve a workflow owner.');
}

async function main() {
	if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(DATABASE_URL, { max: 1 });

	try {
		const raw = await fs.readFile(WORKFLOW_JSON_PATH, 'utf-8');
		const wf = JSON.parse(raw);
		const workflowId = wf.id;

		const existing = await sql`
			select id, user_id, project_id
			from workflows
			where id = ${workflowId}
			limit 1
		`;
		const owner = await resolveOwner(sql, existing[0] ?? null, args.userEmail);

		if (existing[0]) {
			await sql`
				update workflows set
					name = ${wf.name},
					description = ${wf.description},
					nodes = ${sql.json(wf.nodes)},
					edges = ${sql.json(wf.edges)},
					visibility = ${wf.visibility || 'public'},
					spec = ${sql.json(wf.spec)},
					updated_at = now()
				where id = ${workflowId}`;
			console.log(JSON.stringify({ workflowId, created: false, name: wf.name }, null, 2));
		} else {
			await sql`
				insert into workflows (
					id,
					name,
					description,
					nodes,
					edges,
					visibility,
					spec,
					user_id,
					project_id,
					created_at,
					updated_at
				)
				values (
					${workflowId},
					${wf.name},
					${wf.description},
					${sql.json(wf.nodes)},
					${sql.json(wf.edges)},
					${wf.visibility || 'public'},
					${sql.json(wf.spec)},
					${owner.userId},
					${owner.projectId},
					now(),
					now()
				)`;
			console.log(JSON.stringify({ workflowId, created: true, name: wf.name }, null, 2));
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error('[upsert-durable-agent-embedded-validation] Error:', error);
	process.exitCode = 1;
});
