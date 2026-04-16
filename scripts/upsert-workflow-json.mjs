/**
 * Upsert a workflow from a spec-first JSON file.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-workflow-json.mjs services/durable-agent/example.workflow.json
 *   DATABASE_URL=... node scripts/upsert-workflow-json.mjs path/to/workflow.json --user-email admin@example.com
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

function parseArgs(argv) {
	let workflowPath = '';
	let userEmail = '';
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--user-email') {
			userEmail = String(argv[i + 1] || '').trim();
			i += 1;
			continue;
		}
		if (!arg.startsWith('--') && !workflowPath) {
			workflowPath = arg;
		}
	}
	return { workflowPath, userEmail };
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
	const { workflowPath, userEmail } = parseArgs(process.argv.slice(2));
	if (!workflowPath) throw new Error('Workflow JSON path is required');

	const absolutePath = path.resolve(process.cwd(), workflowPath);
	const raw = await fs.readFile(absolutePath, 'utf-8');
	const wf = JSON.parse(raw);
	if (!wf.id || !wf.name || !wf.spec || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
		throw new Error(`Invalid workflow JSON shape: ${workflowPath}`);
	}

	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		const existing = await sql`
			select id, user_id, project_id
			from workflows
			where id = ${wf.id}
			limit 1
		`;
		const owner = await resolveOwner(sql, existing[0] ?? null, userEmail);

		if (existing[0]) {
			await sql`
				update workflows set
					name = ${wf.name},
					description = ${wf.description ?? ''},
					nodes = ${sql.json(wf.nodes)},
					edges = ${sql.json(wf.edges)},
					visibility = ${wf.visibility || 'public'},
					spec = ${sql.json(wf.spec)},
					updated_at = now()
				where id = ${wf.id}`;
			console.log(JSON.stringify({ workflowId: wf.id, created: false, path: workflowPath }, null, 2));
			return;
		}

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
				${wf.id},
				${wf.name},
				${wf.description ?? ''},
				${sql.json(wf.nodes)},
				${sql.json(wf.edges)},
				${wf.visibility || 'public'},
				${sql.json(wf.spec)},
				${owner.userId},
				${owner.projectId},
				now(),
				now()
			)`;
		console.log(JSON.stringify({ workflowId: wf.id, created: true, path: workflowPath }, null, 2));
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error('[upsert-workflow-json] Error:', error);
	process.exitCode = 1;
});
