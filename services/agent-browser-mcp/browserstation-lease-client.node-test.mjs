import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { postBrowserLease } from "./browserstation-lease-client.mjs";

describe("BrowserStation lease client", () => {
	let baseUrl;
	let disconnectNext = false;
	let server;
	const requests = [];
	const sockets = new Set();

	before(async () => {
		server = http.createServer((request, response) => {
			sockets.add(request.socket);
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					method: request.method,
					url: request.url,
					connection: request.headers.connection,
					apiKey: request.headers["x-api-key"],
					body: Buffer.concat(chunks).toString("utf8"),
				});
				if (disconnectNext) {
					disconnectNext = false;
					response.writeHead(200, { "Content-Type": "application/json" });
					response.write('{"browser_id":');
					setImmediate(() => response.destroy());
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end('{"browser_id":"lease-1"}');
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	it("uses one nonpooled connection for each browser creation", async () => {
		for (let index = 0; index < 2; index += 1) {
			const response = await postBrowserLease({
				baseUrl,
				apiKey: "test-key",
			});
			assert.equal(response.ok, true);
			assert.equal((await response.json()).browser_id, "lease-1");
		}

		assert.equal(requests.length, 2);
		assert.equal(sockets.size, 2);
		for (const request of requests) {
			assert.deepEqual(request, {
				method: "POST",
				url: "/browsers",
				connection: "close",
				apiKey: "test-key",
				body: "{}",
			});
		}
	});

	it("rejects when the server disconnects after sending response headers", async () => {
		disconnectNext = true;
		await assert.rejects(
			postBrowserLease({
				baseUrl,
				apiKey: "test-key",
				timeoutMs: 1_000,
			}),
			/aborted|reset|socket/i,
		);
	});
});
