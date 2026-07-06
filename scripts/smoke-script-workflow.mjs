/**
 * End-to-end smoke test for the dynamic-script engine: upsert the demo script,
 * execute it, poll to terminal, and print the journal rows. With --resume-from
 * it re-runs the SAME workflow via the resume path (journal import).
 *
 * Usage:
 *   WFB_BASE_URL=http://localhost:3000 WFB_API_KEY=wfb_... \
 *     node scripts/smoke-script-workflow.mjs \
 *       [--file scripts/fixtures/dynamic-scripts/demo-review.js] \
 *       [--input '{"target":"the demo repo"}'] [--budget 500000] [--resume-from]
 *
 * Requires a running BFF + orchestrator + script-evaluator (a preview env).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { extractStaticMeta } from './upsert-dynamic-script-workflow.mjs';

const BASE_URL = (process.env.WFB_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.WFB_API_KEY || '';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['success', 'error', 'cancelled', 'canceled', 'failed', 'completed']);

function parseArgs(argv) {
	const out = {
		file: 'scripts/fixtures/dynamic-scripts/demo-review.js',
		input: '{}',
		budget: '',
		resumeFrom: false
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--file') out.file = String(argv[++i] || '');
		else if (arg === '--input') out.input = String(argv[++i] || '{}');
		else if (arg === '--budget') out.budget = String(argv[++i] || '');
		else if (arg === '--resume-from') out.resumeFrom = true;
	}
	return out;
}

function headers() {
	const h = { 'Content-Type': 'application/json' };
	if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
	return h;
}

async function api(method, pathname, body) {
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: headers(),
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text}`);
	return text ? JSON.parse(text) : {};
}

async function upsertDemo(file) {
	const script = await fs.readFile(path.resolve(process.cwd(), file), 'utf-8');
	const meta = extractStaticMeta(script) || { name: path.basename(file) };
	const spec = { engine: 'dynamic-script', script, meta };
	const created = await api('POST', '/api/workflows', {
		name: meta.name,
		nodes: [],
		edges: [],
		engineType: 'dynamic-script'
	});
	const workflowId = created.id;
	await api('PUT', `/api/workflows/${encodeURIComponent(workflowId)}`, {
		nodes: [],
		edges: [],
		engineType: 'dynamic-script',
		spec
	});
	return workflowId;
}

async function pollToTerminal(executionId) {
	const start = Date.now();
	while (Date.now() - start < POLL_TIMEOUT_MS) {
		const exec = await api('GET', `/api/workflows/executions/${encodeURIComponent(executionId)}`);
		const status = String(exec.status || '').toLowerCase();
		process.stdout.write(`  status=${status}\r`);
		if (TERMINAL.has(status)) {
			process.stdout.write('\n');
			return status;
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error('timed out waiting for execution to reach a terminal state');
}

async function printJournal(executionId) {
	const { scriptCalls } = await api(
		'GET',
		`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls`
	);
	console.log(`\nJournal (${scriptCalls.length} calls):`);
	for (const c of scriptCalls) {
		console.log(
			`  [${c.seq}] ${c.label || c.callId.slice(0, 12)}  phase=${c.phase ?? '-'}  ` +
				`status=${c.status}  tokens=${c.tokensUsed}` +
				(c.errorCode ? `  error=${c.errorCode}` : '')
		);
	}
	return scriptCalls;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const input = JSON.parse(opts.input || '{}');
	const budgetTotal = opts.budget ? Number(opts.budget) : undefined;

	console.log('1. Upserting demo script workflow…');
	const workflowId = await upsertDemo(opts.file);
	console.log(`   workflowId=${workflowId}`);

	console.log('2. Executing…');
	const exec = await api('POST', `/api/workflows/${encodeURIComponent(workflowId)}/execute`, {
		input,
		...(budgetTotal != null ? { budgetTotal } : {})
	});
	const executionId = exec.executionId;
	console.log(`   executionId=${executionId} instanceId=${exec.instanceId}`);

	console.log('3. Polling to terminal…');
	const status = await pollToTerminal(executionId);
	console.log(`   terminal status=${status}`);
	await printJournal(executionId);

	if (opts.resumeFrom) {
		console.log('\n4. Resuming (journal import)…');
		const resumed = await api(
			'POST',
			`/api/workflows/executions/${encodeURIComponent(executionId)}/resume`,
			{}
		);
		const resumedId = resumed.executionId;
		console.log(`   resumedExecutionId=${resumedId}`);
		const resumedStatus = await pollToTerminal(resumedId);
		console.log(`   resumed terminal status=${resumedStatus}`);
		await printJournal(resumedId);
	}

	console.log('\n✓ smoke complete');
}

main().catch((error) => {
	console.error('\n[smoke-script-workflow] Error:', error.message ?? error);
	process.exitCode = 1;
});
