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
	plan?: unknown;
	error?: unknown;
	workflowId?: unknown;
	workflow_id?: unknown;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSystemHttpRequestInput(input: Record<string, unknown>): {
	input: Record<string, unknown>;
	error?: string;
} {
	// Some callers persist params under `configFields`; merge them so runtime always
	// sees the canonical shape expected by fn-system.
	const merged = {
		...input,
		...(isPlainObject(input.configFields) ? input.configFields : {}),
	};

	// Back-compat: older schema used { url, method, headers, body }.
	const endpoint =
		typeof merged.endpoint === "string"
			? merged.endpoint
			: typeof merged.url === "string"
				? merged.url
				: merged.endpoint;
	const httpMethod =
		typeof merged.httpMethod === "string"
			? merged.httpMethod
			: typeof merged.method === "string"
				? merged.method
				: merged.httpMethod;
	const httpHeaders = merged.httpHeaders ?? merged.headers;
	const httpBody = merged.httpBody ?? merged.body;

	const normalized = {
		...merged,
		endpoint,
		httpMethod,
		httpHeaders,
		httpBody,
		// Keep legacy keys around as well (harmless, helps old templates).
		url: merged.url ?? endpoint,
		method: merged.method ?? httpMethod,
		headers: merged.headers ?? httpHeaders,
		body: merged.body ?? httpBody,
	};

	if (typeof normalized.endpoint !== "string" || !normalized.endpoint.trim()) {
		return {
			input: normalized,
			error:
				"system/http-request: missing required `endpoint` (or legacy `url`). " +
				"Set `endpoint` to a non-empty URL string.",
		};
	}

	return { input: normalized };
}

/** Keys that are metadata, not tool arguments. */
const MASTRA_META_KEYS = new Set(["toolId", "argsJson", "auth"]);

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

	// If argsJson is provided, parse it (legacy run-tool format).
	const argsRaw = input.argsJson;
	if (typeof argsRaw === "string" && argsRaw.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(argsRaw.trim());
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

	// Otherwise collect individual input fields as tool args
	// (used by per-tool actions like mastra/read-file, mastra/write-file, etc.)
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!MASTRA_META_KEYS.has(key) && value !== undefined && value !== null) {
			args[key] = value;
		}
	}
	return { toolId, args };
}

function parseBooleanInput(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

function parseStringArrayInput(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const parsed = value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => Boolean(entry));
		return parsed.length > 0 ? [...new Set(parsed)] : undefined;
	}

	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parseStringArrayInput(parsed);
			}
		} catch {
			return undefined;
		}
	}

	const parsed = trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => Boolean(entry));
	return parsed.length > 0 ? [...new Set(parsed)] : undefined;
}

