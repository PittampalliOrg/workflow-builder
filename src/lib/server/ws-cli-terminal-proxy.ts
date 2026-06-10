import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { env } from '$env/dynamic/private';

import { ACCESS_TOKEN_COOKIE, verifyAccessToken } from '$lib/server/auth';
import { getAgentWorkflowHostPod } from '$lib/server/kube/client';
import { resolveSessionRuntimeDebugTarget } from '$lib/server/sessions/runtime-target';
import { getRuntimeDescriptor } from '$lib/server/agents/runtime-registry';

const CLI_TERMINAL_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/cli-terminal\/([^/]+)$/;
const CLI_TERMINAL_PORT = 8002;
const KEEPALIVE_INTERVAL_MS = 30_000;

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
	const payload = await verifyAccessToken(token);
	if (!payload?.sub) return null;
	return {
		userId: payload.sub,
		projectId: (payload as { projectId?: string }).projectId,
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

function internalToken(): string {
	return (env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? '').trim();
}

/**
 * WebSocket proxy for the interactive-CLI Terminal tab (dev mode; prod has a
 * mirrored path in server-prod.js).
 *
 * Browser path: /api/v1/sessions/<id>/cli-terminal/<terminalId>?target=main|shell
 * Upstream:     ws://<podIp>:8002/terminal/<terminalId>?<same query>
 *               with X-Internal-Token == INTERNAL_API_TOKEN.
 *
 * Framing is passed through verbatim — binary frames are raw PTY bytes; text
 * frames starting with \x01 are resize JSON (same convention as
 * sandbox-terminal.svelte / the openshell terminal proxy). A 30s ping
 * keepalive holds idle TUI sessions open across intermediaries.
 */
export async function handleUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const match = url.pathname.match(CLI_TERMINAL_PATH_RE);
	if (!match) return false;

	const sessionId = decodeURIComponent(match[1]);
	const terminalId = decodeURIComponent(match[2]);

	const auth = await authenticate(req);
	if (!auth) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return true;
	}

	let podIp: string;
	try {
		const target = await resolveSessionRuntimeDebugTarget(sessionId, auth.projectId);
		if (!target) {
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.destroy();
			return true;
		}
		const descriptor = getRuntimeDescriptor(target.agentRuntime);
		if (descriptor?.capabilities?.interactiveTerminal !== true) {
			socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
			socket.destroy();
			return true;
		}
		const pod = await getAgentWorkflowHostPod(target.appId);
		if (!pod?.podIP) {
			socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
			socket.destroy();
			return true;
		}
		podIp = pod.podIP;
	} catch {
		socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
		socket.destroy();
		return true;
	}

	const upstreamUrl = `ws://${podIp}:${CLI_TERMINAL_PORT}/terminal/${encodeURIComponent(terminalId)}${url.search}`;
	const token = internalToken();
	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl, {
			headers: token ? { 'X-Internal-Token': token } : {},
		});
		const pendingMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
		let keepalive: ReturnType<typeof setInterval> | null = null;
		const clearKeepalive = () => {
			if (keepalive) {
				clearInterval(keepalive);
				keepalive = null;
			}
		};

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
			keepalive = setInterval(() => {
				try {
					if (browserWs.readyState === WebSocket.OPEN) browserWs.ping();
					if (upstream.readyState === WebSocket.OPEN) upstream.ping();
				} catch {
					/* noop */
				}
			}, KEEPALIVE_INTERVAL_MS);
		});

		upstream.on('message', (data, isBinary) => {
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.send(data, { binary: isBinary });
			}
		});

		upstream.on('close', (code, reason) => {
			clearKeepalive();
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.close(forwardableCloseCode(code), closeReason(reason));
			}
		});

		upstream.on('error', () => {
			clearKeepalive();
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.close(1011, 'upstream error');
			}
		});

		browserWs.on('close', () => {
			clearKeepalive();
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.close();
			}
		});

		browserWs.on('error', () => {
			clearKeepalive();
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.close();
			}
		});
	});

	return true;
}
