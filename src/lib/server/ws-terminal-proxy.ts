import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const TERMINAL_PATH_RE = /^\/api\/sandboxes\/([^/]+)\/terminal\/([^/]+)$/;

const wss = new WebSocketServer({ noServer: true });

function getUpstreamWsUrl(): string {
	return (
		process.env.OPENSHELL_AGENT_RUNTIME_WS_URL ||
		'ws://openshell-agent-runtime.openshell.svc.cluster.local:8084'
	);
}

function forwardableCloseCode(code: number): number {
	if (code >= 3000 && code <= 4999) return code;
	if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
	return 1011;
}

function closeReason(reason: Buffer): string {
	return (reason.toString() || 'upstream closed').slice(0, 123);
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const match = url.pathname.match(TERMINAL_PATH_RE);
	if (!match) return false;

	const sandboxName = decodeURIComponent(match[1]);
	const sessionId = decodeURIComponent(match[2]);
	const upstreamUrl = `${getUpstreamWsUrl()}/terminal/${encodeURIComponent(sandboxName)}/${encodeURIComponent(sessionId)}`;

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl);
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

	return true;
}
