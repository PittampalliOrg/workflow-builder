import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { ACCESS_TOKEN_COOKIE } from './auth-cookies';
import { getApplicationAdapters } from './application';
import { getSessionRuntimePod } from './kube/client';
import { execInteractive, type InteractiveExecSession } from './kube/ws-exec-client';
import { shellableContainers } from './agents/runtime-registry';

const SHELL_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/shell$/;
// Runtime-registry-derived (every runtime's main container + browser sidecars).
const ALLOWED_CONTAINERS = shellableContainers();

const wss = new WebSocketServer({ noServer: true });

function readCookie(raw: string | undefined, name: string): string | undefined {
	if (!raw) return undefined;
	for (const part of raw.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v ?? '');
	}
	return undefined;
}

async function authenticate(
	req: IncomingMessage,
): Promise<{ userId: string; projectId?: string } | null> {
	const auth = req.headers.authorization;
	let token: string | undefined;
	if (auth?.startsWith('Bearer ')) token = auth.slice(7);
	else token = readCookie(req.headers.cookie, ACCESS_TOKEN_COOKIE);
	if (!token) return null;
	const payload = await getApplicationAdapters().authSession.verifyAccessToken({
		token,
	});
	if (!payload?.sub) return null;
	return {
		userId: payload.sub,
		projectId: (payload as { projectId?: string }).projectId,
	};
}

/**
 * WebSocket proxy for the Shell tab.
 *
 * Browser ↔ BFF framing:
 *   - text frames starting with `\x01{…json}`  -> resize events
 *     (matches the convention in sandbox-terminal.svelte); translated
 *     to k8s channel 4.
 *   - binary frames (and non-prefixed text) -> forwarded as stdin
 *     (k8s channel 0).
 * BFF ↔ browser framing:
 *   - k8s channels 1/2 (stdout/stderr) -> binary frames to the browser
 *     so xterm.js's AttachAddon writes them to the terminal.
 *   - k8s channel 3 (error) -> log, forward a message, close.
 */
export async function handleUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const match = url.pathname.match(SHELL_PATH_RE);
	if (!match) return false;

	const sessionId = decodeURIComponent(match[1]);
	const container = url.searchParams.get('container') ?? 'chromium';
	if (!ALLOWED_CONTAINERS.has(container)) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
		socket.destroy();
		return true;
	}

	const session = await authenticate(req);
	if (!session) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return true;
	}

	const target =
		await getApplicationAdapters().workflowData.getSessionRuntimeDebugTarget({
			sessionId,
			projectId: session.projectId ?? null,
			userId: session.userId,
		});
	if (!target) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return true;
	}

	const pod = await getSessionRuntimePod({
		runtimeAppId: target.appId,
		agentSlug: target.agentSlug,
	});
	if (!pod) {
		socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
		socket.destroy();
		return true;
	}
	if (!pod.containers.some((c) => c.name === container && c.ready)) {
		socket.write(`HTTP/1.1 503 Service Unavailable\r\n\r\n`);
		socket.destroy();
		return true;
	}

	let exec: InteractiveExecSession;
	try {
		exec = await execInteractive(pod.namespace, pod.name, container, [
			'/bin/sh',
			'-c',
			// Prefer bash if the container has it; fall back to sh.
			'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh',
		]);
	} catch {
		socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
		socket.destroy();
		return true;
	}

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		let browserClosed = false;

		exec.onStdout((chunk) => {
			if (browserClosed) return;
			try {
				browserWs.send(chunk, { binary: true });
			} catch {
				/* noop */
			}
		});
		exec.onStderr((chunk) => {
			if (browserClosed) return;
			try {
				browserWs.send(chunk, { binary: true });
			} catch {
				/* noop */
			}
		});
		exec.onError(() => {
			try {
				browserWs.close(1011, 'kube exec error');
			} catch {
				/* noop */
			}
		});
		exec.onClose(() => {
			try {
				browserWs.close(1000, 'exec closed');
			} catch {
				/* noop */
			}
		});

		browserWs.on('message', (data, isBinary) => {
			// Resize messages from xterm.js come as text frames prefixed with \x01.
			if (!isBinary) {
				const str = data.toString();
				if (str.startsWith('\x01')) {
					try {
						const msg = JSON.parse(str.slice(1)) as {
							type?: string;
							cols?: number;
							rows?: number;
						};
						if (msg.type === 'resize' && msg.cols && msg.rows) {
							exec.resize(msg.cols, msg.rows);
							return;
						}
					} catch {
						/* fall through — treat as stdin */
					}
				}
				exec.writeStdin(Buffer.from(str, 'utf8'));
				return;
			}
			let buf: Buffer;
			if (Buffer.isBuffer(data)) buf = data;
			else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
			else buf = Buffer.concat(data as Buffer[]);
			exec.writeStdin(buf);
		});
		browserWs.on('close', () => {
			browserClosed = true;
			exec.close();
		});
		browserWs.on('error', () => {
			browserClosed = true;
			exec.close();
		});
	});

	return true;
}
