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
//     profiles (so the bridge can call capture tools), but tools/list shown to
//     the LLM is filtered to a navigation-oriented action set with pruned
//     schemas. 77+ tools × a dozen restore/namespace/session props each was
//     measurable context bloat and provoked tool-choice loops.
//  4. DEMO SCENES + AUTO-EDITOR: a bridge-implemented virtual tool `demo_scene`
//     lets the agent mark scene boundaries with ONE semantic call (the bridge
//     translates it to record_restart + metadata — no start/stop pairing).
//     When the run closes, titled scene clips are auto-edited (render.mjs:
//     dead-time cuts, captions, title/end cards) into one demo MP4 persisted
//     to the run. Untitled footage (recon wandering) never ships in a demo.
import express from "express";
import { randomUUID } from "node:crypto";
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

const PORT = Number(process.env.PORT || 8000);
// state = cookies/storage (the bridge's own target-auth cookie injection).
const TOOLS = process.env.AGENT_BROWSER_TOOLS || "core,network,debug,state";
const BFF =
	process.env.WORKFLOW_BUILDER_URL ||
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const TOKEN = process.env.INTERNAL_API_TOKEN || "";

// Target-auth injection: authenticate the demo browser to an app the run owner
// controls, WITHOUT the LLM typing credentials and WITHOUT the token entering
// the trace. The run's owning session forwards, per run, on the browser MCP
// entry:
//   X-Wfb-Target-Auth       = "<cookieName>=<cookieValue>" (or "Bearer <token>")
//   X-Wfb-Target-Auth-Host  = the ONE host the credential may be presented to
// The bridge sets that cookie (via agent-browser cookies_set) the first time the
// agent opens a page on the matching host, then re-opens so the agent sees the
// authenticated page. HOST-SCOPING is the safety boundary: the owner credential
// is never attached to any other origin the browser visits.
function parseTargetAuth(headers) {
	const raw = String(headers["x-wfb-target-auth"] || "").trim();
	const host = String(headers["x-wfb-target-auth-host"] || "").trim().toLowerCase();
	if (!raw || !host) return null;
	// "Bearer <jwt>" → send as an Authorization header instead of a cookie.
	if (/^bearer\s+/i.test(raw)) {
		return { host, kind: "header", headerName: "Authorization", headerValue: raw };
	}
	const eq = raw.indexOf("=");
	if (eq <= 0) return null;
	return { host, kind: "cookie", cookieName: raw.slice(0, eq), cookieValue: raw.slice(eq + 1) };
}

