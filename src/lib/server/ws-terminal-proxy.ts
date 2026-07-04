import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ACCESS_TOKEN_COOKIE } from '$lib/server/auth-cookies';
import { getApplicationAdapters } from '$lib/server/application';
import {
	getOpenShellRuntimeInternalToken,
	getOpenShellRuntimeWsUrl
} from '$lib/server/openshell-runtime';
import { resolveOpenShellTerminalTarget } from '$lib/server/openshell-sessions';

const TERMINAL_PATH_RE = /^\/api\/sandboxes\/([^/]+)\/terminal\/([^/]+)$/;
const OPENSHELL_SESSION_TERMINAL_PATH_RE =
	/^\/api\/openshell\/sessions\/([^/]+)\/terminal\/([^/]+)$/;

const wss = new WebSocketServer({ noServer: true });

function getUpstreamWsUrl(): string {
	return getOpenShellRuntimeWsUrl();
}

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
		projectId: (payload as { projectId?: string }).projectId
	};
}

function forwardableCloseCode(code: number): number {
	if (code >= 3000 && code <= 4999) return code;
	if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
	return 1011;
}

function closeReason(reason: Buffer): string {
	return (reason.toString() || 'upstream closed').slice(0, 123);
}

export async function handleUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const sessionTerminalMatch = url.pathname.match(OPENSHELL_SESSION_TERMINAL_PATH_RE);
	if (sessionTerminalMatch) {
		const auth = await authenticate(req);
		if (!auth) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
			socket.destroy();
			return true;
		}
		const sessionId = decodeURIComponent(sessionTerminalMatch[1]);
		const terminalId = decodeURIComponent(sessionTerminalMatch[2]);
		try {
			const target = await resolveOpenShellTerminalTarget(sessionId, terminalId, auth);
			if (!target) {
				socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
				socket.destroy();
				return true;
			}
			proxyTerminal(req, socket, head, target.sandboxName, terminalId);
			return true;
		} catch {
			socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
			socket.destroy();
			return true;
		}
	}

	const match = url.pathname.match(TERMINAL_PATH_RE);
	if (!match) return false;

	const auth = await authenticate(req);
	if (!auth) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return true;
	}
	const sandboxName = decodeURIComponent(match[1]);
	const sessionId = decodeURIComponent(match[2]);
	proxyTerminal(req, socket, head, sandboxName, sessionId);

	return true;
}

function proxyTerminal(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	sandboxName: string,
	sessionId: string,
): void {
	const upstreamUrl = `${getUpstreamWsUrl().replace(/\/$/, '')}/terminal/${encodeURIComponent(sandboxName)}/${encodeURIComponent(sessionId)}`;
	const token = getOpenShellRuntimeInternalToken();
	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl, {
			headers: token ? { 'X-Internal-Token': token } : {}
		});
		const pendingMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

		browserWs.on('message', (data, isBinary) => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(data, { binary: isBinary });
			} else if (upstream.readyState === WebSocket.CONNECTING) {
				pendingMessages.push({ data, isBinary });
			}
		});

		upstream.on('open', () => {
			for (const { data, isBinary } of pendingMessages.splice(0)) {
				upstream.send(data, { binary: isBinary });
			}
		});

		upstream.on('message', (data, isBinary) => {
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.send(data, { binary: isBinary });
			}
		});

		upstream.on('close', (code, reason) => {
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.close(forwardableCloseCode(code), closeReason(reason));
			}
		});

		upstream.on('error', () => {
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.close(1011, 'upstream error');
			}
		});

		browserWs.on('close', () => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.close();
			}
		});

		browserWs.on('error', () => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.close();
			}
		});
	});
}
