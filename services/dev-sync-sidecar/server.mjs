import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
	applyAtomicDevSync,
	DevSyncTransactionError,
	parseAllowedSyncRoots,
	parseDeclaredSyncRoots
} from './atomic-sync.mjs';

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
 *                      tests) — the allowlist is DEV_SYNC_COMMANDS_JSON (SEA
 *                      populates it from the dev-preview registry). No new trust
 *                      boundary: /__sync already delivers code the dev server
 *                      executes, so an allowlisted /__run adds none.
 *
 * /__run executes in the APP container (#40): this sidecar image
 * is node-only, so running e.g. the orchestrator's pytest HERE exits 127. The
 * dev images host a tiny exec bridge (exec-bridge.mjs / exec_bridge.py) on
 * 127.0.0.1:8002 INSIDE the app container; /__run proxies the command NAME to
 * it (containers in a pod share localhost). Bridge failures fail closed by
 * default. A legacy-only opt-in retains the old local runner for images that
 * predate the bridge.
 *
 * Route-add restart signal (#41): a sync that ADDS files under `src/routes/`
 * while the dev server is mid-restart lands on disk but the route never
 * registers (the replaced watcher misses the add event). After applying such a
 * sync we write RESTART_SIGNAL_FILE into the workdir; the BFF's Vite plugin
 * polls for it (WFB_DEV_SYNC_RESTART_SIGNAL), consumes it, and does a full
 * `server.restart()`. Mirrors src/lib/server/dev-sync/added-routes.ts.
 *
 * Env:
 *   DEV_SYNC_PORT          (default 8001)   — listen port
 *   DEV_SYNC_DEST          (default /app)   — untar destination + /__export + /__run cwd
 *   DEV_SYNC_TOKEN         (required)       — receiver leaf accepted by `x-sync-token`
 *   DEV_SYNC_AGENT_TOKEN_SHA256 (required) — hash of the agent-action leaf
 *   DEV_SYNC_COMMANDS_JSON (optional)       — {"<name>":"<shell command>"} allowlist
 *   DEV_SYNC_RUN_TIMEOUT_MS (default 900000) — hard kill for a /__run child
 *   DEV_SYNC_BRIDGE_TOKEN   (required for bridge) — pod-local exec capability
 *   DEV_SYNC_EXEC_PORT     (default 8002)   — app-container exec bridge port
 *   DEV_SYNC_EXEC_HOST     (default 127.0.0.1) — bridge host (tests only)
 *   DEV_SYNC_ALLOW_LOCAL_RUN (default false) — legacy-only sidecar fallback
 *
 * Endpoints: POST /__sync (tar.gz body) · GET /__export?paths=… · GET /__status ·
 *            POST /__run?cmd=<name> · GET /healthz
 */

const PORT = Number(process.env.DEV_SYNC_PORT || 8001);
const DEST = process.env.DEV_SYNC_DEST || '/app';
const TOKEN = process.env.DEV_SYNC_TOKEN || '';
const AGENT_TOKEN_SHA256 = process.env.DEV_SYNC_AGENT_TOKEN_SHA256 || '';
const BRIDGE_TOKEN = process.env.DEV_SYNC_BRIDGE_TOKEN || '';
const MAX = 64 * 1024 * 1024; // keep buffering + concat below the 256 MiB limit
const RUN_TIMEOUT_MS = Number(process.env.DEV_SYNC_RUN_TIMEOUT_MS || 900000); // 15 min
const RUN_OUTPUT_CAP = 64 * 1024; // cap the captured /__run output at 64 KiB
const EXEC_PORT = Number(process.env.DEV_SYNC_EXEC_PORT || 8002);
const EXEC_HOST = process.env.DEV_SYNC_EXEC_HOST || '127.0.0.1';
const ALLOW_LOCAL_RUN = /^(?:1|true|yes)$/i.test(process.env.DEV_SYNC_ALLOW_LOCAL_RUN || '');
const CONFIGURED_SERVICE = (process.env.DEV_SYNC_SERVICE || '').trim();
let ALLOWED_ROOTS = [];
let ALLOWED_ROOTS_ERROR = null;
try {
	ALLOWED_ROOTS = parseAllowedSyncRoots(process.env.DEV_SYNC_ALLOWED_ROOTS_JSON || '');
} catch (error) {
	ALLOWED_ROOTS_ERROR = error.message;
	console.error(`[dev-sync-sidecar] invalid allowed-root contract: ${error.message}`);
}
// Shared with src/lib/server/dev-sync/added-routes.ts (the Vite plugin's poll
// target) — keep the two literals in lockstep.
const RESTART_SIGNAL_FILE = '.dev-sync-restart-request.json';
const ROUTES_PREFIX = 'src/routes/';
const SYNC_STATE_FILE = '.dev-sync-state.json';
const MAX_REPORTED_CHANGED_PATHS = 50;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

function readHeader(req, name) {
	const value = req.headers[name];
	return (Array.isArray(value) ? value[0] : value || '').trim();
}

function tokenEquals(left, right) {
	if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function acceptedSyncToken(presented) {
	return (
		tokenEquals(presented, TOKEN) ||
		tokenEquals(createHash('sha256').update(presented).digest('hex'), AGENT_TOKEN_SHA256)
	);
}

function loadSyncState() {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(DEST, SYNC_STATE_FILE), 'utf8'));
		return {
			generation:
				typeof value.generation === 'string' && GENERATION_PATTERN.test(value.generation)
					? value.generation
					: null,
			service:
				typeof value.service === 'string' && SERVICE_PATTERN.test(value.service)
					? value.service
					: null,
			lastSyncAt: typeof value.lastSyncAt === 'string' ? value.lastSyncAt : null,
			lastSyncBytes:
				typeof value.lastSyncBytes === 'number' && value.lastSyncBytes >= 0
					? value.lastSyncBytes
					: 0,
			contentSha256:
				typeof value.contentSha256 === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.contentSha256)
					? value.contentSha256
					: null
		};
	} catch {
		return {
			generation: null,
			service: null,
			lastSyncAt: null,
			lastSyncBytes: 0,
			contentSha256: null
		};
	}
}

