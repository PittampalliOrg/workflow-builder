import type {
	ObservabilityLlmMessage,
	ObservabilityLlmSpan,
	ObservabilityToolSpan,
	ObservabilityTraceSpan,
} from "$lib/types/observability";

export function normalizeRawTraceSpans(traceSpans: ObservabilityTraceSpan[]): {
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
} {
	const llmSpans: ObservabilityLlmSpan[] = [];
	const toolSpans: ObservabilityToolSpan[] = [];
	for (const span of traceSpans) {
		const attributes = flattenAttributes(span.attributes ?? {});
		const kind = firstString(attributes, ["openinference.span.kind", "span.type"])?.toLowerCase();
		const mlflowSpanType = firstString(attributes, ["mlflow.spanType"])?.toLowerCase();
		const operation = span.operationName.toLowerCase();
		const durableTaskWrapper =
			Boolean(firstString(attributes, ["durabletask.type"])) &&
			!mlflowSpanType &&
			!kind &&
			!firstString(attributes, ["llm.model_name", "gen_ai.request.model", "model", "model_name"]) &&
			!firstString(attributes, ["tool.name", "tool_name", "mcp.tool.name", "function.name", "gen_ai.tool.name"]);
		const toolLike =
			mlflowSpanType === "tool" ||
			kind === "tool" ||
			kind === "function" ||
			(!durableTaskWrapper && operation.includes("tool")) ||
			Boolean(
				firstString(attributes, [
					"tool.name",
					"tool_name",
					"mcp.tool.name",
					"function.name",
					"gen_ai.tool.name",
				]),
			);
		if (toolLike) {
			toolSpans.push(normalizeRawToolSpan(span, attributes));
			continue;
		}
		if (
			mlflowSpanType === "chat_model" ||
			mlflowSpanType === "llm" ||
			kind === "llm" ||
			kind === "chat" ||
			kind === "language_model" ||
			(!durableTaskWrapper && operation.includes("llm")) ||
			Boolean(firstString(attributes, ["llm.model_name", "gen_ai.request.model", "model", "model_name"]))
		) {
			llmSpans.push(normalizeRawLlmSpan(span, attributes));
		}
	}
	return {
		llmSpans: llmSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
		toolSpans: toolSpans.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
	};
}

export function enrichLlmSpansWithRawTraceAttributes(
	llmSpans: ObservabilityLlmSpan[],
	traceSpans: ObservabilityTraceSpan[],
): ObservabilityLlmSpan[] {
	const rawById = new Map<string, ObservabilityTraceSpan>();
	for (const span of traceSpans) {
		rawById.set(`${span.traceId}:${span.spanId}`, span);
	}
	return llmSpans.map((span) => {
		const raw = rawById.get(`${span.traceId}:${span.spanId}`);
		if (!raw) return span;
		const usage = usageFromAttributes(flattenAttributes(raw.attributes ?? {}));
		if (!hasUsage(usage)) return span;
		return {
			...span,
			promptTokens: span.promptTokens ?? usage.promptTokens,
			completionTokens: span.completionTokens ?? usage.completionTokens,
			totalTokens: span.totalTokens ?? usage.totalTokens,
			cacheReadInputTokens: span.cacheReadInputTokens ?? usage.cacheReadInputTokens,
			cacheCreationInputTokens: span.cacheCreationInputTokens ?? usage.cacheCreationInputTokens,
			reasoningTokens: span.reasoningTokens ?? usage.reasoningTokens,
		};
	});
}

function normalizeRawLlmSpan(
	span: ObservabilityTraceSpan,
	attributes: Record<string, unknown>,
): ObservabilityLlmSpan {
	const inputMessages = messagesFromValue(firstValue(attributes, [
		"input.value",
		"llm.input_messages",
		"gen_ai.prompt",
		"prompt",
	]), "user");
	const outputMessages = messagesFromValue(firstValue(attributes, [
		"output.value",
		"llm.output_messages",
		"gen_ai.completion",
		"completion",
	]), "assistant");
	const usage = usageFromAttributes(attributes);
	return {
		...spanRef(span),
		modelName:
			firstString(attributes, [
				"llm.model_name",
				"gen_ai.request.model",
				"model",
				"model_name",
			]) ?? null,
		provider:
			firstString(attributes, ["llm.provider", "gen_ai.system", "provider", "model_provider"]) ??
			null,
		inputMessages,
		outputMessages,
		invocationParameters: recordFromValue(
			firstValue(attributes, ["invocation_parameters", "llm.invocation_parameters"]),
		),
		finishReason:
			firstString(attributes, [
				"finish_reason",
				"llm.finish_reason",
				"gen_ai.response.finish_reasons",
			]) ?? null,
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.totalTokens,
		cacheReadInputTokens: usage.cacheReadInputTokens,
		cacheCreationInputTokens: usage.cacheCreationInputTokens,
		reasoningTokens: usage.reasoningTokens,
		inputMessagesTruncated: false,
		outputMessagesTruncated: false,
		invocationParametersTruncated: false,
	};
}

function normalizeRawToolSpan(
	span: ObservabilityTraceSpan,
	attributes: Record<string, unknown>,
): ObservabilityToolSpan {
	return {
		...spanRef(span),
		toolName:
			firstString(attributes, [
				"tool.name",
				"tool_name",
				"mcp.tool.name",
				"function.name",
				"gen_ai.tool.name",
			]) ??
			span.operationName ??
			"(unknown tool)",
		toolArguments: firstParsedValue(attributes, [
			"tool.arguments",
			"tool_args",
			"input.value",
			"function.arguments",
		]),
		toolResult: firstParsedValue(attributes, [
			"tool.result",
			"tool_result",
			"output.value",
			"function.output",
		]),
		toolArgumentsTruncated: false,
		toolResultTruncated: false,
	};
}

