import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserContextRegistry, finalizeBrowserClose } from "./browser-lane-policy.mjs";
import { createMcpSessionLifecycle } from "./mcp-session-lifecycle.mjs";
import {
	authorizeBrowserSessionTermination,
	targetAuthAssertionDigest,
} from "./target-auth-policy.mjs";

const ASSERTION = "wfb_browser_auth_v1.test-browser-target-assertion";
const EXECUTION_ID = "execution-1";
const AUTHORIZATION_BINDING = "wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROTOCOL_VERSION = "2025-06-18";
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

function initializeBody() {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "browser-lifecycle-test", version: "1.0.0" },
		},
	};
}

function requestHeaders(extra = {}) {
	return {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		"x-wfb-execution-id": EXECUTION_ID,
		"x-wfb-browser-target-assertion": ASSERTION,
		...extra,
	};
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function createSdkHarness() {
	const sessions = new Map();
	const acquisitions = [];
	let childCloseCalls = 0;
	let cleanupCalls = 0;
	const registry = createBrowserContextRegistry();
	const app = express();
	app.use(express.json());

	app.post("/mcp", async (req, res) => {
		const existingSessionId = req.headers["mcp-session-id"];
		const existing = typeof existingSessionId === "string" ? sessions.get(existingSessionId) : null;
		if (existing) {
			await existing.transport.handleRequest(req, res, req.body);
			return;
		}

		const acquisition = registry.acquire(`wfb-${EXECUTION_ID}`, AUTHORIZATION_BINDING);
		assert.ok(acquisition);
		acquisitions.push(acquisition);
		if (req.headers["x-test-close-before-commit"] === "true") {
			const claim = registry.claimClose(acquisition.context);
			assert.ok(claim);
			await registry.release(acquisition.context, claim);
		}

		const server = new Server(
			{ name: "browser-lifecycle-test", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			assert.equal(request.params.name, "agent_browser_close");
			const claim = registry.claimClose(acquisition.context);
			if (!claim) {
				await registry.waitForClose(acquisition.context);
				return {
					content: [{ type: "text", text: "already closed" }],
				};
			}
			await finalizeBrowserClose({
				registry,
				context: acquisition.context,
				claim,
				timeoutMs: 1_000,
				finalize: async () => {
					childCloseCalls += 1;
				},
			});
			return { content: [{ type: "text", text: "closed" }] };
		});

		let transport;
		const lifecycle = createMcpSessionLifecycle({
			registry,
			acquisition,
			sessions,
			cleanup: async () => {
				cleanupCalls += 1;
			},
			getTransportSessionId: () => transport?.sessionId ?? null,
		});
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => `session-${acquisitions.length}`,
			onsessioninitialized: (sessionId) => {
				lifecycle.initialize(sessionId, {
					transport,
					executionId: EXECUTION_ID,
					assertionDigest: targetAuthAssertionDigest(ASSERTION),
					authorizationBinding: AUTHORIZATION_BINDING,
					browserContext: acquisition.context,
				});
			},
		});
		transport.onclose = () => lifecycle.dispose().catch(() => {});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
			await lifecycle.cleanupUncommittedAfterHandle().catch(() => {});
		} catch (error) {
			await lifecycle.dispose().catch(() => {});
			if (!res.headersSent) res.status(500).json({ error: String(error) });
		}
	});

	app.delete("/mcp", async (req, res) => {
		const sessionId = req.headers["mcp-session-id"];
		const session = typeof sessionId === "string" ? sessions.get(sessionId) : null;
		if (!session) {
			res.status(400).send("invalid session");
			return;
		}
		const authorized = authorizeBrowserSessionTermination({
			sessionId,
			executionId: req.headers["x-wfb-execution-id"],
			targetAuth: {
				assertion: req.headers["x-wfb-browser-target-assertion"],
			},
			expectedSessionId: session.sessionId,
			expectedExecutionId: session.executionId,
			expectedAssertionDigest: session.assertionDigest,
		});
		if (!authorized) {
			res.status(403).send("forbidden");
			return;
		}
		try {
			await session.transport.handleRequest(req, res);
		} finally {
			await session.dispose().catch(() => {});
		}
	});

	const httpServer = await new Promise((resolve) => {
		const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
	});
	servers.push(httpServer);
	const address = httpServer.address();
	assert.ok(address && typeof address === "object");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		registry,
		sessions,
		acquisitions,
		get childCloseCalls() {
			return childCloseCalls;
		},
		get cleanupCalls() {
			return cleanupCalls;
		},
	};
}

