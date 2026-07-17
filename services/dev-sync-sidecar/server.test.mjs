import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * End-to-end tests for the dev-sync-sidecar. We spawn the REAL server.mjs as a
 * child process (exactly as the pod runs it) and drive it over HTTP, so the tar
 * untar/create + /__run child-exec paths are exercised for real. Zero deps:
 * node:test + global fetch. Run: `node --test services/dev-sync-sidecar/`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const BRIDGE = path.join(HERE, 'exec-bridge.mjs');
const ATOMIC_SYNC = path.join(HERE, 'atomic-sync.mjs');
const TOKEN = '1'.repeat(64);
const BRIDGE_TOKEN = '2'.repeat(64);
const GENERATION = 'sync-generation-1';
const SERVICE = 'workflow-builder';
const ALLOWED_ROOTS = ['src'];

function syncHeaders(generation = GENERATION, service = SERVICE, roots = ALLOWED_ROOTS) {
	return {
		'x-sync-token': TOKEN,
		'x-sync-generation': generation,
		'x-sync-service': service,
		'x-sync-roots': JSON.stringify(roots)
	};
}

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

/** Spawn server.mjs with a fresh temp DEST; resolve once it logs "listening".
 * Always points DEV_SYNC_EXEC_PORT at a dedicated free port so a stray local
 * listener on the default 8002 can never satisfy (or poison) the bridge probe —
 * tests that WANT a bridge start one on that port via startBridge(). */
async function startSidecar(extraEnv = {}, existingDest = null) {
	const port = await freePort();
	const execPort = await freePort();
	const dest = existingDest ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-dest-'));
	const proc = spawn(process.execPath, [SERVER], {
		env: {
			...process.env,
			DEV_SYNC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_TOKEN: TOKEN,
			DEV_SYNC_BRIDGE_TOKEN: BRIDGE_TOKEN,
			DEV_SYNC_EXEC_PORT: String(execPort),
			DEV_SYNC_SERVICE: SERVICE,
			DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(ALLOWED_ROOTS),
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
		throw new Error(`sidecar did not start; log:\n${log}`);
	}
	return {
		port,
		execPort,
		dest,
		base,
		proc,
		log: () => log,
		stop({ preserveDest = false } = {}) {
			proc.kill('SIGKILL');
			if (preserveDest) return;
			try {
				fs.rmSync(dest, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	};
}

/** Spawn the REAL exec-bridge.mjs on 127.0.0.1:<port> (the app-container half
 * of /__run) and resolve once it logs "listening". */
async function startBridge(port, extraEnv = {}) {
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-bridge-dest-'));
	const proc = spawn(process.execPath, [BRIDGE], {
		env: {
			...process.env,
			DEV_SYNC_EXEC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_BRIDGE_TOKEN: BRIDGE_TOKEN,
			...extraEnv
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	proc.stdout.on('data', (d) => (log += String(d)));
	proc.stderr.on('data', (d) => (log += String(d)));
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (log.includes('listening on')) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!log.includes('listening on')) {
		proc.kill('SIGKILL');
		throw new Error(`exec bridge did not start; log:\n${log}`);
	}
	return {
		dest,
		base: `http://127.0.0.1:${port}`,
		proc,
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

/** Build a tar.gz of a {relPath: contents} map (uses the system tar, like the pod). */
function makeTarGz(files, directoryModes = {}, archiveRoots) {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-src-'));
	const tops = new Set();
	for (const [rel, contents] of Object.entries(files)) {
		const abs = path.join(src, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, contents);
		tops.add(rel.split('/')[0]);
	}
	const modeEntries = Object.entries(directoryModes).sort(
		([left], [right]) => right.split('/').length - left.split('/').length
	);
	for (const [relative, mode] of modeEntries) fs.chmodSync(path.join(src, relative), mode);
	const out = path.join(os.tmpdir(), `dev-sync-upload-${Date.now()}.tgz`);
	const roots = archiveRoots ?? [...tops];
	const args = roots.length
		? ['-czf', out, '-C', src, ...roots]
		: ['-czf', out, '-C', src, '-T', '/dev/null'];
	const r = spawnSync('tar', args);
	assert.equal(r.status, 0, `tar create failed: ${r.stderr}`);
	const buf = fs.readFileSync(out);
	for (const [relative] of [...modeEntries].reverse()) fs.chmodSync(path.join(src, relative), 0o755);
	fs.rmSync(src, { recursive: true, force: true });
	fs.rmSync(out, { force: true });
	return buf;
}

function makeSymlinkTarGz() {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-link-src-'));
	fs.mkdirSync(path.join(src, 'src'), { recursive: true });
	fs.symlinkSync('/tmp', path.join(src, 'src', 'escape'));
	const out = path.join(os.tmpdir(), `dev-sync-link-${Date.now()}.tgz`);
	const result = spawnSync('tar', ['-czf', out, '-C', src, 'src']);
	assert.equal(result.status, 0, `tar create failed: ${result.stderr}`);
	const bytes = fs.readFileSync(out);
	fs.rmSync(src, { recursive: true, force: true });
	fs.rmSync(out, { force: true });
	return bytes;
}

test('GET /healthz is open (no token) and reports the dest', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const resp = await fetch(`${s.base}/healthz`);
	assert.equal(resp.status, 200);
	const body = await resp.json();
	assert.equal(body.ok, true);
	assert.equal(body.dest, s.dest);
});

test('POST /__sync requires the token and untars into the dest', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const tgz = makeTarGz({
		'src/a.txt': 'hello-sync',
		'src/nested/b.txt': 'nested'
	});

	// Wrong/absent token → 401, nothing written.
	const noAuth = await fetch(`${s.base}/__sync`, { method: 'POST', body: tgz });
	assert.equal(noAuth.status, 401);
	assert.ok(!fs.existsSync(path.join(s.dest, 'src/a.txt')));
	const noGeneration = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN },
		body: tgz
	});
	assert.equal(noGeneration.status, 400);

	// Correct token → 200 and files land in the dest.
	const ok = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders(),
		body: tgz
	});
	assert.equal(ok.status, 200);
	const body = await ok.json();
	assert.equal(body.ok, true);
	assert.equal(body.generation, GENERATION);
	assert.equal(body.service, SERVICE);
	assert.deepEqual(body.changedRoots, ['src']);
	assert.deepEqual(body.changedPaths, ['src']);
	assert.equal(body.changedPathCount, 1);
	assert.equal(body.changedPathsTruncated, false);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/a.txt'), 'utf8'), 'hello-sync');
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/nested/b.txt'), 'utf8'), 'nested');
});

test('POST /__sync defaults to merge mode so patch archives do not prune source roots', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	fs.mkdirSync(path.join(s.dest, 'src/routes/dashboard'), { recursive: true });
	fs.mkdirSync(path.join(s.dest, 'src/lib'), { recursive: true });
	fs.writeFileSync(path.join(s.dest, 'src/app.html'), '<div id="svelte">%sveltekit.body%</div>');
	fs.writeFileSync(path.join(s.dest, 'src/lib/keep.ts'), 'export const keep = true;');
	fs.writeFileSync(path.join(s.dest, 'src/routes/dashboard/+page.svelte'), '<h1>before</h1>');

	const response = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('patch-generation-1'),
		body: makeTarGz({ 'src/routes/dashboard/+page.svelte': '<h1>after</h1>' }, {}, ['src'])
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.syncMode, 'merge');
	assert.deepEqual(body.changedRoots, ['src']);
	assert.deepEqual(body.changedPaths, ['src/routes/dashboard/+page.svelte']);
	assert.equal(
		fs.readFileSync(path.join(s.dest, 'src/routes/dashboard/+page.svelte'), 'utf8'),
		'<h1>after</h1>'
	);
	assert.equal(
		fs.readFileSync(path.join(s.dest, 'src/app.html'), 'utf8'),
		'<div id="svelte">%sveltekit.body%</div>'
	);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/lib/keep.ts'), 'utf8'), 'export const keep = true;');
});

