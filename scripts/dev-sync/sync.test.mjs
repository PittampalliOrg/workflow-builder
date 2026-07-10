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
const TOKEN = '3'.repeat(64);

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

async function startSidecar(dest, commandsJson, allowedRoots = ['src']) {
	const port = await freePort();
	const proc = spawn(process.execPath, [SIDECAR], {
		env: {
			...process.env,
			DEV_SYNC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_TOKEN: TOKEN,
			DEV_SYNC_ALLOWED_ROOTS_JSON: JSON.stringify(allowedRoots),
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
	return {
		port,
		base: `http://127.0.0.1:${port}`,
		stop: () => proc.kill('SIGKILL')
	};
}

function runSync(work, extraEnv = {}) {
	return spawnSync('sh', [path.join(work, 'sync.sh')], {
		env: {
			...process.env,
			DEV_SYNC_WORK: work,
			DEV_SYNC_REPO: path.join(work, 'repo'),
			...extraEnv
		},
		encoding: 'utf8'
	});
}

function write(p, contents) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, contents);
}

test('sync.sh syncs source, stages extraSync, and proves dependency state before reuse', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-'));
	// deps command drops a marker in the pod workdir (cwd = DEST) so we can assert it ran.
	const sc = await startSidecar(dest, JSON.stringify({ deps: 'touch .deps-ran' }), [
		'src',
		'.contract-fixtures',
		'.preview-capture/production.Dockerfile'
	]);
	t.after(() => {
		sc.stop();
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	});

	// Fake clone: a service with src/ + a package.json manifest, plus a shared
	// contract dir referenced via extraSync.
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'v1');
	write(path.join(work, 'repo/services/svc/package.json'), '{"deps":1}');
	write(path.join(work, 'repo/services/svc/Dockerfile'), 'FROM node:22\n');
	write(path.join(work, 'repo/services/shared/contract/fixtures/a.json'), '{"x":1}');
	write(
		path.join(work, '.syncenv'),
		[
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${sc.base}/__sync`,
			'EXTRASYNC="../shared/contract:.contract-fixtures Dockerfile:.preview-capture/production.Dockerfile"',
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	// Run 1: source synced, extraSync staged, and deps run because the image's
	// dependency baseline is not independently proven to match this checkout.
	let r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8'), 'v1');
	assert.equal(
		fs.readFileSync(path.join(dest, '.contract-fixtures/fixtures/a.json'), 'utf8'),
		'{"x":1}'
	);
	assert.equal(
		fs.readFileSync(path.join(dest, '.preview-capture/production.Dockerfile'), 'utf8'),
		'FROM node:22\n'
	);
	assert.ok(
		!fs.existsSync(path.join(dest, 'Dockerfile')),
		'capture-only Dockerfile is not applied to its repository path'
	);
	assert.ok(fs.existsSync(path.join(dest, '.deps-ran')), 'deps install on first sync');
	assert.match(r.stdout, /SYNCED services\/svc → HTTP 200/);

	// Run 2: edit source + BUMP the manifest → deps fires.
	fs.rmSync(path.join(dest, '.deps-ran'));
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
	assert.ok(
		!fs.existsSync(path.join(dest, '.deps-ran')),
		'no deps install without a manifest change'
	);

	// Run 4: remove every declared source root. The upload is a valid empty
	// archive whose exact root contract deletes the previously deployed trees.
	fs.rmSync(path.join(work, 'repo/services/svc/src'), { recursive: true });
	fs.rmSync(path.join(work, 'repo/services/shared/contract'), {
		recursive: true
	});
	fs.rmSync(path.join(work, 'repo/services/svc/Dockerfile'));
	r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.ok(!fs.existsSync(path.join(dest, 'src')));
	assert.ok(!fs.existsSync(path.join(dest, '.contract-fixtures')));
	assert.ok(!fs.existsSync(path.join(dest, '.preview-capture/production.Dockerfile')));
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
	write(
		path.join(work, '.syncenv.d/one'),
		[
			`SUBDIR=services/one`,
			`PATHS="src"`,
			`SYNCURL=${sc.base}/__sync`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	// First run attempts deps, gets the explicit no-command 404, and records the
	// baseline. A later manifest bump repeats the bounded no-command check.
	assert.equal(runSync(work).status, 0);
	write(path.join(work, 'repo/services/one/requirements.txt'), 'flask==2');
	const r = runSync(work);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.match(r.stdout, /no deps command configured/);
	assert.equal(fs.readFileSync(path.join(dest, 'src/a.ts'), 'utf8'), 'one');
});

test('sync.sh uses one generated generation for every service in a fanout', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const destOne = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-one-'));
	const destTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-two-'));
	const one = await startSidecar(destOne, '');
	const two = await startSidecar(destTwo, '');
	t.after(() => {
		one.stop();
		two.stop();
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(destOne, { recursive: true, force: true });
		fs.rmSync(destTwo, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/one/src/index.ts'), 'one');
	write(path.join(work, 'repo/services/two/src/index.ts'), 'two');
	write(
		path.join(work, '.syncenv.d/one'),
		[
			`SUBDIR=services/one`,
			`PATHS="src"`,
			`SYNCURL=${one.base}/__sync`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	write(
		path.join(work, '.syncenv.d/two'),
		[
			`SUBDIR=services/two`,
			`PATHS="src"`,
			`SYNCURL=${two.base}/__sync`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = runSync(work);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const headers = { 'x-sync-token': TOKEN };
	const oneStatus = await (await fetch(`${one.base}/__status`, { headers })).json();
	const twoStatus = await (await fetch(`${two.base}/__status`, { headers })).json();
	assert.match(oneStatus.generation, /^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
	assert.equal(oneStatus.generation, twoStatus.generation);
	assert.equal(oneStatus.syncService, 'one');
	assert.equal(twoStatus.syncService, 'two');
});

test('sync.sh never runs dependency actions after a failed source upload', (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	t.after(() => {
		fs.rmSync(work, { recursive: true, force: true });
	});

	const curlLog = path.join(work, 'curl.log');
	const curl = path.join(work, 'bin/curl');
	write(curl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CURL_LOG"\nprintf 500\n');
	fs.chmodSync(curl, 0o755);
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'changed');
	write(path.join(work, 'repo/services/svc/package.json'), '{"deps":2}');
	write(path.join(work, '.depshash-services_svc'), 'previous-hash');
	write(
		path.join(work, '.syncenv'),
		['SUBDIR=services/svc', 'PATHS="src"', 'SYNCURL=http://preview.invalid/__sync', ''].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = runSync(work, {
		CURL_LOG: curlLog,
		PATH: `${path.dirname(curl)}:${process.env.PATH}`
	});
	assert.notEqual(result.status, 0, result.stderr + result.stdout);
	const requests = fs.readFileSync(curlLog, 'utf8').trim().split('\n');
	assert.equal(requests.length, 1);
	assert.match(requests[0], /preview\.invalid\/__sync/);
	assert.doesNotMatch(requests[0], /__run/);
});

test('sync.sh retries a dependency change until the in-pod action succeeds', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-pod-'));
	const sidecar = await startSidecar(dest, JSON.stringify({ deps: 'exit 23' }));
	t.after(() => {
		sidecar.stop();
		fs.rmSync(work, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/svc/src/index.ts'), 'source');
	write(path.join(work, 'repo/services/svc/package.json'), '{"deps":1}');
	write(
		path.join(work, '.syncenv'),
		[
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${sidecar.base}/__sync`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const firstFailure = runSync(work);
	const secondFailure = runSync(work);
	for (const result of [firstFailure, secondFailure]) {
		assert.notEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /POST .*\/__run\?cmd=deps/);
		assert.match(result.stderr, /leaving the prior manifest baseline for retry/);
	}
});