function parseJsonObjectInput(
	value: unknown,
): Record<string, unknown> | undefined {
	if (isPlainObject(value)) return value;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseJsonValueInput(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function parseNumberInput(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDurableAgentConfig(
	input: Record<string, unknown>,
): Record<string, unknown> | undefined {
	return isPlainObject(input.agentConfig) ? input.agentConfig : undefined;
}

function parseDurableModelInput(
	input: Record<string, unknown>,
): string | undefined {
	if (typeof input.model === "string" && input.model.trim()) {
		return input.model.trim();
	}

	const agentConfig = parseDurableAgentConfig(input);
	if (!agentConfig) return undefined;

	if (
		typeof agentConfig.modelSpec === "string" &&
		agentConfig.modelSpec.trim()
	) {
		return agentConfig.modelSpec.trim();
	}

	if (!isPlainObject(agentConfig.model)) return undefined;
	const provider =
		typeof agentConfig.model.provider === "string"
			? agentConfig.model.provider.trim()
			: "";
	const name =
		typeof agentConfig.model.name === "string"
			? agentConfig.model.name.trim()
			: "";
	return provider && name ? `${provider}/${name}` : undefined;
}

function buildStructuredStopCondition(
	input: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const mode =
		typeof input.loopStopMode === "string" ? input.loopStopMode.trim() : "";
	if (!mode || mode === "none" || mode === "custom_json") {
		return undefined;
	}

	if (mode === "stepCountIs") {
		const maxSteps = parseNumberInput(input.loopStopMaxSteps) ?? 20;
		return { type: "stepCountIs", maxSteps: Math.max(1, Math.floor(maxSteps)) };
	}

	if (mode === "hasToolCall") {
		const toolName =
			typeof input.loopStopToolName === "string"
				? input.loopStopToolName.trim()
				: "";
		return toolName ? { type: "hasToolCall", toolName } : undefined;
	}

	if (mode === "toolCallNeedsApproval") {
		const toolNames = parseStringArrayInput(input.loopStopApprovalToolNames);
		return toolNames
			? { type: "toolCallNeedsApproval", toolNames }
			: { type: "toolCallNeedsApproval" };
	}

	if (mode === "toolWithoutExecute") {
		return { type: "toolWithoutExecute" };
	}

	if (mode === "assistantTextIncludes") {
		const text =
			typeof input.loopStopText === "string" ? input.loopStopText.trim() : "";
		if (!text) return undefined;
		const caseSensitive = parseBooleanInput(input.loopStopCaseSensitive);
		return caseSensitive === undefined
			? { type: "assistantTextIncludes", text }
			: { type: "assistantTextIncludes", text, caseSensitive };
	}

	if (mode === "assistantTextMatchesRegex") {
		const pattern =
			typeof input.loopStopRegexPattern === "string"
				? input.loopStopRegexPattern.trim()
				: "";
		if (!pattern) return undefined;
		const flags =
			typeof input.loopStopRegexFlags === "string"
				? input.loopStopRegexFlags.trim()
				: "";
		return flags
			? { type: "assistantTextMatchesRegex", pattern, flags }
			: { type: "assistantTextMatchesRegex", pattern };
	}

	if (mode === "totalUsageAtLeast") {
		const inputTokens = parseNumberInput(input.loopStopInputTokens);
		const outputTokens = parseNumberInput(input.loopStopOutputTokens);
		const totalTokens = parseNumberInput(input.loopStopTotalTokens);
		if (
			inputTokens === undefined &&
			outputTokens === undefined &&
			totalTokens === undefined
		) {
			return undefined;
		}
		return {
			type: "totalUsageAtLeast",
			...(inputTokens !== undefined ? { inputTokens } : {}),
			...(outputTokens !== undefined ? { outputTokens } : {}),
			...(totalTokens !== undefined ? { totalTokens } : {}),
		};
	}

	if (mode === "costEstimateExceeds") {
		const usd = parseNumberInput(input.loopStopCostUsd);
		if (usd === undefined) return undefined;
		const inputPer1kUsd = parseNumberInput(input.loopStopCostInputPer1kUsd);
		const outputPer1kUsd = parseNumberInput(input.loopStopCostOutputPer1kUsd);
		return {
			type: "costEstimateExceeds",
			usd,
			...(inputPer1kUsd !== undefined ? { inputPer1kUsd } : {}),
			...(outputPer1kUsd !== undefined ? { outputPer1kUsd } : {}),
		};
	}

	if (mode === "celExpression") {
		const expression =
			typeof input.loopStopCelExpression === "string"
				? input.loopStopCelExpression.trim()
				: "";
		return expression ? { type: "celExpression", expression } : undefined;
	}

	return undefined;
}

function buildLoopPolicyInput(
	input: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const basePolicy = parseJsonObjectInput(input.loopPolicy) ?? {};
	const policy: Record<string, unknown> = { ...basePolicy };
	let hasLoopConfig = Object.keys(policy).length > 0;

	const stopWhenFromJson = parseJsonValueInput(input.loopStopWhen);
	const stopConditionFromMode = buildStructuredStopCondition(input);
	if (Array.isArray(stopWhenFromJson) || isPlainObject(stopWhenFromJson)) {
		policy.stopWhen = stopWhenFromJson;
		hasLoopConfig = true;
	} else if (stopConditionFromMode) {
		policy.stopWhen = [stopConditionFromMode];
		hasLoopConfig = true;
	}

	const prepareStep = parseJsonObjectInput(input.loopPrepareStep);
	if (prepareStep) {
		policy.prepareStep = prepareStep;
		hasLoopConfig = true;
	}

	const approvalRequiredTools = parseStringArrayInput(
		input.loopApprovalRequiredTools,
	);
	if (approvalRequiredTools) {
		policy.approvalRequiredTools = approvalRequiredTools;
		hasLoopConfig = true;
	}

	const defaultActiveTools = parseStringArrayInput(
		input.loopDefaultActiveTools,
	);
	if (defaultActiveTools) {
		policy.defaultActiveTools = defaultActiveTools;
		hasLoopConfig = true;
	}

	const defaultToolChoiceRaw =
		typeof input.loopDefaultToolChoice === "string"
			? input.loopDefaultToolChoice.trim().toLowerCase()
			: "";
	if (
		defaultToolChoiceRaw === "auto" ||
		defaultToolChoiceRaw === "required" ||
		defaultToolChoiceRaw === "none"
	) {
		policy.defaultToolChoice = defaultToolChoiceRaw;
		hasLoopConfig = true;
	} else if (defaultToolChoiceRaw === "tool") {
		const toolName =
			typeof input.loopDefaultToolName === "string"
				? input.loopDefaultToolName.trim()
				: "";
		if (toolName) {
			policy.defaultToolChoice = {
				type: "tool",
				toolName,
			};
			hasLoopConfig = true;
		}
	}

	const doneToolEnabled = parseBooleanInput(input.loopDoneToolEnabled);
	const doneToolName =
		typeof input.loopDoneToolName === "string"
			? input.loopDoneToolName.trim()
			: "";
	const doneToolDescription =
		typeof input.loopDoneToolDescription === "string"
			? input.loopDoneToolDescription.trim()
			: "";
	const doneToolResponseField =
		typeof input.loopDoneToolResponseField === "string"
			? input.loopDoneToolResponseField.trim()
			: "";
	const doneToolInputSchema = parseJsonValueInput(
		input.loopDoneToolInputSchema,
	);
	const hasDoneToolOverrides =
		doneToolEnabled !== undefined ||
		Boolean(doneToolName) ||
		Boolean(doneToolDescription) ||
		Boolean(doneToolResponseField) ||
		doneToolInputSchema !== undefined;

	if (hasDoneToolOverrides) {
		const existingDoneTool = isPlainObject(policy.doneTool)
			? policy.doneTool
			: {};
		const doneTool: Record<string, unknown> = { ...existingDoneTool };
		if (doneToolEnabled !== undefined) {
			doneTool.enabled = doneToolEnabled;
		}
		if (doneToolName) {
			doneTool.name = doneToolName;
		}
		if (doneToolDescription) {
			doneTool.description = doneToolDescription;
		}
		if (doneToolResponseField) {
			doneTool.responseField = doneToolResponseField;
		}
		if (doneToolInputSchema && typeof doneToolInputSchema === "object") {
			doneTool.inputSchema = doneToolInputSchema;
		}
		policy.doneTool = doneTool;
		hasLoopConfig = true;
	}

	return hasLoopConfig ? policy : undefined;
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

				if (target.appId === "durable-agent") {
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

						// Credential resolution for clone operations
						if (
							toolId === "clone" &&
							!args.githubToken &&
							!args.repositoryToken
						) {
							const authValue = (body.input as Record<string, unknown>)?.auth;
							const parsedConnectionId =
								parseConnectionExternalIdFromAuthTemplate(authValue) ||
								body.connection_external_id;

							if (parsedConnectionId) {
								try {
									const credResult = await fetchCredentialsWithAudit(
										"github",
										body.integrations,
										body.db_execution_id
											? {
													executionId: body.db_execution_id,
													nodeId: body.node_id,
												}
											: undefined,
										parsedConnectionId,
									);
									if (credResult.credentials.GITHUB_TOKEN) {
										args.githubToken = credResult.credentials.GITHUB_TOKEN;
									}
								} catch (err) {
									console.warn(
										"[Execute Route] GitHub credential resolution failed for clone action:",
										err,
									);
								}
							}
						}

						// Route to the appropriate durable-agent endpoint
						const isAgentRun = toolId === "run";
						const isPlan = toolId === "plan";
						const isExecutePlan = toolId === "execute";
						const isWorkspaceProfile =
							pluginId === "workspace" && toolId === "profile";
						const isWorkspaceClone =
							pluginId === "workspace" && toolId === "clone";
						const isWorkspaceCommand =
							pluginId === "workspace" && toolId === "command";
						const isWorkspaceFile =
							pluginId === "workspace" && toolId === "file";
						const isWorkspaceCleanup =
							pluginId === "workspace" && toolId === "cleanup";
						const workspaceExecutionId =
							typeof body.db_execution_id === "string" &&
							body.db_execution_id.trim()
								? body.db_execution_id.trim()
								: body.execution_id;

						let targetUrl: string;
						let requestBody: string;
						const loopPolicy = buildLoopPolicyInput(args);
						const model = parseDurableModelInput(args);
						const agentConfig = parseDurableAgentConfig(args);

						if (isAgentRun) {
							const mode =
								typeof args.mode === "string"
									? args.mode.trim().toLowerCase()
									: "plan_mode";
							if (mode === "plan_mode") {
								targetUrl = `${functionUrl}/api/plan`;
								requestBody = JSON.stringify({
									prompt: args.prompt ?? "",
									cwd: args.cwd ?? "",
									model,
									maxTurns: args.maxTurns,
									timeoutMinutes: args.timeoutMinutes,
									instructions: args.instructions,
									tools: args.tools,
									agentConfig,
									loopPolicy,
									workspaceRef:
										typeof args.workspaceRef === "string"
											? args.workspaceRef
											: undefined,
									parentExecutionId: body.execution_id,
									executionId: workspaceExecutionId,
									dbExecutionId: body.db_execution_id ?? undefined,
									workflowId: body.workflow_id,
									nodeId: body.node_id,
									nodeName: body.node_name,
								});
							} else {
								targetUrl = `${functionUrl}/api/run`;
								requestBody = JSON.stringify({
									prompt: args.prompt ?? "",
									cwd: args.cwd ?? "",
									model,
									maxTurns: args.maxTurns,
									timeoutMinutes: args.timeoutMinutes,
									instructions: args.instructions,
									tools: args.tools,
									agentConfig,
									loopPolicy,
									stopCondition: args.stopCondition,
									requireFileChanges: args.requireFileChanges,
									cleanupWorkspace: args.cleanupWorkspace,
									workspaceRef:
										typeof args.workspaceRef === "string"
											? args.workspaceRef
											: undefined,
									parentExecutionId: body.execution_id,
									executionId: workspaceExecutionId,
									dbExecutionId: body.db_execution_id ?? undefined,
									workflowId: body.workflow_id,
									nodeId: body.node_id,
									nodeName: body.node_name,
								});
							}
						} else if (isPlan) {
							targetUrl = `${functionUrl}/api/plan`;
							requestBody = JSON.stringify({
								prompt: args.prompt ?? "",
								cwd: args.cwd ?? "",
								model,
								maxTurns: args.maxTurns,
								timeoutMinutes: args.timeoutMinutes,
								instructions: args.instructions,
								tools: args.tools,
								agentConfig,
								loopPolicy,
								workspaceRef:
									typeof args.workspaceRef === "string"
										? args.workspaceRef
										: undefined,
								parentExecutionId: body.execution_id,
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isExecutePlan) {
							let plan = args.planJson;
							if (typeof plan === "string") {
								try {
									plan = JSON.parse(plan);
								} catch {
									/* pass as-is */
								}
							}
							targetUrl = `${functionUrl}/api/execute-plan`;
							requestBody = JSON.stringify({
								prompt: args.prompt ?? "",
								plan,
								cwd: args.cwd ?? "",
								maxTurns: args.maxTurns,
								loopPolicy,
								cleanupWorkspace: args.cleanupWorkspace,
								parentExecutionId: body.execution_id,
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isWorkspaceProfile) {
							targetUrl = `${functionUrl}/api/workspaces/profile`;
							requestBody = JSON.stringify({
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								name: args.name,
								rootPath: args.rootPath,
								enabledTools: args.enabledTools,
								requireReadBeforeWrite: args.requireReadBeforeWrite,
								commandTimeoutMs: args.commandTimeoutMs,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isWorkspaceClone) {
							targetUrl = `${functionUrl}/api/workspaces/clone`;
							requestBody = JSON.stringify({
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workspaceRef: args.workspaceRef,
								repositoryOwner: args.repositoryOwner,
								repositoryRepo: args.repositoryRepo,
								repositoryBranch: args.repositoryBranch,
								targetDir: args.targetDir,
								repositoryToken: args.repositoryToken,
								githubToken: args.githubToken,
								timeoutMs: args.timeoutMs,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isWorkspaceCommand) {
							targetUrl = `${functionUrl}/api/workspaces/command`;
							requestBody = JSON.stringify({
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workspaceRef: args.workspaceRef,
								command: args.command ?? args.prompt ?? "",
								timeoutMs: args.timeoutMs,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isWorkspaceFile) {
							targetUrl = `${functionUrl}/api/workspaces/file`;
							requestBody = JSON.stringify({
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workspaceRef: args.workspaceRef,
								operation: args.operation,
								path: args.path,
								content: args.content,
								old_string: args.old_string,
								new_string: args.new_string,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (isWorkspaceCleanup) {
							targetUrl = `${functionUrl}/api/workspaces/cleanup`;
							requestBody = JSON.stringify({
								executionId: workspaceExecutionId,
								dbExecutionId: body.db_execution_id ?? undefined,
								workspaceRef: args.workspaceRef,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else {
							targetUrl = `${functionUrl}/api/tools/${encodeURIComponent(toolId)}`;
							requestBody = JSON.stringify({ args });
						}

						const httpResponse = await fetch(targetUrl, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
							},
							body: requestBody,
							signal: controller.signal,
						});

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
										result:
											parsedMastra.result !== undefined
												? parsedMastra.result
												: parsedMastra,
										...(parsedMastra.result &&
										typeof parsedMastra.result === "object"
											? (parsedMastra.result as Record<string, unknown>)
											: {}),
										plan: parsedMastra.plan,
										workflowId:
											typeof parsedMastra.workflowId === "string"
												? parsedMastra.workflowId
												: typeof parsedMastra.workflow_id === "string"
													? parsedMastra.workflow_id
													: undefined,
										workspaceRef:
											typeof (parsedMastra as Record<string, unknown>)
												.workspaceRef === "string"
												? ((parsedMastra as Record<string, unknown>)
														.workspaceRef as string)
												: undefined,
										executionId:
											typeof (parsedMastra as Record<string, unknown>)
												.executionId === "string"
												? ((parsedMastra as Record<string, unknown>)
														.executionId as string)
												: undefined,
										rootPath:
											typeof (parsedMastra as Record<string, unknown>)
												.rootPath === "string"
												? ((parsedMastra as Record<string, unknown>)
														.rootPath as string)
												: undefined,
										backend:
											typeof (parsedMastra as Record<string, unknown>)
												.backend === "string"
												? ((parsedMastra as Record<string, unknown>)
														.backend as string)
												: undefined,
										cleanedWorkspaceRefs: Array.isArray(
											(parsedMastra as Record<string, unknown>)
												.cleanedWorkspaceRefs,
										)
											? ((parsedMastra as Record<string, unknown>)
													.cleanedWorkspaceRefs as unknown[])
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
							(typeof parsedMastra.workflowId === "string" ||
								typeof parsedMastra.workflow_id === "string")
						) {
							response = {
								success: true,
								data: {
									toolId,
									workflowId:
										typeof parsedMastra.workflowId === "string"
											? parsedMastra.workflowId
											: typeof parsedMastra.workflow_id === "string"
												? parsedMastra.workflow_id
												: undefined,
									plan: parsedMastra.plan,
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
								`Invalid response from durable-agent: ${responseText.slice(0, 300)}`,
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
				} else if (target.appId === "durable-agent") {
					console.log(
						`[Execute Route] Invoking durable-agent step: ${stepName} at ${functionUrl} (routing: ${timing.routingMs}ms)`,
					);

					const controller = new AbortController();
					const timeoutId = setTimeout(
						() => controller.abort(),
						HTTP_TIMEOUT_MS,
					);
					const executionStartTime = Date.now();

					try {
						const resolvedInput = body.input as Record<string, unknown>;
						const toolId = stepName;
						let targetUrl: string;
						let requestBody: string;
						const loopPolicy = buildLoopPolicyInput(resolvedInput);
						const model = parseDurableModelInput(resolvedInput);
						const agentConfig = parseDurableAgentConfig(resolvedInput);

						if (toolId === "run") {
							const mode =
								typeof resolvedInput.mode === "string"
									? resolvedInput.mode.toLowerCase()
									: "plan_mode";
							if (mode === "plan_mode") {
								targetUrl = `${functionUrl}/api/plan`;
								requestBody = JSON.stringify({
									prompt: resolvedInput.prompt || resolvedInput.input || "",
									cwd: resolvedInput.cwd || "",
									model,
									maxTurns: resolvedInput.maxTurns,
									timeoutMinutes: resolvedInput.timeoutMinutes,
									instructions: resolvedInput.instructions,
									tools: resolvedInput.tools,
									agentConfig,
									loopPolicy,
									workspaceRef: resolvedInput.workspaceRef || "",
									parentExecutionId: body.execution_id,
									executionId: body.db_execution_id || body.execution_id,
									dbExecutionId: body.db_execution_id ?? undefined,
									workflowId: body.workflow_id,
									nodeId: body.node_id,
									nodeName: body.node_name,
								});
							} else {
								targetUrl = `${functionUrl}/api/run`;
								requestBody = JSON.stringify({
									prompt: resolvedInput.prompt || resolvedInput.input || "",
									cwd: resolvedInput.cwd || "",
									model,
									maxTurns: resolvedInput.maxTurns,
									timeoutMinutes: resolvedInput.timeoutMinutes,
									instructions: resolvedInput.instructions,
									tools: resolvedInput.tools,
									agentConfig,
									loopPolicy,
									stopCondition: resolvedInput.stopCondition,
									requireFileChanges: resolvedInput.requireFileChanges,
									cleanupWorkspace: resolvedInput.cleanupWorkspace,
									workspaceRef: resolvedInput.workspaceRef || "",
									parentExecutionId: body.execution_id,
									executionId: body.db_execution_id || body.execution_id,
									dbExecutionId: body.db_execution_id ?? undefined,
									workflowId: body.workflow_id,
									nodeId: body.node_id,
									nodeName: body.node_name,
								});
							}
						} else if (toolId === "plan") {
							targetUrl = `${functionUrl}/api/plan`;
							requestBody = JSON.stringify({
								prompt: resolvedInput.prompt || resolvedInput.input || "",
								cwd: resolvedInput.cwd || "",
								model,
								maxTurns: resolvedInput.maxTurns,
								timeoutMinutes: resolvedInput.timeoutMinutes,
								instructions: resolvedInput.instructions,
								tools: resolvedInput.tools,
								agentConfig,
								loopPolicy,
								workspaceRef: resolvedInput.workspaceRef || "",
								parentExecutionId: body.execution_id,
								executionId: body.db_execution_id || body.execution_id,
								dbExecutionId: body.db_execution_id ?? undefined,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else if (toolId === "execute") {
							targetUrl = `${functionUrl}/api/execute-plan`;
							requestBody = JSON.stringify({
								prompt: resolvedInput.prompt || "",
								plan: resolvedInput.planJson || resolvedInput.plan || null,
								cwd: resolvedInput.cwd || "",
								maxTurns: resolvedInput.maxTurns,
								loopPolicy,
								cleanupWorkspace: resolvedInput.cleanupWorkspace,
								parentExecutionId: body.execution_id,
								workflowId: body.workflow_id,
								nodeId: body.node_id,
								nodeName: body.node_name,
							});
						} else {
							// Direct tool call
							targetUrl = `${functionUrl}/api/tools/${encodeURIComponent(toolId)}`;
							requestBody = JSON.stringify({
								args: resolvedInput,
							});
						}

						const httpResponse = await fetch(targetUrl, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: requestBody,
							signal: controller.signal,
						});
						clearTimeout(timeoutId);
						timing.executionMs = Date.now() - executionStartTime;

						const responseText = await httpResponse.text();
						let parsedResponse: Record<string, unknown>;
						try {
							parsedResponse = JSON.parse(responseText) as Record<
								string,
								unknown
							>;
						} catch {
							parsedResponse = { raw: responseText };
						}

						if (!httpResponse.ok) {
							throw new Error(
								`durable-agent returned ${httpResponse.status}: ${responseText.slice(0, 300)}`,
							);
						}

						response = {
							success: parsedResponse.success !== false,
							data: {
								toolId,
								result: parsedResponse.result || parsedResponse,
								workflow_id: parsedResponse.workflow_id,
							},
							duration_ms: timing.executionMs,
						};
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

					// Normalize system/* inputs so older saved workflows and/or AI-generated
					// configs don't fail strict fn-system validation.
					let normalizedInput = body.input as Record<string, unknown>;
					if (pluginId === "system" && stepName === "http-request") {
						const normalized = normalizeSystemHttpRequestInput(normalizedInput);
						normalizedInput = normalized.input;

						if (normalized.error) {
							const duration_ms = Date.now() - startTime;
							const response: ExecuteResponse = {
								success: false,
								error: normalized.error,
								duration_ms,
								routed_to: target.appId,
							};

							console.warn(
								`[Execute Route] Validation failed before invoking fn-system: ${normalized.error}`,
							);

							if (logId && body.db_execution_id) {
								try {
									await logExecutionComplete(logId, {
										success: false,
										error: normalized.error,
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

							return reply.status(200).send(response);
						}
					} else if (
						pluginId === "system" &&
						isPlainObject(normalizedInput.configFields)
					) {
						normalizedInput = {
							...normalizedInput,
							...normalizedInput.configFields,
						};
					}

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
						input: normalizedInput,
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