test('POST /__sync supports explicit replace mode for full root snapshots', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	fs.mkdirSync(path.join(s.dest, 'src/routes/dashboard'), { recursive: true });
	fs.mkdirSync(path.join(s.dest, 'src/lib'), { recursive: true });
	fs.writeFileSync(path.join(s.dest, 'src/app.html'), '<div id="svelte">%sveltekit.body%</div>');
	fs.writeFileSync(path.join(s.dest, 'src/lib/keep.ts'), 'export const keep = true;');
	fs.writeFileSync(path.join(s.dest, 'src/routes/dashboard/+page.svelte'), '<h1>before</h1>');

	const response = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: { ...syncHeaders('replace-generation-1'), 'x-sync-mode': 'replace' },
		body: makeTarGz({ 'src/routes/dashboard/+page.svelte': '<h1>after</h1>' }, {}, ['src'])
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.syncMode, 'replace');
	assert.ok(body.changedPaths.includes('src/app.html'));
	assert.ok(!fs.existsSync(path.join(s.dest, 'src/app.html')));
	assert.ok(!fs.existsSync(path.join(s.dest, 'src/lib/keep.ts')));
	assert.equal(
		fs.readFileSync(path.join(s.dest, 'src/routes/dashboard/+page.svelte'), 'utf8'),
		'<h1>after</h1>'
	);
});

test('POST /__sync accepts the preview-scoped agent capability without exposing the root token', async (t) => {
	const agentToken = '2'.repeat(64);
	const s = await startSidecar({
		DEV_SYNC_AGENT_TOKEN_SHA256: createHash('sha256').update(agentToken).digest('hex')
	});
	t.after(() => s.stop());
	const response = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: {
			...syncHeaders('agent-capability-1'),
			'x-sync-token': agentToken
		},
		body: makeTarGz({ 'src/agent.txt': 'allowed' })
	});
	assert.equal(response.status, 200);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/agent.txt'), 'utf8'), 'allowed');
});

