import { listModelCatalog } from "@/lib/db/model-catalog";
import { DEFAULT_MODEL_CATALOG } from "@/lib/models/catalog-defaults";

type ResolveCatalogModelKeyInput = {
	providerId: string;
	configuredModelId?: string;
	fallbackModelKey: string;
};

const PROVIDER_PREFERRED_MODEL_ORDER: Record<string, string[]> = {
	openai: ["gpt-4o", "gpt-4o-mini"],
	anthropic: [
		"claude-opus-4-6",
		"claude-opus-4.6",
		"claude-sonnet-4-6",
		"claude-sonnet-4-5",
	],
};

function isCodexModelKey(modelKey: string): boolean {
	return modelKey.toLowerCase().includes("codex");
}

function shouldAllowCodexModels(): boolean {
	return process.env.ALLOW_CODEX_MODELS === "true";
}

function parseConfiguredModelKey(
	configuredModelId: string | undefined,
	providerId: string,
): string | null {
	if (!configuredModelId) {
		return null;
	}

	const trimmed = configuredModelId.trim();
	if (!trimmed) {
		return null;
	}

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex < 0) {
		return trimmed;
	}

	const configuredProvider = trimmed.slice(0, slashIndex);
	const configuredKey = trimmed.slice(slashIndex + 1);
	if (!configuredProvider || !configuredKey) {
		return null;
	}

	return configuredProvider === providerId ? configuredKey : null;
}

function getDefaultCatalogModelKeys(providerId: string): string[] {
	return DEFAULT_MODEL_CATALOG.filter(
		(entry) => entry.providerId === providerId,
	)
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((entry) => entry.modelKey);
}

function chooseProviderDefaultModelKey(
	providerId: string,
	modelKeys: string[],
): string | null {
	if (modelKeys.length === 0) {
		return null;
	}

	const preferredModelOrder = PROVIDER_PREFERRED_MODEL_ORDER[providerId];
	if (preferredModelOrder) {
		for (const preferred of preferredModelOrder) {
			if (modelKeys.includes(preferred)) {
				return preferred;
			}
		}
	}

	return modelKeys[0];
}

export async function resolveCatalogModelKey({
	providerId,
	configuredModelId,
	fallbackModelKey,
}: ResolveCatalogModelKeyInput): Promise<string> {
	const configuredModelKey = parseConfiguredModelKey(
		configuredModelId,
		providerId,
	);

	try {
		const catalogRows = await listModelCatalog({ includeDisabled: false });
		const providerModelKeys = catalogRows
			.filter((row) => row.provider === providerId)
			.map((row) => row.modelKey);

		if (providerModelKeys.length > 0) {
			if (
				configuredModelKey &&
				providerModelKeys.includes(configuredModelKey) &&
				(shouldAllowCodexModels() || !isCodexModelKey(configuredModelKey))
			) {
				return configuredModelKey;
			}
			return (
				chooseProviderDefaultModelKey(providerId, providerModelKeys) ||
				providerModelKeys[0]
			);
		}
	} catch (error) {
		console.warn("[AI] Failed to load model catalog from DB.", {
			error: error instanceof Error ? error.message : String(error),
			providerId,
		});
	}

	const defaultKeys = getDefaultCatalogModelKeys(providerId);
	if (configuredModelKey && defaultKeys.includes(configuredModelKey)) {
		return configuredModelKey;
	}

	return (
		chooseProviderDefaultModelKey(providerId, defaultKeys) ||
		defaultKeys[0] ||
		fallbackModelKey
	);
}
