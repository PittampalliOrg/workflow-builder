/**
 * Trace-analyst MCP tools — the "ask the trace" chat's hands.
 *
 * Each tool proxies a BFF internal observability route scoped by BOTH the
 * internal token and the calling session's project (X-Wfb-Session-Id → the
 * BFF validates the execution belongs to the session's workspace). The agent
 * INVESTIGATES instead of receiving a trace dump: digest first, then targeted
 * span/log/LLM-turn reads — a 10k-span run never touches its context window.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "./workflow-tools.js";
import { currentGoalSessionId } from "./goal-context.js";

const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? "";
const TRACE_TOOL_TIMEOUT_MS = Number(process.env.TRACE_TOOL_TIMEOUT_MS) || 45_000;

function headers(): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Internal-Token": INTERNAL_API_TOKEN,
	};
	const sessionId = currentGoalSessionId();
	if (sessionId) h["X-Wfb-Session-Id"] = sessionId;
	return h;
}

function textResult(data: unknown) {
	return {
		content: [
			{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) },
		],
	};
}

function errorResult(msg: string) {
	return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export type TraceToolsContext = { fetchImpl?: typeof fetch };

export function registerTraceTools(
	server: McpServer,
	ctx?: TraceToolsContext,
): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const fetchImpl = ctx?.fetchImpl ?? fetch;

	async function get(executionId: string, path: string, params?: Record<string, string>) {
		if (!INTERNAL_API_TOKEN) throw new Error("INTERNAL_API_TOKEN is not configured");
		if (!currentGoalSessionId()) {
			throw new Error("No session context — trace tools require a session-scoped MCP connection");
		}
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		// Hard timeout: a stalled BFF/ClickHouse round-trip must surface as a tool
		// ERROR the agent can react to — an un-timed-out fetch here hangs the
		// agent's run_tool activity (and its whole session) indefinitely.
		const resp = await fetchImpl(
			`${WORKFLOW_BUILDER_URL}/api/internal/observability/executions/${encodeURIComponent(executionId)}${path}${qs}`,
			{ headers: headers(), signal: AbortSignal.timeout(TRACE_TOOL_TIMEOUT_MS) },
		);
		const body = await resp.json().catch(() => ({}));
		if (!resp.ok) {
			throw new Error(
				typeof (body as { error?: unknown }).error === "string"
					? (body as { error: string }).error
					: `HTTP ${resp.status}`,
			);
		}
		return body;
	}

	(server as any).registerTool(
		"trace_get_digest",
		{
			title: "Get Run Digest",
			description:
				"Deterministic summary of a workflow run's trace: status, wall clock, per-phase durations/tokens/cost, cache hit rate, the critical path, budget burn, and an ISSUES list (call errors with journal errorCodes, retries, span errors with the failure ancestry chain). ALWAYS call this FIRST when analyzing a run — it is the ground truth to anchor further investigation. Issues carry callId / spanId you can cite.",
			inputSchema: { executionId: z.string().min(6).describe("The workflow execution id") },
		},
		async ({ executionId }: { executionId: string }) => {
			try {
				return textResult(await get(executionId, "/digest"));
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	);
	tools.push({
		name: "trace_get_digest",
		description: "Get deterministic workflow run trace digest",
	});

	(server as any).registerTool(
		"trace_search_spans",
		{
			title: "Search Trace Spans",
			description:
				"Search the run's connected trace spans by substring (matches operation name, service, status message, session id). Set errorsOnly=true to filter to failures. Returns lean rows (spanId, name, service, durationMs, status, sessionId) — use trace_get_llm_turn for full LLM content and trace_get_logs for log bodies.",
			inputSchema: {
				executionId: z.string().min(6),
				query: z.string().optional().describe("Substring filter (optional)"),
				errorsOnly: z.boolean().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			},
		},
		async (args: { executionId: string; query?: string; errorsOnly?: boolean; limit?: number }) => {
			try {
				const params: Record<string, string> = {};
				if (args.query) params.query = args.query;
				if (args.errorsOnly) params.errorsOnly = "true";
				if (args.limit) params.limit = String(args.limit);
				return textResult(await get(args.executionId, "/spans", params));
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	);
	tools.push({
		name: "trace_search_spans",
		description: "Search workflow run trace spans",
	});

	(server as any).registerTool(
		"trace_get_llm_turn",
		{
			title: "Get LLM Turn Content",
			description:
				"Full LLM call content for the run: input/output messages, model, token counts, finish reason. Pass spanId (from trace_search_spans or a digest issue) for ONE turn, or sessionId (a call's child session from the digest) for all of that agent's turns. This is how you see what an agent was actually asked and what it replied.",
			inputSchema: {
				executionId: z.string().min(6),
				spanId: z.string().optional(),
				sessionId: z.string().optional(),
			},
		},
		async (args: { executionId: string; spanId?: string; sessionId?: string }) => {
			try {
				if (!args.spanId && !args.sessionId) {
					return errorResult("Provide spanId or sessionId");
				}
				const params: Record<string, string> = {};
				if (args.spanId) params.spanId = args.spanId;
				if (args.sessionId) params.sessionId = args.sessionId;
				return textResult(await get(args.executionId, "/llm-turn", params));
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	);
	tools.push({
		name: "trace_get_llm_turn",
		description: "Read workflow run LLM turn content",
	});

	(server as any).registerTool(
		"trace_get_logs",
		{
			title: "Get Correlated Logs",
			description:
				"Log lines correlated to the run's traces. Optionally filter to one spanId (±the span's window) or errorsOnly. Bodies are truncated to 500 chars.",
			inputSchema: {
				executionId: z.string().min(6),
				spanId: z.string().optional(),
				errorsOnly: z.boolean().optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
		},
		async (args: { executionId: string; spanId?: string; errorsOnly?: boolean; limit?: number }) => {
			try {
				const params: Record<string, string> = {};
				if (args.spanId) params.spanId = args.spanId;
				if (args.errorsOnly) params.errorsOnly = "true";
				if (args.limit) params.limit = String(args.limit);
				return textResult(await get(args.executionId, "/logs", params));
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	);
	tools.push({
		name: "trace_get_logs",
		description: "Read workflow run correlated logs",
	});

	return tools;
}
