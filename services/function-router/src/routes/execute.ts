/**
 * Execute Route
 *
 * Routes function execution requests to the appropriate service:
 * - Knative Services (fn-openai, fn-slack, etc.) via direct HTTP to in-cluster services
 * - function-runner via Dapr service invocation for builtin fallback
 *
 * This route also pre-fetches credentials from Dapr secret store
 * to pass along to functions, with audit logging for compliance.
 *
 * Includes timing breakdown for performance analysis:
 * - credentialFetchMs: Time to resolve credentials
 * - routingMs: Time to resolve Knative function URL
 * - executionMs: Time for the actual function call
 * - wasColdStart: Detected based on response time anomalies
 */

import { DaprClient, HttpMethod } from "@dapr/dapr";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
	fetchCredentialsWithAudit,
	fetchRawConnectionValue,
} from "../core/credential-service.js";
import {
	logExecutionComplete,
	logExecutionStart,
	type TimingBreakdown,
} from "../core/execution-logger.js";
import {
	getResponseTimeAverage,
	recordResponseTime,
	resolveOpenFunctionUrl,
} from "../core/openfunction-resolver.js";
import { lookupFunction } from "../core/registry.js";
import type {
	ExecuteRequest,
	ExecuteResponse,
	OpenFunctionRequest,
} from "../core/types.js";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const HTTP_TIMEOUT_MS = Number.parseInt(
	process.env.HTTP_TIMEOUT_MS || "60000",
	10,
);

// Cold start detection: if response time is > 3x average, likely a cold start
const COLD_START_MULTIPLIER = 3;

// Request body schema using Zod
const ExecuteRequestSchema = z.object({
	function_id: z.string().optional(),
	function_slug: z.string().optional(),
	execution_id: z.string().min(1),
	workflow_id: z.string().min(1),
	node_id: z.string().min(1),
	node_name: z.string().min(1),
	input: z.record(z.string(), z.unknown()).default({}),
	node_outputs: z
		.record(
			z.string(),
			z.object({
				label: z.string(),
				data: z.unknown(),
			}),
		)
		.optional(),
	integration_id: z.string().nullable().optional(),
	integrations: z
		.record(z.string(), z.record(z.string(), z.string()))
		.nullable()
		.optional(),
	db_execution_id: z.string().nullable().optional(),
	connection_external_id: z.string().nullable().optional(),
	ap_project_id: z.string().nullable().optional(),
	ap_platform_id: z.string().nullable().optional(),
});

function parseConnectionExternalIdFromAuthTemplate(
	auth: unknown,
): string | undefined {
	if (typeof auth !== "string") {
		return undefined;
	}
	const trimmed = auth.trim();
	if (!trimmed) {
		return undefined;
	}

	const match = trimmed.match(/\{\{connections\[['"]([^'"]+)['"]\]\}\}/);
	if (match?.[1]) {
		return match[1];
	}

	// Back-compat: some callers may pass the external ID directly.
	if (!trimmed.includes("{{") && !trimmed.includes("}}")) {
		return trimmed;
	}

	return undefined;
}

type MastraToolResponse = {
	success?: unknown;
	toolId?: unknown;
	result?: unknown;
	error?: unknown;
	workflowId?: unknown;
	status?: unknown;
	message?: unknown;
};

function parseJsonResponse(responseText: string): unknown {
	if (!responseText) {
		return null;
	}
	try {
		return JSON.parse(responseText) as unknown;
	} catch {
		return null;
	}
}

