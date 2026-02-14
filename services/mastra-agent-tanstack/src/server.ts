/**
 * Custom Server Entry for mastra-agent-tanstack
 *
 * Intercepts API routes (/api/*) before passing to TanStack Start
 * for SSR page routes. This is the recommended pattern for TanStack Start 1.x
 * which doesn't have built-in API file routes.
 */

import "./lib/otel";
import { interceptConsole } from "./lib/event-bus";
interceptConsole();

import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { nanoid } from "nanoid";
import { eventBus } from "./lib/event-bus";
import { runAgent, initAgent, generatePlan, TOOL_NAMES } from "./lib/agent";
import type { Plan } from "./lib/agent";
import { executeTool, listTools } from "./lib/tool-executor";
import {
	startDaprPublisher,
	publishCompletionEvent,
} from "./lib/dapr-publisher";
import {
	handleDaprSubscriptionEvent,
	getDaprSubscriptions,
} from "./lib/dapr-publisher";
import { handleMcpRequest, getSessionCount } from "./lib/mcp-sessions";
import { sandbox } from "./lib/sandbox-config";

// ── Initialize singletons (runs once on server start) ────────
eventBus.setState({ toolNames: TOOL_NAMES });
startDaprPublisher();
console.log("[mastra-tanstack] Server entry initialized");

