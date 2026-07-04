import http from 'node:http';
import fs from 'node:fs/promises';
import process from 'node:process';
import './instrumentation.server.js';
import { handler } from './build/handler.js';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TERMINAL_PATH_RE = /^\/api\/sandboxes\/([^/]+)\/terminal\/([^/]+)$/;
const OPENSHELL_SESSION_TERMINAL_PATH_RE =
	/^\/api\/openshell\/sessions\/([^/]+)\/terminal\/([^/]+)$/;
const SHELL_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/shell$/;
const CLI_TERMINAL_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/cli-terminal\/([^/]+)$/;
const CLI_TERMINAL_KEEPALIVE_MS = 30000;

// Preflight origin: the BFF hits itself for the resolver endpoint that
// enforces auth + workspace scope. The `SHELL_RESOLVER_ORIGIN` env var
// is a test-only escape hatch.
const SHELL_RESOLVER_ORIGIN =
	process.env.SHELL_RESOLVER_ORIGIN || `http://127.0.0.1:${PORT}`;

const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';

function getUpstreamWsUrl() {
	return (
		process.env.OPENSHELL_AGENT_RUNTIME_WS_BASE_URL ||
		process.env.OPENSHELL_AGENT_RUNTIME_WS_URL ||
		'ws://openshell-agent-runtime.openshell.svc.cluster.local:8084'
	);
}

