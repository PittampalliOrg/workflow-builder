import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOW_JSON_PATH = path.resolve(
	process.cwd(),
	'services/dapr-swe/resolve-github-issue.workflow.json'
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
					nodes = ${JSON.stringify(workflow.nodes)}::jsonb,
					edges = ${JSON.stringify(workflow.edges)}::jsonb,
					spec_version = ${workflow.specVersion},
					spec = ${JSON.stringify(workflow.spec)}::jsonb,
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
					${JSON.stringify(workflow.nodes)}::jsonb,
					${JSON.stringify(workflow.edges)}::jsonb,
					${workflow.specVersion},
					${JSON.stringify(workflow.spec)}::jsonb,
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
