// agent-browser-mcp bridge.
//
// Exposes Vercel agent-browser as a streamable-HTTP MCP endpoint (like
// supergateway), but ALSO deterministically persists the artifacts agent-browser
// produces (screenshot / video / pdf / HAR / trace) to the run they belong to.
//
// Chrome + the artifact files live on THIS pod, so only this service can read
// them. The owning run reaches us as MCP request headers (stamped by the BFF on
// the agent-browser mcpServers entry): X-Wfb-Execution-Id / X-Wfb-Workflow-Id /
// X-Wfb-Node-Id. After each artifact-producing tool call we read the produced
// file and POST it to the BFF's browser-artifacts store, keyed by that execution
// id — no reliance on the LLM to save or upload anything.
//
// Reliability measures, informed by trace review of real runs:
//  1. RUN-SCOPED BROWSER STATE: dapr-agent-py opens a NEW MCP connection per
//     tool call (and different pool replicas connect independently), so browser
//     state must not live on the MCP session. Every child is spawned with
//     AGENT_BROWSER_SESSION=wfb-<executionId>: the agent-browser daemon keys
//     browser state by that name, so all of a run's MCP connections share one
//     Chrome, and concurrent runs are isolated from each other.
//  2. AUTO-CAPTURE, KEYED BY RUN: the bridge is itself an MCP client of the
//     child, so it starts HAR + video recording right after the run's first
//     successful `open` and stops+persists when the agent closes the browser
//     (or after an idle gap). Capture state lives in a process-global map keyed
//     by the run — MCP transport closes (which happen after EVERY tool call)
//     do not touch it. The LLM never choreographs record_start/record_stop —
//     models stall exactly there.
//  3. CURATED TOOL SURFACE: the child runs with the full core,network,debug
//     profiles (so the bridge can call capture tools), but external tools/list
//     and tools/call are restricted to a navigation-oriented action set with
//     pruned schemas. 77+ tools × a dozen restore/namespace/session props
//     created measurable context bloat and provoked tool-choice loops.
//  4. DEMO SCENES + AUTO-EDITOR: a bridge-implemented virtual tool `demo_scene`
//     lets the agent mark scene boundaries with ONE semantic call (the bridge
//     translates it to record_restart + metadata — no start/stop pairing).
//     When the run closes, titled scene clips are auto-edited (render.mjs:
//     dead-time cuts, captions, title/end cards) into one demo MP4 persisted
//     to the run. Untitled footage (recon wandering) never ships in a demo.
import express from "express";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { renderDemo, readAndRm } from "./render.mjs";
import {
	appendPersistedArtifactReference,
	persistedArtifactReferenceFromResponse,
} from "./artifact-reference.mjs";
import {
	DEFAULT_EXPOSED_TOOLS,
	inlineImage,
	isExternallyCallableTool,
	preserveMultimodalToolResult,
	pruneExternalToolDefinition,
	resolveExposedTools,
	sanitizeAllowlistedArguments,
	sanitizeExternalToolArguments,
} from "./vision-contract.mjs";
import {
	createBrowserContextRegistry,
	deleteBrowserWithRetry,
	finalizeBrowserClose,
	resolveBrowserCloseChild,
	shouldCloseBrowserAfterCapture,
	shouldProvisionFarmBrowser,
	waitForBrowserLaneCallReadiness,
	waitForBrowserOperation,
} from "./browser-lane-policy.mjs";
import { createMcpSessionLifecycle } from "./mcp-session-lifecycle.mjs";
import {
	authorizeBrowserInitialization,
	authorizeBrowserSessionPostCloseToolsList,
	authorizeBrowserSessionTermination,
	createTargetAuthExchangeCache,
	exchangeTargetAuth,
	openedUrlMatchesTargetOrigin,
	parseTargetAuthAssertion,
	reauthorizeBrowserSession,
	targetAuthCookieToolArguments,
	targetAuthNeedsRefresh,
	validateTargetAuth,
} from "./target-auth-policy.mjs";
import { postBrowserLease } from "./browserstation-lease-client.mjs";

const PORT = Number(process.env.PORT || 8000);
// state = cookies/storage (the bridge's own target-auth cookie injection).
const TOOLS =
	process.env.AGENT_BROWSER_TOOLS || "core,network,debug,state,mobile";
const BFF =
	process.env.WORKFLOW_BUILDER_URL ||
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const TOKEN = process.env.INTERNAL_API_TOKEN || "";
const CLOSE_FINALIZATION_TIMEOUT_MS = timeoutFromEnv(
	"AGENT_BROWSER_CLOSE_TIMEOUT_MS",
	420000,
);
const BFF_IO_TIMEOUT_MS = timeoutFromEnv(
	"AGENT_BROWSER_BFF_IO_TIMEOUT_MS",
	120000,
);
const BROWSERSTATION_IO_TIMEOUT_MS = timeoutFromEnv(
	"BROWSERSTATION_IO_TIMEOUT_MS",
	30000,
);
const BROWSER_PROCESS_TIMEOUT_MS = timeoutFromEnv(
	"AGENT_BROWSER_PROCESS_TIMEOUT_MS",
	60000,
);
const BROWSER_TOOL_CALL_TIMEOUT_MS = timeoutFromEnv(
	"AGENT_BROWSER_TOOL_TIMEOUT_MS",
	150000,
);
const OPERATION_DRAIN_GRACE_MS = timeoutFromEnv(
	"AGENT_BROWSER_OPERATION_DRAIN_GRACE_MS",
	2000,
);

// BrowserStation lanes: every execution-scoped browser is leased from the
// BrowserStation farm (KubeRay; one Chrome per worker pod), keeping Chromium
// out of this long-lived MCP bridge. `X-Wfb-Browser-Lane: per-node` further
// isolates concurrent script calls by node; otherwise one run shares one farm
// browser. Browser creation can use a separate admission Service so a rollout
// can stop new leases without interrupting readiness, cleanup, or CDP traffic.
// Unset BROWSERSTATION_URL/API key falls back to local Chrome.
const BROWSERSTATION_URL = (process.env.BROWSERSTATION_URL || "").replace(
	/\/$/,
	"",
);
const BROWSERSTATION_LEASE_URL = (
	process.env.BROWSERSTATION_LEASE_URL || BROWSERSTATION_URL
).replace(/\/$/, "");
const BROWSERSTATION_API_KEY = process.env.BROWSERSTATION_API_KEY || "";
// Cold farm scale-up = pod schedule + image pull; warm worker ≈ 2s.
const LANE_READY_TIMEOUT_MS = Number(
	process.env.BROWSERSTATION_READY_TIMEOUT_MS || 240000,
);
// Tool calls wait this long for the lane, then return a retryable error so the
// agent's MCP call doesn't hit client timeouts during farm scale-up.
const LANE_CALL_WAIT_MS = Number(
	process.env.BROWSERSTATION_CALL_WAIT_MS || 45000,
);

// Target-auth injection: execution config carries only a short-lived,
// purpose-specific assertion. On first navigation the bridge exchanges that
// assertion with the fixed BFF endpoint using INTERNAL_API_TOKEN. The BFF
// derives the only allowed target origin and returns a short-lived owner cookie.
// The bridge plants it HttpOnly for that exact origin before each matching
// navigation and never creates a global Authorization header.
// The child keeps internal capture/state tools available to the bridge, while
// external tools/list and tools/call are restricted to this curated subset.
// Configuration may narrow the set but cannot add internal child tools.
const EXPOSED_TOOLS = resolveExposedTools(
	process.env.AGENT_BROWSER_EXPOSED_TOOLS ?? DEFAULT_EXPOSED_TOOLS.join(","),
);

