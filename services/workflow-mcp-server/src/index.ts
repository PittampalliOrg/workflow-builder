/**
 * Workflow MCP Server
 *
 * MCP server that exposes workflow builder tools over HTTP
 * (StreamableHTTP transport).
 *
 * ENV: DATABASE_URL (required), PORT (default 3200)
 */

import "./otel.js";

import http from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PostgresWorkflowPersistenceAdapter } from "./adapters/postgres-workflow-persistence.js";
import { HttpWorkflowDiagnosticsAdapter } from "./adapters/http-workflow-diagnostics.js";
import { HttpPreviewEnvironmentsAdapter } from "./adapters/http-preview-environments.js";
import { ApplicationPreviewEnvironmentService } from "./application/preview-environments.js";
import { ApplicationWorkflowDiagnosticsService } from "./application/workflow-diagnostics.js";
import {
  hasWorkflowMcpScope,
  resolveWorkflowMcpContext,
  runWithWorkflowMcpContext,
  workflowMcpSessionToolAccess,
  type WorkflowMcpRequestContext,
  type WorkflowMcpPrincipal,
  WORKFLOW_MCP_SCOPES,
} from "./auth-context.js";
import {
  registerWorkflowContextTool,
  WORKFLOW_MCP_INSTRUCTIONS,
} from "./context-tools.js";
import { initDb } from "./db.js";
import {
	registerWorkflowTools,
	type RegisteredTool,
} from "./workflow-tools.js";
import { registerTraceTools } from "./trace-tools.js";
import { registerPreviewEnvironmentTools } from "./preview-tools.js";
import {
	registerScriptTools,
	shouldSuppressScriptTools,
} from "./script-tools.js";
import {
	createStructuredOutputMcpServer,
	parseStructuredOutputContext,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from "./structured-output-tools.js";
import { runWithTeamContext } from "./team-context.js";
import { runWithSessionContext } from "./session-context.js";
import { registerTeamTools } from "./team-tools.js";
import {
	diagnosticMcpRequestTrace,
	diagnosticMcpResponseTrace,
	setSpanInput,
	setSpanOutput,
} from "./observability/content.js";
import type { WorkflowPersistencePort } from "./ports/workflow-persistence.js";

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RESPONSE_CAPTURE_MAX_BYTES = 60_000;
const TOOL_CATALOG_PRINCIPAL: WorkflowMcpPrincipal = {
  authMode: "workspace_api_key",
  userId: "tool-catalog",
  projectId: "tool-catalog",
  scopes: [...WORKFLOW_MCP_SCOPES],
  principalAssertion: "tool-catalog",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

// STATELESS transport (SDK "Stateless Mode"): every POST gets a fresh
// transport + server derived entirely from that request's headers (user id,
// team role, script depth, structured-output schema) — there is NO per-pod
// session map. This is what makes replicas>1 safe: the streamable-http
// session handshake is otherwise pod-local, so behind a non-sticky Service a
// follow-up POST that lands on the other replica 400s ("No valid session ID
// provided") and the client's tool load silently fails (observed on dev
// 2026-07-10: teammates lost claim_task/update_task and idled forever).
// Clients that still send mcp-session-id (mid-rollout, or ephemeral clients
// that cached one) are served fine — stateless transports don't validate it.

// Loaded at startup
let registeredTools: RegisteredTool[] = [];
const STRUCTURED_OUTPUT_HEALTH_TOOLS: RegisteredTool[] = [
	{
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		description: "Session-scoped structured-output tool",
	},
];

// ── Helpers ──────────────────────────────────────────────────

function setCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const configuredOrigin = process.env.WORKFLOW_MCP_ALLOWED_ORIGIN?.trim();
  const requestOrigin = req.headers.origin;
  if (
    configuredOrigin &&
    typeof requestOrigin === "string" &&
    requestOrigin === configuredOrigin
  ) {
    res.setHeader("Access-Control-Allow-Origin", configuredOrigin);
    res.setHeader("Vary", "Origin");
  }
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Accept",
      "Authorization",
      "Content-Type",
      "Mcp-Protocol-Version",
      "Mcp-Session-Id",
      "X-Wfb-Mcp-Mode",
      "X-Wfb-Structured-Output-Schema-B64",
      "X-Wfb-Session-Id",
      "X-Wfb-Session-Token",
    ].join(", "),
  );
	res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	setSpanOutput(data);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