describe("MCP session lifecycle", () => {
	it("runs child cleanup even when registry disposal rejects", async () => {
		let cleanupCalls = 0;
		const lifecycle = createMcpSessionLifecycle({
			registry: {
				abandon: async () => {
					throw new Error("registry disposal failed");
				},
			},
			acquisition: {},
			sessions: new Map(),
			cleanup: async () => {
				cleanupCalls += 1;
			},
		});
		await assert.rejects(lifecycle.dispose(), /registry disposal failed/);
		assert.equal(cleanupCalls, 1);
		await assert.rejects(lifecycle.dispose(), /registry disposal failed/);
		assert.equal(cleanupCalls, 1);
	});

	it("terminates a closed browser session with its exact local capability", async () => {
		const harness = await createSdkHarness();
		const initialized = await fetch(`${harness.baseUrl}/mcp`, {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify(initializeBody()),
		});
		await initialized.text();
		assert.equal(initialized.status, 200);
		const sessionId = initialized.headers.get("mcp-session-id");
		assert.equal(sessionId, "session-1");
		await waitFor(() => harness.sessions.size === 1, "session commit");
		assert.equal(harness.acquisitions[0].state, "active");

		const closed = await fetch(`${harness.baseUrl}/mcp`, {
			method: "POST",
			headers: requestHeaders({
				"mcp-session-id": sessionId,
				"mcp-protocol-version": PROTOCOL_VERSION,
			}),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "agent_browser_close", arguments: {} },
			}),
		});
		await closed.text();
		assert.equal(closed.status, 200);
		assert.equal(harness.childCloseCalls, 1);
		assert.equal(harness.registry.current(`wfb-${EXECUTION_ID}`), null);

		const attacker = await fetch(`${harness.baseUrl}/mcp`, {
			method: "DELETE",
			headers: requestHeaders({
				"mcp-session-id": sessionId,
				"mcp-protocol-version": PROTOCOL_VERSION,
				"x-wfb-browser-target-assertion": `${ASSERTION}-attacker`,
			}),
		});
		await attacker.text();
		assert.equal(attacker.status, 403);
		assert.equal(harness.sessions.size, 1);

		const terminated = await fetch(`${harness.baseUrl}/mcp`, {
			method: "DELETE",
			headers: requestHeaders({
				"mcp-session-id": sessionId,
				"mcp-protocol-version": PROTOCOL_VERSION,
			}),
		});
		await terminated.text();
		assert.equal(terminated.status, 200);
		await waitFor(() => harness.cleanupCalls === 1, "child cleanup");
		assert.equal(harness.sessions.size, 0);
		assert.equal(harness.acquisitions[0].state, "detached");
		assert.equal(harness.childCloseCalls, 1);
	});

	it("abandons malformed authenticated initialization after the SDK responds", async () => {
		const harness = await createSdkHarness();
		const response = await fetch(`${harness.baseUrl}/mcp`, {
			method: "POST",
			headers: requestHeaders(),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION },
			}),
		});
		await response.text();
		assert.equal(response.status, 400);
		await waitFor(() => harness.cleanupCalls === 1, "malformed cleanup");
		assert.equal(harness.sessions.size, 0);
		assert.equal(harness.acquisitions[0].state, "abandoned");
		assert.equal(harness.registry.current(`wfb-${EXECUTION_ID}`), null);
	});

	it("abandons initialization when the SDK resolves an invalid Accept request", async () => {
		const harness = await createSdkHarness();
		const response = await fetch(`${harness.baseUrl}/mcp`, {
			method: "POST",
			headers: requestHeaders({ accept: "application/json" }),
			body: JSON.stringify(initializeBody()),
		});
		await response.text();
		assert.equal(response.status, 406);
		await waitFor(() => harness.cleanupCalls === 1, "invalid Accept cleanup");
		assert.equal(harness.sessions.size, 0);
		assert.equal(harness.acquisitions[0].state, "abandoned");
		assert.equal(harness.registry.current(`wfb-${EXECUTION_ID}`), null);
	});

	it("abandons the child when SDK session commit fails inside its callback", async () => {
		const harness = await createSdkHarness();
		const response = await fetch(`${harness.baseUrl}/mcp`, {
			method: "POST",
			headers: requestHeaders({ "x-test-close-before-commit": "true" }),
			body: JSON.stringify(initializeBody()),
		});
		await response.text();
		assert.equal(response.status, 400);
		await waitFor(() => harness.cleanupCalls === 1, "commit failure cleanup");
		assert.equal(harness.sessions.size, 0);
		assert.equal(harness.acquisitions[0].state, "abandoned");
		assert.equal(harness.registry.current(`wfb-${EXECUTION_ID}`), null);
	});
});
