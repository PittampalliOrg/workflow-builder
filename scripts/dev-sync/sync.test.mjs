import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
const REQUIRED_SYNC_TOOLS = [
	'basename',
	'cat',
	'chmod',
	'cp',
	'curl',
	'cut',
	'date',
	'dirname',
	'gzip',
	'ls',
	'mkdir',
	'mktemp',
	'mv',
	'python3',
	'rm',
	'sed',
	'sh',
	'sha256sum',
	'sleep',
	'tar',
	'tr'
];

function findExecutable(name, searchPath = process.env.PATH ?? '') {
	for (const dir of searchPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return null;
}

function syncToolPath(work) {
	const bin = path.join(work, '.sync-test-tools-no-jq');
	fs.mkdirSync(bin, { recursive: true });
	for (const name of REQUIRED_SYNC_TOOLS) {
		const target = findExecutable(name);
		assert.ok(target, `required sync test tool is unavailable: ${name}`);
		const link = path.join(bin, name);
		if (!fs.existsSync(link)) fs.symlinkSync(target, link);
	}
	assert.equal(findExecutable('jq', bin), null, 'isolated sync PATH excludes jq');
	return bin;
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

async function startSidecar(dest, commandsJson, allowedRoots = ['src']) {
	const port = await freePort();
	const proc = spawn(process.execPath, [SIDECAR], {
		env: {
			...process.env,
			DEV_SYNC_PORT: String(port),
			DEV_SYNC_DEST: dest,
			DEV_SYNC_TOKEN: TOKEN,
			DEV_SYNC_ALLOW_LOCAL_RUN: 'true',
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
			DEV_SYNC_CONVERGENCE_TIMEOUT_SECONDS: '2',
			DEV_SYNC_CONVERGENCE_SETTLE_SECONDS: '0',
			DEV_SYNC_CONVERGENCE_POLL_INTERVAL_SECONDS: '0',
			DEV_SYNC_CONVERGENCE_REQUEST_TIMEOUT_SECONDS: '1',
			DEV_SYNC_FANOUT_ATTEMPTS: '1',
			DEV_SYNC_FANOUT_RETRY_DELAY_SECONDS: '0',
			PATH: syncToolPath(work),
			...extraEnv
		},
		encoding: 'utf8'
	});
}

function runSyncAsync(work, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn('sh', [path.join(work, 'sync.sh')], {
			env: {
				...process.env,
				DEV_SYNC_WORK: work,
				DEV_SYNC_REPO: path.join(work, 'repo'),
				DEV_SYNC_CONVERGENCE_TIMEOUT_SECONDS: '2',
				DEV_SYNC_CONVERGENCE_SETTLE_SECONDS: '0',
				DEV_SYNC_CONVERGENCE_POLL_INTERVAL_SECONDS: '0',
				DEV_SYNC_CONVERGENCE_REQUEST_TIMEOUT_SECONDS: '1',
				DEV_SYNC_FANOUT_ATTEMPTS: '1',
				DEV_SYNC_FANOUT_RETRY_DELAY_SECONDS: '0',
				PATH: syncToolPath(work),
				...extraEnv
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (value) => (stdout += String(value)));
		child.stderr.on('data', (value) => (stderr += String(value)));
		child.once('error', reject);
		child.once('close', (status, signal) =>
			resolve({ status, signal, stdout, stderr })
		);
	});
}

async function startConvergenceStub({
	healthCodes = [200],
	staleGeneration = null
} = {}) {
	let generation = null;
	let syncService = null;
	let statusCalls = 0;
	let healthCalls = 0;
	const server = http.createServer((req, res) => {
		if (req.method === 'POST' && req.url === '/__sync') {
			generation = req.headers['x-sync-generation'] ?? null;
			syncService = req.headers['x-sync-service'] ?? null;
			const chunks = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.once('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						ok: true,
						generation,
						service: syncService,
						contentSha256: `sha256:${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`,
						changedPathCount: 0
					})
				);
			});
			return;
		}
		if (req.method === 'GET' && req.url === '/__status') {
			statusCalls += 1;
			if (req.headers['x-sync-token'] !== TOKEN) {
				res.writeHead(401).end();
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					generation: staleGeneration ?? generation,
					syncService
				})
			);
			return;
		}
		if (req.method === 'GET' && req.url === '/app-health') {
			const code = healthCodes[Math.min(healthCalls, healthCodes.length - 1)];
			healthCalls += 1;
			res.writeHead(code).end();
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	return {
		base: `http://127.0.0.1:${port}`,
		statusCalls: () => statusCalls,
		healthCalls: () => healthCalls,
		stop: () => new Promise((resolve) => server.close(resolve))
	};
}