type ResponseCaptureControl = {
	setDiagnosticTool(tool: string): void;
};

function installResponseCapture(res: http.ServerResponse): ResponseCaptureControl {
	const originalWrite = res.write.bind(res) as (...args: any[]) => boolean;
	const originalEnd = res.end.bind(res) as (
		...args: any[]
	) => http.ServerResponse;
	const chunks: Buffer[] = [];
	let capturedBytes = 0;
	let observedBytes = 0;
	let finished = false;
	let diagnosticTool: string | null = null;

	const capture = (chunk: unknown, encoding?: BufferEncoding): void => {
		if (chunk == null) return;
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: ArrayBuffer.isView(chunk)
				? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				: chunk instanceof ArrayBuffer
					? Buffer.from(chunk)
					: Buffer.from(String(chunk), encoding);
		observedBytes += buffer.byteLength;
		if (capturedBytes >= RESPONSE_CAPTURE_MAX_BYTES) return;
		const remaining = RESPONSE_CAPTURE_MAX_BYTES - capturedBytes;
		const selected =
			buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
		chunks.push(selected);
		capturedBytes += selected.byteLength;
	};

	res.write = ((
		chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		capture(
			chunk,
			typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
		);
		return typeof encodingOrCallback === "function"
			? originalWrite(chunk, encodingOrCallback)
			: originalWrite(chunk, encodingOrCallback, callback);
	}) as typeof res.write;

	res.end = ((
		chunk?: unknown,
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	) => {
		if (finished) {
			return typeof encodingOrCallback === "function"
				? originalEnd(chunk, encodingOrCallback)
				: originalEnd(chunk, encodingOrCallback, callback);
		}
		finished = true;
		capture(
			chunk,
			typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
		);
		if (chunks.length > 0) {
			const raw = Buffer.concat(chunks).toString("utf-8");
			setSpanOutput(
				diagnosticTool
					? {
							...diagnosticMcpResponseTrace(raw, diagnosticTool),
							responseBytes: observedBytes,
							captureTruncated: observedBytes > capturedBytes,
						}
					: raw,
			);
		}
		return typeof encodingOrCallback === "function"
			? originalEnd(chunk, encodingOrCallback)
			: originalEnd(chunk, encodingOrCallback, callback);
	}) as typeof res.end;

	return {
		setDiagnosticTool(tool: string) {
			diagnosticTool = tool;
		},
	};
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks).toString("utf-8");
				resolve(body ? JSON.parse(body) : undefined);
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

/** Options controlling which tool groups a server instance exposes. */
type CreateMcpServerOptions = {
  // Recursion guard from the BFF-signed platform-session capability.
	suppressScriptTools?: boolean;
  // Verified team role: "none" registers no team tools, "lead" registers all,
  // and "member" registers only worker tools.
	teamRole?: "none" | "lead" | "member";
};

/** Create a new MCP Server instance with workflow tools. */
function createMcpServer(
  context: WorkflowMcpRequestContext,
  persistence: WorkflowPersistencePort,
	opts?: CreateMcpServerOptions,
): Server {
	const mcpServer = new McpServer(
		{ name: "workflow-builder-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: WORKFLOW_MCP_INSTRUCTIONS,
    },
	);
  registerWorkflowContextTool(mcpServer, context);

  const principal = context.principal;
  if (!principal) return mcpServer.server;
  const sessionTools = workflowMcpSessionToolAccess(principal);

	// Current workflow tools are UI-independent. The legacy Remote DOM/canvas
	// authoring tools are no longer registered by workflow-tools.ts.
  registerWorkflowTools(mcpServer, { persistence, principal });
  // Goal MCP tools (create_goal/update_goal/get_goal) were removed — goals
  // are authored in code via the dynamic-script engine and completed by the
  // BFF evidence backstop, not self-declared/self-completed over MCP.
  if (hasWorkflowMcpScope(principal, "workflow:read")) {
    registerTraceTools(mcpServer, {
      principal,
      diagnostics: new ApplicationWorkflowDiagnosticsService(
        new HttpWorkflowDiagnosticsAdapter({ principal }),
      ),
    });
  }
  registerPreviewEnvironmentTools(mcpServer, {
    principal,
    previews: new ApplicationPreviewEnvironmentService(
      new HttpPreviewEnvironmentsAdapter({ principal }),
    ),
  });

	// Dynamic workflow script tool — also UI-independent. Suppressed inside
	// script-spawned sessions (recursion guard) via suppressScriptTools.
	if (opts?.suppressScriptTools !== true) {
    registerScriptTools(mcpServer, { persistence, principal });
	}

	// Team tools register by role: none → no team tools (not in a team), lead →
	// all, member → worker tools only (nesting guard). Role comes from
  // the BFF-signed platform-session capabilities.
  if (sessionTools.team && opts?.teamRole && opts.teamRole !== "none") {
		registerTeamTools(mcpServer, { role: opts.teamRole });
	}

	return mcpServer.server;
}