function persistSyncState(state) {
	fs.mkdirSync(DEST, { recursive: true });
	const target = path.join(DEST, SYNC_STATE_FILE);
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state));
		if (
			process.env.NODE_ENV === 'test' &&
			(process.env.DEV_SYNC_TEST_FAIL_STATE_WRITE === 'true' ||
				process.env.DEV_SYNC_TEST_FAIL_STATE_WRITE_GENERATION === state.generation)
		) {
			throw new Error('injected state write failure');
		}
		fs.renameSync(tmp, target);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

// /__status diagnostics. State survives sidecar process restarts so a capture
// can still prove which fanout generation produced the live workdir.
const initialSyncState = loadSyncState();
let currentGeneration = initialSyncState.generation;
let currentSyncService = initialSyncState.service || CONFIGURED_SERVICE || null;
let lastSyncAt = initialSyncState.lastSyncAt; // ISO string of the last successful /__sync
let lastSyncBytes = initialSyncState.lastSyncBytes; // byte size of that upload
let currentContentSha256 = initialSyncState.contentSha256;
let lastSyncTimingsMs = null;
let lastExportSha256 = null;
let lastRun = null; // { name, exitCode, startedAt, finishedAt, durationMs, executedIn }
let sourceOperation = null;

function beginSourceOperation(operation) {
	if (sourceOperation) return false;
	sourceOperation = operation;
	return true;
}

function endSourceOperation(operation) {
	if (sourceOperation === operation) sourceOperation = null;
}

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
	return !acceptedSyncToken(readHeader(req, 'x-sync-token'));
}

