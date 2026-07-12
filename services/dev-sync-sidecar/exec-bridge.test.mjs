import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Contract tests for the app-container exec bridges (#40): the node bridge
 * (exec-bridge.mjs) and its python twin (exec_bridge.py) must behave
 * identically — the dev-sync-sidecar's /__run proxy treats them as one
 * interface. Each test drives the REAL bridge process over HTTP.
 * Run: `node --test services/dev-sync-sidecar/`.
 * Python cases self-skip when no python3 is on PATH (CI `checks` lane is node).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = '2'.repeat(64);
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Start a bridge variant; resolve once it logs "listening". */
async function startBridge(variant, extraEnv = {}) {
	const port = await freePort();
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-bridge-dest-'));
	const argv =
		variant === 'python'
			? ['python3', [path.join(HERE, 'exec_bridge.py')]]
			: [process.execPath, [path.join(HERE, 'exec-bridge.mjs')]];
	const proc = spawn(argv[0], argv[1], {
		env: {
			...process.env,
			DEV_SYNC_EXEC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_BRIDGE_TOKEN: TOKEN,
			DEV_SYNC_COMMANDS_JSON: JSON.stringify({
				deps: 'echo installing-deps',
				where: 'pwd',
				failing: 'echo boom >&2; exit 3'
			}),
			...extraEnv
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	proc.stdout.on('data', (d) => (log += String(d)));
	proc.stderr.on('data', (d) => (log += String(d)));
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (log.includes('listening on')) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!log.includes('listening on')) {
		proc.kill('SIGKILL');
		throw new Error(`${variant} bridge did not start; log:\n${log}`);
	}
	return {
		base,
		dest,
		log: () => log,
		stop() {
			proc.kill('SIGKILL');
			try {
				fs.rmSync(dest, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	};
}

for (const variant of ['node', 'python']) {
	const maybe = variant === 'python' && !HAVE_PYTHON ? { skip: 'python3 not on PATH' } : {};

	test(`[${variant}] /healthz is open and lists the allowlist`, maybe, async (t) => {
		const b = await startBridge(variant);
		t.after(() => b.stop());
		const body = await (await fetch(`${b.base}/healthz`)).json();
		assert.equal(body.ok, true);
		assert.equal(body.service, 'dev-sync-exec-bridge');
		assert.deepEqual(body.commands, ['deps', 'failing', 'where']);
	});

	test(`[${variant}] /__exec requires the token and the allowlist`, maybe, async (t) => {
		const b = await startBridge(variant);
		t.after(() => b.stop());
		assert.equal((await fetch(`${b.base}/__exec?cmd=deps`, { method: 'POST' })).status, 401);
		const unknown = await fetch(`${b.base}/__exec?cmd=rm-rf`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(unknown.status, 404);
		assert.deepEqual((await unknown.json()).allowed, ['deps', 'failing', 'where']);
		assert.equal(
			(
				await fetch(`${b.base}/__exec`, { method: 'POST', headers: { 'x-sync-token': TOKEN } })
			).status,
			400
		);
	});

	test(`[${variant}] /__exec fails closed without a bridge token`, maybe, async (t) => {
		const b = await startBridge(variant, { DEV_SYNC_BRIDGE_TOKEN: '' });
		t.after(() => b.stop());
		const response = await fetch(`${b.base}/__exec?cmd=deps`, { method: 'POST' });
		assert.equal(response.status, 503);
		assert.match((await response.json()).error, /bridge token is not configured/);
	});

	test(`[${variant}] /__exec runs in DEST and returns real exit codes`, maybe, async (t) => {
		const b = await startBridge(variant);
		t.after(() => b.stop());
		const ok = await (
			await fetch(`${b.base}/__exec?cmd=where`, {
				method: 'POST',
				headers: { 'x-sync-token': TOKEN }
			})
		).json();
		assert.equal(ok.ok, true);
		assert.equal(ok.exitCode, 0);
		assert.match(ok.output.trim(), new RegExp(b.dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

		const failResp = await fetch(`${b.base}/__exec?cmd=failing`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(failResp.status, 200); // it ran; ok:false carries the failure
		const fail = await failResp.json();
		assert.equal(fail.ok, false);
		assert.equal(fail.exitCode, 3);
		assert.match(fail.output, /boom/);
		assert.equal(typeof fail.durationMs, 'number');
	});

	test(`[${variant}] a missing/malformed allowlist fails closed`, maybe, async (t) => {
		const b = await startBridge(variant, { DEV_SYNC_COMMANDS_JSON: 'not-json{' });
		t.after(() => b.stop());
		const resp = await fetch(`${b.base}/__exec?cmd=deps`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(resp.status, 404);
		assert.deepEqual((await resp.json()).allowed, []);
	});
}
