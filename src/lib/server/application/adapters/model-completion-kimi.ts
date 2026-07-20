import { env } from "$env/dynamic/private";
import { createOpenAI } from "@ai-sdk/openai";
import {
	generateText,
	stepCountIs,
	type ModelMessage,
	type ToolSet,
} from "ai";
import type {
	ModelCompletionPort,
	ModelCompletionRequest,
	ModelGenerationRequest,
	ModelGenerationResult,
} from "$lib/server/application/ports";

export const KIMI_K3_MODEL = "kimi-k3";
export const KIMI_KFC_BASE_URL = "https://api.kimi.com/coding/v1";
export const PREVIEW_RUNTIME_EGRESS_BASE_URL =
	"http://preview-runtime-egress.workflow-builder.svc.cluster.local:7000/v1";
export const KIMI_K3_MAX_COMPLETION_TOKENS = 131_072;

type KimiEnvironment = Record<string, string | undefined>;

type KimiTransport = {
	baseUrl: string;
	apiKey: string;
};

type KimiModelCompletionAdapterOptions = {
	previewDeployment: boolean;
	environment?: KimiEnvironment;
	fetch?: typeof fetch;
	sleep?: (delayMs: number) => Promise<void>;
};

type KimiChatResponse = {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
};

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function textContent(content: unknown): string | null {
	if (typeof content === "string" && content.trim()) return content;
	if (!Array.isArray(content)) return null;
	const text = content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const value = (part as Record<string, unknown>).text;
			return typeof value === "string" ? [value] : [];
		})
		.join("");
	return text.trim() ? text : null;
}

export function buildKimiK3ChatRequest(
	input: Pick<
		ModelCompletionRequest,
		"messages" | "maxOutputTokens" | "responseFormat"
	>,
): Record<string, unknown> {
	return {
		model: KIMI_K3_MODEL,
		messages: input.messages,
		max_completion_tokens: Math.max(
			input.maxOutputTokens,
			KIMI_K3_MAX_COMPLETION_TOKENS,
		),
		reasoning_effort: "max",
		temperature: 1,
		frequency_penalty: 0,
		...(input.responseFormat
			? { response_format: input.responseFormat }
			: {}),
	};
}

/** Apply the fixed K3 policy to requests emitted by the AI SDK. */
export function enforceKimiK3RequestBody(body: string): string {
	try {
		const payload = JSON.parse(body) as Record<string, unknown>;
		const requested = Number(
			payload.max_completion_tokens ??
				payload.max_tokens ??
				payload.max_output_tokens,
		);
		payload.model = KIMI_K3_MODEL;
		payload.reasoning_effort = "max";
		payload.max_completion_tokens = Math.max(
			Number.isFinite(requested) ? requested : 0,
			KIMI_K3_MAX_COMPLETION_TOKENS,
		);
		payload.temperature = 1;
		payload.frequency_penalty = 0;
		delete payload.max_tokens;
		delete payload.max_output_tokens;
		return JSON.stringify(payload);
	} catch {
		return body;
	}
}

export class KimiK3ModelCompletionAdapter implements ModelCompletionPort {
	private readonly environment: KimiEnvironment;
	private readonly fetchImplementation: typeof fetch;
	private readonly sleep: (delayMs: number) => Promise<void>;

	constructor(private readonly options: KimiModelCompletionAdapterOptions) {
		this.environment = options.environment ?? env;
		this.fetchImplementation = options.fetch ?? fetch;
		this.sleep =
			options.sleep ??
			((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
	}

	isAvailable(): boolean {
		return this.options.previewDeployment || Boolean(this.kimiApiKey());
	}

	async complete(input: ModelCompletionRequest): Promise<string> {
		const transport = this.requireTransport();
		const body = JSON.stringify(buildKimiK3ChatRequest(input));
		const maxAttempts = positiveInteger(
			this.environment.KIMI_EMPTY_CONTENT_RETRIES,
			3,
		);
		let lastError = "empty content";

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const response = await this.fetchImplementation(
				`${transport.baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${transport.apiKey}`,
						"Content-Type": "application/json",
					},
					body,
					signal: input.abortSignal,
				},
			);

			if (!response.ok) {
				const detail = (await response.text()).slice(0, 1_000);
				if (response.status >= 500 && attempt < maxAttempts) {
					lastError = `HTTP ${response.status}: ${detail}`;
					await this.sleep(500 * attempt);
					continue;
				}
				throw new Error(`Kimi API error ${response.status}: ${detail}`);
			}

			const data = (await response.json()) as KimiChatResponse;
			const content = textContent(data.choices?.[0]?.message?.content);
			if (content) return content;

			lastError = "empty content";
			if (attempt < maxAttempts) await this.sleep(500 * attempt);
		}

		throw new Error(
			`No content in Kimi response after ${maxAttempts} attempts (${lastError})`,
		);
	}

	async generate(input: ModelGenerationRequest): Promise<ModelGenerationResult> {
		const transport = this.requireTransport();
		const kimiFetch: typeof fetch = (request, init) => {
			const body =
				typeof init?.body === "string"
					? enforceKimiK3RequestBody(init.body)
					: init?.body;
			return this.fetchImplementation(request, { ...init, body });
		};
		const provider = createOpenAI({
			baseURL: transport.baseUrl,
			apiKey: transport.apiKey,
			name: "kimi-for-coding",
			fetch: kimiFetch,
		});

		const result = await generateText({
			model: provider.chat(KIMI_K3_MODEL),
			system: input.system,
			messages: input.messages as ModelMessage[],
			maxOutputTokens: Math.max(
				input.maxOutputTokens,
				KIMI_K3_MAX_COMPLETION_TOKENS,
			),
			temperature: 1,
			frequencyPenalty: 0,
			...(input.tools ? { tools: input.tools as ToolSet } : {}),
			...(input.maxSteps ? { stopWhen: stepCountIs(input.maxSteps) } : {}),
			...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		});

		return {
			text: result.text,
			steps: result.steps.map((step) => ({
				toolCalls: step.toolCalls.map((call) => ({
					toolName: call.toolName,
					input: call.input,
				})),
				toolResults: step.toolResults.map((toolResult) => ({
					toolName: toolResult.toolName,
					output: toolResult.output,
				})),
			})),
		};
	}

	private requireTransport(): KimiTransport {
		if (this.options.previewDeployment) {
			return {
				baseUrl: PREVIEW_RUNTIME_EGRESS_BASE_URL,
				apiKey: "preview-runtime-adapter",
			};
		}

		const apiKey = this.kimiApiKey();
		if (!apiKey) {
			throw new Error("KIMI_API_KEY is not configured");
		}
		return { baseUrl: KIMI_KFC_BASE_URL, apiKey };
	}

	private kimiApiKey(): string | null {
		return this.environment.KIMI_API_KEY?.trim() || null;
	}
}