// What the bridge records on its own: "video", "har", or both. Empty disables.
const AUTO_CAPTURE = (process.env.AGENT_BROWSER_AUTO_CAPTURE ?? "video,har")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
// If the agent abandons the run without close, stop+persist after this idle gap.
// Multi-agent-call demo runs have real gaps between scene sessions — keep this
// comfortably above orchestrator scheduling latency.
const AUTO_CAPTURE_IDLE_MS = Number(
	process.env.AGENT_BROWSER_AUTO_CAPTURE_IDLE_MS || 300000,
);

// Bridge-implemented tools (not proxied to agent-browser).
const DEMO_SCENE_TOOL = {
	name: "demo_scene",
	description:
		"Start the next scene of the demo recording. Call ONCE at the beginning of " +
		"each demo scene, BEFORE performing the scene's browser actions. The platform " +
		"handles all recording — never try to start or stop recordings yourself.",
	inputSchema: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description: "Short scene title shown in the video (max ~40 chars)",
			},
			caption: {
				type: "string",
				description:
					"One-line caption explaining what this scene demonstrates (max ~90 chars)",
			},
			focus: {
				type: "string",
				description:
					"Optional: the overall demo focus/theme (set it on the first scene)",
			},
		},
		required: ["title"],
	},
};
const EXPOSED_BRIDGE_TOOLS = AUTO_CAPTURE.includes("video")
	? [DEMO_SCENE_TOOL.name]
	: [];

// Map an artifact-producing tool to how its output is persisted.
// bucket 'screenshots' → inline <img>; bucket 'assets' kind 'video' → inline
// <video>; kind 'trace' → download link (used for pdf/har/devtools-trace).
const ARTIFACT_TOOLS = {
	agent_browser_screenshot: {
		bucket: "screenshots",
		kind: "screenshot",
		ct: "image/png",
	},
	agent_browser_record_stop: {
		bucket: "assets",
		kind: "video",
		ct: "video/webm",
	},
	agent_browser_pdf: { bucket: "assets", kind: "trace", ct: "application/pdf" },
	agent_browser_network_har_stop: {
		bucket: "assets",
		kind: "trace",
		ct: "application/json",
	},
	agent_browser_trace_stop: {
		bucket: "assets",
		kind: "trace",
		ct: "application/zip",
	},
	agent_browser_profiler_stop: {
		bucket: "assets",
		kind: "trace",
		ct: "application/json",
	},
};

function resultText(result) {
	return (result?.content || [])
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function browserCloseFailureResult() {
	return {
		content: [
			{
				type: "text",
				text: "Browser close finalization reached its deadline.",
			},
		],
		isError: true,
	};
}

function browserCloseFollowerResult(closeSucceeded) {
	if (!closeSucceeded) return browserCloseFailureResult();
	return {
		content: [
			{
				type: "text",
				text: "Browser session was closed by another request.",
			},
		],
	};
}

async function drainBrowserOperations(browserContext, closeClaim, signal) {
	const drainedDuringGrace = await browserContexts.waitForOperations(
		browserContext,
		closeClaim,
		OPERATION_DRAIN_GRACE_MS,
	);
	if (drainedDuringGrace) return;
	const reason = new Error("browser context is closing");
	browserContexts.abortOperations(browserContext, closeClaim, reason);
	await waitForBrowserOperation(
		browserContexts.waitForOperations(browserContext, closeClaim),
		signal,
		BROWSER_TOOL_CALL_TIMEOUT_MS,
		"browser operation drain",
	);
}

function timeoutFromEnv(name, fallbackMs) {
	const value = Number(process.env[name] || fallbackMs);
	return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
		? value
		: fallbackMs;
}

function boundedSignal(parentSignal, timeoutMs) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return parentSignal
		? AbortSignal.any([parentSignal, timeoutSignal])
		: timeoutSignal;
}

function logLaneCallTransition(browserContext, toolName, state, details = {}) {
	console.error(
		`[lane-call] ${JSON.stringify({
			event: "browser_lane_call_transition",
			state,
			browserSession: browserContext.browserSession,
			generation: browserContext.generation,
			browserId: browserContext.lane?.browserId ?? null,
			tool: toolName,
			...details,
		})}`,
	);
}

async function waitWithTimeout(promise, timeoutMs, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
// agent-browser echoes the saved path in its text output (e.g. "HAR saved to
// /root/.agent-browser/tmp/har/har-….har", "Recording saved to …").
function pathFromResult(result) {
	const m = resultText(result).match(
		/\/[^\s"'`]+\.(webm|pdf|har|zip|json|png|jpe?g)/i,
	);
	return m ? m[0] : null;
}

async function persistBlob(
	ctx,
	{ bucket, kind, payloadBase64, contentType, fileName },
	signal,
) {
	if (!ctx?.executionId || !TOKEN) return null;
	const body = {
		workflowExecutionId: ctx.executionId,
		workflowId: ctx.workflowId,
		nodeId: ctx.nodeId,
		status: "ok",
	};
	if (bucket === "screenshots") {
		body.screenshots = [{ payloadBase64, contentType, label: fileName }];
	} else {
		body.assets = [
			{ kind, payloadBase64, contentType, fileName, label: fileName },
		];
	}
	try {
		const resp = await fetch(`${BFF}/api/internal/browser-artifacts`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Internal-Token": TOKEN,
			},
			body: JSON.stringify(body),
			signal: boundedSignal(signal, BFF_IO_TIMEOUT_MS),
		});
		console.error(
			`[artifact] ${fileName} (${contentType}) exec=${ctx.executionId} http=${resp.status}`,
		);
		if (!resp.ok) {
			await resp.body?.cancel().catch(() => {});
			return null;
		}
		const responseBody = await resp.json();
		const persisted = persistedArtifactReferenceFromResponse(responseBody, {
			executionId: ctx.executionId,
			expectedKind: kind,
		});
		if (!persisted) {
			console.error(
				`[artifact] invalid persistence response for ${fileName} exec=${ctx.executionId}`,
			);
			return null;
		}
		return persisted;
	} catch (err) {
		if (signal?.aborted) throw signal.reason ?? err;
		console.error(`[artifact] POST failed for ${fileName}: ${err?.message}`);
		return null;
	}
}

async function persistArtifact(ctx, seen, toolName, result, signal) {
	const spec = ARTIFACT_TOOLS[toolName];
	if (!spec || !ctx?.executionId || !TOKEN) return null;

	let payloadBase64;
	let contentType = spec.ct;
	let fileName;
	if (spec.bucket === "screenshots") {
		const img = inlineImage(result);
		if (img) {
			payloadBase64 = img.data;
			contentType = img.mime;
			fileName = "screenshot.png";
		}
	}
	if (!payloadBase64) {
		const p = pathFromResult(result);
		if (!p || seen.has(p)) return null; // nothing new produced
		seen.add(p);
		try {
			payloadBase64 = (await readFile(p, { signal })).toString("base64");
		} catch (err) {
			if (signal?.aborted) throw signal.reason ?? err;
			console.error(`[artifact] read ${p} failed: ${err?.message}`);
			return null;
		}
		fileName = p.split("/").pop();
	}
	return persistBlob(
		ctx,
		{
			bucket: spec.bucket,
			kind: spec.kind,
			payloadBase64,
			contentType,
			fileName,
		},
		signal,
	);
}