test('sync.sh uses Python 3 stdlib and has no jq runtime dependency', () => {
	const source = fs.readFileSync(SYNC_SH, 'utf8');
	assert.doesNotMatch(source, /\bjq\b/);
	assert.match(source, /python3 -c/);
});

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
			`HEALTHURL=${sc.base}/healthz`,
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
	assert.match(r.stdout, /APPLIED services\/svc → HTTP 200/);
	assert.match(r.stdout, /SYNCED generation=.* services=1 convergence=healthy/);
	assert.match(r.stdout, /sync> idempotent=false changed=3 apply=\d+ms paths=/);

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
			`HEALTHURL=${sc.base}/healthz`,
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
			`HEALTHURL=${one.base}/healthz`,
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
			`HEALTHURL=${two.base}/healthz`,
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
	assert.match(result.stdout, /all=2 healthy \(2\/2\)/);

	const noOp = runSync(work, { DEV_SYNC_GENERATION: 'no-op-fanout-generation' });
	assert.equal(noOp.status, 0, noOp.stderr + noOp.stdout);
	const oneNoOpStatus = await (await fetch(`${one.base}/__status`, { headers })).json();
	const twoNoOpStatus = await (await fetch(`${two.base}/__status`, { headers })).json();
	assert.equal(oneNoOpStatus.generation, 'no-op-fanout-generation');
	assert.equal(twoNoOpStatus.generation, 'no-op-fanout-generation');
	assert.equal((noOp.stdout.match(/changed=0/g) ?? []).length, 2);
});