test('POST /__freeze uses a receiver-only durable prepare/commit/abort protocol', async (t) => {
	const agentToken = '2'.repeat(64);
	const env = {
		DEV_SYNC_AGENT_TOKEN_SHA256: createHash('sha256').update(agentToken).digest('hex'),
		DEV_SYNC_ALLOW_LOCAL_RUN: 'true',
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ check: 'true' })
	};
	const operationId = 'teardown:exec-1:0123456789abcdef';
	const otherOperationId = 'teardown:exec-2:fedcba9876543210';
	const freezeUrl = (base, phase, operation = operationId) =>
		`${base}/__freeze?phase=${phase}&operationId=${encodeURIComponent(operation)}`;
	let s = await startSidecar(env);
	t.after(() => s.stop());
	const archive = makeTarGz({ 'src/current.txt': 'captured' });
	const seeded = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: {
			...syncHeaders('freeze-generation-1'),
			'x-sync-token': agentToken
		},
		body: archive
	});
	assert.equal(seeded.status, 200);
	const seedState = await seeded.json();

	assert.equal((await fetch(freezeUrl(s.base, 'prepare'), { method: 'POST' })).status, 401);
	assert.equal(
		(
			await fetch(freezeUrl(s.base, 'prepare'), {
				method: 'POST',
				headers: { 'x-sync-token': agentToken }
			})
		).status,
		401
	);
	assert.equal(
		(
			await fetch(`${s.base}/__freeze?phase=prepare`, {
				method: 'POST',
				headers: { 'x-sync-token': TOKEN }
			})
		).status,
		400
	);
	let status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': agentToken } })
	).json();
	assert.equal(status.frozen, false);
	assert.equal(status.prepared, false);
	const prematureCommit = await fetch(freezeUrl(s.base, 'commit'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(prematureCommit.status, 409);

	const prepareResponse = await fetch(freezeUrl(s.base, 'prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(prepareResponse.status, 200);
	const expectedPreparedProof = {
		ok: true,
		prepared: true,
		frozen: false,
		idempotent: false,
		operationId,
		service: SERVICE,
		generation: 'freeze-generation-1',
		contentSha256: seedState.contentSha256
	};
	assert.deepEqual(await prepareResponse.json(), expectedPreparedProof);
	let persistedState = JSON.parse(fs.readFileSync(path.join(s.dest, '.dev-sync-state.json')));
	assert.equal(persistedState.frozen, false);
	assert.equal(persistedState.preparedOperationId, operationId);

	for (const token of [TOKEN, agentToken]) {
		const blocked = await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: { ...syncHeaders('after-freeze'), 'x-sync-token': token },
			body: makeTarGz({ 'src/current.txt': 'must-not-land' })
		});
		assert.equal(blocked.status, 409);
		assert.match((await blocked.json()).error, /prepared|quiesced/);
	}
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'captured');
	const blockedRun = await fetch(`${s.base}/__run?cmd=check`, {
		method: 'POST',
		headers: { 'x-sync-token': agentToken }
	});
	assert.equal(blockedRun.status, 409);
	assert.match((await blockedRun.json()).error, /prepared|quiesced/);
	const preparedExport = await fetch(`${s.base}/__export`, {
		headers: { 'x-sync-token': agentToken }
	});
	assert.equal(preparedExport.status, 200);
	assert.equal(preparedExport.headers.get('x-sync-generation'), 'freeze-generation-1');
	status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': agentToken } })
	).json();
	assert.equal(status.frozen, false);
	assert.equal(status.prepared, true);
	assert.equal(status.preparedOperationId, operationId);

	const retry = await fetch(freezeUrl(s.base, 'prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(retry.status, 200);
	assert.deepEqual(await retry.json(), { ...expectedPreparedProof, idempotent: true });
	const conflictingPrepare = await fetch(freezeUrl(s.base, 'prepare', otherOperationId), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(conflictingPrepare.status, 409);
	const wrongCommit = await fetch(freezeUrl(s.base, 'commit', otherOperationId), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(wrongCommit.status, 409);
	const wrongAbort = await fetch(freezeUrl(s.base, 'abort', otherOperationId), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(wrongAbort.status, 409);

	const dest = s.dest;
	const stopped = new Promise((resolve) => s.proc.once('exit', resolve));
	s.stop({ preserveDest: true });
	await stopped;
	s = await startSidecar(env, dest);
	status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.frozen, false);
	assert.equal(status.prepared, true);
	assert.equal(status.preparedOperationId, operationId);
	const abort = await fetch(freezeUrl(s.base, 'abort'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(abort.status, 200);
	assert.deepEqual(await abort.json(), {
		ok: true,
		prepared: false,
		frozen: false,
		idempotent: false,
		operationId
	});
	const abortReplay = await fetch(freezeUrl(s.base, 'abort'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(abortReplay.status, 200);
	assert.equal((await abortReplay.json()).idempotent, true);

	const afterAbortSync = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('freeze-generation-2'),
		body: makeTarGz({ 'src/current.txt': 'captured-again' })
	});
	assert.equal(afterAbortSync.status, 200);
	const afterAbortState = await afterAbortSync.json();
	const secondPrepare = await fetch(freezeUrl(s.base, 'prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(secondPrepare.status, 200);
	const commit = await fetch(freezeUrl(s.base, 'commit'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(commit.status, 200);
	const committedProof = await commit.json();
	assert.deepEqual(committedProof, {
		ok: true,
		prepared: false,
		frozen: true,
		idempotent: false,
		operationId,
		service: SERVICE,
		generation: 'freeze-generation-2',
		contentSha256: afterAbortState.contentSha256
	});
	persistedState = JSON.parse(fs.readFileSync(path.join(s.dest, '.dev-sync-state.json')));
	assert.equal(persistedState.frozen, true);
	assert.equal(persistedState.preparedOperationId, null);
	assert.equal(persistedState.frozenOperationId, operationId);

	for (const phase of ['prepare', 'commit']) {
		const replay = await fetch(freezeUrl(s.base, phase), {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(replay.status, 200);
		assert.deepEqual(await replay.json(), { ...committedProof, idempotent: true });
	}
	for (const phase of ['prepare', 'commit', 'abort']) {
		const conflict = await fetch(freezeUrl(s.base, phase, otherOperationId), {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(conflict.status, 409);
	}
	assert.equal(
		(
			await fetch(`${s.base}/__sync`, {
				method: 'POST',
				headers: syncHeaders('after-restart'),
				body: makeTarGz({ 'src/current.txt': 'must-not-land' })
			})
		).status,
		409
	);
});

test('freeze prepare returns busy while a sync is in flight, then commit freezes its proof', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const operationId = 'teardown:freeze-race:0123456789abcdef';
	const freezeUrl = (phase) =>
		`${s.base}/__freeze?phase=${phase}&operationId=${encodeURIComponent(operationId)}`;
	const archive = makeTarGz({ 'src/current.txt': 'race-winner' });
	let releaseUpload;
	const uploadGate = new Promise((resolve) => {
		releaseUpload = resolve;
	});
	async function* delayedUpload() {
		yield archive.subarray(0, 1);
		await uploadGate;
		yield archive.subarray(1);
	}
	const syncing = fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('freeze-race-1'),
		body: delayedUpload(),
		duplex: 'half'
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	const busy = await fetch(freezeUrl('prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(busy.status, 409);
	assert.match((await busy.json()).error, /sync in progress/);
	releaseUpload();
	const synced = await syncing;
	assert.equal(synced.status, 200);
	const syncProof = await synced.json();

	const prepared = await fetch(freezeUrl('prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(prepared.status, 200);
	assert.deepEqual(await prepared.json(), {
		ok: true,
		prepared: true,
		frozen: false,
		idempotent: false,
		operationId,
		service: SERVICE,
		generation: 'freeze-race-1',
		contentSha256: syncProof.contentSha256
	});
	const frozen = await fetch(freezeUrl('commit'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(frozen.status, 200);
	assert.deepEqual(await frozen.json(), {
		ok: true,
		prepared: false,
		frozen: true,
		idempotent: false,
		operationId,
		service: SERVICE,
		generation: 'freeze-race-1',
		contentSha256: syncProof.contentSha256
	});
});

test('POST /__sync requires the exact receiver root contract', async (t) => {
	const roots = ['config', 'src'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	const body = makeTarGz({ 'src/a.txt': 'a', 'config/app.json': '{}' });

	for (const headers of [
		{ ...syncHeaders('roots-1'), 'x-sync-roots': undefined },
		syncHeaders('roots-2', SERVICE, ['src']),
		syncHeaders('roots-3', SERVICE, ['config', 'src', 'tmp'])
	]) {
		const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
		const response = await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: cleanHeaders,
			body
		});
		assert.equal(response.status, 400);
	}
	assert.ok(!fs.existsSync(path.join(s.dest, 'src')));
});

test('file-granular reconciliation propagates deletions without replacing kept files', async (t) => {
	const roots = ['config', 'src'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	const first = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('deletion-1', SERVICE, roots),
		body: makeTarGz({
			'src/keep.txt': 'old',
			'src/delete.txt': 'remove-me',
			'config/app.json': '{"old":true}'
		})
	});
	assert.equal(first.status, 200);
	const sourceInode = fs.statSync(path.join(s.dest, 'src')).ino;
	const keptInode = fs.statSync(path.join(s.dest, 'src/keep.txt')).ino;

	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: { ...syncHeaders('deletion-2', SERVICE, roots), 'x-sync-mode': 'replace' },
		body: makeTarGz({ 'src/keep.txt': 'old' })
	});
	assert.equal(second.status, 200);
	const result = await second.json();
	assert.deepEqual(result.changedRoots, ['config', 'src']);
	assert.deepEqual(result.changedPaths, ['config', 'src/delete.txt']);
	assert.equal(result.changedPathCount, 2);
	assert.equal(result.changedPathsTruncated, false);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/keep.txt'), 'utf8'), 'old');
	assert.equal(fs.statSync(path.join(s.dest, 'src')).ino, sourceInode);
	assert.equal(fs.statSync(path.join(s.dest, 'src/keep.txt')).ino, keptInode);
	assert.ok(!fs.existsSync(path.join(s.dest, 'src/delete.txt')));
	assert.ok(!fs.existsSync(path.join(s.dest, 'config')));

	const exported = await fetch(`${s.base}/__export`, {
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(exported.status, 200);
	assert.equal(exported.headers.get('x-sync-generation'), 'deletion-2');
	const bytes = Buffer.from(await exported.arrayBuffer());
	const listed = spawnSync('tar', ['-tzf', '-'], { input: bytes }).stdout.toString();
	assert.match(listed, /src\/keep\.txt/);
	assert.doesNotMatch(listed, /src\/delete\.txt|config\//);
	const kept = spawnSync('tar', ['-xOzf', '-', 'src/keep.txt'], { input: bytes });
	assert.equal(kept.status, 0, kept.stderr.toString());
	assert.equal(kept.stdout.toString(), 'old');
});

test('one-file sync preserves its source root, siblings, and unchanged config root', async (t) => {
	const roots = ['src', 'tsconfig.json'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	const first = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('content-aware-1', SERVICE, roots),
		body: makeTarGz({
			'src/current.txt': 'old',
			'src/unchanged.txt': 'same',
			'tsconfig.json': '{}'
		})
	});
	assert.equal(first.status, 200);
	const sourceInode = fs.statSync(path.join(s.dest, 'src')).ino;
	const currentInode = fs.statSync(path.join(s.dest, 'src/current.txt')).ino;
	const unchangedInode = fs.statSync(path.join(s.dest, 'src/unchanged.txt')).ino;
	const configInode = fs.statSync(path.join(s.dest, 'tsconfig.json')).ino;

	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('content-aware-2', SERVICE, roots),
		body: makeTarGz({
			'src/current.txt': 'new',
			'src/unchanged.txt': 'same',
			'tsconfig.json': '{}'
		})
	});
	assert.equal(second.status, 200);
	const result = await second.json();
	assert.deepEqual(result.changedRoots, ['src']);
	assert.deepEqual(result.changedPaths, ['src/current.txt']);
	assert.equal(result.changedPathCount, 1);
	assert.equal(result.changedPathsTruncated, false);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'new');
	assert.equal(fs.statSync(path.join(s.dest, 'src')).ino, sourceInode);
	assert.notEqual(fs.statSync(path.join(s.dest, 'src/current.txt')).ino, currentInode);
	assert.equal(fs.statSync(path.join(s.dest, 'src/unchanged.txt')).ino, unchangedInode);
	assert.equal(fs.statSync(path.join(s.dest, 'tsconfig.json')).ino, configInode);
	const status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.generation, 'content-aware-2');
});

test('one-file sync can update a read-only source root without replacing it', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	assert.equal(
		(
			await fetch(`${s.base}/__sync`, {
				method: 'POST',
				headers: syncHeaders('readonly-1'),
				body: makeTarGz({ 'src/current.txt': 'old', 'src/stable.txt': 'same' })
			})
		).status,
		200
	);
	const sourceInode = fs.statSync(path.join(s.dest, 'src')).ino;
	const stableInode = fs.statSync(path.join(s.dest, 'src/stable.txt')).ino;
	fs.chmodSync(path.join(s.dest, 'src'), 0o555);

	const response = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('readonly-2'),
		body: makeTarGz({ 'src/current.txt': 'new', 'src/stable.txt': 'same' })
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.deepEqual(result.changedPaths, ['src', 'src/current.txt']);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'new');
	assert.equal(fs.statSync(path.join(s.dest, 'src')).ino, sourceInode);
	assert.equal(fs.statSync(path.join(s.dest, 'src/stable.txt')).ino, stableInode);
	assert.equal(fs.statSync(path.join(s.dest, 'src')).mode & 0o7777, 0o755);
});

test('an all-content no-op still advances sidecar generation state', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const body = makeTarGz({ 'src/current.txt': 'same' });
	assert.equal(
		(
			await fetch(`${s.base}/__sync`, {
				method: 'POST',
				headers: syncHeaders('no-op-1'),
				body
			})
		).status,
		200
	);
	const sourceInode = fs.statSync(path.join(s.dest, 'src')).ino;
	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('no-op-2'),
		body
	});
	assert.equal(second.status, 200);
	assert.deepEqual((await second.json()).changedRoots, []);
	assert.equal(fs.statSync(path.join(s.dest, 'src')).ino, sourceInode);
	const status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.generation, 'no-op-2');
});

test('app.py replacement emits a localized watcher event without replacing the workdir', async (t) => {
	const roots = ['app.py'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	const first = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('python-reload-1', SERVICE, roots),
		body: makeTarGz({ 'app.py': 'VERSION = 1\n' })
	});
	assert.equal(first.status, 200);
	const workdirInode = fs.statSync(s.dest).ino;

	let timeout;
	const watcher = fs.watch(s.dest);
	t.after(() => watcher.close());
	const appEvent = new Promise((resolve, reject) => {
		timeout = setTimeout(() => reject(new Error('no app.py watcher event')), 2000);
		watcher.on('change', (eventType, filename) => {
			if (String(filename) === 'app.py') resolve(eventType);
		});
	});
	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('python-reload-2', SERVICE, roots),
		body: makeTarGz({ 'app.py': 'VERSION = 2\n' })
	});
	assert.equal(second.status, 200);
	const result = await second.json();
	assert.deepEqual(result.changedPaths, ['app.py']);
	assert.ok(await appEvent);
	clearTimeout(timeout);
	assert.equal(fs.statSync(s.dest).ino, workdirInode);
	assert.equal(fs.readFileSync(path.join(s.dest, 'app.py'), 'utf8'), 'VERSION = 2\n');
});

test('regular-file backup emits no watcher event before the committed rename', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-watch-root-'));
	const archivePath = path.join(os.tmpdir(), `dev-sync-watch-${process.pid}-${Date.now()}.tgz`);
	fs.mkdirSync(path.join(root, 'src'));
	const watchedPath = path.join(root, 'src/current.txt');
	fs.writeFileSync(watchedPath, 'old');
	fs.writeFileSync(archivePath, makeTarGz({ 'src/current.txt': 'new' }));
	t.after(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(archivePath, { force: true });
	});

	const observedContents = [];
	const watcher = fs.watch(watchedPath, () => {
		try {
			observedContents.push(fs.readFileSync(watchedPath, 'utf8'));
		} catch {
			observedContents.push('<missing>');
		}
	});
	t.after(() => watcher.close());

	const childScript = `
		import fs from 'node:fs';
		import path from 'node:path';
		import { pathToFileURL } from 'node:url';
		const originalRename = fs.renameSync.bind(fs);
		let delayed = false;
		fs.renameSync = (source, target) => {
			if (!delayed && String(source).includes(path.sep + 'stage' + path.sep)) {
				delayed = true;
				process.stdout.write('before-rename\\n');
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
			}
			return originalRename(source, target);
		};
		const { applyAtomicDevSync } = await import(pathToFileURL(process.env.ATOMIC_SYNC).href);
		await applyAtomicDevSync({
			root: process.env.SYNC_ROOT,
			archivePath: process.env.SYNC_ARCHIVE,
			declaredRoots: ['src'],
			nextState: {
				generation: 'watch-2', service: 'workflow-builder',
				lastSyncAt: '2026-07-13T00:00:00.000Z', lastSyncBytes: 1
			},
			stateFile: '.dev-sync-state.json',
			persistState: () => undefined
		});
	`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
		env: {
			...process.env,
			ATOMIC_SYNC,
			SYNC_ROOT: root,
			SYNC_ARCHIVE: archivePath
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => (stdout += String(chunk)));
	child.stderr.on('data', (chunk) => (stderr += String(chunk)));
	const markerDeadline = Date.now() + 3000;
	while (!stdout.includes('before-rename') && Date.now() < markerDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.match(stdout, /before-rename/, `child did not reach commit boundary: ${stderr}`);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(observedContents, [], 'backup changed the watched inode before commit');

	const exitCode = await new Promise((resolve) => child.once('exit', resolve));
	assert.equal(exitCode, 0, stderr);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(observedContents.includes('new'), `missing committed watcher event: ${observedContents}`);
	assert.ok(!observedContents.includes('old'), `observed pre-commit content: ${observedContents}`);
});

test('malformed and link-bearing uploads never mutate the committed generation', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const committed = makeTarGz({ 'src/current.txt': 'committed' });
	assert.equal(
		(
			await fetch(`${s.base}/__sync`, {
				method: 'POST',
				headers: syncHeaders('safe-1'),
				body: committed
			})
		).status,
		200
	);

	for (const [generation, body] of [
		['bad-truncated', committed.subarray(0, Math.max(1, Math.floor(committed.length / 2)))],
		['bad-link', makeSymlinkTarGz()]
	]) {
		const response = await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders(generation),
			body
		});
		assert.equal(response.status, 400);
		assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'committed');
	}
	const status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.generation, 'safe-1');
});

