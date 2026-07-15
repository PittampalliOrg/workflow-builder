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
// Two reliability measures keep small LLMs (GLM 5.2) effective:
//  1. AUTO-CAPTURE: the bridge is itself an MCP client of the agent-browser
//     child, so it starts HAR + video recording right after the agent's first
//     successful `open` and stops+persists them when the agent closes the
//     browser (or the session goes idle / tears down). The LLM never has to
//     choreograph record_start/record_stop pairs — trace review showed models
//     stall exactly there.
//  2. CURATED TOOL SURFACE: the child runs with the full core,network,debug
//     profiles (so the bridge can call capture tools), but tools/list shown to
//     the LLM is filtered to a small action set with pruned schemas. 77 tools ×
//     a dozen restore/namespace/session props each was measurable context bloat
//     and provoked tool-choice loops.
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

const PORT = Number(process.env.PORT || 8000);
const TOOLS = process.env.AGENT_BROWSER_TOOLS || "core,network,debug";
const BFF =
	process.env.WORKFLOW_BUILDER_URL ||
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const TOKEN = process.env.INTERNAL_API_TOKEN || "";

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
		"agent_browser_scroll",
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
// If the agent abandons the session without close, stop+persist after this idle gap.
const AUTO_CAPTURE_IDLE_MS = Number(process.env.AGENT_BROWSER_AUTO_CAPTURE_IDLE_MS || 180000);

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

	const body = {
		workflowExecutionId: ctx.executionId,
		workflowId: ctx.workflowId,
		nodeId: ctx.nodeId,
		status: "ok",
	};
	if (spec.bucket === "screenshots") {
		body.screenshots = [{ payloadBase64, contentType, label: fileName }];
	} else {
		body.assets = [{ kind: spec.kind, payloadBase64, contentType, fileName, label: fileName }];
	}
	try {
		const resp = await fetch(`${BFF}/api/internal/browser-artifacts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": TOKEN },
			body: JSON.stringify(body),
		});
		console.error(
			`[artifact] ${toolName} → ${fileName} (${contentType}) exec=${ctx.executionId} http=${resp.status}`,
		);
	} catch (err) {
		console.error(`[artifact] POST failed for ${toolName}: ${err?.message}`);
	}
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

/** Build a per-connection MCP server that proxies to a fresh agent-browser child
 * and persists artifacts. `ctxRef.value` is filled with the run context once the
 * session initializes. */
async function makeProxy(ctxRef) {
	const childTransport = new StdioClientTransport({
		command: "agent-browser",
		args: ["mcp", "--tools", TOOLS],
	});
	const child = new Client({ name: "agent-browser-child", version: "1.0.0" });
	await child.connect(childTransport);

	const seenPaths = new Set();
	// Auto-capture state for this session.
	const cap = { started: false, videoActive: false, harActive: false, idleTimer: null };

	const canPersist = () => Boolean(ctxRef.value?.executionId && TOKEN);

	async function startAutoCapture(openedUrl) {
		cap.started = true;
		if (AUTO_CAPTURE.includes("har")) {
			try {
				await child.callTool({ name: "agent_browser_network_har_start", arguments: {} });
				cap.harActive = true;
				console.error(`[auto-capture] HAR recording started exec=${ctxRef.value?.executionId}`);
			} catch (err) {
				console.error(`[auto-capture] har_start failed: ${err?.message}`);
			}
		}
		if (AUTO_CAPTURE.includes("video")) {
			try {
				const path = `/tmp/session-recording-${randomUUID().slice(0, 8)}.webm`;
				// record_start swaps to a fresh (cookie-preserving) context and
				// re-navigates, so pass the URL the agent just opened explicitly.
				const args = openedUrl ? { path, url: openedUrl } : { path };
				await child.callTool({ name: "agent_browser_record_start", arguments: args });
				cap.videoActive = true;
				console.error(`[auto-capture] video recording started → ${path}`);
			} catch (err) {
				console.error(`[auto-capture] record_start failed: ${err?.message}`);
			}
		}
	}

	async function stopAutoCapture(reason) {
		if (cap.idleTimer) clearTimeout(cap.idleTimer);
		cap.idleTimer = null;
		if (cap.videoActive) {
			cap.videoActive = false;
			try {
				const result = await child.callTool({ name: "agent_browser_record_stop", arguments: {} });
				await persistArtifact(ctxRef.value, seenPaths, "agent_browser_record_stop", result);
				console.error(`[auto-capture] video stopped+persisted (${reason})`);
			} catch (err) {
				console.error(`[auto-capture] record_stop failed (${reason}): ${err?.message}`);
			}
		}
		if (cap.harActive) {
			cap.harActive = false;
			try {
				const result = await child.callTool({
					name: "agent_browser_network_har_stop",
					arguments: {},
				});
				await persistArtifact(ctxRef.value, seenPaths, "agent_browser_network_har_stop", result);
				console.error(`[auto-capture] HAR stopped+persisted (${reason})`);
			} catch (err) {
				console.error(`[auto-capture] har_stop failed (${reason}): ${err?.message}`);
			}
		}
	}

	function armIdleStop() {
		if (!(cap.videoActive || cap.harActive) || !AUTO_CAPTURE_IDLE_MS) return;
		if (cap.idleTimer) clearTimeout(cap.idleTimer);
		cap.idleTimer = setTimeout(() => {
			stopAutoCapture("idle").catch(() => {});
		}, AUTO_CAPTURE_IDLE_MS);
		cap.idleTimer.unref?.();
	}

	const server = new Server(
		{ name: "agent-browser-mcp", version: "1.1.0" },
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
		return { tools };
	});
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		// The agent is done with the browser — capture must be finalized while
		// the browser session still exists.
		if (name === "agent_browser_close" && (cap.videoActive || cap.harActive)) {
			await stopAutoCapture("close");
		}
		const result = await child.callTool({ name, arguments: args || {} });
		if (ARTIFACT_TOOLS[name]) {
			try {
				await persistArtifact(ctxRef.value, seenPaths, name, result);
			} catch (err) {
				console.error(`[artifact] persist error: ${err?.message}`);
			}
		}
		if (
			name === "agent_browser_open" &&
			!cap.started &&
			result?.isError !== true &&
			AUTO_CAPTURE.length &&
			canPersist()
		) {
			try {
				await startAutoCapture(typeof args?.url === "string" ? args.url : undefined);
			} catch (err) {
				console.error(`[auto-capture] start failed: ${err?.message}`);
			}
		}
		armIdleStop();
		return result;
	});
	const cleanup = async () => {
		try {
			await stopAutoCapture("session-close");
		} catch {
			/* ignore */
		}
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

const sessions = {}; // sessionId -> { transport, cleanup }

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
		},
	};
	const { server, cleanup } = await makeProxy(ctxRef);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (newSid) => {
			sessions[newSid] = { transport, cleanup };
			console.error(
				`[session] ${newSid} exec=${ctxRef.value.executionId ?? "-"} node=${ctxRef.value.nodeId ?? "-"}`,
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
		`[agent-browser-mcp] bridge listening on :${PORT}/mcp (tools=${TOOLS}, exposed=${EXPOSED_TOOLS.length || "all"}, auto=${AUTO_CAPTURE.join("+") || "off"})`,
	);
	console.error(`[agent-browser-mcp] artifact sink: ${BFF}/api/internal/browser-artifacts`);
});
