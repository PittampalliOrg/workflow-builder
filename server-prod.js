import http from 'node:http';
import fs from 'node:fs/promises';
import process from 'node:process';
import { handler } from './build/handler.js';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TERMINAL_PATH_RE = /^\/api\/sandboxes\/([^/]+)\/terminal\/([^/]+)$/;
const SHELL_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/shell$/;

// Preflight origin: the BFF hits itself for the resolver endpoint that
// enforces auth + workspace scope. The `SHELL_RESOLVER_ORIGIN` env var
// is a test-only escape hatch.
const SHELL_RESOLVER_ORIGIN =
	process.env.SHELL_RESOLVER_ORIGIN || `http://127.0.0.1:${PORT}`;

const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';

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
	const shellMatch = url.pathname.match(SHELL_PATH_RE);
	if (shellMatch) {
		handleShellUpgrade(req, socket, head, shellMatch[1], url.searchParams.get('container') || 'chromium');
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
// Pod shell proxy: browser WS <-> k8s pods/exec WS (v4.channel.k8s.io).
// ---------------------------------------------------------------------------
//
// The shell tab opens a WebSocket to /api/v1/sessions/<id>/shell?container=<c>.
// We authenticate via an internal HTTP call to the BFF's session-cookie-gated
// resolver (/api/v1/sessions/<id>/shell/resolve?container=<c>) that returns
// { pod, namespace, container }. Then we open a TLS WebSocket to the
// Kubernetes API with our pod service-account token + the in-cluster CA and
// multiplex channel-framed frames.
//
// v4.channel.k8s.io framing:
//   0 stdin (client -> server)
//   1 stdout (server -> client)
//   2 stderr (server -> client)
//   3 error  (server -> client; JSON status envelope)
//   4 resize (client -> server; JSON {Width, Height})
//
// Browser-side framing (matches sandbox-terminal.svelte):
//   text "\x01{json}" -> resize channel 4
//   anything else     -> stdin channel 0

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

let cachedToken = null;
async function getKubeToken() {
	if (cachedToken) return cachedToken;
	cachedToken = (await fs.readFile(TOKEN_PATH, 'utf-8')).trim();
	return cachedToken;
}

let cachedCa = null;
async function getKubeCA() {
	if (cachedCa) return cachedCa;
	cachedCa = await fs.readFile(CA_PATH);
	return cachedCa;
}

async function resolveShell(req, sessionId, container) {
	const resolverUrl =
		`${SHELL_RESOLVER_ORIGIN}/api/v1/sessions/${encodeURIComponent(sessionId)}/shell/resolve?container=${encodeURIComponent(container)}`;
	const res = await fetch(resolverUrl, {
		method: 'POST',
		headers: {
			...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
			...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
		}
	});
	if (!res.ok) return { error: res.status };
	return res.json();
}

function buildExecUrl(namespace, pod, container) {
	const params = new URLSearchParams();
	params.set('container', container);
	params.set('stdin', 'true');
	params.set('stdout', 'true');
	params.set('stderr', 'true');
	params.set('tty', 'true');
	params.append('command', '/bin/sh');
	params.append('command', '-c');
	params.append('command', 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh');
	return (
		`wss://${K8S_HOST}:${K8S_PORT}` +
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/exec?` +
		params.toString()
	);
}

function handleShellUpgrade(req, socket, head, sessionIdRaw, containerRaw) {
	const sessionId = decodeURIComponent(sessionIdRaw);
	const container = decodeURIComponent(containerRaw);
	(async () => {
		const res = await resolveShell(req, sessionId, container);
		if (res.error) {
			const code = res.error === 401 ? 401 : res.error === 404 ? 404 : 503;
			const name =
				code === 401 ? 'Unauthorized' : code === 404 ? 'Not Found' : 'Service Unavailable';
			socket.write(`HTTP/1.1 ${code} ${name}\r\n\r\n`);
			socket.destroy();
			return;
		}
		const [token, ca] = await Promise.all([getKubeToken(), getKubeCA()]);
		const upstream = new WebSocket(buildExecUrl(res.namespace, res.pod, res.container), ['v4.channel.k8s.io'], {
			headers: { Authorization: `Bearer ${token}` },
			ca
		});
		wss.handleUpgrade(req, socket, head, (browserWs) => {
			pipeShell(browserWs, upstream);
		});
	})().catch(() => {
		try {
			socket.destroy();
		} catch {
			/* noop */
		}
	});
}

function pipeShell(browserWs, upstream) {
	let browserClosed = false;
	let upstreamClosed = false;

	upstream.on('message', (data) => {
		if (browserClosed) return;
		const buf = Buffer.isBuffer(data)
			? data
			: data instanceof ArrayBuffer
			? Buffer.from(new Uint8Array(data))
			: Buffer.concat(data);
		if (buf.length < 1) return;
		const channel = buf[0];
		const payload = buf.subarray(1);
		if (channel === 1 || channel === 2) {
			try {
				browserWs.send(payload, { binary: true });
			} catch {
				/* noop */
			}
		}
		// channel 3 = error; we log & let the upstream close handler terminate.
	});

	upstream.on('close', (code, reason) => {
		upstreamClosed = true;
		if (browserWs.readyState === WebSocket.OPEN) {
			try {
				browserWs.close(forwardableCloseCode(code), closeReason(reason));
			} catch {
				/* noop */
			}
		}
	});
	upstream.on('error', () => {
		upstreamClosed = true;
		if (browserWs.readyState === WebSocket.OPEN) {
			try {
				browserWs.close(1011, 'upstream error');
			} catch {
				/* noop */
			}
		}
	});

	browserWs.on('message', (data, isBinary) => {
		if (upstreamClosed) return;
		if (!isBinary) {
			const str = data.toString();
			if (str.startsWith('\x01')) {
				try {
					const msg = JSON.parse(str.slice(1));
					if (msg.type === 'resize' && msg.cols && msg.rows) {
						const payload = Buffer.from(JSON.stringify({ Width: msg.cols, Height: msg.rows }), 'utf8');
						if (upstream.readyState === WebSocket.OPEN) {
							upstream.send(Buffer.concat([Buffer.from([4]), payload]));
						}
						return;
					}
				} catch {
					/* fall through */
				}
			}
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(Buffer.concat([Buffer.from([0]), Buffer.from(str, 'utf8')]));
			}
			return;
		}
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (upstream.readyState === WebSocket.OPEN) {
			upstream.send(Buffer.concat([Buffer.from([0]), buf]));
		}
	});
	browserWs.on('close', () => {
		browserClosed = true;
		if (upstream.readyState === WebSocket.OPEN) {
			try {
				upstream.close(1000, 'client close');
			} catch {
				/* noop */
			}
		}
	});
	browserWs.on('error', () => {
		browserClosed = true;
		if (upstream.readyState === WebSocket.OPEN) {
			try {
				upstream.close(1011, 'client error');
			} catch {
				/* noop */
			}
		}
	});
}