test('state-write failure rolls roots back and withholds the failed generation from export', async (t) => {
	const roots = ['src', 'tsconfig.json'];
	const s = await startSidecar({
		NODE_ENV: 'test',
		DEV_SYNC_TEST_FAIL_STATE_WRITE_GENERATION: 'rollback-2',
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	assert.equal(
		(
			await fetch(`${s.base}/__sync`, {
				method: 'POST',
				headers: syncHeaders('rollback-1', SERVICE, roots),
				body: makeTarGz({
					'src/current.txt': 'old',
					'src/stays.txt': 'yes',
					'tsconfig.json': '{}'
				})
			})
		).status,
		200
	);
	const configInode = fs.statSync(path.join(s.dest, 'tsconfig.json')).ino;
	const failed = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('rollback-2', SERVICE, roots),
		body: makeTarGz({ 'src/current.txt': 'new', 'tsconfig.json': '{}' })
	});
	assert.equal(failed.status, 500);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'old');
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/stays.txt'), 'utf8'), 'yes');
	assert.equal(fs.statSync(path.join(s.dest, 'tsconfig.json')).ino, configInode);

	const exported = await fetch(`${s.base}/__export`, {
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(exported.status, 200);
	assert.equal(exported.headers.get('x-sync-generation'), 'rollback-1');
	assert.notEqual(exported.headers.get('x-sync-generation'), 'rollback-2');
	const listed = spawnSync('tar', ['-xOzf', '-', 'src/current.txt'], {
		input: Buffer.from(await exported.arrayBuffer())
	});
	assert.equal(listed.status, 0);
	assert.equal(listed.stdout.toString(), 'old');
});

test('same generation is idempotent only for the same archive digest', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const firstBody = makeTarGz({ 'src/a.txt': 'one' });
	const first = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('collision-1'),
		body: firstBody
	});
	assert.equal(first.status, 200);
	const retry = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('collision-1'),
		body: firstBody
	});
	assert.equal(retry.status, 200);
	assert.equal((await retry.json()).idempotent, true);
	const collision = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('collision-1'),
		body: makeTarGz({ 'src/a.txt': 'two' })
	});
	assert.equal(collision.status, 409);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/a.txt'), 'utf8'), 'one');
});

