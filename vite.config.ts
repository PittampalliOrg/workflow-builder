import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

function wsTerminalProxy(): Plugin {
	return {
		name: 'ws-terminal-proxy',
		configureServer(server) {
			const attach = () => {
				if (!server.httpServer) {
					setTimeout(attach, 100);
					return;
				}
				server.httpServer.on('upgrade', (req, socket, head) => {
					const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
					if (!pathname.startsWith('/api/sandboxes/') || !pathname.includes('/terminal/')) return;

					server
						.ssrLoadModule('/src/lib/server/ws-terminal-proxy.ts')
						.then((mod) => {
							(mod.handleUpgrade as (req: unknown, socket: unknown, head: unknown) => boolean)(
								req, socket, head
							);
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
	plugins: [tailwindcss(), sveltekit(), wsTerminalProxy()],
	server: {
		port: 3000,
		host: true,
		allowedHosts: true
	},
	ssr: {
		noExternal: ['@lucide/svelte', 'nats']
	}
});
