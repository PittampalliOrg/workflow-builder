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
	shouldCloseBrowserAfterCapture,
	shouldProvisionFarmBrowser,
} from "./browser-lane-policy.mjs";
import {
	authorizeBrowserInitialization,
	createTargetAuthExchangeCache,
	exchangeTargetAuth,
	openedUrlMatchesTargetOrigin,
	parseTargetAuthAssertion,
	reauthorizeBrowserSession,
	targetAuthCookieToolArguments,
	targetAuthNeedsRefresh,
	validateTargetAuth,
} from "./target-auth-policy.mjs";

const PORT = Number(process.env.PORT || 8000);
// state = cookies/storage (the bridge's own target-auth cookie injection).
const TOOLS = process.env.AGENT_BROWSER_TOOLS || "core,network,debug,state";
const BFF =
	process.env.WORKFLOW_BUILDER_URL ||
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const TOKEN = process.env.INTERNAL_API_TOKEN || "";

// BrowserStation lanes: every execution-scoped browser is leased from the
// BrowserStation farm (KubeRay; one Chrome per worker pod), keeping Chromium
// out of this long-lived MCP bridge. `X-Wfb-Browser-Lane: per-node` further
// isolates concurrent script calls by node; otherwise one run shares one farm
// browser. Unset BROWSERSTATION_URL/API key falls back to local Chrome.
const BROWSERSTATION_URL = (process.env.BROWSERSTATION_URL || "").replace(/\/$/, "");
const BROWSERSTATION_API_KEY = process.env.BROWSERSTATION_API_KEY || "";
// Cold farm scale-up = pod schedule + image pull; warm worker ≈ 2s.
const LANE_READY_TIMEOUT_MS = Number(process.env.BROWSERSTATION_READY_TIMEOUT_MS || 240000);
// Tool calls wait this long for the lane, then return a retryable error so the
// agent's MCP call doesn't hit client timeouts during farm scale-up.
const LANE_CALL_WAIT_MS = Number(process.env.BROWSERSTATION_CALL_WAIT_MS || 45000);

// Target-auth injection: execution config carries only a short-lived,
// purpose-specific assertion. On first navigation the bridge exchanges that
// assertion with the fixed BFF endpoint using INTERNAL_API_TOKEN. The BFF
// derives the only allowed target origin and returns a short-lived owner cookie.
// The bridge plants it HttpOnly for that exact origin and never creates a global
// Authorization header.
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
const AUTO_CAPTURE_IDLE_MS = Number(process.env.AGENT_BROWSER_AUTO_CAPTURE_IDLE_MS || 300000);

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
			title: { type: "string", description: "Short scene title shown in the video (max ~40 chars)" },
			caption: {
				type: "string",
				description: "One-line caption explaining what this scene demonstrates (max ~90 chars)",
			},
			focus: {
				type: "string",
				description: "Optional: the overall demo focus/theme (set it on the first scene)",
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
	agent_browser_screenshot: { bucket: "screenshots", kind: "screenshot", ct: "image/png" },
	agent_browser_record_stop: { bucket: "assets", kind: "video", ct: "video/webm" },
	agent_browser_pdf: { bucket: "assets", kind: "trace", ct: "application/pdf" },
	agent_browser_network_har_stop: { bucket: "assets", kind: "trace", ct: "application/json" },
	agent_browser_trace_stop: { bucket: "assets", kind: "trace", ct: "application/zip" },
	agent_browser_profiler_stop: { bucket: "assets", kind: "trace", ct: "application/json" },
};

