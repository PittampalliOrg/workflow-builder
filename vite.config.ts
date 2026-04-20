import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

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
					const isVnc = /^\/api\/v1\/sessions\/[^/]+\/browser\/vnc$/.test(pathname);
					if (!isTerminal && !isVnc) return;
					const modPath = isVnc
						? '/src/lib/server/ws-vnc-proxy.ts'
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
	plugins: [tailwindcss(), sveltekit(), wsUpgradeProxy()],
	server: {
		port: 3000,
		host: true,
		allowedHosts: true
	},
	ssr: {
		noExternal: ['@lucide/svelte', 'nats'],
		// @novnc/novnc uses top-level await in a CommonJS-looking module that
		// Rollup can't parse during the SSR build, but the library is only
		// imported dynamically from an onMount handler (client-only). Keeping
		// it external means the SSR bundle never analyzes it at all. The
		// CLIENT bundle still processes the module — we intentionally do NOT
		// add it to optimizeDeps.exclude because then Vite would ship the
		// bare specifier to the browser and the dynamic import would fail to
		// resolve at runtime.
		external: ['@novnc/novnc']
	}
});