// ---------------------------------------------------------------------------
// Browser context registry.
//
// Every entry owns one stable authorization binding, cookie cache, auth state,
// and optional BrowserStation lane. Entry-aware release prevents stale cleanup
// from deleting a replacement that advertises the same browser-session name.
// ---------------------------------------------------------------------------
const browserContexts = createBrowserContextRegistry({
	createState: () => ({
		authAppliedGeneration: -1,
		exchangeCache: createTargetAuthExchangeCache(),
		lane: null,
	}),
	releaseResources: releaseBrowserContextResources,
});

function lanesEnabled() {
	return Boolean(
		BROWSERSTATION_URL && BROWSERSTATION_LEASE_URL && BROWSERSTATION_API_KEY,
	);
}

function bsFetchAt(baseUrl, path, init = {}) {
	const { signal, ...requestInit } = init;
	return fetch(`${baseUrl}${path}`, {
		...requestInit,
		headers: {
			"X-API-Key": BROWSERSTATION_API_KEY,
			"Content-Type": "application/json",
			...(requestInit.headers || {}),
		},
		signal: boundedSignal(signal, BROWSERSTATION_IO_TIMEOUT_MS),
	});
}

function bsFetch(path, init = {}) {
	return bsFetchAt(BROWSERSTATION_URL, path, init);
}

function bsLeaseFetch(path, init = {}) {
	if (path !== "/browsers" || init.method !== "POST") {
		throw new Error("BrowserStation lease client only supports POST /browsers");
	}
	return postBrowserLease({
		baseUrl: BROWSERSTATION_LEASE_URL,
		apiKey: BROWSERSTATION_API_KEY,
		body: init.body,
		signal: boundedSignal(init.signal, BROWSERSTATION_IO_TIMEOUT_MS),
		timeoutMs: BROWSERSTATION_IO_TIMEOUT_MS,
	});
}

async function deleteFarmBrowser(browserId) {
	return deleteBrowserWithRetry({
		request: () => bsFetch(`/browsers/${browserId}`, { method: "DELETE" }),
	});
}

function ensureLaneBrowser(browserContext) {
	if (browserContext.lane) return browserContext.lane.ready;
	const { browserSession } = browserContext;
	const lane = {
		browserId: null,
		cdpUrl: null,
		attachmentGeneration: 0,
		attachmentPromise: null,
		ready: null,
		controller: new AbortController(),
	};
	const { signal } = lane.controller;
	browserContext.lane = lane;
	lane.ready = (async () => {
		const created = await bsLeaseFetch("/browsers", {
			method: "POST",
			body: "{}",
			signal,
		});
		if (!created.ok) throw new Error(`lease HTTP ${created.status}`);
		lane.browserId = (await created.json()).browser_id;
		const deadline = Date.now() + LANE_READY_TIMEOUT_MS;
		let info;
		for (;;) {
			if (!browserContexts.isCurrent(browserContext)) {
				throw new Error("lane authorization closed during provisioning");
			}
			const resp = await bsFetch(`/browsers/${lane.browserId}`, { signal });
			if (resp.ok) {
				info = await resp.json();
				if (info.chrome_ready && info.websocket_url) break;
			} else if (resp.status === 404) {
				// The farm GC'd a lease that pended too long for capacity.
				lane.browserId = null;
				throw new Error("lease expired waiting for farm capacity");
			}
			if (Date.now() > deadline)
				throw new Error(`farm browser not ready in ${LANE_READY_TIMEOUT_MS}ms`);
			await waitForBrowserOperation(
				new Promise((resolve) => setTimeout(resolve, 3000)),
				signal,
				4000,
				"browser lane poll",
			);
		}
		if (!browserContexts.isCurrent(browserContext)) {
			throw new Error("lane authorization closed before attachment");
		}
		lane.cdpUrl =
			BROWSERSTATION_URL.replace(/^http/, "ws") + info.websocket_url;
		await attachLaneBrowser(browserContext, signal);
		console.error(
			`[lane] ${browserSession} attached to farm browser ${lane.browserId}`,
		);
		return true;
	})().catch(async (err) => {
		console.error(
			`[lane] ${browserSession} farm lease failed (${err?.message}); browser tools fail closed`,
		);
		if (lane.browserId) {
			try {
				await deleteFarmBrowser(lane.browserId);
				lane.browserId = null;
			} catch (cleanupError) {
				console.error(
					`[lane] ${browserSession} failed to clean up farm browser ${lane.browserId}: ${cleanupError?.message}`,
				);
			}
		}
		lane.cdpUrl = null;
		return false;
	});
	return lane.ready;
}

