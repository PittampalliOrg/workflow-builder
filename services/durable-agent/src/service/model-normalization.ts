type ModelNormalizationOptions = {
	aiModel?: string;
	anthropicApiKey?: string;
	logPrefix?: string;
};

function resolveOptions(
	options: ModelNormalizationOptions | undefined,
): Required<ModelNormalizationOptions> {
	return {
		aiModel: options?.aiModel ?? process.env.AI_MODEL ?? "",
		anthropicApiKey:
			options?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
		logPrefix: options?.logPrefix ?? "[durable-agent]",
	};
}

export function normalizeOpenAiChatModel(
	modelRaw: string,
	source: string,
	options?: Pick<ModelNormalizationOptions, "logPrefix">,
): string {
	const resolved = resolveOptions(options);
	const model = String(modelRaw || "").trim();
	if (!model) {
		throw new Error(
			`${resolved.logPrefix} No OpenAI model configured for ${source}`,
		);
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
			logPrefix: resolved.logPrefix,
		})}`;
	}

	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex <= 0) {
		const normalizedModel = normalizeOpenAiChatModel(modelSpec, "modelSpec", {
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
				logPrefix: resolved.logPrefix,
			},
		);
		return `openai/${normalizedModel}`;
	}

	if (
		provider === "anthropic" &&
		!String(resolved.anthropicApiKey || "").trim()
	) {
		throw new Error(
			`${resolved.logPrefix} Model "${modelSpec}" requires ANTHROPIC_API_KEY`,
		);
	}

	return modelSpec;
}
