import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	createBrowserContextRegistry,
	finalizeBrowserClose,
	shouldCloseBrowserAfterCapture,
	shouldProvisionFarmBrowser,
} from "./browser-lane-policy.mjs";

async function waitUntil(predicate, label) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

	it("never provisions an executionless lane and reuses an existing execution lane", () => {
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

	it("serializes close and reinitialize without double release or stale cleanup", async () => {
		let finishFirstRelease;
		const firstReleaseGate = new Promise((resolve) => {
			finishFirstRelease = resolve;
		});
		const releasedGenerations = [];
		const registry = createBrowserContextRegistry({
			createState: () => ({ cache: new Map() }),
			releaseResources: async (context) => {
				releasedGenerations.push(context.generation);
				context.cache.clear();
				if (context.generation === 1) await firstReleaseGate;
			},
		});
		const browserSession = "wfb-execution-1";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const firstLease = registry.acquire(browserSession, authorizationBinding);
		assert.ok(firstLease);
		const first = firstLease.context;
		first.cache.set("cookie", "owner-cookie");
		const sharedLease = registry.acquire(browserSession, authorizationBinding);
		assert.equal(sharedLease.context, first);
		assert.equal(
			registry.acquire(
				browserSession,
				"wfb_browser_binding_v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			),
			null,
		);

		const closeClaim = registry.claimClose(first);
		assert.ok(closeClaim);
		assert.equal(registry.claimClose(first), null);
		const firstCleanup = registry.release(first, closeClaim);
		const concurrentCleanup = registry.release(first, closeClaim);
		assert.equal(firstCleanup, concurrentCleanup);
		assert.equal(first.released, true);
		assert.equal(registry.current(browserSession), null);
		assert.equal(registry.acquire(browserSession, authorizationBinding), null);

		finishFirstRelease();
		assert.equal(await firstCleanup, true);
		assert.deepEqual(releasedGenerations, [first.generation]);
		const replacementLease = registry.acquire(
			browserSession,
			authorizationBinding,
		);
		assert.ok(replacementLease);
		const replacement = replacementLease.context;
		assert.notEqual(replacement, first);
		assert.ok(replacement.generation > first.generation);
		assert.equal(registry.current(browserSession), replacement);

		assert.equal(await registry.release(first, closeClaim), true);
		assert.equal(registry.current(browserSession), replacement);
		assert.deepEqual(releasedGenerations, [first.generation]);
		const replacementClaim = registry.claimClose(replacement);
		assert.ok(replacementClaim);
		assert.equal(await registry.release(replacement, replacementClaim), true);
		assert.deepEqual(releasedGenerations, [
			first.generation,
			replacement.generation,
		]);
	});

	it("allows exactly one of two concurrent MCP sessions to close the shared browser", async () => {
		let finishChildClose;
		const childCloseGate = new Promise((resolve) => {
			finishChildClose = resolve;
		});
		let childCloseCalls = 0;
		const registry = createBrowserContextRegistry();
		const browserSession = "wfb-execution-1";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const firstSession = registry.acquire(browserSession, authorizationBinding);
		const secondSession = registry.acquire(
			browserSession,
			authorizationBinding,
		);
		assert.equal(firstSession.context, secondSession.context);
		assert.equal(registry.commit(firstSession), true);
		assert.equal(registry.commit(secondSession), true);

		async function closeFromSession() {
			const claim = registry.claimClose(firstSession.context);
			if (!claim) {
				return registry.waitForCloseResponse(firstSession.context);
			}
			await finalizeBrowserClose({
				registry,
				context: firstSession.context,
				claim,
				timeoutMs: 1_000,
				finalize: async () => {
					await childCloseGate;
					childCloseCalls += 1;
				},
			});
			return "owner";
		}

		const owner = closeFromSession();
		const follower = closeFromSession();
		await Promise.resolve();
		assert.equal(childCloseCalls, 0);
		finishChildClose();
		assert.deepEqual(await Promise.all([owner, follower]), ["owner", true]);
		assert.equal(childCloseCalls, 1);
	});

	it("settles a concurrent follower false when owner finalization fails", async () => {
		const registry = createBrowserContextRegistry();
		const browserSession = "wfb-execution-failed-close";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const ownerLease = registry.acquire(browserSession, authorizationBinding);
		const followerLease = registry.acquire(browserSession, authorizationBinding);
		assert.equal(registry.commit(ownerLease), true);
		assert.equal(registry.commit(followerLease), true);
		const claim = registry.claimClose(ownerLease.context);
		assert.ok(claim);
		const follower = registry.waitForCloseResponse(followerLease.context);
		await assert.rejects(
			finalizeBrowserClose({
				registry,
				context: ownerLease.context,
				claim,
				timeoutMs: 1_000,
				finalize: async () => {
					throw new Error("close failed");
				},
			}),
			/close failed/,
		);
		assert.equal(await follower, false);
		await waitUntil(() => registry.current(browserSession) === null, "failed close release");
	});

	it("settles timed-out callers but fences replacement until finalize and cancel drain", async () => {
		let finishFinalization;
		const finalizationGate = new Promise((resolve) => {
			finishFinalization = resolve;
		});
		let finishCancellation;
		const cancellationGate = new Promise((resolve) => {
			finishCancellation = resolve;
		});
		const observedGenerations = [];
		const registry = createBrowserContextRegistry({
			createState: () => ({ touchedByOldWork: [] }),
		});
		const browserSession = "wfb-execution-deadline";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const ownerLease = registry.acquire(browserSession, authorizationBinding);
		const followerLease = registry.acquire(browserSession, authorizationBinding);
		assert.equal(registry.commit(ownerLease), true);
		assert.equal(registry.commit(followerLease), true);
		const oldContext = ownerLease.context;
		const claim = registry.claimClose(ownerLease.context);
		assert.ok(claim);
		assert.equal(registry.claimClose(followerLease.context), null);
		const follower = registry.waitForCloseResponse(followerLease.context);
		const owner = finalizeBrowserClose({
			registry,
			context: ownerLease.context,
			claim,
			timeoutMs: 10,
			finalize: async () => {
				// Deliberately ignore abort to reproduce stale old-generation work.
				await finalizationGate;
				const visible = registry.current(browserSession);
				observedGenerations.push(visible?.generation ?? null);
				visible?.touchedByOldWork.push("finalize");
			},
			cancel: async () => {
				await cancellationGate;
				const visible = registry.current(browserSession);
				observedGenerations.push(visible?.generation ?? null);
				visible?.touchedByOldWork.push("cancel");
			},
		});
		await assert.rejects(owner, /close finalization exceeded 10ms/);
		assert.equal(await follower, false);
		assert.equal(registry.current(browserSession), oldContext);
		assert.equal(registry.acquire(browserSession, authorizationBinding), null);

		finishFinalization();
		await waitUntil(
			() => oldContext.touchedByOldWork.includes("finalize"),
			"late finalization",
		);
		assert.equal(registry.current(browserSession), oldContext);
		assert.equal(registry.acquire(browserSession, authorizationBinding), null);

		finishCancellation();
		await waitUntil(
			() => oldContext.touchedByOldWork.includes("cancel"),
			"late cancellation",
		);
		let replacementLease = null;
		await waitUntil(() => {
			replacementLease = registry.acquire(browserSession, authorizationBinding);
			return Boolean(replacementLease);
		}, "replacement admission");
		assert.deepEqual(observedGenerations, [oldContext.generation, oldContext.generation]);
		assert.deepEqual(oldContext.touchedByOldWork, ["finalize", "cancel"]);
		assert.ok(replacementLease.context.generation > oldContext.generation);
		assert.deepEqual(replacementLease.context.touchedByOldWork, []);
	});

	it("keeps a follower context current when its creator initialization fails", async () => {
		const releasedGenerations = [];
		const registry = createBrowserContextRegistry({
			releaseResources: async (context) => {
				releasedGenerations.push(context.generation);
			},
		});
		const browserSession = "wfb-execution-1";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const creator = registry.acquire(browserSession, authorizationBinding);
		const follower = registry.acquire(browserSession, authorizationBinding);
		assert.equal(creator.context, follower.context);
		assert.equal(registry.commit(follower), true);
		assert.equal(await registry.abandon(creator), true);
		assert.equal(registry.current(browserSession), follower.context);
		assert.deepEqual(releasedGenerations, []);

		assert.equal(registry.detach(follower), true);
		assert.equal(registry.detach(follower), false);
		assert.equal(registry.current(browserSession), follower.context);
		const closeClaim = registry.claimClose(follower.context);
		assert.ok(closeClaim);
		await registry.release(follower.context, closeClaim);

		const failedCreator = registry.acquire(
			"wfb-execution-2",
			authorizationBinding,
		);
		const failedFollower = registry.acquire(
			"wfb-execution-2",
			authorizationBinding,
		);
		assert.equal(await registry.abandon(failedCreator), true);
		assert.equal(registry.current("wfb-execution-2"), failedFollower.context);
		assert.equal(await registry.abandon(failedFollower), true);
		assert.equal(registry.current("wfb-execution-2"), null);
		assert.deepEqual(releasedGenerations, [1, 2]);
	});

	it("wires the policy into the bridge and production image", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const dockerfile = readFileSync(
			new URL("./Dockerfile", import.meta.url),
			"utf8",
		);
		assert.match(bridge, /executionId: ctxRef\.value\.executionId/);
		assert.match(bridge, /shouldProvisionFarmBrowser\(/);
		assert.match(bridge, /shouldCloseBrowserAfterCapture\(reason\)/);
		assert.match(bridge, /name: "agent_browser_close"/);
		assert.match(dockerfile, /browser-lane-policy\.mjs/);
		assert.match(dockerfile, /mcp-session-lifecycle\.mjs/);
		assert.match(dockerfile, /target-auth-policy\.mjs/);
	});

	it("authorizes before selecting, provisioning, or spawning an execution lane", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const initialization = bridge.slice(bridge.indexOf('app.post("/mcp"'));
		const authorizeAt = initialization.indexOf(
			"await authorizeBrowserInitialization",
		);
		const sessionKeyAt = initialization.indexOf("const browserSession");
		const provisionAt = initialization.indexOf(
			"ensureLaneBrowser(browserContext)",
		);
		const spawnAt = initialization.indexOf(
			"await makeProxy(ctxRef, browserContext)",
		);
		assert.ok(authorizeAt >= 0);
		assert.ok(authorizeAt < sessionKeyAt);
		assert.ok(sessionKeyAt < provisionAt);
		assert.ok(provisionAt < spawnAt);
		assert.match(
			initialization.slice(authorizeAt, sessionKeyAt),
			/if \(!initialization\)[\s\S]*rejectBrowserAuthorization/,
		);
		assert.doesNotMatch(initialization, /wfb-anon/);
	});

	it("tracks initialization leases through success, failure, and transport close", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const initialization = bridge.slice(bridge.indexOf('app.post("/mcp"'));
		assert.match(
			initialization,
			/const acquisition = browserContexts\.acquire\(/,
		);
		assert.match(
			initialization,
			/const \{ context: browserContext \} = acquisition/,
		);
		assert.match(
			initialization,
			/makeProxy\(ctxRef, browserContext\)[\s\S]*browserContexts\.abandon\(acquisition\)/,
		);
		assert.match(initialization, /createMcpSessionLifecycle\(\{/);
		assert.match(initialization, /onsessioninitialized:[\s\S]*lifecycle\.initialize\(/);
		assert.match(initialization, /transport\.onclose[\s\S]*lifecycle\.dispose\(\)/);
		assert.match(initialization, /cleanupUncommittedAfterHandle\(\)/);
	});

	it("keeps captured close finalization inside entry-aware release", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const stopCapture = bridge.slice(
			bridge.indexOf("async function stopCapture"),
			bridge.indexOf("function targetAuthExchangeInput"),
		);
		assert.match(stopCapture, /entry\.browserContext !== browserContext/);
		assert.match(stopCapture, /browserContexts\.ownsClose\(\s*browserContext/);
		assert.doesNotMatch(stopCapture, /browserContexts\.claimClose\(browserContext\)/);
		assert.doesNotMatch(stopCapture, /browserContexts\.release\(/);
		assert.match(
			bridge,
			/const browserContext = entry\.browserContext;[\s\S]*claimClose\(browserContext\)[\s\S]*finalizeBrowserClose\(\{[\s\S]*"idle"/,
		);
		const handler = bridge.slice(
			bridge.indexOf("server.setRequestHandler(CallToolRequestSchema"),
			bridge.indexOf("const cleanup = async"),
		);
		assert.match(
			handler,
			/claimClose\(browserContext\)[\s\S]*waitForCloseResponse\(browserContext\)[\s\S]*if \(closesBrowser\) \{[\s\S]*finalizeBrowserClose\(\{[\s\S]*stopCapture\([\s\S]*"close"[\s\S]*child\.callTool\(/,
		);
		assert.equal(
			handler.match(/return browserCloseFollowerResult\(closeSucceeded\);/g)?.length,
			2,
		);
		assert.match(
			bridge,
			/function browserCloseFollowerResult\(closeSucceeded\)[\s\S]*if \(!closeSucceeded\) return browserCloseFailureResult\(\)/,
		);
		assert.match(
			handler,
			/catch \(err\)[\s\S]*close finalization failed[\s\S]*return browserCloseFailureResult\(\)/,
		);
	});

	it("enforces the public tool allowlist before forwarding to the child", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const handler = bridge.slice(
			bridge.indexOf("server.setRequestHandler(CallToolRequestSchema"),
		);
		const authorizeAt = handler.indexOf("isExternallyCallableTool(");
		const sanitizeAt = handler.indexOf(
			"sanitizeExternalToolArguments(name, args)",
		);
		const refreshAt = handler.indexOf("await refreshTargetAuthCookie(");
		const forwardAt = handler.indexOf(
			"child.callTool({ name, arguments: sanitizedArgs",
		);
		assert.ok(authorizeAt >= 0);
		assert.ok(authorizeAt < sanitizeAt);
		assert.ok(sanitizeAt < refreshAt);
		assert.ok(refreshAt < forwardAt);
		assert.match(
			handler.slice(refreshAt, forwardAt),
			/await refreshTargetAuthCookie[\s\S]*the tool was not called/,
		);
		assert.match(
			handler.slice(refreshAt, forwardAt),
			/prepareTargetAuth[\s\S]*prepared === "failed"[\s\S]*navigation was not attempted/,
		);
	});

	it("revalidates every existing-session transport request with the BFF", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const sessionGate = bridge.slice(
			bridge.indexOf("async function requestMatchesSessionAuthorization"),
			bridge.indexOf("function rejectBrowserAuthorization"),
		);
		assert.match(sessionGate, /reauthorizeBrowserSession\(/);
		assert.match(sessionGate, /validateTargetAuth\(/);
		assert.match(sessionGate, /internalToken: TOKEN/);
		const existingPost = bridge.slice(
			bridge.indexOf("if (existingSession)"),
			bridge.indexOf('if (req.body?.method !== "initialize")'),
		);
		assert.match(existingPost, /await requestMatchesSessionAuthorization/);
		const replay = bridge.slice(bridge.indexOf("async function replay"));
		assert.match(replay, /await requestMatchesSessionAuthorization/);
		assert.match(replay, /requestMatchesSessionTerminationAuthorization/);
		assert.match(replay, /finally \{[\s\S]*session\.dispose\(\)/);
	});
});