// Tools the LLM sees in tools/list. The child still exposes everything in
// AGENT_BROWSER_TOOLS — calls to unlisted tools pass through, this only trims
// discovery. Empty value = expose everything unfiltered.
const EXPOSED_TOOLS = (
	process.env.AGENT_BROWSER_EXPOSED_TOOLS ??
	[
		"agent_browser_open",
		"agent_browser_snapshot",
		"agent_browser_click",
		"agent_browser_fill",
		"agent_browser_type",
		"agent_browser_press",
		"agent_browser_hover",
		"agent_browser_select",
		"agent_browser_highlight",
		"agent_browser_scroll",
		"agent_browser_back",
		"agent_browser_wait_for_selector",
		"agent_browser_wait_for_load",
		"agent_browser_screenshot",
		"agent_browser_get_text",
		"agent_browser_get_url",
		"agent_browser_get_title",
		"agent_browser_pdf",
		"agent_browser_close",
	].join(",")
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Schema properties worth showing the LLM; everything else (session, namespace,
// restore*, extraArgs, screenshotDir, …) is plumbing the bridge/child handle.
const EXPOSED_PROPS = new Set([
	"url",
	"selector",
	"text",
	"key",
	"value",
	"state",
	"path",
	"fullPage",
	"format",
	"quality",
	"direction",
	"amount",
	"interactive",
	"compact",
	"depth",
	"timeoutMs",
]);

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
function inlineImage(result) {
	const img = (result?.content || []).find((c) => c && c.type === "image" && c.data);
	return img ? { data: img.data, mime: img.mimeType || "image/png" } : null;
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

function pruneToolForLlm(tool) {
	const schema = tool.inputSchema || {};
	const properties = {};
	for (const [key, value] of Object.entries(schema.properties || {})) {
		if (EXPOSED_PROPS.has(key)) properties[key] = value;
	}
	const required = (schema.required || []).filter((key) => EXPOSED_PROPS.has(key));
	return {
		...tool,
		inputSchema: {
			type: "object",
			properties,
			...(required.length ? { required } : {}),
		},
	};
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

async function startCapture(browserSession, ctx, child, openedUrl) {
	if (captures.has(browserSession)) return;
	const pending = pendingScenes.get(browserSession);
	pendingScenes.delete(browserSession);
	const entry = {
		ctx,
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
		await persistBlob(entry.ctx, {
			bucket: "assets",
			kind: "video",
			payloadBase64: buf.toString("base64"),
			contentType: "video/mp4",
			fileName: "demo.mp4",
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

async function stopCapture(browserSession, reason, liveChild) {
	const entry = captures.get(browserSession);
	if (!entry || entry.stopped) return;
	entry.stopped = true;
	captures.delete(browserSession);
	pendingScenes.delete(browserSession);
	authApplied.delete(browserSession);
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
			return;
		}
	}
	try {
		if (entry.videoActive) {
			entry.videoActive = false;
			try {
				const result = await child.callTool({ name: "agent_browser_record_stop", arguments: {} });
				const hasDemoScenes = entry.clips.some((c) => c.title);
				if (hasDemoScenes) {
					// Edit in the background: the close call must return promptly, and
					// ffmpeg over several clips can take tens of seconds.
					console.error(`[auto-capture] video stopped (${reason}) — demo render queued`);
					renderAndPersistDemo(entry).catch((err) =>
						console.error(`[demo] background render error: ${err?.message}`),
					);
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
				const result = await child.callTool({
					name: "agent_browser_network_har_stop",
					arguments: {},
				});
				await persistArtifact(entry.ctx, entry.seen, "agent_browser_network_har_stop", result);
				console.error(`[auto-capture] HAR stopped+persisted (${reason})`);
			} catch (err) {
				console.error(`[auto-capture] har_stop failed (${reason}): ${err?.message}`);
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
	}
}

// browserSessions whose owner credential has already been planted.
const authApplied = new Set();

/** If the run carries a target-auth credential and the just-opened URL is on the
 * permitted host, plant it (cookie or header) so subsequent navigations — incl.
 * the recorder's fresh-context record_start, which preserves cookies — are
 * authenticated. Returns true if it planted something (caller should re-open so
 * the agent sees the authenticated page). Host-scoped: the credential is never
 * set for any other origin. */
async function applyTargetAuth(browserSession, ctx, child, openedUrl) {
	const auth = ctx?.targetAuth;
	if (!auth || authApplied.has(browserSession)) return false;
	let host;
	try {
		host = new URL(openedUrl).host.toLowerCase();
	} catch {
		return false;
	}
	if (host !== auth.host) return false; // wrong origin — never present the credential
	authApplied.add(browserSession);
	try {
		if (auth.kind === "cookie") {
			await child.callTool({
				name: "agent_browser_cookies_set",
				arguments: { name: auth.cookieName, value: auth.cookieValue, url: openedUrl },
			});
			console.error(`[target-auth] cookie ${auth.cookieName} set for ${host} exec=${ctx.executionId}`);
		} else {
			await child.callTool({
				name: "agent_browser_set_headers",
				arguments: { headers: { [auth.headerName]: auth.headerValue } },
			});
			console.error(`[target-auth] auth header set for ${host} exec=${ctx.executionId}`);
		}
		return true;
	} catch (err) {
		console.error(`[target-auth] apply failed: ${err?.message}`);
		return false;
	}
}

function armIdleStop(browserSession) {
	const entry = captures.get(browserSession);
	if (!entry || !AUTO_CAPTURE_IDLE_MS) return;
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		stopCapture(browserSession, "idle").catch(() => {});
	}, AUTO_CAPTURE_IDLE_MS);
	entry.idleTimer.unref?.();
}

/** Build a per-connection MCP server that proxies to a fresh agent-browser child
 * (scoped to the run's browser session) and persists artifacts. `ctxRef.value`
 * is filled with the run context once the session initializes. */
async function makeProxy(ctxRef, browserSession) {
	const child = await spawnChild(browserSession);
	const seenPaths = new Set();

	const canPersist = () => Boolean(ctxRef.value?.executionId && TOKEN);

	const server = new Server(
		{ name: "agent-browser-mcp", version: "1.4.0" },
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
		if (EXPOSED_TOOLS.length) {
			const allow = new Set(EXPOSED_TOOLS);
			tools = tools.filter((t) => allow.has(t.name)).map(pruneToolForLlm);
		}
		if (AUTO_CAPTURE.includes("video")) tools.push(DEMO_SCENE_TOOL);
		return { tools };
	});
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		if (name === DEMO_SCENE_TOOL.name) {
			try {
				const message = await beginScene(browserSession, ctxRef.value, child, args);
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
		if (name === "agent_browser_close" && captures.has(browserSession)) {
			await stopCapture(browserSession, "close", child);
		}
		let result = await child.callTool({ name, arguments: args || {} });
		// Plant the run owner's credential on the first open of the permitted
		// host, then re-open so the agent (and the recorder) see the
		// authenticated page. Must happen before startCapture's record_start.
		if (
			name === "agent_browser_open" &&
			result?.isError !== true &&
			ctxRef.value?.targetAuth &&
			!authApplied.has(browserSession) &&
			typeof args?.url === "string"
		) {
			const planted = await applyTargetAuth(browserSession, ctxRef.value, child, args.url);
			if (planted) {
				result = await child.callTool({ name, arguments: args });
			}
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
					browserSession,
					ctxRef.value,
					child,
					typeof args?.url === "string" ? args.url : undefined,
				);
			} catch (err) {
				console.error(`[auto-capture] start failed: ${err?.message}`);
			}
		}
		armIdleStop(browserSession);
		return result;
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

const sessions = {}; // MCP sessionId -> { transport, cleanup }

app.post("/mcp", async (req, res) => {
	const sid = req.headers["mcp-session-id"];
	if (typeof sid === "string" && sessions[sid]) {
		await sessions[sid].transport.handleRequest(req, res, req.body);
		return;
	}
	// New session: the first (initialize) request carries the run headers.
	const ctxRef = {
		value: {
			executionId: req.headers["x-wfb-execution-id"] || null,
			workflowId: req.headers["x-wfb-workflow-id"] || null,
			nodeId: req.headers["x-wfb-node-id"] || null,
			targetAuth: parseTargetAuth(req.headers),
		},
	};
	// One browser per run: every MCP connection carrying the same execution id
	// shares Chrome; connections without a run get a throwaway browser.
	const browserSession = ctxRef.value.executionId
		? `wfb-${ctxRef.value.executionId}`
		: `wfb-anon-${randomUUID().slice(0, 8)}`;
	const { server, cleanup } = await makeProxy(ctxRef, browserSession);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (newSid) => {
			sessions[newSid] = { transport, cleanup };
			console.error(
				`[session] ${newSid} exec=${ctxRef.value.executionId ?? "-"} browser=${browserSession} node=${ctxRef.value.nodeId ?? "-"}`,
			);
		},
	});
	transport.onclose = async () => {
		const id = transport.sessionId;
		if (id && sessions[id]) delete sessions[id];
		await cleanup();
	};
	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

async function replay(req, res) {
	const sid = req.headers["mcp-session-id"];
	if (typeof sid !== "string" || !sessions[sid]) {
		res.status(400).send("invalid or missing mcp-session-id");
		return;
	}
	await sessions[sid].transport.handleRequest(req, res);
}
app.get("/mcp", replay);
app.delete("/mcp", replay);

app.listen(PORT, "0.0.0.0", () => {
	console.error(
		`[agent-browser-mcp] bridge listening on :${PORT}/mcp (tools=${TOOLS}, exposed=${EXPOSED_TOOLS.length || "all"}, auto=${AUTO_CAPTURE.join("+") || "off"}, idleStopMs=${AUTO_CAPTURE_IDLE_MS})`,
	);
	console.error(`[agent-browser-mcp] artifact sink: ${BFF}/api/internal/browser-artifacts`);
});
