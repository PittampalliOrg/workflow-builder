import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

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
	}
});