// ── HTTP Request Handler ─────────────────────────────────────

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
  persistence: WorkflowPersistencePort,
): Promise<void> {
  setCorsHeaders(req, res);
	const responseCapture = installResponseCapture(res);

	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (url === "/health" && method === "GET") {
		let toolList = registeredTools;
		try {
			if (parseStructuredOutputContext(req.headers)) {
				toolList = STRUCTURED_OUTPUT_HEALTH_TOOLS;
			}
		} catch (error) {
			sendJson(res, 400, {
				error: {
					message:
						error instanceof Error
							? error.message
							: `Invalid structured-output MCP context: ${String(error)}`,
				},
			});
			return;
		}
		sendJson(res, 200, {
			service: "workflow-builder-mcp",
			tools: toolList.length,
			toolNames: toolList.map((t) => t.name),
		});
		return;
	}

	if (url === "/mcp") {
		if (method === "POST") {
			await handleMcpPost(req, res, persistence, responseCapture);
		} else if (method === "GET") {
			await handleMcpGet(req, res);
		} else if (method === "DELETE") {
			await handleMcpDelete(req, res);
		} else {
			res.writeHead(405);
			res.end("Method Not Allowed");
		}
		return;
	}

	res.writeHead(404);
	res.end("Not Found");
}

async function handleMcpPost(
	req: http.IncomingMessage,
	res: http.ServerResponse,
  persistence: WorkflowPersistencePort,
	responseCapture: ResponseCaptureControl,
): Promise<void> {
	const body = await parseBody(req);
	const diagnosticRequest = diagnosticMcpRequestTrace(body);
	if (diagnosticRequest) {
		responseCapture.setDiagnosticTool(diagnosticRequest.tool);
		setSpanInput(diagnosticRequest);
	} else {
		setSpanInput({ body });
	}

  const context = await resolveWorkflowMcpContext(req.headers);
  // Recursion and team privileges come only from BFF-signed session claims.
  // Caller-controlled depth/team headers are deliberately ignored.
  const suppressScriptTools = shouldSuppressScriptTools(
    context.principal?.capabilities,
  );
  const teamRole = context.principal?.sessionId
    ? context.principal.capabilities.teamRole
    : "none";

	let structuredOutputContext;
	try {
		structuredOutputContext = parseStructuredOutputContext(req.headers);
	} catch (error) {
		sendJson(res, 400, {
			error: {
				message:
					error instanceof Error
						? error.message
						: `Invalid structured-output MCP context: ${String(error)}`,
			},
		});
		return;
	}

	// Fresh per-request transport + server (stateless mode: no session id is
	// issued and none is required). Torn down when the response closes.
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
  const server =
    structuredOutputContext && context.principal
		? createStructuredOutputMcpServer(structuredOutputContext.schema)
      : createMcpServer(context, persistence, {
          suppressScriptTools,
          teamRole,
        });
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);

	// Bind the workflow-builder session (codex thread) for this request so the
	// session-scoped tools (e.g. team tools) can resolve which session.
  const wfbSessionId = context.principal?.sessionId;
  const wfbTeamId = context.principal?.capabilities.teamId ?? null;
  await runWithWorkflowMcpContext(context, () =>
    runWithSessionContext({ sessionId: wfbSessionId ?? null }, () =>
      runWithTeamContext({ teamId: wfbSessionId ? wfbTeamId : null }, () =>
        transport.handleRequest(req, res, body),
      ),
    ),
	);
}

