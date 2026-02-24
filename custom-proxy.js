const http = require("http");
const httpProxy = require("http-proxy");

const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on("error", (err, req, res) => {
	console.error("[Proxy Error]", err);
	if (res && res.writeHead) {
		res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("Proxy error");
	}
});

const server = http.createServer((req, res) => {
	const match = req.url.match(/^\/api\/sandbox-vnc\/([0-9.]+)\/(.*)$/);
	if (match) {
		const ip = match[1];
		const rest = match[2] || "";
		proxy.web(req, res, {
			target: `http://${ip}:6080/${rest}`,
			ignorePath: true,
		});
		return;
	}

	const aioMatch = req.url.match(/^\/api\/sandbox-aio\/([0-9.]+)\/(.*)$/);
	if (aioMatch) {
		const ip = aioMatch[1];
		const rest = aioMatch[2] || "";
		proxy.web(req, res, {
			target: `http://${ip}:8080/${rest}`,
			ignorePath: true,
		});
		return;
	}

	proxy.web(req, res, { target: "http://127.0.0.1:3001" });
});

server.on("upgrade", (req, socket, head) => {
	const match = req.url.match(/^\/api\/sandbox-vnc\/([0-9.]+)\/(.*)$/);
	if (match) {
		const ip = match[1];
		const rest = match[2] || "";
		proxy.ws(req, socket, head, {
			target: `http://${ip}:6080/${rest}`,
			ignorePath: true,
		});
		return;
	}

	const aioMatch = req.url.match(/^\/api\/sandbox-aio\/([0-9.]+)\/(.*)$/);
	if (aioMatch) {
		const ip = aioMatch[1];
		const rest = aioMatch[2] || "";
		proxy.ws(req, socket, head, {
			target: `http://${ip}:8080/${rest}`,
			ignorePath: true,
		});
		return;
	}

	proxy.ws(req, socket, head, { target: "http://127.0.0.1:3001" });
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
	console.log(
		`[Proxy] Custom server listening on port ${port}, routing to Next.js on 3001`,
	);
});