function runAgentBrowserConnect(browserContext, lane, signal) {
	return new Promise((resolve, reject) => {
		const p = spawn("agent-browser", ["connect", lane.cdpUrl], {
			env: {
				...process.env,
				AGENT_BROWSER_SESSION: browserContext.browserSession,
				// Persist the external target in a daemon started by this command so
				// agent-browser recovery cannot silently launch a local Chrome.
				AGENT_BROWSER_CDP: lane.cdpUrl,
			},
			stdio: ["ignore", "ignore", "inherit"],
		});
		let settled = false;
		let timer;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			error ? reject(error) : resolve();
		};
		const onAbort = () => {
			p.kill("SIGKILL");
			finish(signal?.reason ?? new Error("browser lane attachment aborted"));
		};
		timer = setTimeout(() => {
			p.kill("SIGKILL");
			finish(
				new Error(
					`agent-browser connect exceeded ${BROWSER_PROCESS_TIMEOUT_MS}ms`,
				),
			);
		}, BROWSER_PROCESS_TIMEOUT_MS);
		p.on("exit", (code) =>
			finish(code === 0 ? null : new Error(`connect exit ${code}`)),
		);
		p.on("error", finish);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

/** Serialize and verify attachment to the execution's original farm browser. */
function attachLaneBrowser(browserContext, signal) {
	const lane = browserContext?.lane;
	if (!lane?.cdpUrl || !browserContexts.isCurrent(browserContext)) {
		return Promise.reject(
			new Error("browser lane is not current or has no CDP target"),
		);
	}
	if (lane.attachmentPromise) return lane.attachmentPromise;
	const attempt = runAgentBrowserConnect(browserContext, lane, signal).then(
		() => {
			if (
				!browserContexts.isCurrent(browserContext) ||
				browserContext.lane !== lane
			) {
				throw new Error("browser lane closed during attachment");
			}
			lane.attachmentGeneration += 1;
			return true;
		},
	);
	const wrapped = attempt.finally(() => {
		if (lane.attachmentPromise === wrapped) {
			lane.attachmentPromise = null;
		}
	});
	lane.attachmentPromise = wrapped;
	return wrapped;
}

async function releaseBrowserContextResources(browserContext) {
	browserContext.authAppliedGeneration = -1;
	browserContext.exchangeCache.clear();
	discardCapture(browserContext, "browser resource release");
	const lane = browserContext.lane;
	browserContext.lane = null;
	if (!lane) return;
	lane.controller.abort(new Error("browser context released"));
	await waitWithTimeout(
		Promise.allSettled([lane.ready, lane.attachmentPromise].filter(Boolean)),
		BROWSER_PROCESS_TIMEOUT_MS,
		"browser lane release wait",
	).catch(() => false);
	if (!lane.browserId) {
		lane.cdpUrl = null;
		return;
	}
	try {
		await deleteFarmBrowser(lane.browserId);
		console.error(
			`[lane] ${browserContext.browserSession}#${browserContext.generation} released farm browser ${lane.browserId}`,
		);
		lane.browserId = null;
	} catch (err) {
		console.error(
			`[lane] release failed for ${browserContext.browserSession}#${browserContext.generation}: ${err?.message}`,
		);
	} finally {
		lane.cdpUrl = null;
	}
}

async function closeChild(child, label = "agent-browser child close") {
	if (!child) return;
	await waitWithTimeout(
		Promise.resolve().then(() => child.close()),
		BROWSER_PROCESS_TIMEOUT_MS,
		label,
	);
}

async function spawnChild(browserContext, signal) {
	const { browserSession } = browserContext;
	const cdpUrl = browserContext.lane?.cdpUrl;
	const childTransport = new StdioClientTransport({
		command: "agent-browser",
		args: ["mcp", "--tools", TOOLS],
		env: {
			...process.env,
			AGENT_BROWSER_SESSION: browserSession,
			...(cdpUrl ? { AGENT_BROWSER_CDP: cdpUrl } : {}),
		},
	});
	const child = new Client({ name: "agent-browser-child", version: "1.0.0" });
	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				closeChild(child, "aborted agent-browser child close").catch(() => {});
			},
			{ once: true },
		);
	}
	try {
		signal?.throwIfAborted();
		await waitForBrowserOperation(
			child.connect(childTransport),
			signal,
			BROWSER_PROCESS_TIMEOUT_MS,
			"agent-browser child connect",
		);
		signal?.throwIfAborted();
		return child;
	} catch (error) {
		await closeChild(child, "failed agent-browser child close").catch(() => {});
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Run-scoped auto-capture registry.
//
// dapr-agent-py connects per TOOL CALL, and different pool replicas connect
// independently, so an MCP transport close means nothing about the run's
// lifecycle. Capture state is therefore keyed by the agent-browser session
// name (wfb-<executionId>) and only ends on the agent's `close` call, an idle
// timeout, or process exit — never on transport close.
// ---------------------------------------------------------------------------
const captures = new Map(); // browserSession -> capture entry
const pendingScenes = new Map(); // browserSession -> scene declared before first open

function discardCapture(browserContext, reason) {
	const { browserSession } = browserContext;
	const entry = captures.get(browserSession);
	if (!entry || entry.browserContext !== browserContext) {
		pendingScenes.delete(browserSession);
		return false;
	}
	entry.stopped = true;
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = null;
	captures.delete(browserSession);
	pendingScenes.delete(browserSession);
	console.error(`[auto-capture] discarded ${browserSession}: ${reason}`);
	return true;
}

function newClipPath() {
	return `/tmp/clip-${randomUUID().slice(0, 8)}.webm`;
}

async function startCapture(browserContext, ctx, child, openedUrl, signal) {
	const { browserSession } = browserContext;
	if (captures.has(browserSession)) return;
	const pending = pendingScenes.get(browserSession);
	pendingScenes.delete(browserSession);
	const entry = {
		ctx,
		browserContext,
		browserSession,
		seen: new Set(),
		clips: [], // [{path, title, caption}] — title null = not part of a demo
		site: (() => {
			try {
				return openedUrl ? new URL(openedUrl).host : "";
			} catch {
				return "";
			}
		})(),
		focus: pending?.focus || "",
		videoActive: false,
		harActive: false,
		idleTimer: null,
		stopped: false,
	};
	captures.set(browserSession, entry);
	if (AUTO_CAPTURE.includes("har")) {
		try {
			await child.callTool(
				{ name: "agent_browser_network_har_start", arguments: {} },
				undefined,
				{ timeout: BROWSER_TOOL_CALL_TIMEOUT_MS, signal },
			);
			entry.harActive = true;
			console.error(
				`[auto-capture] HAR recording started exec=${ctx.executionId}`,
			);
		} catch (err) {
			console.error(`[auto-capture] har_start failed: ${err?.message}`);
		}
	}
	if (AUTO_CAPTURE.includes("video")) {
		try {
			const path = newClipPath();
			// record_start swaps to a fresh (cookie-preserving) context and
			// re-navigates, so pass the URL the agent just opened explicitly.
			const args = openedUrl ? { path, url: openedUrl } : { path };
			await child.callTool(
				{ name: "agent_browser_record_start", arguments: args },
				undefined,
				{ timeout: BROWSER_TOOL_CALL_TIMEOUT_MS, signal },
			);
			entry.videoActive = true;
			entry.clips.push({
				path,
				title: pending?.title ?? null,
				caption: pending?.caption ?? "",
			});
			console.error(
				`[auto-capture] video recording started → ${path} exec=${ctx.executionId}` +
					(pending?.title ? ` scene="${pending.title}"` : ""),
			);
		} catch (err) {
			console.error(`[auto-capture] record_start failed: ${err?.message}`);
		}
	}
	if (!entry.videoActive && !entry.harActive) {
		captures.delete(browserSession);
		return;
	}
	armIdleStop(browserSession);
}

async function beginScene(browserSession, ctx, child, args, signal) {
	const title =
		String(args?.title || "")
			.slice(0, 60)
			.trim() || "Untitled scene";
	const caption = String(args?.caption || "")
		.slice(0, 120)
		.trim();
	const focus = String(args?.focus || "").trim();
	const entry = captures.get(browserSession);
	if (!entry || entry.stopped || !entry.videoActive) {
		// Browser not open yet — remember the scene; it applies when capture starts.
		pendingScenes.set(browserSession, { title, caption, focus });
		return `Scene queued: "${title}" (it starts with the first page you open).`;
	}
	if (focus) entry.focus = focus;
	const path = newClipPath();
	await child.callTool(
		{ name: "agent_browser_record_restart", arguments: { path } },
		undefined,
		{ timeout: BROWSER_TOOL_CALL_TIMEOUT_MS, signal },
	);
	entry.clips.push({ path, title, caption });
	armIdleStop(browserSession);
	const n = entry.clips.filter((c) => c.title).length;
	console.error(
		`[demo] scene ${n} "${title}" started exec=${entry.ctx.executionId}`,
	);
	return `Scene ${n} started: "${title}". Perform the scene's actions now.`;
}

async function renderAndPersistDemo(entry, signal) {
	const titled = entry.clips.filter((c) => c.title);
	try {
		signal?.throwIfAborted();
		const demo = await renderDemo(
			titled,
			{ site: entry.site, focus: entry.focus },
			{ signal },
		);
		signal?.throwIfAborted();
		const buf = await readAndRm(demo.path, signal);
		// Parallel lanes each render their own mini-demo; name by scene so the
		// Browser tab distinguishes them from the run-level demo.mp4.
		const laneSuffix = entry.browserSession?.includes("--")
			? (titled[0]?.title || entry.browserSession.split("--").pop() || "lane")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 40)
			: null;
		await persistBlob(
			entry.ctx,
			{
				bucket: "assets",
				kind: "video",
				payloadBase64: buf.toString("base64"),
				contentType: "video/mp4",
				fileName: laneSuffix ? `page-${laneSuffix}.mp4` : "demo.mp4",
			},
			signal,
		);
		console.error(
			`[demo] rendered ${demo.seconds.toFixed(1)}s (${titled.length} scene(s), speedup ${demo.speedup.toFixed(2)}x) exec=${entry.ctx.executionId}`,
		);
	} catch (err) {
		if (signal?.aborted) throw signal.reason ?? err;
		console.error(
			`[demo] render failed (${err?.message}) — persisting raw scene clips`,
		);
		for (const clip of titled) {
			try {
				signal?.throwIfAborted();
				const buf = await readFile(clip.path, { signal });
				await persistBlob(
					entry.ctx,
					{
						bucket: "assets",
						kind: "video",
						payloadBase64: buf.toString("base64"),
						contentType: "video/webm",
						fileName: clip.path.split("/").pop(),
					},
					signal,
				);
			} catch (error) {
				if (signal?.aborted) throw signal.reason ?? error;
				/* clip unreadable — skip */
			}
		}
	}
}