function usageFromAttributes(attributes: Record<string, unknown>): Pick<
	ObservabilityLlmSpan,
	| "promptTokens"
	| "completionTokens"
	| "totalTokens"
	| "cacheReadInputTokens"
	| "cacheCreationInputTokens"
	| "reasoningTokens"
> {
	return {
		promptTokens: firstNumber(attributes, [
			"llm.token_count.prompt",
			"gen_ai.usage.input_tokens",
			"usage.prompt_tokens",
			"prompt_tokens",
			"input_tokens",
		]),
		completionTokens: firstNumber(attributes, [
			"llm.token_count.completion",
			"gen_ai.usage.output_tokens",
			"usage.completion_tokens",
			"completion_tokens",
			"output_tokens",
		]),
		totalTokens: firstNumber(attributes, [
			"llm.token_count.total",
			"gen_ai.usage.total_tokens",
			"usage.total_tokens",
			"total_tokens",
		]),
		cacheReadInputTokens: firstNumber(attributes, [
			"gen_ai.usage.cache_read_input_tokens",
			"llm.token_count.cache_read",
			"usage.cache_read_input_tokens",
			"cache_read_input_tokens",
			"cached_content_token_count",
			"prompt_tokens_details.cached_tokens",
			"usage.prompt_tokens_details.cached_tokens",
		]),
		cacheCreationInputTokens: firstNumber(attributes, [
			"gen_ai.usage.cache_creation_input_tokens",
			"llm.token_count.cache_creation",
			"usage.cache_creation_input_tokens",
			"cache_creation_input_tokens",
			"cache_creation_tokens",
		]),
		reasoningTokens: firstNumber(attributes, [
			"gen_ai.usage.reasoning_tokens",
			"llm.token_count.reasoning",
			"usage.reasoning_tokens",
			"reasoning_tokens",
			"thoughts_token_count",
			"completion_tokens_details.reasoning_tokens",
			"usage.completion_tokens_details.reasoning_tokens",
		]),
	};
}

function hasUsage(usage: ReturnType<typeof usageFromAttributes>): boolean {
	return Object.values(usage).some((value) => value != null);
}

function spanRef(span: ObservabilityTraceSpan) {
	const attrs = span.attributes ?? {};
	const resources = span.resourceAttributes ?? {};
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		parentSpanId: span.parentSpanId,
		serviceName: span.serviceName,
		timestamp: span.startTime,
		sessionId: stringFrom(attrs["session.id"] ?? resources["session.id"]) ?? "",
		workflowExecutionId:
			stringFrom(
				attrs["workflow.execution.id"] ??
					resources["workflow.execution.id"] ??
					attrs["workflow_execution_id"],
			) ?? "",
		agentRunId:
			stringFrom(attrs["agent.run.id"] ?? attrs["agent_run_id"] ?? resources["agent.run.id"]) ??
			null,
		statusCode: span.statusCode ?? (span.status === "error" ? "STATUS_CODE_ERROR" : "OK"),
	};
}

function flattenAttributes(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		const parsed = maybeJson(raw);
		out[key] = parsed;
		if (isRecord(parsed)) flattenAttributeRecord(out, key, parsed);
	}
	return out;
}

function flattenAttributeRecord(
	out: Record<string, unknown>,
	prefix: string,
	value: Record<string, unknown>,
): void {
	for (const [childKey, rawChildValue] of Object.entries(value)) {
		const childValue = maybeJson(rawChildValue);
		out[`${prefix}.${childKey}`] = childValue;
		out[childKey] ??= childValue;
		if (isRecord(childValue)) {
			flattenAttributeRecord(out, `${prefix}.${childKey}`, childValue);
		}
	}
}

function messagesFromValue(value: unknown, role: string): ObservabilityLlmMessage[] {
	const parsed = maybeJson(value);
	if (Array.isArray(parsed)) {
		return parsed.map((item) => normalizeMessage(item, role)).filter(Boolean);
	}
	if (isRecord(parsed) && Array.isArray(parsed.messages)) {
		return parsed.messages.map((item) => normalizeMessage(item, role)).filter(Boolean);
	}
	if (parsed == null || parsed === "") return [];
	return [{ role, content: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }];
}

function normalizeMessage(value: unknown, fallbackRole: string): ObservabilityLlmMessage {
	if (!isRecord(value)) {
		return { role: fallbackRole, content: value == null ? null : String(value) };
	}
	return {
		role: stringFrom(value.role) ?? fallbackRole,
		content: value.content == null ? null : String(value.content),
		name: stringFrom(value.name) ?? undefined,
		toolCallId: stringFrom(value.tool_call_id ?? value.toolCallId) ?? undefined,
		toolCalls: Array.isArray(value.tool_calls)
			? (value.tool_calls as ObservabilityLlmMessage["toolCalls"])
			: Array.isArray(value.toolCalls)
				? (value.toolCalls as ObservabilityLlmMessage["toolCalls"])
				: undefined,
	};
}

function firstValue(attributes: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (attributes[key] != null && attributes[key] !== "") return attributes[key];
	}
	return null;
}

function firstParsedValue(attributes: Record<string, unknown>, keys: string[]): unknown {
	return maybeJson(firstValue(attributes, keys));
}

function firstString(attributes: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = stringFrom(attributes[key]);
		if (value) return value;
	}
	return null;
}

function firstNumber(attributes: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = attributes[key];
		const n =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: NaN;
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function recordFromValue(value: unknown): Record<string, unknown> | null {
	const parsed = maybeJson(value);
	return isRecord(parsed) ? parsed : null;
}

function maybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!["{", "["].includes(trimmed[0])) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function stringFrom(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
