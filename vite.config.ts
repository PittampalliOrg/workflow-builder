import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin, ViteDevServer } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
// Relative import on purpose: $lib aliases don't resolve at config-load time.
import { detectAddedRouteFiles } from './src/lib/server/dev-sync/added-routes';
import {
	applyAtomicDevSync,
	DevSyncTransactionError,
	parseAllowedSyncRoots,
	parseDeclaredSyncRoots,
	type AtomicDevSyncTimings
} from './src/lib/server/dev-sync/atomic-sync';

const DEV_SYNC_STATE_FILE = '.dev-sync-state.json';
const DEV_SYNC_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEV_SYNC_SERVICE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEV_SYNC_FREEZE_OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type DevSyncState = {
	generation: string | null;
	service: string | null;
	lastSyncAt: string | null;
	lastSyncBytes: number;
	contentSha256: string | null;
	frozen: boolean;
	preparedOperationId: string | null;
	preparedAt: string | null;
	frozenOperationId: string | null;
};

function headerText(value: string | string[] | undefined): string {
	return (Array.isArray(value) ? value[0] : (value ?? '')).trim();
}

function devSyncTokenEquals(left: string, right: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function acceptsDevSyncToken(
	presented: string | string[] | undefined,
	receiverToken: string,
	agentTokenSha256: string
): boolean {
	const value = headerText(presented);
	return (
		devSyncTokenEquals(value, receiverToken) ||
		devSyncTokenEquals(createHash('sha256').update(value).digest('hex'), agentTokenSha256)
	);
}

function readDevSyncState(root: string): DevSyncState {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(root, DEV_SYNC_STATE_FILE), 'utf8')
		) as Partial<DevSyncState>;
		return {
			generation:
				typeof parsed.generation === 'string' && DEV_SYNC_GENERATION_PATTERN.test(parsed.generation)
					? parsed.generation
					: null,
			service:
				typeof parsed.service === 'string' && DEV_SYNC_SERVICE_PATTERN.test(parsed.service)
					? parsed.service
					: null,
			lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
			lastSyncBytes:
				typeof parsed.lastSyncBytes === 'number' && parsed.lastSyncBytes >= 0
					? parsed.lastSyncBytes
					: 0,
			contentSha256:
				typeof parsed.contentSha256 === 'string' &&
				/^sha256:[0-9a-f]{64}$/.test(parsed.contentSha256)
					? parsed.contentSha256
					: null,
			frozen: parsed.frozen === true,
			preparedOperationId:
				typeof parsed.preparedOperationId === 'string' &&
				DEV_SYNC_FREEZE_OPERATION_PATTERN.test(parsed.preparedOperationId)
					? parsed.preparedOperationId
					: null,
			preparedAt: typeof parsed.preparedAt === 'string' ? parsed.preparedAt : null,
			frozenOperationId:
				typeof parsed.frozenOperationId === 'string' &&
				DEV_SYNC_FREEZE_OPERATION_PATTERN.test(parsed.frozenOperationId)
					? parsed.frozenOperationId
					: null
		};
	} catch {
		return {
			generation: null,
			service: null,
			lastSyncAt: null,
			lastSyncBytes: 0,
			contentSha256: null,
			frozen: false,
			preparedOperationId: null,
			preparedAt: null,
			frozenOperationId: null
		};
	}
}

