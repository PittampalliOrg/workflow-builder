import { spawn } from 'node:child_process';
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
				const json = (code: number, body: Record<string, unknown>) => {
					res.statusCode = code;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(body));
				};
				if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
				if (token && req.headers['x-sync-token'] !== token)
					return json(401, { ok: false, error: 'unauthorized' });
				// Stream the request body straight into `tar` extracting under the project
				// root. The producer scopes the archive to `src/`; --no-absolute-names +
				// extracting into `root` keeps writes inside the tree.
				const tar = spawn(
					'tar',
					['-xzf', '-', '-C', root, '--no-same-owner', '--no-absolute-names'],
					{ stdio: ['pipe', 'ignore', 'pipe'] }
				);
				let errout = '';
				tar.stderr.on('data', (d) => (errout += String(d)));
				tar.on('error', (e) => json(500, { ok: false, error: `tar spawn: ${e.message}` }));
				tar.on('close', (code) => {
					if (code === 0) {
						console.log('[wfb-dev-live-sync] applied src sync → Vite HMR');
						json(200, { ok: true, appliedAt: new Date().toISOString() });
					} else {
						json(500, { ok: false, error: errout.slice(0, 500) || `tar exit ${code}` });
					}
				});
				req.pipe(tar.stdin);
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
