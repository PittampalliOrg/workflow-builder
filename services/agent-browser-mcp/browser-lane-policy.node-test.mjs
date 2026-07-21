import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	createBrowserContextRegistry,
	deleteBrowserWithRetry,
	finalizeBrowserClose,
	resolveBrowserCloseChild,
	shouldCloseBrowserAfterCapture,
	shouldProvisionFarmBrowser,
} from "./browser-lane-policy.mjs";

async function waitUntil(predicate, label) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${label}`);
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

	it("treats a missing BrowserStation lease as an idempotent delete", async () => {
		let calls = 0;
		const deleted = await deleteBrowserWithRetry({
			request: async () => {
				calls += 1;
				return { ok: false, status: 404 };
			},
			sleep: async () => assert.fail("404 must not be retried"),
		});
		assert.equal(deleted, false);
		assert.equal(calls, 1);
	});

	it("retries transient BrowserStation deletion failures with bounded backoff", async () => {
		const outcomes = [
			{ ok: false, status: 503 },
			new Error("connection reset"),
			{ ok: true, status: 204 },
		];
		const delays = [];
		const attempts = [];
		const deleted = await deleteBrowserWithRetry({
			request: async (attempt) => {
				attempts.push(attempt);
				const outcome = outcomes.shift();
				if (outcome instanceof Error) throw outcome;
				return outcome;
			},
			attempts: 3,
			initialDelayMs: 10,
			sleep: async (delayMs) => delays.push(delayMs),
		});
		assert.equal(deleted, true);
		assert.deepEqual(attempts, [1, 2, 3]);
		assert.deepEqual(delays, [10, 20]);
	});

	it("fails persistent and permanent BrowserStation deletion errors", async () => {
		let transientCalls = 0;
		await assert.rejects(
			deleteBrowserWithRetry({
				request: async () => {
					transientCalls += 1;
					return { ok: false, status: 500 };
				},
				attempts: 3,
				initialDelayMs: 0,
				sleep: async () => {},
			}),
			/browser delete HTTP 500/,
		);
		assert.equal(transientCalls, 3);

		let permanentCalls = 0;
		await assert.rejects(
			deleteBrowserWithRetry({
				request: async () => {
					permanentCalls += 1;
					return { ok: false, status: 403 };
				},
				sleep: async () => assert.fail("403 must not be retried"),
			}),
			/browser delete HTTP 403/,
		);
		assert.equal(permanentCalls, 1);
	});

	it("never forwards farm close to an unbound child while provisioning", async () => {
		const unboundChild = { id: "unbound-local-child" };
		let bound = false;
		const selected = await resolveBrowserCloseChild({
			lane: { ready: Promise.resolve(false), cdpUrl: null },
			localChild: unboundChild,
			childCdpUrl: null,
			waitForLaneReady: (ready) => ready,
			bindLaneChild: async () => {
				bound = true;
				return { child: unboundChild, cdpUrl: null };
			},
		});
		assert.equal(selected, null);
		assert.equal(bound, false);
	});

	it("binds farm close to the exact established CDP target", async () => {
		const unboundChild = { id: "unbound-local-child" };
		const boundChild = { id: "farm-child" };
		const cdpUrl = "ws://browserstation/ws/browsers/farm/devtools/browser/id";
		const selected = await resolveBrowserCloseChild({
			lane: { ready: Promise.resolve(true), cdpUrl },
			localChild: unboundChild,
			childCdpUrl: null,
			waitForLaneReady: (ready) => ready,
			bindLaneChild: async (expectedCdpUrl) => ({
				child: boundChild,
				cdpUrl: expectedCdpUrl,
			}),
		});
		assert.equal(selected, boundChild);

		await assert.rejects(
			resolveBrowserCloseChild({
				lane: { ready: Promise.resolve(true), cdpUrl },
				localChild: unboundChild,
				childCdpUrl: null,
				waitForLaneReady: (ready) => ready,
				bindLaneChild: async () => ({
					child: boundChild,
					cdpUrl: "ws://wrong-target",
				}),
			}),
			/not bound to its farm lane/,
		);
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

	it("leases ordinary operations only while their browser generation is current", async () => {
		const registry = createBrowserContextRegistry();
		const browserSession = "wfb-execution-operation-lease";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const acquisition = registry.acquire(browserSession, authorizationBinding);
		assert.ok(acquisition);
		assert.equal(registry.commit(acquisition), true);

		const operation = registry.acquireOperation(
			acquisition.context,
			authorizationBinding,
		);
		assert.ok(operation);
		assert.equal(operation.generation, acquisition.context.generation);
		assert.equal(operation.signal.aborted, false);
		assert.equal(registry.hasOperations(acquisition.context), true);
		assert.equal(
			registry.acquireOperation(
				acquisition.context,
				"wfb_browser_binding_v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			),
			null,
		);

		const claim = registry.claimClose(acquisition.context);
		assert.ok(claim);
		assert.equal(
			registry.acquireOperation(acquisition.context, authorizationBinding),
			null,
		);
		assert.equal(registry.releaseOperation(operation), true);
		assert.equal(registry.hasOperations(acquisition.context), false);
		assert.equal(registry.releaseOperation(operation), false);
		assert.equal(
			await registry.waitForOperations(acquisition.context, claim, 0),
			true,
		);
		assert.equal(await registry.release(acquisition.context, claim), true);
	});

	it("bounds operation drain and lets only the close owner abort active work", async () => {
		const registry = createBrowserContextRegistry();
		const browserSession = "wfb-execution-operation-abort";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const acquisition = registry.acquire(browserSession, authorizationBinding);
		assert.ok(acquisition);
		assert.equal(registry.commit(acquisition), true);
		const first = registry.acquireOperation(acquisition.context);
		const second = registry.acquireOperation(acquisition.context);
		assert.ok(first);
		assert.ok(second);
		assert.equal(registry.hasOperations(acquisition.context), true);
		const claim = registry.claimClose(acquisition.context);
		assert.ok(claim);
		const impostor = Object.freeze({ nonce: Symbol("not-the-close-owner") });

		assert.equal(
			await registry.waitForOperations(acquisition.context, impostor, 0),
			false,
		);
		assert.equal(
			registry.abortOperations(acquisition.context, impostor),
			false,
		);
		assert.equal(
			await registry.waitForOperations(acquisition.context, claim, 10),
			false,
		);
		assert.throws(
			() => registry.waitForOperations(acquisition.context, claim, -1),
			/invalid browser operation drain deadline/,
		);

		const reason = new Error("operation drain grace expired");
		assert.equal(
			registry.abortOperations(acquisition.context, claim, reason),
			2,
		);
		assert.equal(first.signal.aborted, true);
		assert.equal(first.signal.reason, reason);
		assert.equal(second.signal.aborted, true);
		assert.equal(second.signal.reason, reason);
		assert.equal(
			registry.abortOperations(acquisition.context, claim, reason),
			0,
		);

		let drained = false;
		const drain = registry
			.waitForOperations(acquisition.context, claim)
			.then((result) => {
				drained = result;
				return result;
			});
		assert.equal(registry.releaseOperation(first), true);
		assert.equal(registry.hasOperations(acquisition.context), true);
		await Promise.resolve();
		assert.equal(drained, false);
		assert.equal(registry.releaseOperation(second), true);
		assert.equal(registry.hasOperations(acquisition.context), false);
		assert.equal(await drain, true);
		assert.equal(await registry.release(acquisition.context, claim), true);
	});

	it("aborts a forwarded child call and drains it before releasing resources", async () => {
		const events = [];
		const registry = createBrowserContextRegistry({
			releaseResources: async () => events.push("resources-released"),
		});
		const browserSession = "wfb-execution-operation-child";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const acquisition = registry.acquire(browserSession, authorizationBinding);
		assert.ok(acquisition);
		assert.equal(registry.commit(acquisition), true);
		const operation = registry.acquireOperation(acquisition.context);
		assert.ok(operation);

		const childCall = new Promise((resolve, reject) => {
			operation.signal.addEventListener(
				"abort",
				() => {
					events.push("child-aborted");
					reject(operation.signal.reason);
				},
				{ once: true },
			);
		}).finally(() => {
			events.push("operation-released");
			registry.releaseOperation(operation);
		});

		const claim = registry.claimClose(acquisition.context);
		assert.ok(claim);
		assert.equal(
			await registry.waitForOperations(acquisition.context, claim, 0),
			false,
		);
		const reason = new Error("close requested");
		assert.equal(
			registry.abortOperations(acquisition.context, claim, reason),
			1,
		);
		await assert.rejects(childCall, /close requested/);
		assert.equal(
			await registry.waitForOperations(acquisition.context, claim, 0),
			true,
		);
		assert.equal(await registry.release(acquisition.context, claim), true);
		assert.deepEqual(events, [
			"child-aborted",
			"operation-released",
			"resources-released",
		]);
	});

	it("fences resource release and replacement admission until stale work exits", async () => {
		let releaseStarted = false;
		const registry = createBrowserContextRegistry({
			createState: () => ({ mutations: [] }),
			releaseResources: async () => {
				releaseStarted = true;
			},
		});
		const browserSession = "wfb-execution-operation-fence";
		const authorizationBinding =
			"wfb_browser_binding_v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const acquisition = registry.acquire(browserSession, authorizationBinding);
		assert.ok(acquisition);
		assert.equal(registry.commit(acquisition), true);
		const oldContext = acquisition.context;
		const operation = registry.acquireOperation(oldContext);
		assert.ok(operation);
		const claim = registry.claimClose(oldContext);
		assert.ok(claim);

		const cleanup = registry.release(oldContext, claim);
		assert.equal(registry.current(browserSession), null);
		assert.equal(registry.acquire(browserSession, authorizationBinding), null);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(releaseStarted, false);
		assert.equal(registry.abortOperations(oldContext, claim), 1);
		assert.equal(operation.signal.aborted, true);
		assert.equal(registry.current(browserSession), null);
		assert.equal(registry.acquire(browserSession, authorizationBinding), null);

		// Work from the old generation cannot observe or mutate a replacement.
		const visibleToStaleWork = registry.current(browserSession);
		visibleToStaleWork?.mutations.push("stale mutation");
		assert.equal(visibleToStaleWork, null);
		assert.equal(registry.releaseOperation(operation), true);
		assert.equal(await cleanup, true);
		assert.equal(releaseStarted, true);

		const replacement = registry.acquire(browserSession, authorizationBinding);
		assert.ok(replacement);
		assert.ok(replacement.context.generation > oldContext.generation);
		assert.deepEqual(replacement.context.mutations, []);
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
		const followerLease = registry.acquire(
			browserSession,
			authorizationBinding,
		);
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
		await waitUntil(
			() => registry.current(browserSession) === null,
			"failed close release",
		);
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
		const followerLease = registry.acquire(
			browserSession,
			authorizationBinding,
		);
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
		assert.deepEqual(observedGenerations, [
			oldContext.generation,
			oldContext.generation,
		]);
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

	it("splits browser admission from stable management traffic", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		assert.match(
			bridge,
			/process\.env\.BROWSERSTATION_LEASE_URL \|\| BROWSERSTATION_URL/,
		);
		const leaseFetch = bridge.slice(
			bridge.indexOf("function bsLeaseFetch"),
			bridge.indexOf("async function deleteFarmBrowser"),
		);
		assert.match(leaseFetch, /postBrowserLease\(\{/);
		assert.match(leaseFetch, /baseUrl: BROWSERSTATION_LEASE_URL/);
		assert.match(leaseFetch, /init\.method !== "POST"/);

		const provisioning = bridge.slice(
			bridge.indexOf("function ensureLaneBrowser"),
			bridge.indexOf("function runAgentBrowserConnect"),
		);
		assert.match(
			provisioning,
			/const created = await bsLeaseFetch\("\/browsers"/,
		);
		assert.match(
			provisioning,
			/const resp = await bsFetch\(`\/browsers\/\$\{lane\.browserId\}`/,
		);
		assert.match(
			provisioning,
			/BROWSERSTATION_URL\.replace\(\/\^http\/, "ws"\)/,
		);
		assert.match(
			bridge,
			/deleteFarmBrowser[\s\S]*bsFetch\(`\/browsers\/\$\{browserId\}`[\s\S]*method: "DELETE"/,
		);
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
		assert.match(
			initialization,
			/onsessioninitialized:[\s\S]*lifecycle\.initialize\(/,
		);
		assert.match(
			initialization,
			/transport\.onclose[\s\S]*lifecycle\.dispose\(\)/,
		);
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
		assert.doesNotMatch(
			stopCapture,
			/browserContexts\.claimClose\(browserContext\)/,
		);
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
			handler.match(/return browserCloseFollowerResult\(closeSucceeded\);/g)
				?.length,
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

	it("enforces the public tool allowlist and lane/auth gates before forwarding", () => {
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
		const attachAt = handler.indexOf("await attachLaneBrowser(");
		const closeClaimAt = handler.indexOf("browserContexts.claimClose(");
		const acquireOperationAt = handler.indexOf(
			"browserContexts.acquireOperation(",
		);
		const prepareAt = handler.indexOf("await prepareTargetAuth(");
		const refreshAt = handler.indexOf("await refreshTargetAuthCookie(");
		const forwardAt = handler.lastIndexOf(
			"{ name, arguments: sanitizedArgs },",
		);
		assert.ok(authorizeAt >= 0);
		assert.ok(authorizeAt < sanitizeAt);
		assert.ok(sanitizeAt < attachAt);
		assert.ok(sanitizeAt < closeClaimAt);
		assert.ok(closeClaimAt < acquireOperationAt);
		assert.ok(acquireOperationAt < attachAt);
		assert.ok(attachAt < prepareAt);
		assert.ok(prepareAt < refreshAt);
		assert.ok(refreshAt < forwardAt);
		assert.match(
			handler.slice(sanitizeAt, forwardAt),
			/ready !== true[\s\S]*lane is unavailable[\s\S]*await attachLaneBrowser[\s\S]*could not reconnect to its assigned lane/,
		);
		assert.match(
			handler.slice(prepareAt, forwardAt),
			/prepareTargetAuth[\s\S]*prepared === "failed"[\s\S]*navigation was not attempted/,
		);
		assert.match(
			handler.slice(refreshAt, forwardAt),
			/refreshTargetAuthCookie[\s\S]*the tool was not called/,
		);
		assert.match(
			handler.slice(forwardAt),
			/timeout: BROWSER_TOOL_CALL_TIMEOUT_MS/,
		);
	});

	it("reattaches farm lanes and reapplies exact-origin auth by attachment generation", () => {
		const bridge = readFileSync(
			new URL("./bridge.mjs", import.meta.url),
			"utf8",
		);
		const attachment = bridge.slice(
			bridge.indexOf("function runAgentBrowserConnect"),
			bridge.indexOf("async function releaseBrowserContextResources"),
		);
		assert.match(attachment, /AGENT_BROWSER_CDP: lane\.cdpUrl/);
		assert.match(
			bridge,
			/deleteFarmBrowser[\s\S]*deleteBrowserWithRetry[\s\S]*bsFetch\([\s\S]*method: "DELETE"/,
		);
		assert.match(attachment, /lane\.attachmentGeneration \+= 1/);
		assert.match(attachment, /browserContexts\.isCurrent\(browserContext\)/);
		const auth = bridge.slice(
			bridge.indexOf("async function plantTargetAuthCookie"),
			bridge.indexOf("function armIdleStop"),
		);
		assert.match(
			auth,
			/authAppliedGeneration\s*=\s*browserContext\.lane\?\.attachmentGeneration/,
		);
		assert.match(auth, /authAppliedGeneration === attachmentGeneration/);
		assert.doesNotMatch(auth, /browserContext\.authApplied\b/);
		assert.doesNotMatch(
			bridge.slice(
				bridge.indexOf("async function prepareTargetAuth"),
				bridge.indexOf("function armIdleStop"),
			),
			/authApplied/,
		);
		const proxy = bridge.slice(
			bridge.indexOf("async function makeProxy"),
			bridge.indexOf("const app = express()"),
		);
		assert.match(
			proxy,
			/let child = await spawnChild\(browserContext\)[\s\S]*ensureLaneBoundChild[\s\S]*await attachLaneBrowser[\s\S]*await ensureLaneBoundChild\(operationSignal\)/,
		);
		assert.match(proxy, /childCdpUrl = expectedCdpUrl/);
		assert.match(
			proxy,
			/proxyClosing = true[\s\S]*await childLaneBindingPromise\?\.catch[\s\S]*Promise\.allSettled\([\s\S]*closeChild\(entry\)/,
		);
		assert.match(
			proxy,
			/acquireOperation\([\s\S]*try \{[\s\S]*signal: operation\.signal[\s\S]*finally \{[\s\S]*releaseOperation\(operation\)/,
		);
		assert.match(
			proxy,
			/if \(operation\) pauseIdleStop\(browserSession\)[\s\S]*finally \{[\s\S]*releaseOperation\(operation\)[\s\S]*isCurrent\(browserContext\)[\s\S]*armIdleStop\(browserSession\)/,
		);
		assert.match(
			bridge,
			/function armIdleStop[\s\S]*hasOperations\(browserContext\)[\s\S]*setTimeout[\s\S]*hasOperations\(browserContext\)/,
		);
		assert.match(
			bridge,
			/releaseBrowserContextResources[\s\S]*discardCapture\(browserContext, "browser resource release"\)/,
		);
		assert.match(
			bridge,
			/drainBrowserOperations[\s\S]*waitForOperations[\s\S]*abortOperations[\s\S]*browser operation drain/,
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