function persistDevSyncState(root: string, state: DevSyncState): void {
	const target = path.join(root, DEV_SYNC_STATE_FILE);
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state));
		fs.renameSync(tmp, target);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * Dev-only live-sync endpoint for the `workflow-builder-dev` preview pod.
 *
 * A self-update WORKFLOW (running in an unprivileged agent sandbox pod) edits the
 * repo, then POSTs a `tar.gz` of `src/**` here — over Dapr service invocation
 * (`localhost:3500/v1.0/invoke/workflow-builder-dev/method/__sync`) or plain Service
 * DNS. We untar into the project root (scoped to `src/`) on the pod's LOCAL disk, and
 * Vite's watcher fires HMR — the change is live in ~2-5s with no rebuild/redeploy.
 * This is skaffold's tar-sync mechanism, done as an in-cluster HTTP push (no kubectl /
 * pods-exec / RBAC). See docs/agentic-deploy-inspect-loop.md.
 *
 * SAFETY: `apply: 'serve'` means this exists ONLY under `vite dev` — it is never part
 * of `vite build` / the prod image. It is additionally gated by WFB_DEV_SYNC_ENABLED
 * and a WFB_DEV_SYNC_TOKEN shared secret, and only ever writes under `src/`. The dev
 * pod has no DB/secrets, so the blast radius is the throwaway preview only.
 *
 * ROUTE-ADD RESTART (#41): a sync that ADDS files under `src/routes/` while the
 * dev server is mid-restart lands on disk but the route never registers — the
 * replaced watcher misses the `add` event and even a later `touch` fires
 * nothing (verified live 2026-07-05; requests 302 via the error-page layout).
 * Two hooks close the gap, both via Vite's own in-process `server.restart()`
 * (NEVER by killing PID 1 — that wedges vcluster-synced pods ready=false):
 *   1. in-plugin: /__sync pre-lists the tar; when it adds route files, we
 *      respond first, then schedule a full restart;
 *   2. sidecar transport: the dev-sync-sidecar can't reach into this process,
 *      so it writes a signal file the poller below consumes
 *      (WFB_DEV_SYNC_RESTART_SIGNAL, delete-then-restart → loop-safe).
 */
function scheduleRouteAddRestart(server: ViteDevServer, addedRoutes: string[], why: string) {
	console.log(
		`[wfb-dev-live-sync] ${why}: ${addedRoutes.length} new route file(s) [${addedRoutes
			.slice(0, 5)
			.join(
				', '
			)}${addedRoutes.length > 5 ? ', …' : ''}] — full dev-server restart to register them`
	);
	setTimeout(() => {
		server.restart().catch((e: unknown) => {
			console.warn(
				`[wfb-dev-live-sync] server.restart() failed: ${e instanceof Error ? e.message : e}`
			);
		});
	}, 100);
}

function devLiveSyncPlugin(): Plugin {
	let syncState: DevSyncState = {
		generation: null,
		service: null,
		lastSyncAt: null,
		lastSyncBytes: 0,
		contentSha256: null,
		frozen: false,
		preparedOperationId: null,
		preparedAt: null,
		frozenOperationId: null
	};
	let lastSyncTimingsMs: AtomicDevSyncTimings | null = null;
	let lastExportSha256: string | null = null;
	let sourceOperation: string | null = null;
	const beginSourceOperation = (operation: string) => {
		if (sourceOperation) return false;
		sourceOperation = operation;
		return true;
	};
	const endSourceOperation = (operation: string) => {
		if (sourceOperation === operation) sourceOperation = null;
	};
	return {
		name: 'wfb-dev-live-sync',
		apply: 'serve',
		configureServer(server) {
			// #41 hook 2 — sidecar-transport restart signal. The sidecar (a separate
			// container applying /__sync into the shared workdir) writes this file
			// when a sync added new route files; we consume (delete) it, then
			// restart. Polling (not fs.watch) on purpose: the whole bug is that
			// watchers miss events around the restart window, and a 2s stat of one
			// path is free. Env is stamped by sandbox-execution-api in sidecar mode,
			// so plain `vite dev` / plugin-mode pods pay nothing.
			const restartSignal = process.env.WFB_DEV_SYNC_RESTART_SIGNAL ?? '';
			if (restartSignal && server.httpServer) {
				let consuming = false;
				const poll = setInterval(() => {
					if (consuming || !fs.existsSync(restartSignal)) return;
					consuming = true;
					let added: string[] = [];
					try {
						const parsed = JSON.parse(fs.readFileSync(restartSignal, 'utf8'));
						if (Array.isArray(parsed?.addedRoutes)) added = parsed.addedRoutes;
					} catch {
						/* malformed signal still triggers a restart */
					}
					try {
						fs.unlinkSync(restartSignal); // consume BEFORE restarting → no loop
					} catch {
						/* ignore */
					}
					scheduleRouteAddRestart(server, added, 'sidecar restart signal');
				}, 2000);
				poll.unref?.();
				// A restart re-runs configureServer on the NEW server instance; the
				// old poller dies with the old http server (else it would double-fire).
				server.httpServer.once('close', () => clearInterval(poll));
			}

			if (process.env.WFB_DEV_SYNC_ENABLED !== 'true') return;
			const token = process.env.WFB_DEV_SYNC_TOKEN ?? '';
			const agentTokenSha256 = process.env.WFB_DEV_SYNC_AGENT_TOKEN_SHA256 ?? '';
			const root = server.config.root;
			const configuredService = process.env.WFB_DEV_SYNC_SERVICE ?? 'workflow-builder';
			let allowedRoots: string[] = [];
			let allowedRootsError: string | null = null;
			try {
				allowedRoots = parseAllowedSyncRoots(process.env.WFB_DEV_SYNC_ALLOWED_ROOTS_JSON ?? '');
			} catch (error) {
				allowedRootsError = (error as Error).message;
				console.error(`[wfb-dev-live-sync] invalid allowed-root contract: ${allowedRootsError}`);
			}
			syncState = readDevSyncState(root);
			if (!syncState.service) syncState.service = configuredService;
			if (syncState.frozen) {
				syncState.preparedOperationId = null;
				syncState.preparedAt = null;
			} else {
				syncState.frozenOperationId = null;
			}
			server.middlewares.use('/__freeze', (req, res) => {
				let replied = false;
				const json = (code: number, body: Record<string, unknown>) => {
					if (replied) return;
					replied = true;
					res.statusCode = code;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(body));
				};
				if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
				req.resume();
				if (!devSyncTokenEquals(headerText(req.headers['x-sync-token']), token)) {
					return json(401, { ok: false, error: 'unauthorized' });
				}
				const url = new URL(req.url ?? '/__freeze', 'http://localhost');
				const phase = (url.searchParams.get('phase') ?? '').trim();
				const operationId = (url.searchParams.get('operationId') ?? '').trim();
				if (!['prepare', 'commit', 'abort'].includes(phase)) {
					return json(400, { ok: false, error: 'valid freeze phase required' });
				}
				if (!DEV_SYNC_FREEZE_OPERATION_PATTERN.test(operationId)) {
					return json(400, { ok: false, error: 'valid operationId required' });
				}
				const sourceOperationName = `freeze-${phase}`;
				if (!beginSourceOperation(sourceOperationName)) {
					return json(409, {
						ok: false,
						error: `source ${sourceOperation} in progress`
					});
				}
				const proof = (idempotent: boolean) => ({
					ok: true,
					prepared: !syncState.frozen && syncState.preparedOperationId === operationId,
					frozen: syncState.frozen,
					idempotent,
					operationId,
					service: syncState.service,
					generation: syncState.generation,
					contentSha256: syncState.contentSha256
				});
				try {
					if (phase === 'prepare') {
						if (syncState.frozen) {
							if (
								syncState.frozenOperationId &&
								syncState.frozenOperationId !== operationId
							) {
								return json(409, {
									ok: false,
									error: 'receiver frozen by another operation'
								});
							}
							return json(200, proof(true));
						}
						if (
							syncState.preparedOperationId &&
							syncState.preparedOperationId !== operationId
						) {
							return json(409, {
								ok: false,
								error: 'receiver prepared by another operation'
							});
						}
						const idempotent = syncState.preparedOperationId === operationId;
						if (!idempotent) {
							const nextState: DevSyncState = {
								...syncState,
								preparedOperationId: operationId,
								preparedAt: new Date().toISOString()
							};
							persistDevSyncState(root, nextState);
							syncState = nextState;
						}
						return json(200, proof(idempotent));
					}

					if (phase === 'abort') {
						if (syncState.frozen) {
							return json(409, {
								ok: false,
								error: 'receiver freeze is already committed'
							});
						}
						if (
							syncState.preparedOperationId &&
							syncState.preparedOperationId !== operationId
						) {
							return json(409, {
								ok: false,
								error: 'receiver prepared by another operation'
							});
						}
						const idempotent = syncState.preparedOperationId === null;
						if (!idempotent) {
							const nextState: DevSyncState = {
								...syncState,
								preparedOperationId: null,
								preparedAt: null
							};
							persistDevSyncState(root, nextState);
							syncState = nextState;
						}
						return json(200, {
							ok: true,
							prepared: false,
							frozen: false,
							idempotent,
							operationId
						});
					}

					if (syncState.frozen) {
						if (
							syncState.frozenOperationId &&
							syncState.frozenOperationId !== operationId
						) {
							return json(409, {
								ok: false,
								error: 'receiver frozen by another operation'
							});
						}
						return json(200, proof(true));
					}
					if (syncState.preparedOperationId !== operationId) {
						return json(409, { ok: false, error: 'matching freeze preparation required' });
					}
					const nextState: DevSyncState = {
						...syncState,
						frozen: true,
						preparedOperationId: null,
						preparedAt: null,
						frozenOperationId: operationId
					};
					persistDevSyncState(root, nextState);
					syncState = nextState;
					return json(200, proof(false));
				} catch (error) {
					return json(500, {
						ok: false,
						error: `freeze state write: ${error instanceof Error ? error.message : String(error)}`
					});
				} finally {
					endSourceOperation(sourceOperationName);
				}
			});
			server.middlewares.use('/__sync', (req, res) => {
				let replied = false;
				const json = (code: number, body: Record<string, unknown>) => {
					if (replied) return;
					replied = true;
					try {
						res.statusCode = code;
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify(body));
					} catch {
						/* socket already gone */
					}
				};
				if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
				if (!acceptsDevSyncToken(req.headers['x-sync-token'], token, agentTokenSha256))
					return json(401, { ok: false, error: 'unauthorized' });
				if (syncState.frozen || syncState.preparedOperationId) {
					req.resume();
					return json(409, {
						ok: false,
						error: syncState.frozen
							? 'source receiver is frozen'
							: 'source receiver is prepared for checkpoint',
						frozen: syncState.frozen,
						prepared: Boolean(syncState.preparedOperationId)
					});
				}
				if (allowedRootsError) {
					req.resume();
					return json(503, {
						ok: false,
						error: `receiver allowed-root contract invalid: ${allowedRootsError}`
					});
				}
				const generation = headerText(req.headers['x-sync-generation']);
				if (!DEV_SYNC_GENERATION_PATTERN.test(generation)) {
					req.resume();
					return json(400, {
						ok: false,
						error: 'valid x-sync-generation required'
					});
				}
				const service = headerText(req.headers['x-sync-service']) || configuredService;
				if (!DEV_SYNC_SERVICE_PATTERN.test(service)) {
					req.resume();
					return json(400, {
						ok: false,
						error: 'valid x-sync-service required'
					});
				}
				if (service !== configuredService) {
					req.resume();
					return json(409, {
						ok: false,
						error: `x-sync-service ${service} does not match ${configuredService}`
					});
				}
				let declaredRoots: string[];
				try {
					declaredRoots = parseDeclaredSyncRoots(
						headerText(req.headers['x-sync-roots']),
						allowedRoots
					);
				} catch (error) {
					req.resume();
					return json(400, { ok: false, error: (error as Error).message });
				}
				if (!beginSourceOperation('sync')) {
					req.resume();
					return json(409, {
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

				// BUFFER the whole body first (do NOT pipe the request straight into
				// tar.stdin — if tar dies on a partial/streamed gzip the broken pipe
				// raised an unhandled EPIPE that crashed the vite process). Swallow
				// request-stream errors so a dropped/aborted upload can never crash dev.
				const chunks: Buffer[] = [];
				let total = 0;
				let aborted = false;
				const MAX = 64 * 1024 * 1024;
				req.on('error', () => {
					aborted = true;
					if (!bodyComplete) release();
				});
				req.on('aborted', () => {
					aborted = true;
					if (!bodyComplete) release();
				});
				req.on('data', (c: Buffer) => {
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
						return json(400, {
							ok: false,
							error: 'aborted or too large'
						});
					}
					const tmp = path.join(os.tmpdir(), `wfb-sync-${process.pid}-${randomUUID()}.tgz`);
					let buf: Buffer;
					try {
						buf = Buffer.concat(chunks);
						fs.writeFileSync(tmp, buf);
					} catch (e) {
						release();
						return json(500, {
							ok: false,
							error: `buffer/write: ${(e as Error).message}`
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
					if (syncState.generation === generation) {
						cleanup();
						release();
						if (syncState.contentSha256 === contentSha256) {
							return json(200, {
								ok: true,
								idempotent: true,
								bytes: buf.length,
								generation,
								service,
								contentSha256
							});
						}
						return json(409, {
							ok: false,
							error: 'sync generation already committed with different content'
						});
					}

					const nextState: DevSyncState = {
						generation,
						service,
						lastSyncAt: new Date().toISOString(),
						lastSyncBytes: buf.length,
						contentSha256,
						frozen: false,
						preparedOperationId: null,
						preparedAt: null,
						frozenOperationId: null
					};
					let addedRoutes: string[] = [];
					void applyAtomicDevSync({
						root,
						archivePath: tmp,
						declaredRoots,
						nextState,
						stateFile: DEV_SYNC_STATE_FILE,
						persistState: (state) => persistDevSyncState(root, state as DevSyncState),
						beforeCommit: (entries) => {
							addedRoutes = detectAddedRouteFiles(entries, (rel) =>
								fs.existsSync(path.join(root, rel))
							);
						}
					})
						.then(({ changedRoots, changedPaths, timingsMs }) => {
							cleanup();
							syncState = nextState;
							lastSyncTimingsMs = timingsMs;
							console.log(
								`[wfb-dev-live-sync] committed ${changedRoots.join(',') || '<no source changes>'} (${buf.length}B, ${timingsMs.total}ms apply) -> Vite HMR`
							);
							release();
							json(200, {
								ok: true,
								bytes: buf.length,
								generation,
								service,
								contentSha256,
								changedRoots,
								changedPathCount: changedPaths.length,
								changedPaths: changedPaths.slice(0, 50),
								changedPathsTruncated: changedPaths.length > 50,
								timingsMs,
								...(addedRoutes.length
									? {
											routesAdded: addedRoutes.slice(0, 50),
											willRestart: true
										}
									: {})
							});
							if (addedRoutes.length) {
								scheduleRouteAddRestart(server, addedRoutes, 'sync added routes');
							}
						})
						.catch((error: unknown) => {
							cleanup();
							syncState = readDevSyncState(root);
							if (!syncState.service) syncState.service = configuredService;
							release();
							json(
								error instanceof DevSyncTransactionError && error.phase === 'commit' ? 500 : 400,
								{
									ok: false,
									error: error instanceof Error ? error.message : String(error)
								}
							);
						});
				});
			});

			server.middlewares.use('/__status', (req, res) => {
				if (req.method !== 'GET') {
					res.statusCode = 405;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'GET only' }));
					return;
				}
				if (!acceptsDevSyncToken(req.headers['x-sync-token'], token, agentTokenSha256)) {
					res.statusCode = 401;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
					return;
				}
				res.statusCode = 200;
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						ok: true,
						transport: 'vite-plugin',
						service: syncState.service,
						generation: syncState.generation,
						lastSyncAt: syncState.lastSyncAt,
						lastSyncBytes: syncState.lastSyncBytes,
						lastSyncTimingsMs,
						contentSha256: syncState.contentSha256,
						frozen: syncState.frozen,
						prepared: Boolean(syncState.preparedOperationId),
						preparedOperationId: syncState.preparedOperationId,
						preparedAt: syncState.preparedAt,
						frozenOperationId: syncState.frozenOperationId,
						allowedRoots,
						lastExportSha256
					})
				);
			});

			// Read-back counterpart to /__sync: GET /__export streams a `tar.gz` of the
			// current working `src/` (the live state, incl. everything synced so far) so an
			// agent can pull the dev pod's source — making the DEV POD the source-of-truth
			// (no full-repo clone into the slow JuiceFS shared workspace). The agent then
			// edits on local disk and POSTs back to /__sync. Same gating + busybox-tar
			// (relative paths) as the producer side. See docs/agentic-deploy-inspect-loop.md.
			server.middlewares.use('/__export', (req, res) => {
				if (req.method !== 'GET') {
					res.statusCode = 405;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'GET only' }));
					return;
				}
				if (!acceptsDevSyncToken(req.headers['x-sync-token'], token, agentTokenSha256)) {
					res.statusCode = 401;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
					return;
				}
				// Export only catalog-owned roots. With no query, export the complete
				// replacement set so a pull/edit/push loop cannot accidentally delete
				// roots it did not fetch.
				const url = new URL(req.url ?? '/__export', 'http://localhost');
				const rawPaths = url.searchParams.get('paths');
				let requestedPaths: string[];
				try {
					requestedPaths =
						rawPaths === null
							? [...allowedRoots]
							: parseDeclaredSyncRoots(
									JSON.stringify(rawPaths.split(',').map((entry) => entry.trim())),
									allowedRoots
								);
				} catch (error) {
					res.statusCode = 400;
					res.setHeader('content-type', 'application/json');
					res.end(
						JSON.stringify({
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						})
					);
					return;
				}
				const paths = requestedPaths.filter((entry) => fs.existsSync(path.join(root, entry)));
				if (paths.length === 0) {
					res.statusCode = 400;
					res.setHeader('content-type', 'application/json');
					res.end(
						JSON.stringify({
							ok: false,
							error: 'no existing paths'
						})
					);
					return;
				}
				if (!beginSourceOperation('export')) {
					res.statusCode = 409;
					res.setHeader('content-type', 'application/json');
					res.end(
						JSON.stringify({
							ok: false,
							error: `source ${sourceOperation} in progress`
						})
					);
					return;
				}
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					endSourceOperation('export');
				};
				const tmp = path.join(os.tmpdir(), `wfb-export-${process.pid}-${randomUUID()}.tgz`);
				// Materialize first so metadata hashes the exact gzip bytes returned.
				const tar = spawn('tar', ['-czf', tmp, '-C', root, ...paths], {
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
					res.statusCode = 500;
					res.end();
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
						console.warn(`[wfb-dev-live-sync] export tar exit ${code}: ${errout.slice(0, 200)}`);
						res.statusCode = 500;
						res.setHeader('content-type', 'application/json');
						res.end(
							JSON.stringify({
								ok: false,
								error: errout.slice(0, 500) || `tar exit ${code}`
							})
						);
						return;
					}
					try {
						const bytes = fs.readFileSync(tmp);
						const contentSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
						lastExportSha256 = contentSha256;
						res.statusCode = 200;
						res.setHeader('content-type', 'application/gzip');
						res.setHeader('x-content-sha256', contentSha256);
						res.setHeader('x-sync-roots', JSON.stringify(allowedRoots));
						if (syncState.generation) res.setHeader('x-sync-generation', syncState.generation);
						if (syncState.service) res.setHeader('x-sync-service', syncState.service);
						res.end(bytes);
						console.log(
							`[wfb-dev-live-sync] exported ${paths.join(',')} (${bytes.length}B ${contentSha256})`
						);
					} catch (e) {
						res.statusCode = 500;
						res.setHeader('content-type', 'application/json');
						res.end(
							JSON.stringify({
								ok: false,
								error: `export read: ${(e as Error).message}`
							})
						);
					} finally {
						try {
							fs.rmSync(tmp, { force: true });
						} catch {
							/* ignore */
						}
					}
				});
				// Abort the tar if the client disconnects mid-stream.
				req.on('aborted', () => {
					try {
						tar.kill();
					} catch {
						/* already gone */
					}
				});
			});
		}
	};
}

