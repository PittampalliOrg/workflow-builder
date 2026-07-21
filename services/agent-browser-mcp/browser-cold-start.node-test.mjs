import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { waitForBrowserLaneCallReadiness } from "./browser-lane-policy.mjs";
import { preserveMultimodalToolResult } from "./vision-contract.mjs";

const CALL_WAIT_MS = 30;
const servers = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise((resolve) => {
					server.closeAllConnections?.();
					server.close(resolve);
				}),
		),
	);
});

async function createColdStartHarness() {
	let resolveReady;
	const operation = new AbortController();
	let leaseAllocations = 0;
	const allocateLane = () => {
		leaseAllocations += 1;
		return {
			browserId: "browser-station-1",
			launchHash: "stable-launch-1",
			ready: new Promise((resolve) => {
				resolveReady = resolve;
			}),
			closed: false,
		};
	};
	const lane = allocateLane();
	const originalLane = lane;
	const observedBrowserIds = [];
	let closeCalls = 0;

	const sessions = new Map();
	const app = express();
	app.use(express.json());

	function createMcpServer() {
		const server = new Server(
			{ name: "browser-cold-start-test", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "agent_browser_screenshot",
					description: "Capture native browser pixels.",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "agent_browser_close",
					description: "Close the execution browser.",
					inputSchema: { type: "object", properties: {} },
				},
			],
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (request.params.name === "agent_browser_close") {
				if (!lane.closed) {
					lane.closed = true;
					closeCalls += 1;
				}
				return { content: [{ type: "text", text: "closed" }] };
			}
			assert.equal(request.params.name, "agent_browser_screenshot");
			observedBrowserIds.push(lane.browserId);
			const readiness = await waitForBrowserLaneCallReadiness({
				ready: lane.ready,
				signal: operation.signal,
				timeoutMs: CALL_WAIT_MS,
			});
			if (readiness.state === "pending") {
				return {
					content: [
						{
							type: "text",
							text: "The browser is still provisioning; retry this exact call.",
						},
					],
					isError: true,
				};
			}
			assert.equal(readiness.state, "ready");
			return preserveMultimodalToolResult({
				content: [
					{
						type: "text",
						text: `browserId=${lane.browserId} launchHash=${lane.launchHash}`,
					},
					{
						type: "image",
						data: "iVBORw0KGgoAAA",
						mimeType: "image/png",
					},
				],
			});
		});
		return server;
	}

	app.post("/mcp", async (req, res) => {
		const sessionId = req.headers["mcp-session-id"];
		const existing =
			typeof sessionId === "string" ? sessions.get(sessionId) : null;
		if (existing) {
			await existing.handleRequest(req, res, req.body);
			return;
		}
		if (req.body?.method !== "initialize") {
			res.status(400).send("initialization required");
			return;
		}
		const server = createMcpServer();
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => "cold-start-session",
			onsessioninitialized: (newSessionId) => {
				sessions.set(newSessionId, transport);
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
		};
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	});

	for (const method of ["get", "delete"]) {
		app[method]("/mcp", async (req, res) => {
			const sessionId = req.headers["mcp-session-id"];
			const transport =
				typeof sessionId === "string" ? sessions.get(sessionId) : null;
			if (!transport) {
				res.status(400).send("invalid session");
				return;
			}
			await transport.handleRequest(req, res);
		});
	}

	const httpServer = await new Promise((resolve) => {
		const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
	});
	servers.push(httpServer);
	const address = httpServer.address();
	assert.ok(address && typeof address === "object");
	return {
		url: new URL(`http://127.0.0.1:${address.port}/mcp`),
		lane,
		originalLane,
		observedBrowserIds,
		markReady() {
			resolveReady(true);
		},
		get leaseAllocations() {
			return leaseAllocations;
		},
		get closeCalls() {
			return closeCalls;
		},
	};
}

describe("BrowserStation cold-start MCP contract", () => {
	it("returns a bounded retry, then reuses one browser for native vision and close", async () => {
		const harness = await createColdStartHarness();
		const client = new Client(
			{ name: "browser-cold-start-consumer", version: "1.0.0" },
			{ capabilities: {} },
		);
		const transport = new StreamableHTTPClientTransport(harness.url);
		try {
			await client.connect(transport);
			const startedAt = Date.now();
			const pending = await client.callTool({
				name: "agent_browser_screenshot",
				arguments: {},
			});
			const elapsedMs = Date.now() - startedAt;
			assert.equal(pending.isError, true);
			assert.match(pending.content[0].text, /still provisioning/);
			assert.ok(elapsedMs >= CALL_WAIT_MS - 10, `returned in ${elapsedMs}ms`);
			assert.ok(elapsedMs < 500, `retry exceeded its bound: ${elapsedMs}ms`);
			assert.strictEqual(harness.lane, harness.originalLane);
			assert.equal(harness.leaseAllocations, 1);
			assert.equal(harness.lane.closed, false);

			harness.markReady();
			const screenshot = await client.callTool({
				name: "agent_browser_screenshot",
				arguments: {},
			});
			assert.equal(screenshot.isError, undefined);
			assert.deepEqual(screenshot.content[1], {
				type: "image",
				data: "iVBORw0KGgoAAA",
				mimeType: "image/png",
			});
			assert.match(screenshot.content[0].text, /stable-launch-1/);
			assert.deepEqual(harness.observedBrowserIds, [
				"browser-station-1",
				"browser-station-1",
			]);

			await client.callTool({ name: "agent_browser_close", arguments: {} });
			assert.equal(harness.closeCalls, 1);
			assert.equal(harness.lane.closed, true);
		} finally {
			await client.close().catch(() => {});
		}
		assert.equal(harness.closeCalls, 1);
	});
});
