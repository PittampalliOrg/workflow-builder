const DEFAULT_OPENAI_CHAT_FALLBACK_MODEL = "gpt-4o";

type ModelNormalizationOptions = {
	aiModel?: string;
	anthropicApiKey?: string;
	fallbackModel?: string;
	logPrefix?: string;
};

function resolveOptions(
	options: ModelNormalizationOptions | undefined,
): Required<ModelNormalizationOptions> {
	const fallbackModelRaw =
		options?.fallbackModel ?? process.env.OPENAI_CHAT_FALLBACK_MODEL;
	const fallbackModel = String(fallbackModelRaw || "").trim();
	return {
		aiModel: options?.aiModel ?? process.env.AI_MODEL ?? "",
		anthropicApiKey:
			options?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
		fallbackModel: fallbackModel || DEFAULT_OPENAI_CHAT_FALLBACK_MODEL,
		logPrefix: options?.logPrefix ?? "[durable-agent]",
	};
}

export function normalizeOpenAiChatModel(
	modelRaw: string,
	source: string,
	options?: Pick<ModelNormalizationOptions, "fallbackModel" | "logPrefix">,
): string {
	const resolved = resolveOptions(options);
	const model = String(modelRaw || "").trim();
	if (!model) {
		return resolved.fallbackModel;
	}
	const normalized = model.toLowerCase();
	if (normalized.includes("codex")) {
		console.warn(
			`${resolved.logPrefix} Model "${model}" from ${source} is not compatible with OpenAI chat completions; falling back to "${resolved.fallbackModel}"`,
		);
		return resolved.fallbackModel;
	}
	return model;
}

export function normalizeModelSpecForEnvironment(
	modelSpecRaw: string,
	options?: ModelNormalizationOptions,
): string {
	const resolved = resolveOptions(options);
	const modelSpec = String(modelSpecRaw || "").trim();
	if (!modelSpec) {
		return `openai/${normalizeOpenAiChatModel(resolved.aiModel, "AI_MODEL", {
			fallbackModel: resolved.fallbackModel,
			logPrefix: resolved.logPrefix,
		})}`;
	}

	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex <= 0) {
		const normalizedModel = normalizeOpenAiChatModel(modelSpec, "modelSpec", {
			fallbackModel: resolved.fallbackModel,
			logPrefix: resolved.logPrefix,
		});
		return `openai/${normalizedModel}`;
	}

	const provider = modelSpec.slice(0, slashIndex).toLowerCase();
	const modelName = modelSpec.slice(slashIndex + 1);
	if (provider === "openai") {
		const normalizedModel = normalizeOpenAiChatModel(
			modelName,
			`modelSpec:${provider}`,
			{
				fallbackModel: resolved.fallbackModel,
				logPrefix: resolved.logPrefix,
			},
		);
		return `openai/${normalizedModel}`;
	}

	if (
		provider === "anthropic" &&
		!String(resolved.anthropicApiKey || "").trim()
	) {
		const fallback = `openai/${normalizeOpenAiChatModel(
			resolved.aiModel,
			"AI_MODEL",
			{
				fallbackModel: resolved.fallbackModel,
				logPrefix: resolved.logPrefix,
			},
		)}`;
		console.warn(
			`${resolved.logPrefix} Model "${modelSpec}" requires ANTHROPIC_API_KEY; falling back to "${fallback}"`,
		);
		return fallback;
	}

	return modelSpec;
}