function wsUpgradeProxy(): Plugin {
	return {
		name: 'ws-upgrade-proxy',
		configureServer(server) {
			// Middleware-mode servers (including Vitest) intentionally have no HTTP
			// server. Retrying forever leaks a timer and keeps every test process open.
			const httpServer = server.httpServer;
			if (!httpServer) return;
			const attach = () => {
				httpServer.on('upgrade', (req, socket, head) => {
					const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
						.pathname;
					const isTerminal =
						pathname.startsWith('/api/sandboxes/') && pathname.includes('/terminal/');
					const isOpenShellSessionTerminal =
						pathname.startsWith('/api/openshell/sessions/') && pathname.includes('/terminal/');
					const isShell = /^\/api\/v1\/sessions\/[^/]+\/shell$/.test(pathname);
					const isCliTerminal = /^\/api\/v1\/sessions\/[^/]+\/cli-terminal\/[^/]+$/.test(pathname);
					if (!isTerminal && !isOpenShellSessionTerminal && !isShell && !isCliTerminal) return;
					const modPath = isShell
						? '/src/lib/server/ws-kube-exec-proxy.ts'
						: isCliTerminal
							? '/src/lib/server/ws-cli-terminal-proxy.ts'
							: '/src/lib/server/ws-terminal-proxy.ts';
					server
						.ssrLoadModule(modPath)
						.then((mod) => {
							const fn = mod.handleUpgrade as (
								req: unknown,
								socket: unknown,
								head: unknown
							) => boolean | Promise<boolean>;
							const r = fn(req, socket, head);
							if (r instanceof Promise) r.catch(() => {});
						})
						.catch(() => {
							// let other handlers proceed
						});
				});
			};
			attach();
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), wsUpgradeProxy(), devLiveSyncPlugin()],
	server: {
		port: 3000,
		host: true,
		allowedHosts: true,
		// Atomic uploads stage below this hidden directory before committing. State
		// and route-restart signals are transport metadata, not application inputs.
		// Only committed catalog roots should reach Vite's module watcher.
		watch: {
			ignored: [
				'**/.dev-sync-transactions/**',
				'**/.dev-sync-state.json*',
				'**/.dev-sync-restart-request.json'
			]
		}
	},
	ssr: {
		noExternal: ['nats']
	},
	test: {
		exclude: [
			...configDefaults.exclude,
			'tests/e2e/**',
			// node:test suites (run via `node --test`, not vitest) — vitest's *.test.mjs
			// glob would otherwise pick them up and fail with "No test suite found".
			'services/dev-sync-sidecar/**/*.test.mjs',
			'scripts/dev-sync/sync.test.mjs',
			// script-evaluator needs node --experimental-vm-modules (vm.SourceTextModule);
			// the root runner never sets it. Runs via its own lane:
			// `cd services/script-evaluator && pnpm test` (cross-env NODE_OPTIONS).
			'services/script-evaluator/**',
			// CI-only: these import service-local deps (@activepieces/*,
			// function-router's runtime stack, workflow-mcp-server's MCP/pg/zod
			// stack) that the root install does not provide; locally they run
			// against services/*/node_modules.
			// Follow-up: service-owned test lanes.
			...(process.env.CI
				? [
						'services/piece-mcp-server/src/metadata-catalog.test.ts',
						'services/function-router/src/routes/execute*.test.ts',
						'services/workflow-mcp-server/**'
					]
				: [])
		]
	}
});