function getOpenShellRuntimeToken() {
	return (
		process.env.OPENSHELL_AGENT_RUNTIME_INTERNAL_TOKEN ||
		process.env.INTERNAL_API_TOKEN ||
		''
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

// Shutdown states: draining = /healthz reports 503 (readiness pulls the pod
// out of Service endpoints) but requests/upgrades still serve; closing = the
// listener is closed and new upgrades are refused.
let draining = false;
let closing = false;

const server = http.createServer((req, res) => {
	if (req.url === '/healthz' || req.url?.startsWith('/healthz?')) {
		const code = draining ? 503 : 200;
		res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
		res.end(draining ? 'draining' : 'ok');
		return;
	}
	handler(req, res);
});

server.on('upgrade', (req, socket, head) => {
	if (closing) {
		socket.destroy();
		return;
	}
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const shellMatch = url.pathname.match(SHELL_PATH_RE);
	if (shellMatch) {
		handleShellUpgrade(req, socket, head, shellMatch[1], url.searchParams.get('container') || 'chromium');
		return;
	}
	const cliTerminalMatch = url.pathname.match(CLI_TERMINAL_PATH_RE);
	if (cliTerminalMatch) {
		handleCliTerminalUpgrade(
			req,
			socket,
			head,
			cliTerminalMatch[1],
			cliTerminalMatch[2],
			url.search
		);
		return;
	}
	const openshellSessionMatch = url.pathname.match(OPENSHELL_SESSION_TERMINAL_PATH_RE);
	if (openshellSessionMatch) {
		handleOpenShellSessionTerminalUpgrade(
			req,
			socket,
			head,
			openshellSessionMatch[1],
			openshellSessionMatch[2]
		);
		return;
	}
	const match = url.pathname.match(TERMINAL_PATH_RE);
	if (!match) {
		socket.destroy();
		return;
	}

	const sandboxName = decodeURIComponent(match[1]);
	const sessionId = decodeURIComponent(match[2]);
	handleOpenShellSandboxTerminalUpgrade(req, socket, head, sandboxName, sessionId);
});

async function resolveSandboxTerminal(req, sandboxName, terminalId) {
	const resolverUrl =
		`${SHELL_RESOLVER_ORIGIN}/api/sandboxes/${encodeURIComponent(sandboxName)}` +
		`/terminal/${encodeURIComponent(terminalId)}/resolve`;
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

async function resolveOpenShellTerminal(req, sessionId, terminalId) {
	const resolverUrl =
		`${SHELL_RESOLVER_ORIGIN}/api/openshell/sessions/${encodeURIComponent(sessionId)}` +
		`/terminal/${encodeURIComponent(terminalId)}/resolve`;
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

function writeWsPreflightError(socket, status) {
	const code = status === 401 ? 401 : status === 404 ? 404 : status === 409 ? 409 : 503;
	const name =
		code === 401
			? 'Unauthorized'
			: code === 404
				? 'Not Found'
				: code === 409
					? 'Conflict'
					: 'Service Unavailable';
	socket.write(`HTTP/1.1 ${code} ${name}\r\n\r\n`);
	socket.destroy();
}

function handleOpenShellSandboxTerminalUpgrade(req, socket, head, sandboxName, terminalId) {
	(async () => {
		const res = await resolveSandboxTerminal(req, sandboxName, terminalId);
		if (res.error) {
			writeWsPreflightError(socket, res.error);
			return;
		}
		proxyOpenShellTerminal(req, socket, head, res.sandboxName, terminalId);
	})().catch(() => {
		try {
			socket.destroy();
		} catch {
			/* noop */
		}
	});
}

function handleOpenShellSessionTerminalUpgrade(req, socket, head, sessionIdRaw, terminalIdRaw) {
	const sessionId = decodeURIComponent(sessionIdRaw);
	const terminalId = decodeURIComponent(terminalIdRaw);
	(async () => {
		const res = await resolveOpenShellTerminal(req, sessionId, terminalId);
		if (res.error) {
			writeWsPreflightError(socket, res.error);
			return;
		}
		proxyOpenShellTerminal(req, socket, head, res.sandboxName, terminalId);
	})().catch(() => {
		try {
			socket.destroy();
		} catch {
			/* noop */
		}
	});
}

function proxyOpenShellTerminal(req, socket, head, sandboxName, sessionId) {
	const upstreamUrl = `${getUpstreamWsUrl().replace(/\/$/, '')}/terminal/${encodeURIComponent(sandboxName)}/${encodeURIComponent(sessionId)}`;
	const token = getOpenShellRuntimeToken();

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl, {
			headers: token ? { 'X-Internal-Token': token } : {}
		});
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
}

// ---------------------------------------------------------------------------
// Interactive-CLI terminal proxy: browser WS <-> per-session pod PTY WS.
// ---------------------------------------------------------------------------
//
// The Terminal tab opens /api/v1/sessions/<id>/cli-terminal/<terminalId>
// ?target=main|shell. We preflight via the cookie/JWT-gated resolver
// (/api/v1/sessions/<id>/cli-terminal/resolve -> { podIp, port }), then pipe
// to ws://<podIp>:<port>/terminal/<terminalId>?<query> on the cli-agent-py
// host, authenticating with X-Internal-Token. Framing passes through
// verbatim (binary = raw PTY bytes; text "\x01{json}" = resize, same
// convention as sandbox-terminal.svelte). 30s ping keepalive holds idle TUI
// sessions open.

async function resolveCliTerminal(req, sessionId) {
	const resolverUrl =
		`${SHELL_RESOLVER_ORIGIN}/api/v1/sessions/${encodeURIComponent(sessionId)}/cli-terminal/resolve`;
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

function handleCliTerminalUpgrade(req, socket, head, sessionIdRaw, terminalIdRaw, search) {
	const sessionId = decodeURIComponent(sessionIdRaw);
	const terminalId = decodeURIComponent(terminalIdRaw);
	(async () => {
		const res = await resolveCliTerminal(req, sessionId);
		if (res.error) {
			writeWsPreflightError(socket, res.error);
			return;
		}
		proxyCliTerminal(req, socket, head, res.podIp, res.port || 8002, terminalId, search || '');
	})().catch(() => {
		try {
			socket.destroy();
		} catch {
			/* noop */
		}
	});
}

function proxyCliTerminal(req, socket, head, podIp, port, terminalId, search) {
	const upstreamUrl = `ws://${podIp}:${port}/terminal/${encodeURIComponent(terminalId)}${search}`;
	const token = process.env.INTERNAL_API_TOKEN || '';

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const upstream = new WebSocket(upstreamUrl, {
			headers: token ? { 'X-Internal-Token': token } : {}
		});
		const pendingMessages = [];
		let keepalive = null;
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
			}, CLI_TERMINAL_KEEPALIVE_MS);
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
}

server.listen(PORT, HOST, () => {
	console.log(`Listening on http://${HOST}:${PORT}`);
});

// Drain instead of the old exit(1)-after-10s: that hard exit killed live
// terminal WebSockets and SSE streams on every rollout despite the pod's
// 90s terminationGracePeriodSeconds. Timeline (must fit inside that grace):
//   t=0            healthz -> 503; keep serving so the Service stops routing
//                  here BEFORE we refuse connections (no ECONNREFUSED blips;
//                  replaces a preStop sleep)
//   t=LAME_DUCK    close the listener + refuse new upgrades, ask WS clients
//                  to leave (1001 -> clients reconnect to a healthy pod; the
//                  PTYs live on in their pods), drop idle keep-alives
//   +FORCE_CLOSE   sever remaining sockets (open SSE streams would otherwise
//                  hold server.close() forever; EventSource auto-reconnects)
//                  -> server.close() completes -> exit 0
//   +5s            last-resort exit 1
const SHUTDOWN_LAME_DUCK_MS = parseInt(process.env.SHUTDOWN_LAME_DUCK_MS || '15000', 10);
const SHUTDOWN_FORCE_CLOSE_MS = parseInt(process.env.SHUTDOWN_FORCE_CLOSE_MS || '65000', 10);

function beginClosePhase() {
	if (closing) return;
	closing = true;
	console.log(`[shutdown] closing: refusing new connections, force-close in ${SHUTDOWN_FORCE_CLOSE_MS}ms`);

	server.close(() => {
		console.log('[shutdown] drained cleanly');
		process.exit(0);
	});
	server.closeIdleConnections();

	for (const ws of wss.clients) {
		try {
			ws.close(1001, 'server shutting down');
		} catch {
			/* noop */
		}
	}

	setTimeout(() => {
		console.log('[shutdown] force-closing remaining connections');
		try {
			server.closeAllConnections();
		} catch {
			/* noop */
		}
	}, SHUTDOWN_FORCE_CLOSE_MS).unref();

	// Ref'd on purpose: guarantees the process ends inside the pod's 90s
	// grace even if a handle is stuck; the clean-drain exit(0) preempts it.
	setTimeout(() => process.exit(1), SHUTDOWN_FORCE_CLOSE_MS + 5000);
}

function gracefulShutdown() {
	if (draining) {
		// Second signal (e.g. Ctrl-C again in local dev): stop waiting.
		process.exit(130);
	}
	draining = true;
	console.log(`[shutdown] draining: healthz=503, close phase in ${SHUTDOWN_LAME_DUCK_MS}ms`);
	setTimeout(beginClosePhase, SHUTDOWN_LAME_DUCK_MS);
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