/**
 * #41: entries under src/routes/ that do NOT yet exist in DEST — the files
 * whose creation needs a full dev-server restart to register (an add during
 * the server's restart window is otherwise silently dropped by the watcher).
 * Inline twin of src/lib/server/dev-sync/added-routes.ts (this file is a
 * zero-dependency plain-node script and cannot import the TS helper).
 */
function detectAddedRouteFiles(entries) {
	const added = [];
	const seen = new Set();
	for (const raw of entries) {
		const entry = raw.replace(/^\.\//, '');
		if (!entry.startsWith(ROUTES_PREFIX) || entry.endsWith('/') || seen.has(entry)) continue;
		seen.add(entry);
		if (!fs.existsSync(path.join(DEST, entry))) added.push(entry);
	}
	return added;
}

/** Require `?paths=` to declare the complete catalog-owned replacement set. */
function parsePaths(rawUrl) {
	const url = new URL(rawUrl || '/', 'http://localhost');
	const raw = url.searchParams.get('paths');
	if (raw === null) return [...ALLOWED_ROOTS];
	return parseDeclaredSyncRoots(
		JSON.stringify(raw.split(',').map((entry) => entry.trim())),
		ALLOWED_ROOTS
	);
}

// ----- POST /__sync : untar an uploaded tar.gz into the shared workdir -----
function handleSync(req, res) {
	if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
	if (unauthorized(req)) return reply(res, 401, { ok: false, error: 'unauthorized' });
	if (ALLOWED_ROOTS_ERROR) {
		req.resume();
		return reply(res, 503, {
			ok: false,
			error: `receiver allowed-root contract invalid: ${ALLOWED_ROOTS_ERROR}`
		});
	}
	const generation = readHeader(req, 'x-sync-generation');
	if (!GENERATION_PATTERN.test(generation)) {
		req.resume();
		return reply(res, 400, {
			ok: false,
			error: 'valid x-sync-generation required'
		});
	}
	const syncService = readHeader(req, 'x-sync-service') || CONFIGURED_SERVICE;
	if (!SERVICE_PATTERN.test(syncService)) {
		req.resume();
		return reply(res, 400, {
			ok: false,
			error: 'valid x-sync-service required'
		});
	}
	if (CONFIGURED_SERVICE && syncService !== CONFIGURED_SERVICE) {
		req.resume();
		return reply(res, 409, {
			ok: false,
			error: `x-sync-service ${syncService} does not match ${CONFIGURED_SERVICE}`
		});
	}
	let declaredRoots;
	try {
		declaredRoots = parseDeclaredSyncRoots(readHeader(req, 'x-sync-roots'), ALLOWED_ROOTS);
	} catch (error) {
		req.resume();
		return reply(res, 400, { ok: false, error: error.message });
	}
	if (!beginSourceOperation('sync')) {
		req.resume();
		return reply(res, 409, {
			ok: false,
			error: `source ${sourceOperation} in progress`
		});
	}
	let bodyComplete = false;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		endSourceOperation('sync');
	};

	// Buffer the whole body first (do NOT pipe straight into tar.stdin — a tar
	// that dies on a partial gzip raises an unhandled EPIPE; swallow request
	// errors so a dropped upload can never crash the sidecar). Same shape as the
	// proven Vite plugin.
	const chunks = [];
	let total = 0;
	let aborted = false;
	req.on('error', () => {
		aborted = true;
		if (!bodyComplete) release();
	});
	req.on('aborted', () => {
		aborted = true;
		if (!bodyComplete) release();
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
		bodyComplete = true;
		if (aborted) {
			release();
			return reply(res, 400, { ok: false, error: 'aborted or too large' });
		}
		const tmp = path.join(os.tmpdir(), `dev-sync-${process.pid}-${randomUUID()}.tgz`);
		let buf;
		try {
			buf = Buffer.concat(chunks);
			fs.writeFileSync(tmp, buf);
			fs.mkdirSync(DEST, { recursive: true });
		} catch (e) {
			release();
			return reply(res, 500, {
				ok: false,
				error: `buffer/write: ${e.message}`
			});
		}
		const cleanup = () => {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		};
		const contentSha256 = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
		if (currentGeneration === generation) {
			cleanup();
			release();
			if (currentContentSha256 === contentSha256) {
				return reply(res, 200, {
					ok: true,
					idempotent: true,
					bytes: buf.length,
					generation,
					service: syncService,
					contentSha256
				});
			}
			return reply(res, 409, {
				ok: false,
				error: 'sync generation already committed with different content'
			});
		}

		const syncedAt = new Date().toISOString();
		const nextState = {
			generation,
			service: syncService,
			lastSyncAt: syncedAt,
			lastSyncBytes: buf.length,
			contentSha256
		};
		let addedRoutes = [];
		void applyAtomicDevSync({
			root: DEST,
			archivePath: tmp,
			declaredRoots,
			nextState,
			stateFile: SYNC_STATE_FILE,
			persistState: persistSyncState,
			beforeCommit: (entries) => {
				addedRoutes = detectAddedRouteFiles(entries);
			}
		})
			.then(({ changedRoots, changedPaths, timingsMs }) => {
				cleanup();
				currentGeneration = generation;
				currentSyncService = syncService;
				lastSyncAt = syncedAt;
				lastSyncBytes = buf.length;
				currentContentSha256 = contentSha256;
				lastSyncTimingsMs = timingsMs;
				let restartSignaled = false;
				if (addedRoutes.length) {
					try {
						fs.writeFileSync(
							path.join(DEST, RESTART_SIGNAL_FILE),
							JSON.stringify({
								requestedAt: new Date().toISOString(),
								addedRoutes: addedRoutes.slice(0, 50)
							})
						);
						restartSignaled = true;
					} catch (error) {
						console.warn(`[dev-sync-sidecar] restart signal write failed: ${error.message}`);
					}
				}
				console.log(
					`[dev-sync-sidecar] committed ${changedRoots.join(',') || '<no source changes>'} (${buf.length}B, ${timingsMs.total}ms apply) -> ${DEST}`
				);
				release();
				reply(res, 200, {
					ok: true,
					bytes: buf.length,
					dest: DEST,
					generation,
					service: syncService,
					contentSha256,
					changedRoots,
					changedPathCount: changedPaths.length,
					changedPaths: changedPaths.slice(0, MAX_REPORTED_CHANGED_PATHS),
					changedPathsTruncated: changedPaths.length > MAX_REPORTED_CHANGED_PATHS,
					timingsMs,
					...(addedRoutes.length ? { routesAdded: addedRoutes.slice(0, 50), restartSignaled } : {})
				});
			})
			.catch((error) => {
				cleanup();
				const restored = loadSyncState();
				currentGeneration = restored.generation;
				currentSyncService = restored.service || CONFIGURED_SERVICE || null;
				lastSyncAt = restored.lastSyncAt;
				lastSyncBytes = restored.lastSyncBytes;
				currentContentSha256 = restored.contentSha256;
				release();
				reply(
					res,
					error instanceof DevSyncTransactionError && error.phase === 'commit' ? 500 : 400,
					{
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					}
				);
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
	if (ALLOWED_ROOTS_ERROR) {
		return reply(res, 503, {
			ok: false,
			error: `receiver allowed-root contract invalid: ${ALLOWED_ROOTS_ERROR}`
		});
	}
	let requested;
	try {
		requested = parsePaths(req.url);
	} catch (error) {
		return reply(res, 400, { ok: false, error: error.message });
	}
	const paths = requested.filter((p) => fs.existsSync(path.join(DEST, p)));
	if (paths.length === 0) return reply(res, 400, { ok: false, error: 'no existing paths' });
	if (!beginSourceOperation('export')) {
		return reply(res, 409, {
			ok: false,
			error: `source ${sourceOperation} in progress`
		});
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		endSourceOperation('export');
	};
	const tmp = path.join(os.tmpdir(), `dev-export-${process.pid}-${randomUUID()}.tgz`);
	// Materialize first: response metadata must digest the exact gzip bytes sent.
	const tar = spawn('tar', ['-czf', tmp, '-C', DEST, ...paths], {
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let spawnFailed = false;
	let errout = '';
	tar.stderr.on('data', (d) => (errout += String(d)));
	tar.on('error', () => {
		spawnFailed = true;
		release();
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		reply(res, 500, { ok: false, error: 'export tar spawn failed' });
	});
	tar.on('close', (code) => {
		if (spawnFailed) return;
		release();
		if (code !== 0) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				/* ignore */
			}
			console.warn(`[dev-sync-sidecar] export tar exit ${code}: ${errout.slice(0, 200)}`);
			return reply(res, 500, {
				ok: false,
				error: errout.slice(0, 500) || `tar exit ${code}`
			});
		}
		try {
			const bytes = fs.readFileSync(tmp);
			const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
			lastExportSha256 = contentSha256;
			res.statusCode = 200;
			res.setHeader('content-type', 'application/gzip');
			res.setHeader('x-content-sha256', contentSha256);
			res.setHeader('x-sync-roots', JSON.stringify(ALLOWED_ROOTS));
			if (currentGeneration) res.setHeader('x-sync-generation', currentGeneration);
			if (currentSyncService) res.setHeader('x-sync-service', currentSyncService);
			res.end(bytes);
			console.log(
				`[dev-sync-sidecar] exported ${paths.join(',')} (${bytes.length}B ${contentSha256})`
			);
		} catch (e) {
			reply(res, 500, { ok: false, error: `export read: ${e.message}` });
		} finally {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				/* ignore */
			}
		}
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
		lastSyncTimingsMs,
		contentSha256: currentContentSha256,
		allowedRoots: ALLOWED_ROOTS,
		allowedRootsError: ALLOWED_ROOTS_ERROR,
		generation: currentGeneration,
		syncService: currentSyncService,
		lastExportSha256,
		lastRun,
		commands: Object.keys(COMMANDS).sort()
	});
}

// ----- POST /__run?cmd=<name> : run an ALLOWLISTED command in the workdir -----
// The ONLY commands that can run are the named entries in DEV_SYNC_COMMANDS_JSON
// (never an arbitrary command string from the request). Output is capped and the
// exit code is returned in the body; HTTP 200 means the command ran (check `ok`),
// non-200 means it could not be dispatched (auth / unknown name / spawn failure).
//
// #40: the command runs in the APP container when its exec bridge is present
// (executedIn:"app") — only the NAME crosses the pod-localhost hop, and the
// bridge enforces its own allowlist copy. Any bridge failure is fail-closed for
// preview-native pods. DEV_SYNC_ALLOW_LOCAL_RUN exists only for deliberately
// configured legacy images that predate the bridge. A 200 that then goes bad
// mid-body is reported as an error because the command may already have run.
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
	if (!beginSourceOperation('run')) {
		return reply(res, 409, {
			ok: false,
			error: `source ${sourceOperation} in progress`
		});
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		endSourceOperation('run');
	};

	tryBridgeRun(name, (bridge) => {
		if (bridge.ran) {
			const body = bridge.body || {};
			const exitCode = typeof body.exitCode === 'number' ? body.exitCode : -1;
			lastRun = {
				name,
				exitCode,
				startedAt: bridge.startedAt,
				finishedAt: new Date().toISOString(),
				durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
				executedIn: 'app'
			};
			console.log(`[dev-sync-sidecar] run "${name}" via app exec bridge exit=${exitCode}`);
			release();
			return reply(res, 200, { ...body, cmd: name, executedIn: 'app' });
		}
		if (bridge.fatal) {
			// The bridge MAY have run the command (response broke after it was
			// accepted) — do not double-execute; report the broken bridge.
			release();
			return reply(res, 200, {
				ok: false,
				cmd: name,
				exitCode: null,
				error: `exec bridge failed mid-run: ${bridge.reason}`,
				executedIn: 'app'
			});
		}
		if (ALLOW_LOCAL_RUN) return runLocal(name, command, res, bridge.reason, release);
		release();
		return reply(res, 503, {
			ok: false,
			cmd: name,
			exitCode: null,
			error: `exec bridge unavailable: ${bridge.reason}`,
			executedIn: null
		});
	});
}

/**
 * Ask the app container's exec bridge (127.0.0.1:EXEC_PORT) to run `name`.
 * Callback receives exactly one of:
 *   {ran:true, body, startedAt}    — bridge returned 200 (the command RAN there)
 *   {ran:false, reason}            — bridge did NOT run it
 *   {ran:false, fatal:true, reason} — ambiguous mid-run failure (do NOT fall back)
 */
function tryBridgeRun(name, cb) {
	const startedAt = new Date().toISOString();
	let settled = false;
	const settle = (result) => {
		if (settled) return;
		settled = true;
		cb(result);
	};
	const preq = http.request(
		{
			host: EXEC_HOST,
			port: EXEC_PORT,
			path: `/__exec?cmd=${encodeURIComponent(name)}`,
			method: 'POST',
			headers: BRIDGE_TOKEN ? { 'x-sync-token': BRIDGE_TOKEN } : {}
		},
		(pres) => {
			let body = '';
			pres.on('data', (d) => {
				body += String(d);
				if (body.length > RUN_OUTPUT_CAP + 64 * 1024) pres.destroy();
			});
			pres.on('error', () => {
				// Headers arrived → the bridge accepted the request; ambiguous.
				settle(
					pres.statusCode === 200
						? { ran: false, fatal: true, reason: 'response stream error' }
						: {
								ran: false,
								reason: `bridge HTTP ${pres.statusCode} (broken body)`
							}
				);
			});
			pres.on('end', () => {
				if (pres.statusCode !== 200) {
					// 401/404/405/500 → the bridge REFUSED before running anything.
					return settle({
						ran: false,
						reason: `bridge HTTP ${pres.statusCode}`
					});
				}
				try {
					settle({ ran: true, body: JSON.parse(body), startedAt });
				} catch {
					settle({
						ran: false,
						fatal: true,
						reason: 'malformed bridge response'
					});
				}
			});
		}
	);
	// Localhost connect is instant; anything slower means no bridge listening.
	const connectTimer = setTimeout(() => {
		settle({ ran: false, reason: 'bridge connect timeout' });
		preq.destroy();
	}, 2000);
	preq.on('socket', (socket) => {
		socket.once('connect', () => clearTimeout(connectTimer));
	});
	preq.on('error', (e) => {
		clearTimeout(connectTimer);
		// ECONNREFUSED/EHOSTUNREACH before a response → the command never ran.
		settle({
			ran: false,
			reason: `bridge unreachable (${e.code || e.message})`
		});
	});
	preq.end();
}

// Legacy-only local execution. Preview-native pods never enable this because
// the sidecar process holds the receiver token in its environment.
function runLocal(name, command, res, bridgeNote, release) {
	const startedAt = new Date().toISOString();
	const t0 = Date.now();
	let child;
	try {
		child = spawn('sh', ['-c', command], {
			cwd: DEST,
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (e) {
		release();
		return reply(res, 500, {
			ok: false,
			cmd: name,
			error: `spawn: ${e.message}`
		});
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
		lastRun = {
			name,
			exitCode,
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs,
			executedIn: 'sidecar'
		};
		console.log(
			`[dev-sync-sidecar] run "${name}" exit=${exitCode} (${durationMs}ms) executedIn=sidecar` +
				(bridgeNote ? ` (${bridgeNote})` : '')
		);
		release();
		reply(res, 200, {
			ok: exitCode === 0,
			cmd: name,
			exitCode,
			durationMs,
			truncated,
			output,
			executedIn: 'sidecar',
			...(bridgeNote ? { bridge: bridgeNote } : {}),
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
			service: 'dev-sync-sidecar',
			dest: DEST
		});
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