test('GET /__export streams a gzip tar only for the exact allowed root set', async (t) => {
	const roots = ['src', 'config'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	// Seed the dest via /__sync.
	await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders(GENERATION, SERVICE, roots),
		body: makeTarGz({ 'src/x.ts': 'export const x = 1;' })
	});

	// Missing token → 401.
	assert.equal((await fetch(`${s.base}/__export?paths=src`)).status, 401);

	for (const paths of ['src', 'src,does-not-exist']) {
		const mismatch = await fetch(`${s.base}/__export?paths=${paths}`, {
			headers: { 'x-sync-token': TOKEN }
		});
		assert.equal(mismatch.status, 400);
		assert.match((await mismatch.json()).error, /exactly match/);
	}

	// `config` is absent on disk but remains part of the declared replacement
	// set; the archive contains existing roots and its header preserves both.
	const resp = await fetch(`${s.base}/__export`, {
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(resp.status, 200);
	assert.equal(resp.headers.get('content-type'), 'application/gzip');
	assert.deepEqual(JSON.parse(resp.headers.get('x-sync-roots')), [...roots].sort());
	assert.equal(resp.headers.get('x-sync-generation'), GENERATION);
	assert.equal(resp.headers.get('x-sync-service'), SERVICE);
	const bytes = Buffer.from(await resp.arrayBuffer());
	assert.equal(
		resp.headers.get('x-content-sha256'),
		`sha256:${createHash('sha256').update(bytes).digest('hex')}`
	);
	assert.equal(bytes[0], 0x1f, 'gzip magic byte 0');
	assert.equal(bytes[1], 0x8b, 'gzip magic byte 1');
	// Round-trip: the archive should contain src/x.ts.
	const listed = spawnSync('tar', ['-tzf', '-'], {
		input: bytes
	}).stdout.toString();
	assert.match(listed, /src\/x\.ts/);

	// A wholly unknown replacement set is rejected, never silently filtered.
	const none = await fetch(`${s.base}/__export?paths=nope`, {
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(none.status, 400);
});

test('source export is rejected while a sync generation is still uploading', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	fs.mkdirSync(path.join(s.dest, 'src'), { recursive: true });
	fs.writeFileSync(path.join(s.dest, 'src/current.txt'), 'old');
	const tgz = makeTarGz({ 'src/current.txt': 'new' });
	let releaseUpload;
	const uploadGate = new Promise((resolve) => {
		releaseUpload = resolve;
	});
	async function* delayedUpload() {
		yield tgz.subarray(0, 1);
		await uploadGate;
		yield tgz.subarray(1);
	}
	const syncing = fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders(),
		body: delayedUpload(),
		duplex: 'half'
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	const blocked = await fetch(`${s.base}/__export`, {
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(blocked.status, 409);
	assert.match((await blocked.json()).error, /sync in progress/);
	releaseUpload();
	assert.equal((await syncing).status, 200);
});

test('sync and export are rejected while an allowlisted run reads the source tree', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_ALLOW_LOCAL_RUN: 'true',
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({
			hold: 'sleep 0.3; test -f src/current.txt'
		})
	});
	t.after(() => s.stop());
	const operationId = 'teardown:run-freeze:0123456789abcdef';
	const freezeUrl = (phase) =>
		`${s.base}/__freeze?phase=${phase}&operationId=${encodeURIComponent(operationId)}`;
	const seeded = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('run-freeze-generation'),
		body: makeTarGz({ 'src/current.txt': 'stable' })
	});
	assert.equal(seeded.status, 200);
	const running = fetch(`${s.base}/__run?cmd=hold`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	await new Promise((resolve) => setTimeout(resolve, 75));
	const [sync, exported, freezeWhileRunning] = await Promise.all([
		fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders('blocked-by-run'),
			body: makeTarGz({ 'src/current.txt': 'changed' })
		}),
		fetch(`${s.base}/__export`, { headers: { 'x-sync-token': TOKEN } }),
		fetch(freezeUrl('prepare'), {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		})
	]);
	assert.equal(sync.status, 409);
	assert.equal(exported.status, 409);
	assert.equal(freezeWhileRunning.status, 409);
	assert.match((await sync.json()).error, /run in progress/);
	assert.match((await exported.json()).error, /run in progress/);
	assert.match((await freezeWhileRunning.json()).error, /run in progress/);
	assert.equal((await running).status, 200);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'stable');

	const prepared = await fetch(freezeUrl('prepare'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(prepared.status, 200);
	const frozen = await fetch(freezeUrl('commit'), {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(frozen.status, 200);
	const blockedRun = await fetch(`${s.base}/__run?cmd=hold`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(blockedRun.status, 409);
	assert.deepEqual(await blockedRun.json(), {
		ok: false,
		error: 'source receiver is frozen',
		frozen: true,
		prepared: false
	});
});

test('GET /__status reflects the last sync + last run and lists commands', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'true', contract: 'true' })
	});
	t.after(() => s.stop());

	let status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.lastSyncAt, null);
	assert.equal(status.lastSyncTimingsMs, null);
	assert.deepEqual(status.commands, ['contract', 'deps']);

	await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders(),
		body: makeTarGz({ 'src/a.txt': 'x' })
	});
	status = await (await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })).json();
	assert.ok(status.lastSyncAt, 'lastSyncAt set after a sync');
	assert.ok(status.lastSyncBytes > 0);
	assert.ok(status.lastSyncTimingsMs.total >= 0);
	assert.ok(status.lastSyncTimingsMs.planning >= 0);
	assert.equal(status.generation, GENERATION);
	assert.equal(status.syncService, SERVICE);

	// Missing token → 401.
	assert.equal((await fetch(`${s.base}/__status`)).status, 401);
});

