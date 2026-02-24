const http = require("http");

function proxyRequest(req, res, targetUrl) {
	const url = new URL(targetUrl);
	const options = {
		hostname: url.hostname,
		port: url.port || 80,
		path: url.pathname + url.search,
		method: req.method,
		headers: { ...req.headers, host: url.host },
	};

	const proxyReq = http.request(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on("error", (err) => {
		console.error("[Proxy Error]", err.message);
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "text/plain" });
		}
		res.end("Proxy error");
	});

	req.pipe(proxyReq, { end: true });
}

function proxyWebSocket(req, socket, head, targetUrl) {
	const url = new URL(targetUrl);
	const port = url.port || 80;

	const proxySocket = require("net").connect(
		{ host: url.hostname, port },
		() => {
			const path = url.pathname + url.search;
			const reqHeaders = [`GET ${path} HTTP/1.1`];
			for (const [key, value] of Object.entries(req.headers)) {
				if (key.toLowerCase() === "host") {
					reqHeaders.push(`Host: ${url.host}`);
				} else {
					reqHeaders.push(
						`${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
					);
				}
			}
			reqHeaders.push("", "");
			proxySocket.write(reqHeaders.join("\r\n"));
			if (head && head.length) proxySocket.write(head);
			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
		},
	);

	proxySocket.on("error", (err) => {
		console.error("[WS Proxy Error]", err.message);
		socket.end();
	});

	socket.on("error", () => proxySocket.end());
}

function matchSandboxRoute(url) {
	const vncMatch = url.match(/^\/api\/sandbox-vnc\/([0-9.]+)\/(.*)$/);
	if (vncMatch) return `http://${vncMatch[1]}:6080/${vncMatch[2]}`;

	const aioMatch = url.match(/^\/api\/sandbox-aio\/([0-9.]+)\/(.*)$/);
	if (aioMatch) return `http://${aioMatch[1]}:8080/${aioMatch[2]}`;

	return null;
}

const server = http.createServer((req, res) => {
	const sandboxTarget = matchSandboxRoute(req.url);
	if (sandboxTarget) {
		proxyRequest(req, res, sandboxTarget);
		return;
	}
	proxyRequest(req, res, `http://127.0.0.1:3001${req.url}`);
});

server.on("upgrade", (req, socket, head) => {
	const sandboxTarget = matchSandboxRoute(req.url);
	if (sandboxTarget) {
		proxyWebSocket(req, socket, head, sandboxTarget);
		return;
	}
	proxyWebSocket(req, socket, head, `http://127.0.0.1:3001${req.url}`);
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
	console.log(
		`[Proxy] Custom server listening on port ${port}, routing to Next.js on 3001`,
	);
});
