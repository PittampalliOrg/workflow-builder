import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

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
 */
function devLiveSyncPlugin(): Plugin {
	return {
		name: 'wfb-dev-live-sync',
		apply: 'serve',
		configureServer(server) {
			if (process.env.WFB_DEV_SYNC_ENABLED !== 'true') return;
			const token = process.env.WFB_DEV_SYNC_TOKEN ?? '';
			const root = server.config.root;
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
				if (token && req.headers['x-sync-token'] !== token)
					return json(401, { ok: false, error: 'unauthorized' });

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
				});
				req.on('aborted', () => {
					aborted = true;
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
					if (aborted) return json(400, { ok: false, error: 'aborted or too large' });
					const tmp = path.join(os.tmpdir(), `wfb-sync-${process.pid}-${total}.tgz`);
					let buf: Buffer;
					try {
						buf = Buffer.concat(chunks);
						fs.writeFileSync(tmp, buf);
					} catch (e) {
						return json(500, { ok: false, error: `buffer/write: ${(e as Error).message}` });
					}
					const cleanup = () => {
						try {
							fs.unlinkSync(tmp);
						} catch {
							/* ignore */
						}
					};
					// Extract from the FILE (not a stream) into the project root. The dev
					// image is node:22-alpine → BUSYBOX tar, which rejects GNU long flags
					// (--no-same-owner/--no-absolute-names) and strips leading '/' itself;
					// the producer archives only relative `src/`. `-o` = don't restore
					// user:group (busybox + GNU compatible). Vite's watcher then HMRs.
					const tar = spawn('tar', ['-xzf', tmp, '-C', root, '-o'], {
						stdio: ['ignore', 'ignore', 'pipe']
					});
					let errout = '';
					tar.stderr.on('data', (d) => (errout += String(d)));
					tar.on('error', (e) => {
						cleanup();
						json(500, { ok: false, error: `tar spawn: ${e.message}` });
					});
					tar.on('close', (code) => {
						cleanup();
						if (code === 0) {
							console.log(`[wfb-dev-live-sync] applied src sync (${buf.length}B) → Vite HMR`);
							json(200, { ok: true, bytes: buf.length });
						} else {
							json(500, { ok: false, error: errout.slice(0, 500) || `tar exit ${code}` });
						}
					});
				});
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
				if (token && req.headers['x-sync-token'] !== token) {
					res.statusCode = 401;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
					return;
				}
				// `?paths=src,static` (default `src`); reject absolute / parent-escaping paths.
				const url = new URL(req.url ?? '/__export', 'http://localhost');
				const paths = (url.searchParams.get('paths') ?? 'src')
					.split(',')
					.map((p) => p.trim())
					.filter((p) => p && !p.startsWith('/') && !p.split('/').includes('..'));
				if (paths.length === 0) {
					res.statusCode = 400;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: 'no valid paths' }));
					return;
				}
				res.statusCode = 200;
				res.setHeader('content-type', 'application/gzip');
				// `-czf -` to stdout; relative paths under root (busybox + GNU compatible).
				const tar = spawn('tar', ['-czf', '-', '-C', root, ...paths], {
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
						console.log(`[wfb-dev-live-sync] exported ${paths.join(',')} (tar.gz)`);
					} else {
						console.warn(`[wfb-dev-live-sync] export tar exit ${code}: ${errout.slice(0, 200)}`);
					}
					// stdout pipe already ended `res`; nothing else to do.
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
			const attach = () => {
				if (!server.httpServer) {
					setTimeout(attach, 100);
					return;
				}
				server.httpServer.on('upgrade', (req, socket, head) => {
					const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
					const isTerminal =
						pathname.startsWith('/api/sandboxes/') && pathname.includes('/terminal/');
					const isOpenShellSessionTerminal =
						pathname.startsWith('/api/openshell/sessions/') && pathname.includes('/terminal/');
					const isShell = /^\/api\/v1\/sessions\/[^/]+\/shell$/.test(pathname);
					const isCliTerminal = /^\/api\/v1\/sessions\/[^/]+\/cli-terminal\/[^/]+$/.test(
						pathname
					);
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
								head: unknown,
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
		allowedHosts: true
	},
	ssr: {
		noExternal: ['nats']
	},
	test: {
		exclude: [...configDefaults.exclude, 'tests/e2e/**']
	}
});
