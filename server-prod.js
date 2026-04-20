import http from 'node:http';
import process from 'node:process';
import net from 'node:net';
import { handler } from './build/handler.js';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TERMINAL_PATH_RE = /^\/api\/sandboxes\/([^/]+)\/terminal\/([^/]+)$/;
const VNC_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/browser\/vnc$/;

// Live browser VNC proxy config. Keep resolver in-process — we'll dial the
// BFF itself on localhost:PORT to reuse its session-auth + pod-ip lookup,
// rather than duplicating the Kubernetes client here.
const VNC_RESOLVER_ORIGIN =
	process.env.VNC_RESOLVER_ORIGIN || `http://127.0.0.1:${PORT}`;

function getUpstreamWsUrl() {
	return (
		process.env.OPENSHELL_AGENT_RUNTIME_WS_URL ||
		'ws://openshell-agent-runtime.openshell.svc.cluster.local:8084'
	);
}

function forwardableCloseCode(code) {
	if (code >= 3000 && code <= 4999) return code;
	if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
	return 1011;
}

function closeReason(reason) {
	return (reason.toString() || 'upstream closed').slice(0, 123);
}

const wss = new WebSocketServer({ noServer: true });

const server = http.createServer(handler);

server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const vncMatch = url.pathname.match(VNC_PATH_RE);
	if (vncMatch) {
		handleVncUpgrade(req, socket, head, vncMatch[1], url.searchParams.get('viewOnly') !== '0');
		return;
	}
	const match = url.pathname.match(TERMINAL_PATH_RE);
	if (!match) {
		socket.destroy();
		return;
	}

	const sandboxName = decodeURIComponent(match[1]);
	const sessionId = decodeURIComponent(match[2]);
	const upstreamUrl = `${getUpstreamWsUrl()}/terminal/${encodeURIComponent(sandboxName)}/${encodeURIComponent(sessionId)}`;

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl);
		const pendingMessages = [];

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
});

server.listen(PORT, HOST, () => {
	console.log(`Listening on http://${HOST}:${PORT}`);
});

function gracefulShutdown() {
	server.close(() => {
		process.exit(0);
	});
	server.closeIdleConnections();
	setTimeout(() => process.exit(1), 10000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ---------------------------------------------------------------------------
// Live browser VNC proxy (WS -> raw TCP on agent pod's chromium :5901)
// ---------------------------------------------------------------------------
//
// Auth + session -> pod-IP lookup happens via an internal HTTP call to this
// same BFF, so we don't duplicate the DB/Kubernetes clients here in plain JS.
// The TypeScript implementation used by vite dev lives at
// src/lib/server/ws-vnc-proxy.ts; this file mirrors its RFB filter behavior.

const IDLE_MS = 10 * 60 * 1000;

async function resolveAgent(req) {
	const resolverUrl = `${VNC_RESOLVER_ORIGIN}/api/v1/sessions/${encodeURIComponent(req.sessionId)}/browser/resolve`;
	const res = await fetch(resolverUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			// Forward caller's cookie (contains the access token) + any
			// authorization header — the endpoint enforces workspace scope.
			...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
			...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
		}
	});
	if (!res.ok) return { error: res.status };
	return res.json();
}

function handleVncUpgrade(req, socket, head, sessionId, viewOnly) {
	req.sessionId = decodeURIComponent(sessionId);
	resolveAgent(req)
		.then((result) => {
			if (result.error) {
				const code = result.error === 401 ? 401 : result.error === 404 ? 404 : 503;
				socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : code === 404 ? 'Not Found' : 'Unavailable'}\r\n\r\n`);
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (browserWs) => {
				pipeVnc(browserWs, result.podIP, viewOnly);
			});
		})
		.catch(() => {
			socket.destroy();
		});
}

function pipeVnc(browserWs, podIP, viewOnly) {
	const tcp = net.createConnection({ host: podIP, port: 5901 });
	const filter = viewOnly ? createRfbViewOnlyFilter() : null;
	let idleTimer = null;
	const bumpIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			try {
				browserWs.close(1000, 'idle timeout');
			} catch {
				/* noop */
			}
			try {
				tcp.destroy();
			} catch {
				/* noop */
			}
		}, IDLE_MS);
	};
	bumpIdle();

	browserWs.on('message', (data, isBinary) => {
		bumpIdle();
		if (!isBinary) return;
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const forwarded = filter ? filter.feed(buf) : buf;
		if (forwarded.length && !tcp.destroyed) tcp.write(forwarded);
	});

	tcp.on('data', (data) => {
		bumpIdle();
		if (browserWs.readyState === WebSocket.OPEN) {
			browserWs.send(data, { binary: true });
		}
	});

	const closeBoth = (code = 1006, reason = 'closed') => {
		if (idleTimer) clearTimeout(idleTimer);
		try {
			if (browserWs.readyState === WebSocket.OPEN) browserWs.close(code, reason.slice(0, 123));
		} catch {
			/* noop */
		}
		try {
			if (!tcp.destroyed) tcp.destroy();
		} catch {
			/* noop */
		}
	};

	tcp.on('close', () => closeBoth(1000, 'upstream closed'));
	tcp.on('error', () => closeBoth(1011, 'upstream error'));
	browserWs.on('close', () => closeBoth());
	browserWs.on('error', () => closeBoth(1011, 'client error'));
}

function createRfbViewOnlyFilter() {
	// See RFBViewOnlyFilter in src/lib/server/ws-vnc-proxy.ts for commentary.
	let buf = Buffer.alloc(0);
	let handshakeBytesLeft = 12;
	let securityTypeSent = false;
	let clientInitSent = false;

	function messageLen(type) {
		if (type === 0x00) return 20;
		if (type === 0x02) {
			if (buf.length < 4) return null;
			const num = buf.readUInt16BE(2);
			return 4 + 4 * num;
		}
		if (type === 0x03) return 10;
		if (type === 0x04) return 8;
		if (type === 0x05) return 6;
		if (type === 0x06) {
			if (buf.length < 8) return null;
			const len = buf.readUInt32BE(4);
			return 8 + len;
		}
		return 1;
	}

	return {
		feed(chunk) {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
			const out = [];
			if (handshakeBytesLeft > 0) {
				const take = Math.min(handshakeBytesLeft, buf.length);
				out.push(buf.subarray(0, take));
				handshakeBytesLeft -= take;
				buf = buf.subarray(take);
			}
			if (handshakeBytesLeft === 0 && !securityTypeSent && buf.length >= 1) {
				out.push(buf.subarray(0, 1));
				buf = buf.subarray(1);
				securityTypeSent = true;
			}
			if (securityTypeSent && !clientInitSent && buf.length >= 1) {
				out.push(buf.subarray(0, 1));
				buf = buf.subarray(1);
				clientInitSent = true;
			}
			while (clientInitSent && buf.length >= 1) {
				const type = buf[0];
				const len = messageLen(type);
				if (len === null) return Buffer.concat(out);
				if (buf.length < len) break;
				const msg = buf.subarray(0, len);
				buf = buf.subarray(len);
				if (type === 0x00 || type === 0x02 || type === 0x03) out.push(msg);
			}
			return Buffer.concat(out);
		}
	};
}