async function stopCapture(
	browserContext,
	reason,
	liveChild,
	existingCloseClaim,
	signal,
) {
	const { browserSession } = browserContext;
	const entry = captures.get(browserSession);
	if (!entry || entry.stopped || entry.browserContext !== browserContext) {
		return false;
	}
	const closeClaim = browserContexts.ownsClose(
		browserContext,
		existingCloseClaim,
	)
		? existingCloseClaim
		: null;
	if (!closeClaim) {
		await browserContexts.waitForCloseResponse(browserContext);
		return false;
	}
	entry.stopped = true;
	if (captures.get(browserSession) === entry) captures.delete(browserSession);
	pendingScenes.delete(browserSession);
	if (entry.idleTimer) clearTimeout(entry.idleTimer);

	// Prefer the child that carried the triggering call (alive for the duration
	// of that request); the idle path has no live proxy, so spawn an ephemeral
	// one — any process in the same AGENT_BROWSER_SESSION controls the daemon.
	let child = liveChild;
	let ephemeral = null;
	if (!child) {
		try {
			signal?.throwIfAborted();
			ephemeral = await spawnChild(browserContext, signal);
			child = ephemeral;
		} catch (err) {
			console.error(
				`[auto-capture] stop child spawn failed (${reason}): ${err?.message}`,
			);
			throw err;
		}
	}
	try {
		signal?.throwIfAborted();
		if (entry.videoActive) {
			entry.videoActive = false;
			try {
				// Finalizing a long recording (ffmpeg) routinely exceeds the SDK's
				// 60s default request timeout — that lost every 10-min-plus video.
				const result = await child.callTool(
					{ name: "agent_browser_record_stop", arguments: {} },
					undefined,
					{ timeout: 300000, signal },
				);
				signal?.throwIfAborted();
				const hasDemoScenes = entry.clips.some((c) => c.title);
				if (hasDemoScenes) {
					// When the AGENT explicitly closes, the run finalizes right after this returns —
					// render+persist SYNCHRONOUSLY, or demo.mp4 lands after the run snapshot is frozen
					// and the viewer must hard-refresh to see it. The close deadline now also
					// bounds idle rendering, so every path finishes before releasing the lane.
					console.error(
						`[auto-capture] video stopped (${reason}) — rendering demo inline`,
					);
					await renderAndPersistDemo(entry, signal);
				} else {
					await persistArtifact(
						entry.ctx,
						entry.seen,
						"agent_browser_record_stop",
						result,
						signal,
					);
					console.error(`[auto-capture] video stopped+persisted (${reason})`);
				}
			} catch (err) {
				if (signal?.aborted) throw signal.reason ?? err;
				console.error(
					`[auto-capture] record_stop failed (${reason}): ${err?.message}`,
				);
			}
		}
		if (entry.harActive) {
			entry.harActive = false;
			try {
				const result = await child.callTool(
					{ name: "agent_browser_network_har_stop", arguments: {} },
					undefined,
					{ timeout: 300000, signal },
				);
				signal?.throwIfAborted();
				await persistArtifact(
					entry.ctx,
					entry.seen,
					"agent_browser_network_har_stop",
					result,
					signal,
				);
				console.error(`[auto-capture] HAR stopped+persisted (${reason})`);
			} catch (err) {
				if (signal?.aborted) throw signal.reason ?? err;
				console.error(
					`[auto-capture] har_stop failed (${reason}): ${err?.message}`,
				);
			}
		}
		if (shouldCloseBrowserAfterCapture(reason)) {
			try {
				await child.callTool(
					{ name: "agent_browser_close", arguments: {} },
					undefined,
					{ timeout: 60000, signal },
				);
				console.error(`[browser] session closed after ${reason} cleanup`);
			} catch (err) {
				if (signal?.aborted) throw signal.reason ?? err;
				console.error(
					`[browser] close failed after ${reason}: ${err?.message}`,
				);
			}
		}
	} finally {
		if (ephemeral) {
			await closeChild(ephemeral, "ephemeral agent-browser child close").catch(
				() => {},
			);
		}
	}
	return true;
}

function targetAuthExchangeInput(browserContext, ctx) {
	return {
		bffUrl: BFF,
		internalToken: TOKEN,
		assertion: ctx?.targetAuth?.assertion,
		executionId: ctx?.executionId,
		authorizationBinding: browserContext.authorizationBinding,
	};
}

async function resolveTargetAuth(browserContext, ctx) {
	return browserContext.exchangeCache.resolve(
		targetAuthExchangeInput(browserContext, ctx),
	);
}

async function plantTargetAuthCookie(browserContext, ctx, child, signal) {
	const exchange = await resolveTargetAuth(browserContext, ctx);
	if (!exchange) return null;
	await child.callTool(
		{
			name: "agent_browser_cookies_set",
			arguments: targetAuthCookieToolArguments(exchange),
		},
		undefined,
		{ timeout: BROWSER_TOOL_CALL_TIMEOUT_MS, signal },
	);
	browserContext.authAppliedGeneration =
		browserContext.lane?.attachmentGeneration ?? 0;
	return exchange;
}

async function refreshTargetAuthCookie(browserContext, ctx, child, signal) {
	if (!ctx?.targetAuth) return false;
	try {
		const existing = await browserContext.exchangeCache.peek(
			targetAuthExchangeInput(browserContext, ctx),
		);
		const attachmentGeneration = browserContext.lane?.attachmentGeneration ?? 0;
		if (
			browserContext.authAppliedGeneration === attachmentGeneration &&
			!targetAuthNeedsRefresh(existing)
		) {
			return true;
		}
		const refreshed = await plantTargetAuthCookie(
			browserContext,
			ctx,
			child,
			signal,
		);
		if (refreshed) {
			console.error(
				`[target-auth] owner cookie refreshed for ${refreshed.targetOrigin} exec=${ctx.executionId}`,
			);
			return true;
		}
	} catch (err) {
		console.error(`[target-auth] refresh failed: ${err?.message}`);
	}
	return false;
}

/** Plant auth before every navigation to the exact BFF-derived origin. */
async function prepareTargetAuth(
	browserContext,
	ctx,
	child,
	requestedUrl,
	signal,
) {
	if (!ctx?.targetAuth) return "skip";
	const exchange = await resolveTargetAuth(browserContext, ctx);
	if (!exchange) {
		console.error(
			`[target-auth] exchange unavailable exec=${ctx.executionId ?? "-"}`,
		);
		return "failed";
	}
	if (!openedUrlMatchesTargetOrigin(requestedUrl, exchange.targetOrigin)) {
		let openedOrigin = "invalid-url";
		try {
			openedOrigin = new URL(requestedUrl).origin;
		} catch {
			/* keep invalid-url */
		}
		console.error(
			`[target-auth] origin mismatch: requested=${openedOrigin} expected=${exchange.targetOrigin} — credential NOT presented`,
		);
		return "skip";
	}
	try {
		const planted = await plantTargetAuthCookie(
			browserContext,
			ctx,
			child,
			signal,
		);
		if (!planted) return "failed";
		console.error(
			`[target-auth] HttpOnly owner cookie set for ${exchange.targetOrigin} exec=${ctx.executionId}`,
		);
		return "applied";
	} catch (err) {
		console.error(`[target-auth] apply failed: ${err?.message}`);
		return "failed";
	}
}

