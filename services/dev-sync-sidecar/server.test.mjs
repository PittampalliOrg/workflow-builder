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
async function startSidecar(extraEnv = {}) {
	const port = await freePort();
	const execPort = await freePort();
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-dest-'));
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
function makeTarGz(files) {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-src-'));
	const tops = new Set();
	for (const [rel, contents] of Object.entries(files)) {
		const abs = path.join(src, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, contents);
		tops.add(rel.split('/')[0]);
	}
	const out = path.join(os.tmpdir(), `dev-sync-upload-${Date.now()}.tgz`);
	const args = tops.size
		? ['-czf', out, '-C', src, ...tops]
		: ['-czf', out, '-C', src, '-T', '/dev/null'];
	const r = spawnSync('tar', args);
	assert.equal(r.status, 0, `tar create failed: ${r.stderr}`);
	const buf = fs.readFileSync(out);
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
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/a.txt'), 'utf8'), 'hello-sync');
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/nested/b.txt'), 'utf8'), 'nested');
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

test('atomic root replacement propagates file and whole-root deletions', async (t) => {
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

	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('deletion-2', SERVICE, roots),
		body: makeTarGz({ 'src/keep.txt': 'new' })
	});
	assert.equal(second.status, 200);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/keep.txt'), 'utf8'), 'new');
	assert.ok(!fs.existsSync(path.join(s.dest, 'src/delete.txt')));
	assert.ok(!fs.existsSync(path.join(s.dest, 'config')));
});

test('atomic root replacement preserves an unchanged config root', async (t) => {
	const roots = ['src', 'tsconfig.json'];
	const s = await startSidecar({
		DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(roots)
	});
	t.after(() => s.stop());
	const first = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('content-aware-1', SERVICE, roots),
		body: makeTarGz({ 'src/current.txt': 'old', 'tsconfig.json': '{}' })
	});
	assert.equal(first.status, 200);
	const configInode = fs.statSync(path.join(s.dest, 'tsconfig.json')).ino;

	const second = await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders('content-aware-2', SERVICE, roots),
		body: makeTarGz({ 'src/current.txt': 'new', 'tsconfig.json': '{}' })
	});
	assert.equal(second.status, 200);
	assert.deepEqual((await second.json()).changedRoots, ['src']);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'new');
	assert.equal(fs.statSync(path.join(s.dest, 'tsconfig.json')).ino, configInode);
	const status = await (
		await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })
	).json();
	assert.equal(status.generation, 'content-aware-2');
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
	fs.mkdirSync(path.join(s.dest, 'src'), { recursive: true });
	fs.writeFileSync(path.join(s.dest, 'src/current.txt'), 'stable');
	const running = fetch(`${s.base}/__run?cmd=hold`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	await new Promise((resolve) => setTimeout(resolve, 75));
	const [sync, exported] = await Promise.all([
		fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders('blocked-by-run'),
			body: makeTarGz({ 'src/current.txt': 'changed' })
		}),
		fetch(`${s.base}/__export`, { headers: { 'x-sync-token': TOKEN } })
	]);
	assert.equal(sync.status, 409);
	assert.equal(exported.status, 409);
	assert.match((await sync.json()).error, /run in progress/);
	assert.match((await exported.json()).error, /run in progress/);
	assert.equal((await running).status, 200);
	assert.equal(fs.readFileSync(path.join(s.dest, 'src/current.txt'), 'utf8'), 'stable');
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
	assert.deepEqual(status.commands, ['contract', 'deps']);

	await fetch(`${s.base}/__sync`, {
		method: 'POST',
		headers: syncHeaders(),
		body: makeTarGz({ 'src/a.txt': 'x' })
	});
	status = await (await fetch(`${s.base}/__status`, { headers: { 'x-sync-token': TOKEN } })).json();
	assert.ok(status.lastSyncAt, 'lastSyncAt set after a sync');
	assert.ok(status.lastSyncBytes > 0);
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
	// the SAME tree adds nothing → no new signal, no restart loop.
	fs.unlinkSync(signal);
	const second = await (
		await fetch(`${s.base}/__sync`, {
			method: 'POST',
			headers: syncHeaders('route-generation-2'),
			body: tgz
		})
	).json();
	assert.equal(second.ok, true);
	assert.equal(second.routesAdded, undefined);
	assert.ok(!fs.existsSync(signal), 'no signal for a sync that adds no routes');
});
