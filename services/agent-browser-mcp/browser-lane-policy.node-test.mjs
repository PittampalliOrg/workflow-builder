import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	shouldCloseBrowserAfterCapture,
	shouldProvisionFarmBrowser,
} from "./browser-lane-policy.mjs";

describe("agent-browser lane policy", () => {
	it("offloads every execution-scoped browser when BrowserStation is configured", () => {
		assert.equal(
			shouldProvisionFarmBrowser({
				executionId: "exec-1",
				farmConfigured: true,
				laneExists: false,
			}),
			true,
		);
	});

	it("keeps anonymous and already-provisioned sessions local to their current lane", () => {
		assert.equal(
			shouldProvisionFarmBrowser({
				executionId: null,
				farmConfigured: true,
				laneExists: false,
			}),
			false,
		);
		assert.equal(
			shouldProvisionFarmBrowser({
				executionId: "exec-1",
				farmConfigured: true,
				laneExists: true,
			}),
			false,
		);
	});

	it("closes abandoned browsers after idle capture cleanup without double-closing explicit close", () => {
		assert.equal(shouldCloseBrowserAfterCapture("idle"), true);
		assert.equal(shouldCloseBrowserAfterCapture("close"), false);
	});

	it("wires the policy into the bridge and production image", () => {
		const bridge = readFileSync(new URL("./bridge.mjs", import.meta.url), "utf8");
		const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
		assert.match(bridge, /executionId: ctxRef\.value\.executionId/);
		assert.match(bridge, /shouldProvisionFarmBrowser\(/);
		assert.match(bridge, /shouldCloseBrowserAfterCapture\(reason\)/);
		assert.match(bridge, /name: "agent_browser_close"/);
		assert.match(dockerfile, /browser-lane-policy\.mjs/);
	});

	it("authorizes before selecting, provisioning, or spawning an execution lane", () => {
		const bridge = readFileSync(new URL("./bridge.mjs", import.meta.url), "utf8");
		const initialization = bridge.slice(bridge.indexOf('app.post("/mcp"'));
		const authorizeAt = initialization.indexOf(
			"await authorizeBrowserInitialization",
		);
		const sessionKeyAt = initialization.indexOf("const browserSession");
		const provisionAt = initialization.indexOf("ensureLaneBrowser(browserSession)");
		const spawnAt = initialization.indexOf("await makeProxy(ctxRef, browserSession)");
		assert.ok(authorizeAt >= 0);
		assert.ok(authorizeAt < sessionKeyAt);
		assert.ok(sessionKeyAt < provisionAt);
		assert.ok(provisionAt < spawnAt);
		assert.match(
			initialization.slice(authorizeAt, sessionKeyAt),
			/if \(!initialization\)[\s\S]*rejectBrowserAuthorization/,
		);
	});

	it("enforces the public tool allowlist before forwarding to the child", () => {
		const bridge = readFileSync(new URL("./bridge.mjs", import.meta.url), "utf8");
		const handler = bridge.slice(
			bridge.indexOf("server.setRequestHandler(CallToolRequestSchema"),
		);
		const authorizeAt = handler.indexOf("isExternallyCallableTool(");
		const forwardAt = handler.indexOf("child.callTool({ name, arguments:");
		assert.ok(authorizeAt >= 0);
		assert.ok(authorizeAt < forwardAt);
	});
});
