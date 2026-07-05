import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * dev-sync-sidecar — a language-agnostic live-sync + dev-loop receiver.
 *
 * Generalizes workflow-builder's in-process Vite `/__sync` plugin so ANY
 * microservice dev image works unchanged: this runs as a SIDECAR container next
 * to the service's hot-reload dev server (vite / `uvicorn --reload` / `tsx
 * watch`), sharing an `emptyDir` mounted at the service workdir. An agent POSTs a
 * tar.gz of edited source here; we untar it into the shared workdir on the pod's
 * LOCAL disk → the dev server's inotify watcher fires → hot-reload in seconds.
 * (inotify works on emptyDir; it does NOT on the JuiceFS shared workspace, which
 * is why edits travel as an HTTP push, never a network-FS mount — same rationale
 * as the P2 Vite plugin.)
 *
 * It also hosts the read-back + dev-loop endpoints the Vite plugin only exposed
 * for the BFF, so sidecar-mode services reach parity:
 *   - GET  /__export : pull the current workdir source as a tar.gz (version capture)
 *   - GET  /__status : last-sync + last-run diagnostics
 *   - POST /__run    : run an ALLOWLISTED named command (deps install / contract
 *                      tests) in the workdir — the allowlist is DEV_SYNC_COMMANDS_JSON
 *                      (SEA populates it from the dev-preview registry). No new trust
 *                      boundary: /__sync already delivers code the dev server executes,
 *                      so an allowlisted /__run adds none.
 *
 * Env:
 *   DEV_SYNC_PORT          (default 8001)   — listen port
 *   DEV_SYNC_DEST          (default /app)   — untar destination + /__export + /__run cwd
 *   DEV_SYNC_TOKEN         (optional)       — if set, require matching `x-sync-token`
 *   DEV_SYNC_COMMANDS_JSON (optional)       — {"<name>":"<shell command>"} allowlist
 *   DEV_SYNC_RUN_TIMEOUT_MS (default 900000) — hard kill for a /__run child
 *
 * Endpoints: POST /__sync (tar.gz body) · GET /__export?paths=… · GET /__status ·
 *            POST /__run?cmd=<name> · GET /healthz
 */

const PORT = Number(process.env.DEV_SYNC_PORT || 8001);
const DEST = process.env.DEV_SYNC_DEST || '/app';
const TOKEN = process.env.DEV_SYNC_TOKEN || '';
const MAX = 256 * 1024 * 1024; // 256 MiB ceiling on a /__sync upload
const RUN_TIMEOUT_MS = Number(process.env.DEV_SYNC_RUN_TIMEOUT_MS || 900000); // 15 min
const RUN_OUTPUT_CAP = 64 * 1024; // cap the captured /__run output at 64 KiB

/**
 * The /__run allowlist. Parsed ONCE at boot — SEA stamps it into the pod's env
 * from the registry (`deps` = depsCommand, plus each testCommands entry under its
 * own name), and it never changes for the pod's lifetime. A malformed value is
 * logged and treated as an empty allowlist (fail-closed: /__run then 404s).
 */
function loadCommands() {
	const raw = (process.env.DEV_SYNC_COMMANDS_JSON || '').trim();
	if (!raw) return {};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		console.error(`[dev-sync-sidecar] invalid DEV_SYNC_COMMANDS_JSON (ignored): ${e.message}`);
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[dev-sync-sidecar] DEV_SYNC_COMMANDS_JSON must be a JSON object (ignored)');
		return {};
	}
	const out = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v === 'string' && v.trim()) out[k] = v;
	}
	return out;
}

const COMMANDS = loadCommands();

// /__status diagnostics.
let lastSyncAt = null; // ISO string of the last successful /__sync
let lastSyncBytes = 0; // byte size of that upload
let lastRun = null; // { name, exitCode, startedAt, finishedAt, durationMs }

function reply(res, code, body) {
	try {
		res.statusCode = code;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	} catch {
		/* socket already gone */
	}
}

function unauthorized(req) {
	return TOKEN && req.headers['x-sync-token'] !== TOKEN;
}

/** Sanitize `?paths=` into safe relative paths (no absolute, no `..` escape). */
function parsePaths(rawUrl) {
	const url = new URL(rawUrl || '/', 'http://localhost');
	return (url.searchParams.get('paths') ?? 'src')
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p && !p.startsWith('/') && !p.split('/').includes('..'));
}

// ----- POST /__sync : untar an uploaded tar.gz into the shared workdir -----
function handleSync(req, res) {
	if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
	if (unauthorized(req)) return reply(res, 401, { ok: false, error: 'unauthorized' });

	// Buffer the whole body first (do NOT pipe straight into tar.stdin — a tar
	// that dies on a partial gzip raises an unhandled EPIPE; swallow request
	// errors so a dropped upload can never crash the sidecar). Same shape as the
	// proven Vite plugin.
	const chunks = [];
	let total = 0;
	let aborted = false;
	req.on('error', () => {
		aborted = true;
	});
	req.on('aborted', () => {
		aborted = true;
	});
	req.on('data', (c) => {
		total += c.length;
		if (total > MAX) {
			aborted = true;
			req.destroy();
			return;
		}
		chunks.push(c);
	});
	req.on('end', () => {
		if (aborted) return reply(res, 400, { ok: false, error: 'aborted or too large' });
		const tmp = path.join(os.tmpdir(), `dev-sync-${process.pid}-${total}.tgz`);
		let buf;
		try {
			buf = Buffer.concat(chunks);
			fs.writeFileSync(tmp, buf);
			fs.mkdirSync(DEST, { recursive: true });
		} catch (e) {
			return reply(res, 500, { ok: false, error: `buffer/write: ${e.message}` });
		}
		const cleanup = () => {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		};
		// busybox tar (alpine): `-o` = don't restore user:group; busybox strips a
		// leading '/' itself. The producer archives relative paths.
		const tar = spawn('tar', ['-xzf', tmp, '-C', DEST, '-o'], {
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let errout = '';
		tar.stderr.on('data', (d) => (errout += String(d)));
		tar.on('error', (e) => {
			cleanup();
			reply(res, 500, { ok: false, error: `tar spawn: ${e.message}` });
		});
		tar.on('close', (code) => {
			cleanup();
			if (code === 0) {
				lastSyncAt = new Date().toISOString();
				lastSyncBytes = buf.length;
				console.log(`[dev-sync-sidecar] applied sync (${buf.length}B) → ${DEST}`);
				reply(res, 200, { ok: true, bytes: buf.length, dest: DEST });
			} else {
				reply(res, 500, { ok: false, error: errout.slice(0, 500) || `tar exit ${code}` });
			}
		});
	});
}

// ----- GET /__export?paths=… : stream a tar.gz of the live workdir source -----
// Read-back counterpart to /__sync, ported from the BFF's Vite `/__export` plugin
// so sidecar services reach version-capture parity (captureDevPreviewSource guards
// on the gzip magic bytes, so the wire format must match: `tar -czf -` of the
// listed paths, busybox-relative). We ADDITIONALLY drop non-existent paths before
// tarring — sidecar services carry language-family DEFAULT syncPaths (a superset),
// and busybox tar would exit non-zero on a missing member.
function handleExport(req, res) {
	if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
	if (unauthorized(req)) return reply(res, 401, { ok: false, error: 'unauthorized' });
	const requested = parsePaths(req.url);
	if (requested.length === 0) return reply(res, 400, { ok: false, error: 'no valid paths' });
	const paths = requested.filter((p) => fs.existsSync(path.join(DEST, p)));
	if (paths.length === 0) return reply(res, 400, { ok: false, error: 'no existing paths' });
	res.statusCode = 200;
	res.setHeader('content-type', 'application/gzip');
	// `-czf -` to stdout; relative paths under DEST (busybox + GNU compatible).
	const tar = spawn('tar', ['-czf', '-', '-C', DEST, ...paths], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let errout = '';
	tar.stderr.on('data', (d) => (errout += String(d)));
	tar.stdout.pipe(res);
	tar.on('error', () => {
		try {
			res.destroy();
		} catch {
			/* socket gone */
		}
	});
	tar.on('close', (code) => {
		if (code === 0) {
			console.log(`[dev-sync-sidecar] exported ${paths.join(',')} (tar.gz)`);
		} else {
			console.warn(`[dev-sync-sidecar] export tar exit ${code}: ${errout.slice(0, 200)}`);
		}
		// stdout pipe already ended `res`; nothing else to do.
	});
	req.on('aborted', () => {
		try {
			tar.kill();
		} catch {
			/* already gone */
		}
	});
}

// ----- GET /__status : last-sync + last-run diagnostics -----
function handleStatus(req, res) {
	if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
	if (unauthorized(req)) return reply(res, 401, { ok: false, error: 'unauthorized' });
	return reply(res, 200, {
		ok: true,
		service: 'dev-sync-sidecar',
		dest: DEST,
		lastSyncAt,
		lastSyncBytes,
		lastRun,
		commands: Object.keys(COMMANDS).sort()
	});
}

// ----- POST /__run?cmd=<name> : run an ALLOWLISTED command in the workdir -----
// The ONLY commands that can run are the named entries in DEV_SYNC_COMMANDS_JSON
// (never an arbitrary command string from the request). Output is capped and the
// exit code is returned in the body; HTTP 200 means the command ran (check `ok`),
// non-200 means it could not be dispatched (auth / unknown name / spawn failure).
function handleRun(req, res) {
	if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
	if (unauthorized(req)) return reply(res, 401, { ok: false, error: 'unauthorized' });
	// Drain+ignore any request body (cmd comes from the query only).
	req.resume();
	const name = (new URL(req.url || '/', 'http://localhost').searchParams.get('cmd') || '').trim();
	if (!name) return reply(res, 400, { ok: false, error: 'missing cmd' });
	const command = COMMANDS[name];
	if (!command) {
		return reply(res, 404, {
			ok: false,
			error: `unknown command "${name}"`,
			allowed: Object.keys(COMMANDS).sort()
		});
	}

	const startedAt = new Date().toISOString();
	const t0 = Date.now();
	let child;
	try {
		child = spawn('sh', ['-c', command], { cwd: DEST, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		return reply(res, 500, { ok: false, cmd: name, error: `spawn: ${e.message}` });
	}
	let output = '';
	let truncated = false;
	const capture = (d) => {
		if (truncated) return;
		output += String(d);
		if (output.length > RUN_OUTPUT_CAP) {
			output = output.slice(0, RUN_OUTPUT_CAP);
			truncated = true;
		}
	};
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);

	let done = false;
	const timer = setTimeout(() => {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already gone */
		}
	}, RUN_TIMEOUT_MS);

	const finish = (exitCode, extra) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		const durationMs = Date.now() - t0;
		lastRun = { name, exitCode, startedAt, finishedAt: new Date().toISOString(), durationMs };
		console.log(`[dev-sync-sidecar] run "${name}" exit=${exitCode} (${durationMs}ms)`);
		reply(res, 200, {
			ok: exitCode === 0,
			cmd: name,
			exitCode,
			durationMs,
			truncated,
			output,
			...(extra || {})
		});
	};
	child.on('error', (e) => finish(-1, { error: `spawn: ${e.message}` }));
	child.on('close', (code, signal) =>
		finish(code === null ? -1 : code, signal ? { signal } : undefined)
	);
}

const server = http.createServer((req, res) => {
	const url = (req.url || '').split('?')[0];
	if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
		return reply(res, 200, { ok: true, service: 'dev-sync-sidecar', dest: DEST });
	}
	switch (url) {
		case '/__sync':
			return handleSync(req, res);
		case '/__export':
			return handleExport(req, res);
		case '/__status':
			return handleStatus(req, res);
		case '/__run':
			return handleRun(req, res);
		default:
			return reply(res, 404, { ok: false, error: 'not found' });
	}
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(
		`[dev-sync-sidecar] listening on :${PORT} → ${DEST}` +
			(Object.keys(COMMANDS).length
				? ` (commands: ${Object.keys(COMMANDS).sort().join(', ')})`
				: ' (no /__run commands)')
	);
});