// Stateless mode: no standalone SSE stream and no client-initiated session
// termination — 405 per the SDK's stateless example. MCP clients treat both
// as "server doesn't offer this" and carry on.
async function handleMcpGet(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setSpanInput({ method: "GET", path: "/mcp" });
	res.writeHead(405, { Allow: "POST" });
	res.end("Method Not Allowed");
}

async function handleMcpDelete(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setSpanInput({ method: "DELETE", path: "/mcp" });
	res.writeHead(405, { Allow: "POST" });
	res.end("Method Not Allowed");
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Initialize database pool
	console.log("[wf-mcp] Initializing database connection...");
	initDb();
  const workflowPersistence = new PostgresWorkflowPersistenceAdapter();

	// Dry-run registration to count the normal-mode MCP surface. Structured
	// output is a separate header-selected mode and is reported separately by
	// /health when those headers are present.
	{
		const dryServer = new McpServer(
			{ name: "dry-run", version: "0.0.0" },
			{ capabilities: { tools: {}, resources: {} } },
		);
		registeredTools = [
      ...registerWorkflowContextTool(dryServer),
      ...registerWorkflowTools(dryServer, {
        persistence: workflowPersistence,
        principal: TOOL_CATALOG_PRINCIPAL,
      }),
		];
	}
	// Count workspace-scoped trace tools. Runtime registration still requires
	// workflow:read from the authenticated principal.
	{
		const dryTraceServer = new McpServer(
			{ name: "dry-run-trace", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerTraceTools(dryTraceServer, {
				principal: TOOL_CATALOG_PRINCIPAL,
				diagnostics: new ApplicationWorkflowDiagnosticsService(
					new HttpWorkflowDiagnosticsAdapter({
						principal: TOOL_CATALOG_PRINCIPAL,
					}),
				),
			}),
		];
	}
	// Count BFF-authorized preview lifecycle and diagnostic tools. Individual
	// runtime registration still honors workflow:read / workflow:execute scopes.
	{
		const dryPreviewServer = new McpServer(
			{ name: "dry-run-preview", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerPreviewEnvironmentTools(dryPreviewServer, {
				principal: TOOL_CATALOG_PRINCIPAL,
				previews: new ApplicationPreviewEnvironmentService(
					new HttpPreviewEnvironmentsAdapter({
						principal: TOOL_CATALOG_PRINCIPAL,
					}),
				),
			}),
		];
	}
	// Count the dynamic workflow script tool (suppressed only inside
	// script-spawned sessions).
	{
		const dryScriptServer = new McpServer(
			{ name: "dry-run-script", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
      ...registerScriptTools(dryScriptServer, {
        persistence: workflowPersistence,
        principal: TOOL_CATALOG_PRINCIPAL,
      }),
		];
	}
	// Count the team tools (suppressed only for teammate sessions carrying
	// X-Wfb-Team-Depth). Session/team scope resolves at call time.
	{
		const dryTeamServer = new McpServer(
			{ name: "dry-run-team", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerTeamTools(dryTeamServer, { role: "lead" }),
		];
	}

	// Start HTTP server
	const httpServer = http.createServer(async (req, res) => {
		try {
      await handleRequest(req, res, workflowPersistence);
		} catch (error) {
			console.error("[wf-mcp] Unhandled error:", error);
			if (!res.headersSent) {
				sendJson(res, 500, { error: "Internal Server Error" });
			}
		}
	});

	httpServer.listen(PORT, HOST, () => {
		console.log(`[wf-mcp] workflow-mcp-server listening on ${HOST}:${PORT}`);
		console.log(
			`[wf-mcp] Registered ${registeredTools.length} tools: ${registeredTools.map((t) => t.name).join(", ")}`,
		);
		console.log(`[wf-mcp] MCP endpoint: http://${HOST}:${PORT}/mcp`);
		console.log(`[wf-mcp] Health check: http://${HOST}:${PORT}/health`);
	});
}

main().catch((error) => {
	console.error("[wf-mcp] Fatal startup error:", error);
	process.exit(1);
});