function armIdleStop(browserSession) {
	const entry = captures.get(browserSession);
	if (!entry || !AUTO_CAPTURE_IDLE_MS) return;
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	const browserContext = entry.browserContext;
	entry.idleTimer = null;
	if (browserContexts.hasOperations(browserContext)) return;
	entry.idleTimer = setTimeout(() => {
		entry.idleTimer = null;
		if (browserContexts.hasOperations(browserContext)) return;
		const closeClaim = browserContexts.claimClose(browserContext);
		if (!closeClaim) {
			browserContexts.waitForCloseResponse(browserContext).catch(() => {});
			return;
		}
		finalizeBrowserClose({
			registry: browserContexts,
			context: browserContext,
			claim: closeClaim,
			timeoutMs: CLOSE_FINALIZATION_TIMEOUT_MS,
			finalize: async (signal) => {
				await drainBrowserOperations(browserContext, closeClaim, signal);
				return stopCapture(
					browserContext,
					"idle",
					undefined,
					closeClaim,
					signal,
				);
			},
			cancel: (reason) => {
				browserContexts.abortOperations(browserContext, closeClaim, reason);
			},
		}).catch((err) =>
			console.error(`[auto-capture] idle finalization failed: ${err?.message}`),
		);
	}, AUTO_CAPTURE_IDLE_MS);
	entry.idleTimer.unref?.();
}

function pauseIdleStop(browserSession) {
	const entry = captures.get(browserSession);
	if (!entry?.idleTimer) return;
	clearTimeout(entry.idleTimer);
	entry.idleTimer = null;
}

/** Build a per-connection MCP server that proxies to a fresh agent-browser child
 * (scoped to the run's browser session) and persists artifacts. `ctxRef.value`
 * is filled with the run context once the session initializes. */