// ── Graceful shutdown — clean up sandbox resources ───────────
async function shutdown(signal: string) {
	console.log(`[mastra-tanstack] Received ${signal}, shutting down...`);
	try {
		// _destroy() is the race-condition-safe wrapper that handles status transitions
		if ("_destroy" in sandbox) {
			await (sandbox as any)._destroy();
		} else if (sandbox.destroy) {
			await sandbox.destroy();
		}
	} catch (err) {
		console.error("[mastra-tanstack] Sandbox destroy failed:", err);
	}
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── TanStack Start handler (SSR pages + server functions) ────
const startFetch = createStartHandler(defaultStreamHandler);

// ── API route handler ────────────────────────────────────────

async function handleApiRoute(request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	// Health check
	if (path === "/api/health" && method === "GET") {
		const state = eventBus.getState();
		return Response.json({
			service: "mastra-agent-tanstack",
			framework: "tanstack-start",
			mcpSessions: getSessionCount(),
			agentStatus: state.status,
			agentTools: TOOL_NAMES,
			totalRuns: state.totalRuns,
			totalTokens: state.totalTokens,
		});
	}

	// MCP endpoint (all methods)
	if (path === "/api/mcp") {
		return handleMcpRequest(request);
	}

	// List available tools
	if (path === "/api/tools" && method === "GET") {
		return Response.json({ success: true, tools: listTools() });
	}

	// Execute a workspace tool directly (called by function-router for mastra/* slugs)
	const toolMatch = path.match(/^\/api\/tools\/(.+)$/);
	if (toolMatch && method === "POST") {
		const toolId = decodeURIComponent(toolMatch[1]);
		try {
			await initAgent();
			const body = (await request.json()) as Record<string, unknown>;
			const args = (body.args as Record<string, unknown>) ?? body;
			const result = await executeTool(toolId, args);
			return Response.json({ success: true, toolId, result });
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(`[mastra-tanstack] Tool ${toolId} failed: ${errorMsg}`);
			return Response.json(
				{ success: false, toolId, error: errorMsg },
				{ status: 400 },
			);
		}
	}

	// Dapr subscription discovery
	if (path === "/api/dapr/subscribe" && method === "GET") {
		return Response.json(getDaprSubscriptions());
	}

	// Agent run endpoint (called by Dapr workflow orchestrator)
	if (path === "/api/run" && method === "POST") {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			const prompt = body.prompt as string;
			if (!prompt) {
				return Response.json(
					{ success: false, error: "prompt is required" },
					{ status: 400 },
				);
			}

			const parentExecutionId = (body.parentExecutionId as string) ?? "";
			const workflowId = (body.workflowId as string) ?? "";
			const nodeId = (body.nodeId as string) ?? "";
			const nodeName = (body.nodeName as string) ?? "";
			const agentWorkflowId = `mastra-run-${nanoid(12)}`;

			// Set workflow context on eventBus
			eventBus.setWorkflowContext({
				workflowId: agentWorkflowId,
				nodeId,
				stepIndex: 0,
			});

			console.log(
				`[mastra-tanstack] /api/run: agentWorkflowId=${agentWorkflowId} prompt="${prompt.slice(0, 80)}"`,
			);

			// Fire-and-forget: run agent and publish completion
			runAgent(prompt)
				.then((result) => {
					return publishCompletionEvent({
						agentWorkflowId,
						parentExecutionId,
						success: true,
						result: {
							text: result.text,
							plan: result.plan,
							toolCalls: result.toolCalls,
							usage: result.usage,
						},
					});
				})
				.catch((err) => {
					const errorMsg = err instanceof Error ? err.message : String(err);
					console.error(`[mastra-tanstack] Agent run failed: ${errorMsg}`);
					return publishCompletionEvent({
						agentWorkflowId,
						parentExecutionId,
						success: false,
						error: errorMsg,
					});
				});

			// Return immediately
			return Response.json({
				success: true,
				workflow_id: agentWorkflowId,
			});
		} catch (err) {
			return Response.json(
				{ success: false, error: String(err) },
				{ status: 400 },
			);
		}
	}

	// Plan endpoint (synchronous — single LLM call with structured output)
	if (path === "/api/plan" && method === "POST") {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			const prompt = body.prompt as string;
			if (!prompt) {
				return Response.json(
					{ success: false, error: "prompt is required" },
					{ status: 400 },
				);
			}

			const cwd = (body.cwd as string) ?? "";
			await initAgent();

			eventBus.emitEvent("planning_started", { prompt });

			// Give planner directory context so it generates path-specific steps
			let contextPrefix = "";
			if (cwd) {
				try {
					const files = await executeTool("list-files", { path: cwd });
					contextPrefix = `Working directory: ${cwd}\nDirectory contents: ${JSON.stringify(files)}\n\n`;
				} catch {
					/* non-fatal */
				}
			}

			const plan = await generatePlan(contextPrefix + prompt);

			eventBus.emitEvent("planning_completed", {
				goal: plan.goal,
				stepCount: plan.steps.length,
				estimatedToolCalls: plan.estimated_tool_calls,
			});

			return Response.json({ success: true, plan });
		} catch (err) {
			return Response.json(
				{ success: false, error: String(err) },
				{ status: 500 },
			);
		}
	}

	// Execute plan endpoint (fire-and-forget — long-running agent loop)
	if (path === "/api/execute-plan" && method === "POST") {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			const plan = body.plan as Plan | undefined;
			const cwd = (body.cwd as string) ?? "";
			const prompt = (body.prompt as string) ?? "";
			const parentExecutionId = (body.parentExecutionId as string) ?? "";
			const agentWorkflowId = `mastra-exec-${nanoid(12)}`;

			if (!plan || !plan.steps?.length) {
				return Response.json(
					{ success: false, error: "plan with steps is required" },
					{ status: 400 },
				);
			}

			await initAgent();
			eventBus.setWorkflowContext({
				workflowId: agentWorkflowId,
				nodeId: (body.nodeId as string) ?? "",
				stepIndex: 0,
			});

			// Build execution prompt with plan injected
			const planText = plan.steps
				.map((s) => `${s.step}. [${s.tool}] ${s.action} — ${s.reasoning}`)
				.join("\n");
			const cwdContext = cwd ? `Working directory: ${cwd}\n\n` : "";
			const executionPrompt = `${cwdContext}## Task\n${prompt || plan.goal}\n\n## Execution Plan\nFollow this plan step-by-step:\n${planText}\n\nExecute each step in order. If a step fails, note the error and continue.`;

			// Fire-and-forget
			runAgent(executionPrompt, { skipPlanning: true })
				.then((result) =>
					publishCompletionEvent({
						agentWorkflowId,
						parentExecutionId,
						success: true,
						result: {
							text: result.text,
							plan: result.plan,
							toolCalls: result.toolCalls,
							usage: result.usage,
						},
					}),
				)
				.catch((err) =>
					publishCompletionEvent({
						agentWorkflowId,
						parentExecutionId,
						success: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);

			return Response.json({
				success: true,
				workflow_id: agentWorkflowId,
			});
		} catch (err) {
			return Response.json(
				{ success: false, error: String(err) },
				{ status: 400 },
			);
		}
	}

	// Dapr event delivery
	if (path === "/api/dapr/sub" && method === "POST") {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			handleDaprSubscriptionEvent({
				id: (body.id as string) ?? "",
				source: (body.source as string) ?? "",
				type: (body.type as string) ?? "",
				specversion: (body.specversion as string) ?? "1.0",
				datacontenttype: (body.datacontenttype as string) ?? "application/json",
				data: (body.data as Record<string, unknown>) ?? {},
			});
			return Response.json({ status: "SUCCESS" });
		} catch (err) {
			return Response.json({ error: String(err) }, { status: 400 });
		}
	}

	// Not an API route — return null to pass through to TanStack Start
	return null;
}

// ── Server entry (Vinxi expects { fetch } default export) ────

function createServerEntry(entry: {
	fetch: (request: Request, ...args: any[]) => Response | Promise<Response>;
}) {
	return {
		async fetch(request: Request, ...rest: any[]): Promise<Response> {
			// Try API routes first
			const apiResponse = await handleApiRoute(request);
			if (apiResponse) return apiResponse;

			// Fall through to TanStack Start (SSR pages, server functions)
			return entry.fetch(request, ...rest);
		},
	};
}

export { createServerEntry };
export default createServerEntry({ fetch: startFetch as any });