function resultText(result) {
	return (result?.content || [])
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}
// agent-browser echoes the saved path in its text output (e.g. "HAR saved to
// /root/.agent-browser/tmp/har/har-….har", "Recording saved to …").
function pathFromResult(result) {
	const m = resultText(result).match(/\/[^\s"'`]+\.(webm|pdf|har|zip|json|png|jpe?g)/i);
	return m ? m[0] : null;
}

async function persistBlob(ctx, { bucket, kind, payloadBase64, contentType, fileName }) {
	if (!ctx?.executionId || !TOKEN) return;
	const body = {
		workflowExecutionId: ctx.executionId,
		workflowId: ctx.workflowId,
		nodeId: ctx.nodeId,
		status: "ok",
	};
	if (bucket === "screenshots") {
		body.screenshots = [{ payloadBase64, contentType, label: fileName }];
	} else {
		body.assets = [{ kind, payloadBase64, contentType, fileName, label: fileName }];
	}
	try {
		const resp = await fetch(`${BFF}/api/internal/browser-artifacts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": TOKEN },
			body: JSON.stringify(body),
		});
		console.error(
			`[artifact] ${fileName} (${contentType}) exec=${ctx.executionId} http=${resp.status}`,
		);
	} catch (err) {
		console.error(`[artifact] POST failed for ${fileName}: ${err?.message}`);
	}
}

async function persistArtifact(ctx, seen, toolName, result) {
	const spec = ARTIFACT_TOOLS[toolName];
	if (!spec || !ctx?.executionId || !TOKEN) return;

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
		if (!p || seen.has(p)) return; // nothing new produced
		seen.add(p);
		try {
			payloadBase64 = (await readFile(p)).toString("base64");
		} catch (err) {
			console.error(`[artifact] read ${p} failed: ${err?.message}`);
			return;
		}
		fileName = p.split("/").pop();
	}
	await persistBlob(ctx, {
		bucket: spec.bucket,
		kind: spec.kind,
		payloadBase64,
		contentType,
		fileName,
	});
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
		authApplied: false,
		exchangeCache: createTargetAuthExchangeCache(),
		lane: null,
	}),
	releaseResources: releaseBrowserContextResources,
});

function lanesEnabled() {
	return Boolean(BROWSERSTATION_URL && BROWSERSTATION_API_KEY);
}

function bsFetch(path, init = {}) {
	return fetch(`${BROWSERSTATION_URL}${path}`, {
		...init,
		headers: {
			"X-API-Key": BROWSERSTATION_API_KEY,
			"Content-Type": "application/json",
			...(init.headers || {}),
		},
	});
}

function ensureLaneBrowser(browserContext) {
	if (browserContext.lane) return browserContext.lane.ready;
	const { browserSession } = browserContext;
	const lane = { browserId: null, ready: null };
	browserContext.lane = lane;
	lane.ready = (async () => {
		const created = await bsFetch("/browsers", { method: "POST", body: "{}" });
		if (!created.ok) throw new Error(`lease HTTP ${created.status}`);
		lane.browserId = (await created.json()).browser_id;
		const deadline = Date.now() + LANE_READY_TIMEOUT_MS;
		let info;
		for (;;) {
			if (!browserContexts.isCurrent(browserContext)) {
				throw new Error("lane authorization closed during provisioning");
			}
			const resp = await bsFetch(`/browsers/${lane.browserId}`);
			if (resp.ok) {
				info = await resp.json();
				if (info.chrome_ready && info.websocket_url) break;
			} else if (resp.status === 404) {
				// The farm GC'd a lease that pended too long for capacity.
				lane.browserId = null;
				throw new Error("lease expired waiting for farm capacity");
			}
			if (Date.now() > deadline) throw new Error(`farm browser not ready in ${LANE_READY_TIMEOUT_MS}ms`);
			await new Promise((r) => setTimeout(r, 3000));
		}
		if (!browserContexts.isCurrent(browserContext)) {
			throw new Error("lane authorization closed before attachment");
		}
		const ws = BROWSERSTATION_URL.replace(/^http/, "ws") + info.websocket_url;
		await new Promise((resolve, reject) => {
			const p = spawn("agent-browser", ["connect", ws], {
				env: { ...process.env, AGENT_BROWSER_SESSION: browserSession },
				stdio: ["ignore", "ignore", "inherit"],
			});
			p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`connect exit ${code}`))));
			p.on("error", reject);
		});
		console.error(`[lane] ${browserSession} attached to farm browser ${lane.browserId}`);
		return true;
	})().catch(async (err) => {
		console.error(
			`[lane] ${browserSession} farm lease failed (${err?.message}) — this lane uses a local Chrome`,
		);
		if (lane.browserId) {
			try {
				await bsFetch(`/browsers/${lane.browserId}`, { method: "DELETE" });
			} catch {
				/* best-effort */
			}
			lane.browserId = null;
		}
		return false;
	});
	return lane.ready;
}

async function releaseBrowserContextResources(browserContext) {
	browserContext.authApplied = false;
	browserContext.exchangeCache.clear();
	const lane = browserContext.lane;
	browserContext.lane = null;
	if (!lane) return;
	await lane.ready?.catch(() => false);
	if (!lane.browserId) return;
	try {
		await bsFetch(`/browsers/${lane.browserId}`, { method: "DELETE" });
		console.error(
			`[lane] ${browserContext.browserSession}#${browserContext.generation} released farm browser ${lane.browserId}`,
		);
		lane.browserId = null;
	} catch (err) {
		console.error(
			`[lane] release failed for ${browserContext.browserSession}#${browserContext.generation}: ${err?.message}`,
		);
	}
}

function spawnChild(browserSession) {
	const childTransport = new StdioClientTransport({
		command: "agent-browser",
		args: ["mcp", "--tools", TOOLS],
		env: { ...process.env, AGENT_BROWSER_SESSION: browserSession },
	});
	const child = new Client({ name: "agent-browser-child", version: "1.0.0" });
	return child.connect(childTransport).then(() => child);
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

function newClipPath() {
	return `/tmp/clip-${randomUUID().slice(0, 8)}.webm`;
}

async function startCapture(browserContext, ctx, child, openedUrl) {
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
			await child.callTool({ name: "agent_browser_network_har_start", arguments: {} });
			entry.harActive = true;
			console.error(`[auto-capture] HAR recording started exec=${ctx.executionId}`);
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
			await child.callTool({ name: "agent_browser_record_start", arguments: args });
			entry.videoActive = true;
			entry.clips.push({ path, title: pending?.title ?? null, caption: pending?.caption ?? "" });
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

async function beginScene(browserSession, ctx, child, args) {
	const title = String(args?.title || "").slice(0, 60).trim() || "Untitled scene";
	const caption = String(args?.caption || "").slice(0, 120).trim();
	const focus = String(args?.focus || "").trim();
	const entry = captures.get(browserSession);
	if (!entry || entry.stopped || !entry.videoActive) {
		// Browser not open yet — remember the scene; it applies when capture starts.
		pendingScenes.set(browserSession, { title, caption, focus });
		return `Scene queued: "${title}" (it starts with the first page you open).`;
	}
	if (focus) entry.focus = focus;
	const path = newClipPath();
	await child.callTool({ name: "agent_browser_record_restart", arguments: { path } });
	entry.clips.push({ path, title, caption });
	armIdleStop(browserSession);
	const n = entry.clips.filter((c) => c.title).length;
	console.error(`[demo] scene ${n} "${title}" started exec=${entry.ctx.executionId}`);
	return `Scene ${n} started: "${title}". Perform the scene's actions now.`;
}

async function renderAndPersistDemo(entry) {
	const titled = entry.clips.filter((c) => c.title);
	try {
		const demo = await renderDemo(titled, { site: entry.site, focus: entry.focus });
		const buf = await readAndRm(demo.path);
		// Parallel lanes each render their own mini-demo; name by scene so the
		// Browser tab distinguishes them from the run-level demo.mp4.
		const laneSuffix = entry.browserSession?.includes("--")
			? (titled[0]?.title || entry.browserSession.split("--").pop() || "lane")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 40)
			: null;
		await persistBlob(entry.ctx, {
			bucket: "assets",
			kind: "video",
			payloadBase64: buf.toString("base64"),
			contentType: "video/mp4",
			fileName: laneSuffix ? `page-${laneSuffix}.mp4` : "demo.mp4",
		});
		console.error(
			`[demo] rendered ${demo.seconds.toFixed(1)}s (${titled.length} scene(s), speedup ${demo.speedup.toFixed(2)}x) exec=${entry.ctx.executionId}`,
		);
	} catch (err) {
		console.error(`[demo] render failed (${err?.message}) — persisting raw scene clips`);
		for (const clip of titled) {
			try {
				const buf = await readFile(clip.path);
				await persistBlob(entry.ctx, {
					bucket: "assets",
					kind: "video",
					payloadBase64: buf.toString("base64"),
					contentType: "video/webm",
					fileName: clip.path.split("/").pop(),
				});
			} catch {
				/* clip unreadable — skip */
			}
		}
	}
}

async function stopCapture(browserContext, reason, liveChild) {
	const { browserSession } = browserContext;
	const entry = captures.get(browserSession);
	if (
		!entry ||
		entry.stopped ||
		entry.browserContext !== browserContext ||
		!browserContexts.beginClose(browserContext)
	) {
		return;
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
			ephemeral = await spawnChild(browserSession);
			child = ephemeral;
		} catch (err) {
			console.error(`[auto-capture] stop child spawn failed (${reason}): ${err?.message}`);
			await browserContexts.release(entry.browserContext).catch(() => {});
			return;
		}
	}
	try {
		if (entry.videoActive) {
			entry.videoActive = false;
			try {
				// Finalizing a long recording (ffmpeg) routinely exceeds the SDK's
				// 60s default request timeout — that lost every 10-min-plus video.
				const result = await child.callTool(
					{ name: "agent_browser_record_stop", arguments: {} },
					undefined,
					{ timeout: 300000 },
				);
				const hasDemoScenes = entry.clips.some((c) => c.title);
				if (hasDemoScenes) {
					// When the AGENT explicitly closes, the run finalizes right after this returns —
					// render+persist SYNCHRONOUSLY, or demo.mp4 lands after the run snapshot is frozen
					// and the viewer must hard-refresh to see it. Idle/teardown paths have nobody
					// waiting, so background them (don't block timers/exit).
					if (reason === "close") {
						console.error(`[auto-capture] video stopped (${reason}) — rendering demo inline`);
						await renderAndPersistDemo(entry);
					} else {
						console.error(`[auto-capture] video stopped (${reason}) — demo render queued`);
						renderAndPersistDemo(entry).catch((err) =>
							console.error(`[demo] background render error: ${err?.message}`),
						);
					}
				} else {
					await persistArtifact(entry.ctx, entry.seen, "agent_browser_record_stop", result);
					console.error(`[auto-capture] video stopped+persisted (${reason})`);
				}
			} catch (err) {
				console.error(`[auto-capture] record_stop failed (${reason}): ${err?.message}`);
			}
		}
		if (entry.harActive) {
			entry.harActive = false;
			try {
				const result = await child.callTool(
					{ name: "agent_browser_network_har_stop", arguments: {} },
					undefined,
					{ timeout: 300000 },
				);
				await persistArtifact(entry.ctx, entry.seen, "agent_browser_network_har_stop", result);
				console.error(`[auto-capture] HAR stopped+persisted (${reason})`);
			} catch (err) {
				console.error(`[auto-capture] har_stop failed (${reason}): ${err?.message}`);
			}
		}
		if (shouldCloseBrowserAfterCapture(reason)) {
			try {
				await child.callTool(
					{ name: "agent_browser_close", arguments: {} },
					undefined,
					{ timeout: 60000 },
				);
				console.error(`[browser] session closed after ${reason} cleanup`);
			} catch (err) {
				console.error(`[browser] close failed after ${reason}: ${err?.message}`);
			}
		}
	} finally {
		if (ephemeral) {
			try {
				await ephemeral.close();
			} catch {
				/* ignore */
			}
		}
		// Explicit close releases only after the caller's child close completes.
		if (reason !== "close") {
			await browserContexts.release(entry.browserContext).catch(() => {});
		}
	}
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

async function plantTargetAuthCookie(browserContext, ctx, child) {
	const exchange = await resolveTargetAuth(browserContext, ctx);
	if (!exchange) return null;
	await child.callTool({
		name: "agent_browser_cookies_set",
		arguments: targetAuthCookieToolArguments(exchange),
	});
	browserContext.authApplied = true;
	return exchange;
}

async function refreshTargetAuthCookie(browserContext, ctx, child) {
	if (!ctx?.targetAuth) return false;
	if (!browserContext.authApplied) return true;
	try {
		const existing = await browserContext.exchangeCache.peek(
			targetAuthExchangeInput(browserContext, ctx),
		);
		if (!targetAuthNeedsRefresh(existing)) return true;
		const refreshed = await plantTargetAuthCookie(browserContext, ctx, child);
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

/** Plant auth before the first navigation to the exact BFF-derived origin. */
async function prepareTargetAuth(browserContext, ctx, child, requestedUrl) {
	if (!ctx?.targetAuth || browserContext.authApplied) return "skip";
	const exchange = await resolveTargetAuth(browserContext, ctx);
	if (!exchange) {
		console.error(`[target-auth] exchange unavailable exec=${ctx.executionId ?? "-"}`);
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
		const planted = await plantTargetAuthCookie(browserContext, ctx, child);
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
	entry.idleTimer = setTimeout(() => {
		stopCapture(browserContext, "idle").catch(() => {});
	}, AUTO_CAPTURE_IDLE_MS);
	entry.idleTimer.unref?.();
}

/** Build a per-connection MCP server that proxies to a fresh agent-browser child
 * (scoped to the run's browser session) and persists artifacts. `ctxRef.value`
 * is filled with the run context once the session initializes. */
async function makeProxy(ctxRef, browserContext) {
	const { browserSession } = browserContext;
	const child = await spawnChild(browserSession);
	const seenPaths = new Set();

	const canPersist = () => Boolean(ctxRef.value?.executionId && TOKEN);

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
		if (
			!browserContexts.isCurrent(
				browserContext,
				browserContext.authorizationBinding,
			)
		) {
			return {
				content: [{ type: "text", text: "Browser lane authorization is closing." }],
				isError: true,
			};
		}
		// A lane still provisioning its farm browser must not let the first
		// tool call race ahead onto a fresh LOCAL Chrome — wait bounded, then
		// tell the agent to retry (cold farm scale-up can take minutes).
		const lane = browserContext.lane;
		if (lane) {
			const ready = await Promise.race([
				lane.ready,
				new Promise((r) => setTimeout(() => r("pending"), LANE_CALL_WAIT_MS)),
			]);
			if (ready === "pending") {
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
		}
		if (!(await refreshTargetAuthCookie(browserContext, ctxRef.value, child))) {
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
		if (name === DEMO_SCENE_TOOL.name) {
			try {
				const message = await beginScene(
					browserSession,
					ctxRef.value,
					child,
					sanitizedArgs,
				);
				return { content: [{ type: "text", text: message }] };
			} catch (err) {
				return {
					content: [{ type: "text", text: `demo_scene failed: ${err?.message}` }],
					isError: true,
				};
			}
		}
		// The agent is done with the browser — capture must be finalized while
		// the browser session still exists.
		const closesBrowser = name === "agent_browser_close";
		if (closesBrowser) {
			if (!browserContexts.beginClose(browserContext)) {
				return {
					content: [{ type: "text", text: "Browser lane is already closing." }],
					isError: true,
				};
			}
		}
		if (
			name === "agent_browser_open" &&
			ctxRef.value?.targetAuth &&
			!browserContext.authApplied &&
			typeof sanitizedArgs.url === "string"
		) {
			const prepared = await prepareTargetAuth(
				browserContext,
				ctxRef.value,
				child,
				sanitizedArgs.url,
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
		}
		let result;
		if (closesBrowser) {
			try {
				if (captures.has(browserSession)) {
					await stopCapture(browserContext, "close", child);
				}
				result = await child.callTool({ name, arguments: sanitizedArgs });
			} finally {
				await browserContexts.release(browserContext).catch(() => {});
			}
		} else {
			result = await child.callTool({ name, arguments: sanitizedArgs });
		}
		if (ARTIFACT_TOOLS[name]) {
			try {
				await persistArtifact(ctxRef.value, seenPaths, name, result);
			} catch (err) {
				console.error(`[artifact] persist error: ${err?.message}`);
			}
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
				typeof sanitizedArgs.url === "string" ? sanitizedArgs.url : undefined,
				);
			} catch (err) {
				console.error(`[auto-capture] start failed: ${err?.message}`);
			}
		}
		armIdleStop(browserSession);
		return preserveMultimodalToolResult(result);
	});
	const cleanup = async () => {
		// Transport closes after every dapr-agent-py tool call — the run (and
		// its capture) outlives this proxy. Just release the child process.
		try {
			await child.close();
		} catch {
			/* ignore */
		}
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

function rejectBrowserAuthorization(res) {
	res.status(403).json({ error: "Execution browser authorization denied" });
}

app.post("/mcp", async (req, res) => {
	const sid = req.headers["mcp-session-id"];
	const existingSession = typeof sid === "string" ? sessions.get(sid) : null;
	if (existingSession) {
		if (!(await requestMatchesSessionAuthorization(req, existingSession))) {
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
	const laneHeader = String(req.headers["x-wfb-browser-lane"] || "").trim().toLowerCase();
	const laneKey =
		laneHeader === "per-node" && ctxRef.value.executionId && ctxRef.value.nodeId
			? String(ctxRef.value.nodeId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "lane"
			: null;
	const browserSession = laneKey
		? `wfb-${ctxRef.value.executionId}--${laneKey}`
		: `wfb-${ctxRef.value.executionId}`;
	const existingBrowserContext = browserContexts.current(browserSession);
	const browserContext = browserContexts.acquire(
		browserSession,
		initialization.authorizationBinding,
	);
	if (!browserContext) {
		rejectBrowserAuthorization(res);
		return;
	}
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
		if (!existingBrowserContext) {
			await browserContexts.release(browserContext).catch(() => {});
		}
		console.error(`[session] child startup failed: ${error?.message}`);
		res.status(503).json({ error: "Browser lane unavailable" });
		return;
	}
	const { server, cleanup } = proxy;
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (newSid) => {
			sessions.set(newSid, {
				transport,
				cleanup,
				executionId: initialization.executionId,
				assertionDigest: initialization.assertionDigest,
				authorizationBinding: initialization.authorizationBinding,
				browserContext,
			});
			console.error(
				`[session] ${newSid} exec=${ctxRef.value.executionId ?? "-"} browser=${browserSession} node=${ctxRef.value.nodeId ?? "-"}`,
			);
		},
	});
	transport.onclose = async () => {
		const id = transport.sessionId;
		if (id) sessions.delete(id);
		await cleanup();
	};
	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

async function replay(req, res) {
	const sid = req.headers["mcp-session-id"];
	const session = typeof sid === "string" ? sessions.get(sid) : null;
	if (!session) {
		res.status(400).send("invalid or missing mcp-session-id");
		return;
	}
	if (!(await requestMatchesSessionAuthorization(req, session))) {
		rejectBrowserAuthorization(res);
		return;
	}
	await session.transport.handleRequest(req, res);
}
app.get("/mcp", replay);
app.delete("/mcp", replay);

app.listen(PORT, "0.0.0.0", () => {
	console.error(
		`[agent-browser-mcp] bridge listening on :${PORT}/mcp (tools=${TOOLS}, exposed=${EXPOSED_TOOLS.length || "all"}, auto=${AUTO_CAPTURE.join("+") || "off"}, idleStopMs=${AUTO_CAPTURE_IDLE_MS}, lanes=${lanesEnabled() ? BROWSERSTATION_URL : "local-only"})`,
	);
	console.error(`[agent-browser-mcp] artifact sink: ${BFF}/api/internal/browser-artifacts`);
});