async function makeProxy(ctxRef, browserContext) {
	const { browserSession } = browserContext;
	let child = await spawnChild(browserContext);
	let childCdpUrl = browserContext.lane?.cdpUrl ?? null;
	let childLaneBindingPromise = null;
	let proxyClosing = false;
	const children = new Set([child]);
	const seenPaths = new Set();

	const canPersist = () => Boolean(ctxRef.value?.executionId && TOKEN);
	const ensureLaneBoundChild = (signal, closeClaim = null) => {
		const lane = browserContext.lane;
		if (!lane?.cdpUrl || childCdpUrl === lane.cdpUrl)
			return Promise.resolve(child);
		if (childLaneBindingPromise) return childLaneBindingPromise;
		const expectedCdpUrl = lane.cdpUrl;
		const binding = (async () => {
			const replacement = await spawnChild(browserContext, signal);
			const ownsBrowserContext = closeClaim
				? browserContexts.ownsClose(browserContext, closeClaim)
				: browserContexts.isCurrent(browserContext);
			if (
				proxyClosing ||
				!ownsBrowserContext ||
				browserContext.lane !== lane ||
				lane.cdpUrl !== expectedCdpUrl
			) {
				await closeChild(replacement, "stale lane-bound child close").catch(
					() => {},
				);
				throw new Error("browser lane changed during child binding");
			}
			children.add(replacement);
			child = replacement;
			childCdpUrl = expectedCdpUrl;
			return replacement;
		})();
		const wrapped = binding.finally(() => {
			if (childLaneBindingPromise === wrapped) {
				childLaneBindingPromise = null;
			}
		});
		childLaneBindingPromise = wrapped;
		return wrapped;
	};

	const server = new Server(
		{ name: "agent-browser-mcp", version: "1.7.3" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		// Child tool discovery is paginated — aggregate every page.
		let tools = [];
		let cursor;
		do {
			const page = await child.listTools(cursor ? { cursor } : {});
			tools = tools.concat(page.tools || []);
			cursor = page.nextCursor;
		} while (cursor);
		const allow = new Set(EXPOSED_TOOLS);
		tools = tools
			.filter((t) => allow.has(t.name))
			.map(pruneExternalToolDefinition);
		if (AUTO_CAPTURE.includes("video")) tools.push(DEMO_SCENE_TOOL);
		return { tools };
	});
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		if (!isExternallyCallableTool(name, EXPOSED_TOOLS, EXPOSED_BRIDGE_TOOLS)) {
			return {
				content: [
					{
						type: "text",
						text: `Tool "${name}" is not available through this browser bridge.`,
					},
				],
				isError: true,
			};
		}
		const sanitizedArgs =
			name === DEMO_SCENE_TOOL.name
				? sanitizeAllowlistedArguments(args, ["title", "caption", "focus"])
				: sanitizeExternalToolArguments(name, args);
		const closesBrowser = name === "agent_browser_close";
		if (
			!browserContexts.isCurrent(
				browserContext,
				browserContext.authorizationBinding,
			)
		) {
			if (closesBrowser && browserContext.closing) {
				const closeSucceeded =
					await browserContexts.waitForCloseResponse(browserContext);
				return browserCloseFollowerResult(closeSucceeded);
			}
			return {
				content: [
					{ type: "text", text: "Browser lane authorization is closing." },
				],
				isError: true,
			};
		}
		let closeClaim = null;
		if (closesBrowser) {
			closeClaim = browserContexts.claimClose(browserContext);
			if (!closeClaim) {
				const closeSucceeded =
					await browserContexts.waitForCloseResponse(browserContext);
				return browserCloseFollowerResult(closeSucceeded);
			}
			if (browserContext.lane && !browserContext.lane.cdpUrl) {
				browserContext.lane.controller.abort(
					new Error("browser closed during farm provisioning"),
				);
			}
		}
		const operation = closesBrowser
			? null
			: browserContexts.acquireOperation(
					browserContext,
					browserContext.authorizationBinding,
				);
		if (!closesBrowser && !operation) {
			return {
				content: [
					{ type: "text", text: "Browser lane authorization is closing." },
				],
				isError: true,
			};
		}
		if (operation) pauseIdleStop(browserSession);
		try {
			// A lane still provisioning its farm browser must not let the first
			// tool call race ahead onto a fresh LOCAL Chrome — wait bounded, then
			// tell the agent to retry (cold farm scale-up can take minutes).
			const lane = browserContext.lane;
			if (lane && !closesBrowser) {
				const coldWait = !lane.cdpUrl;
				if (coldWait) {
					logLaneCallTransition(browserContext, name, "waiting", {
						timeoutMs: LANE_CALL_WAIT_MS,
					});
				}
				const readiness = await waitForBrowserLaneCallReadiness({
					ready: lane.ready,
					signal: operation.signal,
					timeoutMs: LANE_CALL_WAIT_MS,
				});
				if (coldWait || readiness.state !== "ready") {
					logLaneCallTransition(browserContext, name, readiness.state, {
						elapsedMs: readiness.elapsedMs,
					});
				}
				if (readiness.state === "aborted") {
					return {
						content: [
							{
								type: "text",
								text: "Browser lane authorization is closing.",
							},
						],
						isError: true,
					};
				}
				if (readiness.state === "pending") {
					return {
						content: [
							{
								type: "text",
								text: "The browser for this task is still provisioning (farm scale-up). Wait ~30 seconds and retry this exact tool call.",
							},
						],
						isError: true,
					};
				}
				if (readiness.state !== "ready") {
					return {
						content: [
							{
								type: "text",
								text: "The execution browser lane is unavailable; the tool was not called.",
							},
						],
						isError: true,
					};
				}
				try {
					const operationSignal = AbortSignal.any([
						lane.controller.signal,
						operation.signal,
					]);
					await attachLaneBrowser(browserContext, operationSignal);
					await ensureLaneBoundChild(operationSignal);
					if (coldWait) {
						logLaneCallTransition(browserContext, name, "bound");
					}
				} catch (err) {
					console.error(
						`[lane] ${browserSession} reattachment failed: ${err?.message}`,
					);
					return {
						content: [
							{
								type: "text",
								text: "The execution browser could not reconnect to its assigned lane; the tool was not called.",
							},
						],
						isError: true,
					};
				}
			}
			if (!closesBrowser) {
				const targetOpen =
					name === "agent_browser_open" &&
					ctxRef.value?.targetAuth &&
					typeof sanitizedArgs.url === "string";
				if (targetOpen) {
					const prepared = await prepareTargetAuth(
						browserContext,
						ctxRef.value,
						child,
						sanitizedArgs.url,
						operation.signal,
					);
					if (prepared === "failed") {
						return {
							content: [
								{
									type: "text",
									text: "Browser authorization could not be applied; navigation was not attempted.",
								},
							],
							isError: true,
						};
					}
				} else if (
					!(await refreshTargetAuthCookie(
						browserContext,
						ctxRef.value,
						child,
						operation.signal,
					))
				) {
					return {
						content: [
							{
								type: "text",
								text: "Browser authorization could not be refreshed; the tool was not called.",
							},
						],
						isError: true,
					};
				}
			}
			if (name === DEMO_SCENE_TOOL.name) {
				try {
					const message = await beginScene(
						browserSession,
						ctxRef.value,
						child,
						sanitizedArgs,
						operation.signal,
					);
					return { content: [{ type: "text", text: message }] };
				} catch (err) {
					return {
						content: [
							{ type: "text", text: `demo_scene failed: ${err?.message}` },
						],
						isError: true,
					};
				}
			}
			// The agent is done with the browser — capture must be finalized while
			// the browser session still exists.
			let result;
			if (closesBrowser) {
				try {
					result = await finalizeBrowserClose({
						registry: browserContexts,
						context: browserContext,
						claim: closeClaim,
						timeoutMs: CLOSE_FINALIZATION_TIMEOUT_MS,
						finalize: async (signal) => {
							await drainBrowserOperations(browserContext, closeClaim, signal);
							const closingChild = await resolveBrowserCloseChild({
								lane: browserContext.lane,
								localChild: child,
								childCdpUrl,
								waitForLaneReady: async (ready) => {
									try {
										return await waitForBrowserOperation(
											ready,
											signal,
											LANE_CALL_WAIT_MS,
											"browser close lane readiness",
										);
									} catch (error) {
										if (signal.aborted) throw signal.reason ?? error;
										return false;
									}
								},
								bindLaneChild: async () => {
									const boundChild = await ensureLaneBoundChild(
										signal,
										closeClaim,
									);
									return { child: boundChild, cdpUrl: childCdpUrl };
								},
							});
							if (!closingChild) {
								discardCapture(
									browserContext,
									"farm lane unavailable during close",
								);
								console.error(
									`[browser] ${browserSession} closed before its farm lane became usable`,
								);
								return {
									content: [
										{
											type: "text",
											text: "Browser session closed before its farm lane became ready.",
										},
									],
								};
							}
							if (captures.has(browserSession)) {
								await stopCapture(
									browserContext,
									"close",
									closingChild,
									closeClaim,
									signal,
								);
							}
							signal.throwIfAborted();
							return closingChild.callTool(
								{ name, arguments: sanitizedArgs },
								undefined,
								{ timeout: 60000, signal },
							);
						},
						cancel: (reason) => {
							browserContexts.abortOperations(
								browserContext,
								closeClaim,
								reason,
							);
							return closeChild(child, "deadline agent-browser child close");
						},
					});
				} catch (err) {
					console.error(`[browser] close finalization failed: ${err?.message}`);
					return browserCloseFailureResult();
				}
			} else {
				try {
					if (lane) {
						logLaneCallTransition(browserContext, name, "forwarded");
					}
					result = await child.callTool(
						{ name, arguments: sanitizedArgs },
						undefined,
						{
							timeout: BROWSER_TOOL_CALL_TIMEOUT_MS,
							signal: operation.signal,
						},
					);
				} catch (err) {
					if (lane) browserContext.authAppliedGeneration = -1;
					throw err;
				}
			}
			let persistedArtifact = null;
			if (ARTIFACT_TOOLS[name]) {
				try {
					persistedArtifact = await persistArtifact(
						ctxRef.value,
						seenPaths,
						name,
						result,
						operation?.signal,
					);
				} catch (err) {
					console.error(`[artifact] persist error: ${err?.message}`);
				}
			}
			if (
				name === "agent_browser_screenshot" &&
				persistedArtifact
			) {
				result = appendPersistedArtifactReference(result, persistedArtifact);
			}
			if (
				name === "agent_browser_open" &&
				result?.isError !== true &&
				AUTO_CAPTURE.length &&
				!captures.has(browserSession) &&
				canPersist()
			) {
				try {
					await startCapture(
						browserContext,
						ctxRef.value,
						child,
						typeof sanitizedArgs.url === "string"
							? sanitizedArgs.url
							: undefined,
						operation.signal,
					);
				} catch (err) {
					console.error(`[auto-capture] start failed: ${err?.message}`);
				}
			}
			return preserveMultimodalToolResult(result);
		} finally {
			if (operation) {
				browserContexts.releaseOperation(operation);
				if (browserContexts.isCurrent(browserContext)) {
					armIdleStop(browserSession);
				}
			}
		}
	});
	const cleanup = async () => {
		// Transport closes after every dapr-agent-py tool call — the run (and
		// its capture) outlives this proxy. Release both the schema child and a
		// lane-bound replacement, if the lane became ready after initialization.
		proxyClosing = true;
		await childLaneBindingPromise?.catch(() => {});
		await Promise.allSettled([...children].map((entry) => closeChild(entry)));
	};
	return { server, cleanup };
}