test('sync.sh replays one immutable generation after a partial fanout', async (t) => {
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

	write(path.join(work, 'repo/services/one/src/index.ts'), 'one-before');
	write(path.join(work, 'repo/services/two/src/index.ts'), 'two-before');
	for (const [service, sidecar] of [
		['one', one],
		['two', two]
	]) {
		write(
			path.join(work, `.syncenv.d/${service}`),
			[
				`SERVICE=${service}`,
				`SUBDIR=services/${service}`,
				'PATHS="src"',
				`SYNCURL=${sidecar.base}/__sync`,
				`HEALTHURL=${sidecar.base}/healthz`,
				`SYNC_TOKEN=${TOKEN}`,
				''
			].join('\n')
		);
	}
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const freeze = await fetch(`${two.base}/__freeze?phase=prepare&operationId=block-two`, {
		method: 'POST',
		headers: { 'x-sync-token': TOKEN }
	});
	assert.equal(freeze.status, 200);

	const first = runSync(work, { DEV_SYNC_GENERATION: 'recoverable-generation' });
	assert.notEqual(first.status, 0, first.stderr + first.stdout);
	assert.match(first.stdout, /APPLIED services\/one/);
	assert.match(first.stderr, /APPLY FAILED services\/two/);
	assert.doesNotMatch(first.stdout, /^SYNCED /m);
	assert.match(first.stderr, /sync transaction pending: generation=recoverable-generation/);
	assert.ok(fs.existsSync(path.join(work, '.syncdeps.dev-sync-transaction')));

	const headers = { 'x-sync-token': TOKEN };
	const splitOne = await (await fetch(`${one.base}/__status`, { headers })).json();
	const splitTwo = await (await fetch(`${two.base}/__status`, { headers })).json();
	assert.equal(splitOne.generation, 'recoverable-generation');
	assert.equal(splitTwo.generation, null);

	// Edits made after the interrupted fanout must not alter the pending payload.
	write(path.join(work, 'repo/services/one/src/index.ts'), 'one-after');
	write(path.join(work, 'repo/services/two/src/index.ts'), 'two-after');
	const abort = await fetch(`${two.base}/__freeze?phase=abort&operationId=block-two`, {
		method: 'POST',
		headers
	});
	assert.equal(abort.status, 200);

	const recovered = runSync(work);
	assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
	assert.match(recovered.stdout, /sync transaction: recovering generation=recoverable-generation/);
	assert.match(recovered.stdout, /idempotent=true/);
	assert.match(
		recovered.stdout,
		/SYNCED generation=recoverable-generation services=2 convergence=healthy/
	);
	assert.ok(!fs.existsSync(path.join(work, '.syncdeps.dev-sync-transaction')));
	assert.equal(fs.readFileSync(path.join(destOne, 'src/index.ts'), 'utf8'), 'one-before');
	assert.equal(fs.readFileSync(path.join(destTwo, 'src/index.ts'), 'utf8'), 'two-before');

	const next = runSync(work, { DEV_SYNC_GENERATION: 'next-generation' });
	assert.equal(next.status, 0, next.stderr + next.stdout);
	assert.equal(fs.readFileSync(path.join(destOne, 'src/index.ts'), 'utf8'), 'one-after');
	assert.equal(fs.readFileSync(path.join(destTwo, 'src/index.ts'), 'utf8'), 'two-after');
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
		[
			'SUBDIR=services/svc',
			'PATHS="src"',
			'SYNCURL=http://preview.invalid/__sync',
			'HEALTHURL=http://preview.invalid/healthz',
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = runSync(work, {
		CURL_LOG: curlLog,
		PATH: `${path.dirname(curl)}:${syncToolPath(work)}`
	});
	assert.notEqual(result.status, 0, result.stderr + result.stdout);
	const requests = fs.readFileSync(curlLog, 'utf8').trim().split('\n');
	assert.equal(requests.length, 1);
	assert.match(requests[0], /preview\.invalid\/__sync/);
	assert.doesNotMatch(requests[0], /__run/);
});

test('sync.sh rejects a concurrent producer before mutating a receiver', (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	t.after(() => fs.rmSync(work, { recursive: true, force: true }));
	write(path.join(work, 'repo/services/svc/src/index.ts'), 'source');
	write(
		path.join(work, '.syncenv'),
		[
			'SERVICE=svc',
			'SUBDIR=services/svc',
			'PATHS="src"',
			'SYNCURL=http://preview.invalid/__sync',
			'HEALTHURL=http://preview.invalid/healthz',
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));
	const lock = path.join(work, '.syncdeps.dev-sync-transaction.lock');
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`);

	const result = runSync(work);
	assert.notEqual(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stderr, new RegExp(`sync transaction already active \\(pid=${process.pid}\\)`));
	assert.ok(fs.existsSync(lock), 'a rejected client must not remove the active owner lock');
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
			`HEALTHURL=${sidecar.base}/healthz`,
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

test('sync.sh waits for delayed app health and requires two consecutive healthy rounds', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const stub = await startConvergenceStub({ healthCodes: [503, 302, 302] });
	t.after(async () => {
		await stub.stop();
		fs.rmSync(work, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/svc/src/index.ts'), 'source');
	write(
		path.join(work, '.syncenv'),
		[
			'SERVICE=svc',
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${stub.base}/__sync`,
			`HEALTHURL=${stub.base}/app-health`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = await runSyncAsync(work, {
		DEV_SYNC_GENERATION: 'shared-delayed-generation'
	});
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.ok(stub.healthCalls() >= 3, 'one failure plus two consecutive healthy rounds');
	assert.ok(stub.statusCalls() >= 3, 'status is re-proven in every health round');
	assert.match(result.stdout, /shared-delayed-generation/);
	assert.match(result.stdout, /healthy \(2\/2\)/);
});

test('sync.sh fails with per-service diagnostics while app health remains unhealthy', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const stub = await startConvergenceStub({ healthCodes: [503] });
	t.after(async () => {
		await stub.stop();
		fs.rmSync(work, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/svc/src/index.ts'), 'source');
	write(
		path.join(work, '.syncenv'),
		[
			'SERVICE=svc',
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${stub.base}/__sync`,
			`HEALTHURL=${stub.base}/app-health`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = await runSyncAsync(work, {
		DEV_SYNC_GENERATION: 'unhealthy-generation'
	});
	assert.notEqual(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stderr, /convergence failed: generation=unhealthy-generation/);
	assert.match(result.stderr, /svc: status=http=200 .*; health=http=503/);
});

test('sync.sh rejects a stale sidecar generation even when app health is ready', async (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sync-work-'));
	const stub = await startConvergenceStub({
		healthCodes: [204],
		staleGeneration: 'previous-generation'
	});
	t.after(async () => {
		await stub.stop();
		fs.rmSync(work, { recursive: true, force: true });
	});

	write(path.join(work, 'repo/services/svc/src/index.ts'), 'source');
	write(
		path.join(work, '.syncenv'),
		[
			'SERVICE=svc',
			'SUBDIR=services/svc',
			'PATHS="src"',
			`SYNCURL=${stub.base}/__sync`,
			`HEALTHURL=${stub.base}/app-health`,
			`SYNC_TOKEN=${TOKEN}`,
			''
		].join('\n')
	);
	fs.copyFileSync(SYNC_SH, path.join(work, 'sync.sh'));

	const result = await runSyncAsync(work, {
		DEV_SYNC_GENERATION: 'current-generation'
	});
	assert.notEqual(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stderr, /convergence failed: generation=current-generation/);
	assert.match(result.stderr, /generation='previous-generation'/);
	assert.match(result.stderr, /health=http=204/);
});
