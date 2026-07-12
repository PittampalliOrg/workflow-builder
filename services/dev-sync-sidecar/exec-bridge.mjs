import { spawn } from 'node:child_process';
import http from 'node:http';

/**
 * dev-sync exec bridge (#40) — the APP-container half of `/__run`.
 *
 * The dev-sync-sidecar is a node-only image, so a `/__run` executed THERE runs
 * in the wrong runtime (live repro: orchestrator `cmd=contract` → exit 127
 * `sh: python: not found`). This ~100-line stdlib-only server runs INSIDE the
 * app container (started by each `skaffold/dev/<svc>/Dockerfile.dev` entrypoint
 * alongside the dev server), so allowlisted deps/test commands execute with the
 * app's real toolchain (python/pytest, pnpm/node_modules) and cwd = workdir.
 *
 * The sidecar's `/__run` proxies here over pod-localhost and fails closed when
 * the bridge is unavailable. This keeps the receiver credential out of the
 * process that executes synchronized code.
 *
 * SECURITY: binds 127.0.0.1 ONLY (pod-local; never reachable from outside the
 * pod), requires a purpose-specific bridge token, and runs NOTHING but the named
 * entries of its own DEV_SYNC_COMMANDS_JSON (fail-closed: absent/malformed env
 * → every /__exec 404s). Same trust story as the sidecar's /__run: /__sync
 * already delivers code the dev server executes.
 *
 * Env (stamped into the app container by sandbox-execution-api in sidecar mode):
 *   DEV_SYNC_EXEC_PORT      (default 8002)   — 127.0.0.1 listen port
 *   DEV_SYNC_DEST           (default /app)   — command cwd (the synced workdir)
 *   DEV_SYNC_BRIDGE_TOKEN   (required)       — require matching `x-sync-token`
 *   DEV_SYNC_COMMANDS_JSON  (optional)       — {"<name>":"<shell command>"} allowlist
 *   DEV_SYNC_RUN_TIMEOUT_MS (default 900000) — hard kill for a child
 *
 * Endpoints: POST /__exec?cmd=<name> · GET /healthz
 * Response contract mirrors the sidecar /__run:
 *   200 {ok, cmd, exitCode, durationMs, truncated, output}  — the command RAN
 *   4xx/5xx {ok:false, error, ...}                          — it did NOT run
 * (`exec_bridge.py` is the python-image twin — keep the contracts in lockstep.)
 */

const PORT = Number(process.env.DEV_SYNC_EXEC_PORT || 8002);
const DEST = process.env.DEV_SYNC_DEST || '/app';
const TOKEN = process.env.DEV_SYNC_BRIDGE_TOKEN || '';
const RUN_TIMEOUT_MS = Number(process.env.DEV_SYNC_RUN_TIMEOUT_MS || 900000);
const RUN_OUTPUT_CAP = 64 * 1024;

function loadCommands() {
	const raw = (process.env.DEV_SYNC_COMMANDS_JSON || '').trim();
	if (!raw) return {};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		console.error(`[dev-sync-exec-bridge] invalid DEV_SYNC_COMMANDS_JSON (ignored): ${e.message}`);
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.error('[dev-sync-exec-bridge] DEV_SYNC_COMMANDS_JSON must be a JSON object (ignored)');
		return {};
	}
	const out = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v === 'string' && v.trim()) out[k] = v;
	}
	return out;
}

const COMMANDS = loadCommands();

function reply(res, code, body) {
	try {
		res.statusCode = code;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	} catch {
		/* socket already gone */
	}
}

function handleExec(req, res) {
	if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
	if (!/^[a-f0-9]{64}$/.test(TOKEN))
		return reply(res, 503, { ok: false, error: 'bridge token is not configured' });
	if (req.headers['x-sync-token'] !== TOKEN)
		return reply(res, 401, { ok: false, error: 'unauthorized' });
	req.resume(); // drain+ignore any body (cmd comes from the query only)
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
		console.log(`[dev-sync-exec-bridge] run "${name}" exit=${exitCode} (${durationMs}ms)`);
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
		return reply(res, 200, {
			ok: true,
			service: 'dev-sync-exec-bridge',
			dest: DEST,
			commands: Object.keys(COMMANDS).sort()
		});
	}
	if (url === '/__exec') return handleExec(req, res);
	return reply(res, 404, { ok: false, error: 'not found' });
});

// The bridge runs as a BACKGROUND child of the dev-image entrypoint; a listen
// failure (port taken) must never take the dev server down — log and exit.
server.on('error', (e) => {
	console.error(`[dev-sync-exec-bridge] listen failed: ${e.message} — exec bridge disabled`);
	process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
	console.log(
		`[dev-sync-exec-bridge] listening on 127.0.0.1:${PORT} (cwd ${DEST})` +
			(Object.keys(COMMANDS).length
				? ` commands: ${Object.keys(COMMANDS).sort().join(', ')}`
				: ' (no commands — /__exec fails closed)')
	);
});