test('POST /__run only runs allowlisted commands and returns the exit code', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_ALLOW_LOCAL_RUN: 'true',
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({
			deps: 'echo installing-deps',
			failing: 'echo boom >&2; exit 3'
		})
	});
	t.after(() => s.stop());

	// Unknown command → 404 with the allowed list.
	const unknown = await fetch(`${s.base}/__run?cmd=rm-rf`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(unknown.status, 404);
	assert.deepEqual((await unknown.json()).allowed, ['deps', 'failing']);

	// Missing token → 401.
	assert.equal((await fetch(`${s.base}/__run?cmd=deps`, { method: 'POST' })).status, 401);

	// Allowlisted success → ok:true, exit 0, output captured.
	const ok = await (
		await fetch(`${s.base}/__run?cmd=deps`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		})
	).json();
	assert.equal(ok.ok, true);
	assert.equal(ok.exitCode, 0);
	assert.match(ok.output, /installing-deps/);

	// Allowlisted failure → HTTP 200 (it ran) but ok:false + the real exit code.
	const failResp = await fetch(`${s.base}/__run?cmd=failing`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(failResp.status, 200);
	const fail = await failResp.json();
	assert.equal(fail.ok, false);
	assert.equal(fail.exitCode, 3);
	assert.match(fail.output, /boom/);
});

