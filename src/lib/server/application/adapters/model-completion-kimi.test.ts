import { describe, expect, it, vi } from "vitest";
import {
	buildKimiK3ChatRequest,
	enforceKimiK3RequestBody,
	KIMI_K3_MAX_COMPLETION_TOKENS,
	KIMI_KFC_BASE_URL,
	KimiK3ModelCompletionAdapter,
	PREVIEW_RUNTIME_EGRESS_BASE_URL,
} from "./model-completion-kimi";

function successfulFetch(
	calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>,
): typeof fetch {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response(
			JSON.stringify({ choices: [{ message: { content: "completed" } }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
}

describe("KimiK3ModelCompletionAdapter", () => {
	it("routes physical BFF completions directly to Kimi-for-Coding", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const adapter = new KimiK3ModelCompletionAdapter({
			previewDeployment: false,
			environment: {
				KIMI_API_KEY: "physical-kimi-key",
					KIMI_BASE_URL: "https://wrong-kimi-endpoint.invalid/v1",
				LLM_GATEWAY_OPENAI_BASE_URL: "http://mlflow-gateway.test/v1",
				AI_GATEWAY_API_KEY: "legacy-gateway-key",
			},
			fetch: successfulFetch(calls),
		});

		await expect(
			adapter.complete({
				maxOutputTokens: 800,
				responseFormat: { type: "json_object" },
				messages: [{ role: "user", content: "Return JSON." }],
			}),
		).resolves.toBe("completed");

		expect(String(calls[0].input)).toBe(
			`${KIMI_KFC_BASE_URL}/chat/completions`,
		);
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
			"Bearer physical-kimi-key",
		);
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			model: "kimi-k3",
			max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
			reasoning_effort: "max",
			temperature: 1,
			frequency_penalty: 0,
			response_format: { type: "json_object" },
		});
	});

	it("routes preview BFF completions only through preview-runtime-egress", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const adapter = new KimiK3ModelCompletionAdapter({
			previewDeployment: true,
			environment: {
				KIMI_API_KEY: "must-not-cross-preview-boundary",
				LLM_GATEWAY_OPENAI_BASE_URL: "http://unexpected-gateway.test/v1",
			},
			fetch: successfulFetch(calls),
		});

		expect(adapter.isAvailable()).toBe(true);
		await adapter.complete({
			maxOutputTokens: 1_024,
			messages: [{ role: "user", content: "Preview request" }],
		});

		expect(String(calls[0].input)).toBe(
			`${PREVIEW_RUNTIME_EGRESS_BASE_URL}/chat/completions`,
		);
		expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
			"Bearer preview-runtime-adapter",
		);
	});

	it("applies the K3 policy to AI SDK generation calls", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const fetchImplementation = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ input, init });
				return new Response(
					JSON.stringify({
						id: "completion-1",
						object: "chat.completion",
						created: 1,
						model: "kimi-k3",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "generated" },
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		) as typeof fetch;
		const adapter = new KimiK3ModelCompletionAdapter({
			previewDeployment: false,
			environment: { KIMI_API_KEY: "physical-kimi-key" },
			fetch: fetchImplementation,
		});

		await expect(
			adapter.generate({
				system: "Be concise.",
				messages: [{ role: "user", content: "Hello" }],
				maxOutputTokens: 2_048,
			}),
		).resolves.toMatchObject({ text: "generated" });

		expect(String(calls[0].input)).toBe(
			`${KIMI_KFC_BASE_URL}/chat/completions`,
		);
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			model: "kimi-k3",
			reasoning_effort: "max",
			max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
			temperature: 1,
			frequency_penalty: 0,
		});
	});

	it("is unavailable outside previews when KIMI_API_KEY is absent", async () => {
		const adapter = new KimiK3ModelCompletionAdapter({
			previewDeployment: false,
			environment: {},
		});

		expect(adapter.isAvailable()).toBe(false);
		await expect(
			adapter.complete({
				maxOutputTokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("KIMI_API_KEY is not configured");
	});
});

describe("Kimi K3 request policy", () => {
	it("fixes the model, max reasoning, and K3 completion budget", () => {
		expect(
			buildKimiK3ChatRequest({
				maxOutputTokens: 4_096,
				messages: [{ role: "user", content: "Hello" }],
			}),
		).toMatchObject({
			model: "kimi-k3",
			reasoning_effort: "max",
			max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
		});
	});

	it("enforces the same policy on AI SDK request bodies", () => {
		const request = JSON.parse(
			enforceKimiK3RequestBody(
				JSON.stringify({
					model: "other-model",
					max_tokens: 2_048,
					reasoning_effort: "low",
				}),
			),
		) as Record<string, unknown>;

		expect(request).toMatchObject({
			model: "kimi-k3",
			reasoning_effort: "max",
			max_completion_tokens: KIMI_K3_MAX_COMPLETION_TOKENS,
			temperature: 1,
			frequency_penalty: 0,
		});
		expect(request).not.toHaveProperty("max_tokens");
	});
});
