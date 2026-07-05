import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Integration test for scripts/dev-sync/sync.sh driven against the REAL
 * dev-sync-sidecar: sync.sh tars + POSTs → the sidecar untars into its DEST →
 * sync.sh triggers /__run?cmd=deps only when a manifest hash changes. Exercises
 * B3a (deps lane) + B4 (extraSync staging) end to end. Zero deps: node:test.
 * Run: `node --test scripts/dev-sync/`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(HERE, '..', '..', 'services', 'dev-sync-sidecar', 'server.mjs');
const SYNC_SH = path.join(HERE, 'sync.sh');
const TOKEN = 'sync-tok';

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

async function startSidecar(dest, commandsJson) {
	const port = await freePort();
	const proc = spawn(process.execPath, [SIDECAR], {
		env: {
			...process.env,
			DEV_SYNC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_TOKEN: TOKEN,
			...(commandsJson ? { DEV_SYNC_COMMANDS_JSON: commandsJson } : {})
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	proc.stdout.on('data', (d) => (log += String(d)));
	proc.stderr.on('data', (d) => (log += String(d)));
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !log.includes('listening on')) {
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!log.includes('listening on')) {
		proc.kill('SIGKILL');
		throw new Error(`sidecar failed to start:\n${log}`);
	}
	return { port, base: `http://127.0.0.1:${port}`, stop: () => proc.kill('SIGKILL') };
}

function runSync(work) {
	return spawnSync('sh', [path.join(work, 'sync.sh')], {
		env: { ...process.env, DEV_SYNC_WORK: work, DEV_SYNC_REPO: path.join(work, 'repo') },
		encoding: 'utf8'
	});
}

function write(p, contents) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents);
}

test('sync.sh syncs source + stages extraSync, and fires deps only on a manifest change', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-'));
	// deps command drops a marker in the pod workdir (cwd = DEST) so we can assert it ran.
	const sc = await startSidecar(dest, JSON.stringify({ deps: 'touch .deps-ran' }));
	t.after(() => {
		sc.stop();
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	});

	// Fake clone: a service with src/ + a package.json manifest, plus a shared
	// contract dir referenced via extraSync.
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'v1');
	write(path.join(work, 'repo/services/svc/package.json'), '{"deps":1}');
	write(path.join(work, 'repo/services/shared/contract/fixtures/a.json'), '{"x":1}');
	write(
		path.join(work, '.syncenv'),
		[
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${sc.base}/__sync`,
			'EXTRASYNC="../shared/contract:.contract-fixtures"',
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	// Run 1: source synced, extraSync staged, deps NOT run (first-sync baseline).
	let r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8'), 'v1');
	assert.equal(fs.readFileSync(path.join(dest, '.contract-fixtures/fixtures/a.json'), 'utf8'), '{"x":1}');
	assert.ok(!fs.existsSync(path.join(dest, '.deps-ran')), 'no deps install on first sync');
	assert.match(r.stdout, /SYNCED services\/svc → HTTP 200/);

	// Run 2: edit source + BUMP the manifest → deps fires.
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'v2');
	write(path.join(work, 'repo/services/svc/package.json'), '{"deps":2}');
	r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8'), 'v2');
	assert.ok(fs.existsSync(path.join(dest, '.deps-ran')), 'deps install on manifest change');

	// Run 3: edit source only (manifest unchanged) → deps does NOT re-run.
	fs.rmSync(path.join(dest, '.deps-ran'));
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'v3');
	r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8'), 'v3');
	assert.ok(!fs.existsSync(path.join(dest, '.deps-ran')), 'no deps install without a manifest change');
});

test('sync.sh fans out over .syncenv.d and tolerates a service with no deps command', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-'));
	// No DEV_SYNC_COMMANDS_JSON → /__run?cmd=deps 404s; sync.sh must not fail.
	const sc = await startSidecar(dest, '');
	t.after(() => {
		sc.stop();
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/one/src/a.ts'), 'one');
	write(path.join(work, 'repo/services/one/requirements.txt'), 'flask==1');
	write(path.join(work, '.syncenv.d/one'), [`SUBDIR=services/one`, `PATHS="src"`, `SYNCURL=${sc.base}/__sync`, `SYNC_TOKEN=${TOKEN}`, ''].join('\n'));
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	// First run: baseline. Second run: manifest bump → deps attempted, gets 404, still exit 0.
	assert.equal(runSync(work).status, 0);
	write(path.join(work, 'repo/services/one/requirements.txt'), 'flask==2');
	const r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.match(r.stdout, /no deps command configured/);
	assert.equal(fs.readFileSync(path.join(dest, 'src/a.ts'), 'utf8'), 'one');
});