test('POST /__run runs in DEST and a bad DEV_SYNC_COMMANDS_JSON fails closed', async (t) => {
	const s = await startSidecar({ DEV_SYNC_COMMANDS_JSON: 'not-json{' });
	t.after(() => s.stop());
	// Malformed allowlist → empty → every /__run 404s.
	const resp = await fetch(`${s.base}/__run?cmd=deps`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(resp.status, 404);

	const s2 = await startSidecar({
		DEV_SYNC_ALLOW_LOCAL_RUN: 'true',
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ pwd: 'pwd' })
	});
	t.after(() => s2.stop());
	const out = await (
		await fetch(`${s2.base}/__run?cmd=pwd`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		})
	).json();
	// Commands execute with cwd = DEST.
	assert.match(out.output.trim(), new RegExp(s2.dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('unknown paths 404', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	assert.equal((await fetch(`${s.base}/nope`)).status, 404);
});

// ----- #40: /__run proxies to the app-container exec bridge -----

test('POST /__run executes via the app-container bridge when present (executedIn app)', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'echo sidecar-side' })
	});
	t.after(() => s.stop());
	// The REAL bridge on the sidecar's exec port, with its OWN dest + allowlist —
	// output proves the command ran in the bridge process, not the sidecar.
	const b = await startBridge(s.execPort, {
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'echo bridge-side; pwd' })
	});
	t.after(() => b.stop());

	const out = await (
		await fetch(`${s.base}/__run?cmd=deps`, {
			method: 'POST',
			headers: { 'x-sync-token': TOKEN }
		})
	).json();
	assert.equal(out.executedIn, 'app');
	assert.equal(out.ok, true);
	assert.equal(out.exitCode, 0);
	assert.match(out.output, /bridge-side/);
	assert.match(out.output, new RegExp(b.dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.ok(!out.output.includes('sidecar-side'), 'must not also run locally');

	// /__status reflects where the last run executed.
	const status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.lastRun.executedIn, 'app');
});

