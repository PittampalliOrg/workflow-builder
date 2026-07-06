/**
 * Upsert a dynamic-script (engineType `dynamic-script`) workflow from a JS file.
 *
 * Models `scripts/upsert-workflow-json.mjs` but goes through the HTTP API so the
 * server-side validation + evaluator-truth meta stamping run: POST /api/workflows
 * (empty nodes/edges, engineType dynamic-script) then PUT /api/workflows/[id] with
 * the built spec `{engine:'dynamic-script', script, meta}`.
 *
 * Usage:
 *   WFB_BASE_URL=http://localhost:3000 WFB_API_KEY=wfb_... \
 *     node scripts/upsert-dynamic-script-workflow.mjs \
 *       --file scripts/fixtures/dynamic-scripts/demo-review.js [--name "Demo Review"]
 *
 * Auth: a user API key (`wfb_...`) via WFB_API_KEY (sent as Authorization: Bearer).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.WFB_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.WFB_API_KEY || '';

function parseArgs(argv) {
	let file = '';
	let name = '';
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--file') {
			file = String(argv[i + 1] || '').trim();
			i += 1;
		} else if (arg === '--name') {
			name = String(argv[i + 1] || '').trim();
			i += 1;
		} else if (!arg.startsWith('--') && !file) {
			file = arg;
		}
	}
	return { file, name };
}

/** Best-effort static extraction of `meta.name`/`meta.description` for the default name. */
export function extractStaticMeta(script) {
	const m = script.match(/export\s+const\s+meta\s*=\s*\{/);
	if (!m || m.index === undefined) return null;
	const start = script.indexOf('{', m.index);
	if (start < 0) return null;
	let depth = 0;
	let end = -1;
	for (let i = start; i < script.length; i += 1) {
		const ch = script[i];
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return null;
	const literal = script.slice(start, end + 1);
	const nameMatch = literal.match(/name\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
	const descMatch = literal.match(/description\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
	if (!nameMatch) return null;
	const meta = { name: nameMatch[2] };
	if (descMatch) meta.description = descMatch[2];
	return meta;
}

function authHeaders() {
	const headers = { 'Content-Type': 'application/json' };
	if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
	return headers;
}

async function main() {
	const { file, name } = parseArgs(process.argv.slice(2));
	if (!file) throw new Error('--file <script.js> is required');

	const absolutePath = path.resolve(process.cwd(), file);
	const script = await fs.readFile(absolutePath, 'utf-8');
	const staticMeta = extractStaticMeta(script) || { name: path.basename(file, path.extname(file)) };
	const workflowName = name || staticMeta.name;
	const spec = { engine: 'dynamic-script', script, meta: staticMeta };

	// 1. Create the workflow row (engineType dynamic-script, empty graph).
	const createRes = await fetch(`${BASE_URL}/api/workflows`, {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify({
			name: workflowName,
			nodes: [],
			edges: [],
			engineType: 'dynamic-script'
		})
	});
	if (!createRes.ok) {
		throw new Error(`POST /api/workflows failed (${createRes.status}): ${await createRes.text()}`);
	}
	const created = await createRes.json();
	const workflowId = created.id;
	if (!workflowId) throw new Error(`create response missing id: ${JSON.stringify(created)}`);

	// 2. PUT the spec (server validates + stamps evaluator-truth meta).
	const updateRes = await fetch(`${BASE_URL}/api/workflows/${encodeURIComponent(workflowId)}`, {
		method: 'PUT',
		headers: authHeaders(),
		body: JSON.stringify({ nodes: [], edges: [], engineType: 'dynamic-script', spec })
	});
	if (!updateRes.ok) {
		throw new Error(
			`PUT /api/workflows/${workflowId} failed (${updateRes.status}): ${await updateRes.text()}`
		);
	}

	console.log(JSON.stringify({ workflowId, name: workflowName, file }, null, 2));
	return workflowId;
}

// Only run when invoked directly (allows importing extractStaticMeta from tests).
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error('[upsert-dynamic-script-workflow] Error:', error.message ?? error);
		process.exitCode = 1;
	});
}