function parseMastraToolInput(
	input: Record<string, unknown>,
	fallbackToolId: string,
): { toolId: string; args: Record<string, unknown> } {
	const configuredToolId =
		typeof input.toolId === "string" ? input.toolId.trim() : "";
	const toolId = configuredToolId || fallbackToolId;

	if (!toolId) {
		throw new Error(
			"Mastra tool ID is required. Set the Tool field in this action node.",
		);
	}

	const argsRaw = input.argsJson;
	if (typeof argsRaw === "undefined" || argsRaw === null || argsRaw === "") {
		return { toolId, args: {} };
	}

	if (typeof argsRaw !== "string") {
		throw new Error(
			"Mastra tool args must be a JSON object string in argsJson.",
		);
	}
	const normalizedArgs = argsRaw.trim();
	if (!normalizedArgs) {
		return { toolId, args: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(normalizedArgs);
	} catch (error) {
		throw new Error(
			`Invalid Mastra args JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Mastra args JSON must be an object.");
	}

	return { toolId, args: parsed as Record<string, unknown> };
}

export async function executeRoutes(app: FastifyInstance): Promise<void> {
	/**
	 * POST /execute - Route function execution to appropriate service
	 */
	app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
		// Validate request body
		const parseResult = ExecuteRequestSchema.safeParse(request.body);

		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				error: "Validation failed",
				details: parseResult.error.issues,
				duration_ms: 0,
			} as ExecuteResponse);
		}

		const body = parseResult.data as ExecuteRequest;
		const functionSlug = body.function_slug || body.function_id;

		if (!functionSlug) {
			return reply.status(400).send({
				success: false,
				error: "Either function_id or function_slug is required",
				duration_ms: 0,
			} as ExecuteResponse);
		}

		console.log(
			`[Execute Route] Received request for function: ${functionSlug}`,
		);
		console.log(
			`[Execute Route] Workflow: ${body.workflow_id}, Node: ${body.node_name}`,
		);

		const startTime = Date.now();

		// Initialize timing breakdown
		const timing: TimingBreakdown = {};

		// Log execution start (only if we have a valid database execution ID)
		let logId: string | undefined;
		if (body.db_execution_id) {
			try {
				logId = await logExecutionStart({
					executionId: body.db_execution_id,
					nodeId: body.node_id,
					nodeName: body.node_name,
					nodeType: "action",
					actionType: functionSlug,
					input: body.input,
				});
			} catch (logError) {
				console.error(
					"[Execute Route] Failed to log execution start:",
					logError,
				);
			}
		}

		// Step 1: Look up the target service
		const target = await lookupFunction(functionSlug);
		console.log(
			`[Execute Route] Routing ${functionSlug} to ${target.appId} (${target.type})`,
		);
		timing.routedTo = target.appId;

		// Step 2: Create Dapr client for service invocation
		const client = new DaprClient({
			daprHost: DAPR_HOST,
			daprPort: DAPR_HTTP_PORT,
		});

		try {
			let response: ExecuteResponse;

			if (target.type === "knative" || target.type === "openfunction") {
				// Route to Knative service via direct HTTP
				// Extract the step name from the slug (e.g., "openai/generate-text" -> "generate-text")
				const stepName = functionSlug.split("/")[1] || functionSlug;
				const pluginId = functionSlug.split("/")[0];

				// Resolve the function URL (Knative Service DNS in Knative-only mode)
				const routingStartTime = Date.now();
				const functionUrl = await resolveOpenFunctionUrl(target.appId);
				timing.routingMs = Date.now() - routingStartTime;

				if (target.appId === "mastra-agent") {
					console.log(
						`[Execute Route] Invoking Mastra agent step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
					);

					const controller = new AbortController();
					const timeoutId = setTimeout(
						() => controller.abort(),
						HTTP_TIMEOUT_MS,
					);
					const executionStartTime = Date.now();

					try {
						const { toolId, args } = parseMastraToolInput(
							body.input as Record<string, unknown>,
							stepName,
						);

						const httpResponse = await fetch(
							`${functionUrl}/api/tools/${encodeURIComponent(toolId)}`,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({ args }),
								signal: controller.signal,
							},
						);

						clearTimeout(timeoutId);
						timing.executionMs = Date.now() - executionStartTime;

						const responseText = await httpResponse.text();
						const parsed = parseJsonResponse(responseText);
						const parsedMastra =
							parsed && typeof parsed === "object"
								? (parsed as MastraToolResponse)
								: undefined;

						if (!httpResponse.ok) {
							const errorFromBody =
								typeof parsedMastra?.error === "string"
									? parsedMastra.error
									: responseText;
							throw new Error(
								`Mastra agent HTTP ${httpResponse.status}: ${errorFromBody.slice(0, 300)}`,
							);
						}

						if (typeof parsedMastra?.success === "boolean") {
							if (!parsedMastra.success) {
								response = {
									success: false,
									error:
										typeof parsedMastra.error === "string"
											? parsedMastra.error
											: `Mastra tool "${toolId}" failed`,
									duration_ms: 0,
								};
							} else {
								response = {
									success: true,
									data: {
										toolId:
											typeof parsedMastra.toolId === "string"
												? parsedMastra.toolId
												: toolId,
										result: parsedMastra.result,
										workflowId:
											typeof parsedMastra.workflowId === "string"
												? parsedMastra.workflowId
												: undefined,
										status:
											typeof parsedMastra.status === "string"
												? parsedMastra.status
												: undefined,
										message:
											typeof parsedMastra.message === "string"
												? parsedMastra.message
												: undefined,
									},
									duration_ms: 0,
								};
							}
						} else if (
							parsedMastra &&
							typeof parsedMastra.workflowId === "string"
						) {
							response = {
								success: true,
								data: {
									toolId,
									workflowId: parsedMastra.workflowId,
									status:
										typeof parsedMastra.status === "string"
											? parsedMastra.status
											: undefined,
									message:
										typeof parsedMastra.message === "string"
											? parsedMastra.message
											: undefined,
								},
								duration_ms: 0,
							};
						} else {
							throw new Error(
								`Invalid response from mastra-agent: ${responseText.slice(0, 300)}`,
							);
						}
					} catch (httpError) {
						clearTimeout(timeoutId);
						timing.executionMs = Date.now() - executionStartTime;
						if (httpError instanceof Error && httpError.name === "AbortError") {
							throw new Error(
								`Request to ${target.appId} timed out after ${HTTP_TIMEOUT_MS}ms`,
							);
						}
						throw httpError;
					}
				} else {
					const isApRoute = target.appId === "fn-activepieces";
					const parsedConnectionExternalId =
						parseConnectionExternalIdFromAuthTemplate(body.input?.auth);
					const connectionExternalId =
						body.connection_external_id || parsedConnectionExternalId;

					// Pre-fetch credentials
					const credentialStartTime = Date.now();
					let credentialsRaw: unknown | undefined;

					const apContext =
						body.ap_project_id && body.ap_platform_id
							? {
									projectId: body.ap_project_id,
									platformId: body.ap_platform_id,
								}
							: undefined;

					if (isApRoute && connectionExternalId) {
						// For AP actions: fetch raw connection value (passes directly to context.auth)
						credentialsRaw = await fetchRawConnectionValue(
							connectionExternalId,
							apContext,
						);
					}

					// Always fetch env-var-mapped credentials too (for native services and as fallback)
					const credentialResult = await fetchCredentialsWithAudit(
						pluginId,
						body.integrations,
						body.db_execution_id
							? {
									executionId: body.db_execution_id,
									nodeId: body.node_id,
								}
							: undefined,
						connectionExternalId,
						apContext,
					);
					timing.credentialFetchMs = Date.now() - credentialStartTime;

					console.log(
						`[Execute Route] Credentials fetched in ${timing.credentialFetchMs}ms (source: ${credentialResult.source})`,
					);

					const knativeRequest: OpenFunctionRequest = {
						step: isApRoute ? functionSlug : stepName,
						execution_id: body.execution_id,
						workflow_id: body.workflow_id,
						node_id: body.node_id,
						input: body.input as Record<string, unknown>,
						node_outputs: body.node_outputs,
						credentials: credentialResult.credentials,
						...(isApRoute && {
							credentials_raw: credentialsRaw,
							metadata: { pieceName: pluginId, actionName: stepName },
						}),
					};

					console.log(
						`[Execute Route] Invoking Knative function ${target.appId} step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
					);

					// Make direct HTTP call to the Knative service
					const controller = new AbortController();
					const timeoutId = setTimeout(
						() => controller.abort(),
						HTTP_TIMEOUT_MS,
					);

					const executionStartTime = Date.now();
					try {
						const httpResponse = await fetch(`${functionUrl}/execute`, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify(knativeRequest),
							signal: controller.signal,
						});

						clearTimeout(timeoutId);
						timing.executionMs = Date.now() - executionStartTime;

						// IMPORTANT:
						// OpenFunctions use HTTP status codes inconsistently (some return 5xx
						// for a handled action failure). We always try to parse the JSON
						// response and propagate it back to the orchestrator as a normal
						// (HTTP 200) function-router response, so the orchestrator can surface
						// `error` instead of failing with RequestException.
						const responseText = await httpResponse.text();
						const parsed = parseJsonResponse(responseText);

						if (
							parsed &&
							typeof parsed === "object" &&
							"success" in parsed &&
							typeof (parsed as { success?: unknown }).success === "boolean"
						) {
							response = parsed as ExecuteResponse;
						} else if (httpResponse.ok) {
							throw new Error(
								`Invalid JSON response from ${target.appId}: ${responseText.slice(0, 200)}`,
							);
						} else {
							throw new Error(`HTTP ${httpResponse.status}: ${responseText}`);
						}
					} catch (httpError) {
						clearTimeout(timeoutId);
						timing.executionMs = Date.now() - executionStartTime;
						if (httpError instanceof Error && httpError.name === "AbortError") {
							throw new Error(
								`Request to ${target.appId} timed out after ${HTTP_TIMEOUT_MS}ms`,
							);
						}
						throw httpError;
					}
				}

				// Cold start detection
				const avgResponseTime = getResponseTimeAverage(target.appId);
				if (
					avgResponseTime > 0 &&
					timing.executionMs > avgResponseTime * COLD_START_MULTIPLIER
				) {
					timing.wasColdStart = true;
					timing.coldStartMs = timing.executionMs - avgResponseTime;
					console.log(
						`[Execute Route] Cold start detected for ${target.appId}: ${timing.executionMs}ms vs avg ${avgResponseTime}ms`,
					);
				} else {
					timing.wasColdStart = false;
				}

				// Record response time for future cold start detection
				recordResponseTime(target.appId, timing.executionMs);

				response.routed_to = target.appId;
			} else {
				// Route to function-runner (builtin fallback)
				console.log(
					"[Execute Route] Routing to function-runner for builtin execution",
				);

				const executionStartTime = Date.now();
				const result = await client.invoker.invoke(
					target.appId,
					"execute",
					HttpMethod.POST,
					body,
				);
				timing.executionMs = Date.now() - executionStartTime;

				response = result as ExecuteResponse;
				response.routed_to = target.appId;
			}

			const duration_ms = Date.now() - startTime;
			response.duration_ms = duration_ms;

			console.log(
				`[Execute Route] Function ${functionSlug} completed via ${target.appId}: success=${response.success}, duration=${duration_ms}ms` +
					(timing.wasColdStart ? " (cold start)" : ""),
			);

			// Log execution completion (only if we started logging)
			if (logId && body.db_execution_id) {
				try {
					await logExecutionComplete(logId, {
						success: response.success,
						output: response.data,
						error: response.error,
						durationMs: duration_ms,
						timing,
					});
				} catch (logError) {
					console.error(
						"[Execute Route] Failed to log execution completion:",
						logError,
					);
				}
			}

			// Always return 200 for a successfully routed call, even when the function
			// reports `success: false`. The workflow-orchestrator uses `raise_for_status`
			// and would otherwise drop the actionable error message.
			return reply.status(200).send(response);
		} catch (error) {
			const duration_ms = Date.now() - startTime;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			console.error(
				`[Execute Route] Failed to route ${functionSlug} to ${target.appId}:`,
				error,
			);

			// Log execution failure (only if we started logging)
			if (logId && body.db_execution_id) {
				try {
					await logExecutionComplete(logId, {
						success: false,
						error: `Function routing failed: ${errorMessage}`,
						durationMs: duration_ms,
						timing,
					});
				} catch (logError) {
					console.error(
						"[Execute Route] Failed to log execution failure:",
						logError,
					);
				}
			}

			return reply.status(500).send({
				success: false,
				error: `Function routing failed: ${errorMessage}`,
				duration_ms,
				routed_to: target.appId,
			} as ExecuteResponse);
		}
	});

	/**
	 * GET /registry - List current function registry (for debugging)
	 */
	app.get("/registry", async (_request, reply) => {
		const { loadRegistry } = await import("../core/registry.js");
		const registry = await loadRegistry();

		return reply.status(200).send({
			success: true,
			registry,
			count: Object.keys(registry).length,
		});
	});
}