test('bridge run failures propagate the real exit code (no sidecar fallback)', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({
			contract: 'echo should-not-run-here'
		})
	});
	t.after(() => s.stop());
	const b = await startBridge(s.execPort, {
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({
			contract: 'echo bridge-boom >&2; exit 5'
		})
	});
	t.after(() => b.stop());

	const resp = await fetch(`${s.base}/__run?cmd=contract`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(resp.status, 200); // it RAN (in the app container) — ok:false carries the failure
	const out = await resp.json();
	assert.equal(out.executedIn, 'app');
	assert.equal(out.ok, false);
	assert.equal(out.exitCode, 5);
	assert.match(out.output, /bridge-boom/);
});

test('POST /__run fails closed when no bridge is listening', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'echo installing-deps' })
	});
	t.after(() => s.stop());
	const response = await fetch(`${s.base}/__run?cmd=deps`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(response.status, 503);
	const out = await response.json();
	assert.equal(out.ok, false);
	assert.equal(out.executedIn, null);
	assert.match(out.error, /bridge unavailable.*(?:unreachable|connect timeout)/);
});

test('POST /__run fails closed when the bridge refuses the command', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'echo must-not-run' })
	});
	t.after(() => s.stop());
	// Bridge WITHOUT DEV_SYNC_COMMANDS_JSON rejects the command before execution.
	const b = await startBridge(s.execPort);
	t.after(() => b.stop());
	const response = await fetch(`${s.base}/__run?cmd=deps`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(response.status, 503);
	const out = await response.json();
	assert.equal(out.ok, false);
	assert.equal(out.executedIn, null);
	assert.match(out.error, /bridge unavailable: bridge HTTP 404/);
});

test('POST /__run permits explicit legacy-only local execution', async (t) => {
	const s = await startSidecar({
		DEV_SYNC_ALLOW_LOCAL_RUN: 'yes',
		DEV_SYNC_COMMANDS_JSON: JSON.stringify({ deps: 'echo legacy-local' })
	});
	t.after(() => s.stop());
	const response = await fetch(`${s.base}/__run?cmd=deps`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(response.status, 200);
	const out = await response.json();
	assert.equal(out.executedIn, 'sidecar');
	assert.equal(out.ok, true);
	assert.match(out.output, /legacy-local/);
});

// ----- #41: route-add detection + restart signal -----

test('POST /__sync flags NEW src/routes files and writes the restart signal once', async (t) => {
	const s = await startSidecar();
	t.after(() => s.stop());
	const signal = path.join(s.dest, '.dev-sync-restart-request.json');
	const tgz = makeTarGz({
		'src/routes/pr-preview-marker/+server.ts': 'export const GET = () => new Response("ok");',
		'src/lib/util.ts': 'export const x = 1;'
	});

	const first = await (
		await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders('route-generation-1'),
			body: tgz
		})
	).json();
	assert.equal(first.ok, true);
	assert.deepEqual(first.routesAdded, ['src/routes/pr-preview-marker/+server.ts']);
	assert.equal(first.restartSignaled, true);
	const written = JSON.parse(fs.readFileSync(signal, 'utf8'));
	assert.deepEqual(written.addedRoutes, ['src/routes/pr-preview-marker/+server.ts']);
	assert.ok(written.requestedAt);

	// The plugin consumes (deletes) the signal before restarting; a re-sync of
	// an edit to the EXISTING route adds nothing → no new signal, no restart loop.
	fs.unlinkSync(signal);
	const edited = makeTarGz({
		'src/routes/pr-preview-marker/+server.ts':
			'export const GET = () => new Response("updated");',
		'src/lib/util.ts': 'export const x = 1;'
	});
	const second = await (
		await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders('route-generation-2'),
			body: edited
		})
	).json();
	assert.equal(second.ok, true);
	assert.deepEqual(second.changedPaths, ['src/routes/pr-preview-marker/+server.ts']);
	assert.equal(second.routesAdded, undefined);
	assert.ok(!fs.existsSync(signal), 'no signal for a sync that adds no routes');
});
