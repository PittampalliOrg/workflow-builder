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
	const server = new Server(
		{ name: "agent-browser-mcp", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => child.listTools());
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		const result = await child.callTool({ name, arguments: args || {} });
		if (ARTIFACT_TOOLS[name]) {
			try {
				await persistArtifact(ctxRef.value, seenPaths, name, result);
			} catch (err) {
				console.error(`[artifact] persist error: ${err?.message}`);
			}
		}
		return result;
	});
	const cleanup = async () => {
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
	console.error(`[agent-browser-mcp] bridge listening on :${PORT}/mcp (tools=${TOOLS})`);
	console.error(`[agent-browser-mcp] artifact sink: ${BFF}/api/internal/browser-artifacts`);
});