const app = express();
app.use(express.json({ limit: "16mb" }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

const sessions = new Map(); // MCP sessionId -> authorized transport context

function requestHeader(req, name) {
	const value = req.headers[name];
	return typeof value === "string" ? value.trim() : "";
}

async function requestMatchesSessionAuthorization(req, session) {
	const targetAuth = parseTargetAuthAssertion(req.headers);
	return reauthorizeBrowserSession({
		executionId: requestHeader(req, "x-wfb-execution-id"),
		targetAuth,
		expectedExecutionId: session.executionId,
		expectedAssertionDigest: session.assertionDigest,
		expectedAuthorizationBinding: session.authorizationBinding,
		browserContext: session.browserContext,
		isBrowserContextCurrent: (browserContext, authorizationBinding) =>
			browserContexts.isCurrent(browserContext, authorizationBinding),
		validate: ({ assertion, executionId }) =>
			validateTargetAuth({
				bffUrl: BFF,
				internalToken: TOKEN,
				assertion,
				executionId,
			}),
	});
}

function requestMatchesSessionTerminationAuthorization(req, session) {
	return authorizeBrowserSessionTermination({
		sessionId: requestHeader(req, "mcp-session-id"),
		executionId: requestHeader(req, "x-wfb-execution-id"),
		targetAuth: parseTargetAuthAssertion(req.headers),
		expectedSessionId: session.sessionId,
		expectedExecutionId: session.executionId,
		expectedAssertionDigest: session.assertionDigest,
	});
}

function consumePostCloseSchemaRefreshAuthorization(req, session) {
	const authorized = authorizeBrowserSessionPostCloseToolsList({
		method: req.body?.method,
		schemaRefreshAvailable: session.postCloseSchemaRefreshAvailable,
		browserContext: session.browserContext,
		sessionId: requestHeader(req, "mcp-session-id"),
		executionId: requestHeader(req, "x-wfb-execution-id"),
		targetAuth: parseTargetAuthAssertion(req.headers),
		expectedSessionId: session.sessionId,
		expectedExecutionId: session.executionId,
		expectedAssertionDigest: session.assertionDigest,
	});
	if (authorized) session.postCloseSchemaRefreshAvailable = false;
	return authorized;
}

function rejectBrowserAuthorization(res) {
	res.status(403).json({ error: "Execution browser authorization denied" });
}

app.post("/mcp", async (req, res) => {
	const sid = req.headers["mcp-session-id"];
	const existingSession = typeof sid === "string" ? sessions.get(sid) : null;
	if (existingSession) {
		const postCloseSchemaRefresh = consumePostCloseSchemaRefreshAuthorization(
			req,
			existingSession,
		);
		if (
			!postCloseSchemaRefresh &&
			!(await requestMatchesSessionAuthorization(req, existingSession))
		) {
			rejectBrowserAuthorization(res);
			return;
		}
		if (req.body?.method === "initialize") {
			res.status(400).json({ error: "MCP session is already initialized" });
			return;
		}
		await existingSession.transport.handleRequest(req, res, req.body);
		return;
	}
	if (req.body?.method !== "initialize") {
		res.status(400).json({ error: "MCP initialization is required" });
		return;
	}
	// Authorize before deriving an execution browser key or touching a browser.
	// The BFF rechecks live run, owner, and project membership on every initialize.
	const targetAuth = parseTargetAuthAssertion(req.headers);
	const initialization = await authorizeBrowserInitialization({
		executionId: requestHeader(req, "x-wfb-execution-id"),
		targetAuth,
		validate: ({ assertion, executionId }) =>
			validateTargetAuth({
				bffUrl: BFF,
				internalToken: TOKEN,
				assertion,
				executionId,
			}),
	});
	if (!initialization) {
		rejectBrowserAuthorization(res);
		return;
	}
	const ctxRef = {
		value: {
			executionId: initialization.executionId,
			workflowId: requestHeader(req, "x-wfb-workflow-id") || null,
			nodeId: requestHeader(req, "x-wfb-node-id") || null,
			targetAuth: initialization.targetAuth,
			authorizationBinding: initialization.authorizationBinding,
		},
	};
	// One browser per run: every authorized MCP connection carrying the same
	// execution id shares Chrome. A
	// `X-Wfb-Browser-Lane: per-node` header instead isolates each script call
	// (node) in its own lane — leased from the BrowserStation farm when
	// configured, a separate local Chrome otherwise.
	const laneHeader = String(req.headers["x-wfb-browser-lane"] || "")
		.trim()
		.toLowerCase();
	const laneKey =
		laneHeader === "per-node" && ctxRef.value.executionId && ctxRef.value.nodeId
			? String(ctxRef.value.nodeId)
					.replace(/[^a-zA-Z0-9]/g, "")
					.slice(0, 12) || "lane"
			: null;
	const browserSession = laneKey
		? `wfb-${ctxRef.value.executionId}--${laneKey}`
		: `wfb-${ctxRef.value.executionId}`;
	const acquisition = browserContexts.acquire(
		browserSession,
		initialization.authorizationBinding,
	);
	if (!acquisition) {
		rejectBrowserAuthorization(res);
		return;
	}
	const { context: browserContext } = acquisition;
	if (
		shouldProvisionFarmBrowser({
			executionId: ctxRef.value.executionId,
			farmConfigured: lanesEnabled(),
			laneExists: Boolean(browserContext.lane),
		})
	) {
		// Fire the run or node lease now (idempotent); tool calls await readiness bounded.
		ensureLaneBrowser(browserContext);
	}
	let proxy;
	try {
		proxy = await makeProxy(ctxRef, browserContext);
	} catch (error) {
		await browserContexts.abandon(acquisition).catch(() => {});
		console.error(`[session] child startup failed: ${error?.message}`);
		res.status(503).json({ error: "Browser lane unavailable" });
		return;
	}
	const { server, cleanup } = proxy;
	let transport;
	const lifecycle = createMcpSessionLifecycle({
		registry: browserContexts,
		acquisition,
		sessions,
		cleanup,
		getTransportSessionId: () => transport?.sessionId ?? null,
	});
	transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (newSid) => {
			lifecycle.initialize(newSid, {
				transport,
				executionId: initialization.executionId,
				assertionDigest: initialization.assertionDigest,
				authorizationBinding: initialization.authorizationBinding,
				browserContext,
				postCloseSchemaRefreshAvailable: true,
			});
			console.error(
				`[session] ${newSid} exec=${ctxRef.value.executionId ?? "-"} browser=${browserSession} node=${ctxRef.value.nodeId ?? "-"}`,
			);
		},
	});
	transport.onclose = async () => {
		await lifecycle.dispose().catch(() => {});
	};
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
		await lifecycle.cleanupUncommittedAfterHandle().catch(() => {});
	} catch (error) {
		await lifecycle.dispose().catch(() => {});
		console.error(`[session] initialization failed: ${error?.message}`);
		if (!res.headersSent) {
			res.status(503).json({ error: "Browser session initialization failed" });
		}
	}
});

async function replay(req, res) {
	const sid = req.headers["mcp-session-id"];
	const session = typeof sid === "string" ? sessions.get(sid) : null;
	if (!session) {
		res.status(400).send("invalid or missing mcp-session-id");
		return;
	}
	const authorized =
		req.method === "DELETE"
			? requestMatchesSessionTerminationAuthorization(req, session)
			: await requestMatchesSessionAuthorization(req, session);
	if (!authorized) {
		rejectBrowserAuthorization(res);
		return;
	}
	try {
		await session.transport.handleRequest(req, res);
	} finally {
		if (req.method === "DELETE") {
			await session.dispose().catch(() => {});
		}
	}
}
app.get("/mcp", replay);
app.delete("/mcp", replay);

app.listen(PORT, "0.0.0.0", () => {
	console.error(
		`[agent-browser-mcp] bridge listening on :${PORT}/mcp (tools=${TOOLS}, exposed=${EXPOSED_TOOLS.length || "all"}, auto=${AUTO_CAPTURE.join("+") || "off"}, idleStopMs=${AUTO_CAPTURE_IDLE_MS}, lanes=${lanesEnabled() ? BROWSERSTATION_URL : "local-only"})`,
	);
	console.error(
		`[agent-browser-mcp] artifact sink: ${BFF}/api/internal/browser-artifacts`,
	);
});
