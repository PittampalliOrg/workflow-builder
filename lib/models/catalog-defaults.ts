export type DefaultModelProvider = {
	id: string;
	name: string;
	iconKey: "openai" | "anthropic" | "google" | "meta";
	sortOrder: number;
};

export type DefaultModelCatalogEntry = {
	id: string;
	providerId: string;
	modelKey: string;
	displayName: string;
	description?: string;
	sortOrder: number;
};

export type DefaultModelOption = {
	id: string;
	name: string;
	provider: string;
	description?: string;
};

export const DEFAULT_MODEL_PROVIDERS: DefaultModelProvider[] = [
	{ id: "openai", name: "OpenAI", iconKey: "openai", sortOrder: 10 },
	{ id: "anthropic", name: "Anthropic", iconKey: "anthropic", sortOrder: 20 },
	{ id: "google", name: "Google", iconKey: "google", sortOrder: 30 },
	{ id: "meta", name: "Meta", iconKey: "meta", sortOrder: 40 },
];

export const DEFAULT_MODEL_CATALOG: DefaultModelCatalogEntry[] = [
	{
		id: "openai/gpt-5.3-codex",
		providerId: "openai",
		modelKey: "gpt-5.3-codex",
		displayName: "GPT-5.3 Codex",
		sortOrder: 10,
	},
	{
		id: "openai/gpt-5.2-codex",
		providerId: "openai",
		modelKey: "gpt-5.2-codex",
		displayName: "GPT-5.2 Codex",
		sortOrder: 20,
	},
	{
		id: "openai/gpt-5.1-instant",
		providerId: "openai",
		modelKey: "gpt-5.1-instant",
		displayName: "GPT-5.1 Instant",
		sortOrder: 30,
	},
	{
		id: "openai/gpt-4o",
		providerId: "openai",
		modelKey: "gpt-4o",
		displayName: "GPT-4o",
		sortOrder: 40,
	},
	{
		id: "openai/gpt-4o-mini",
		providerId: "openai",
		modelKey: "gpt-4o-mini",
		displayName: "GPT-4o mini",
		sortOrder: 50,
	},
	{
		id: "anthropic/claude-opus-4-6",
		providerId: "anthropic",
		modelKey: "claude-opus-4-6",
		displayName: "Claude Opus 4.6",
		sortOrder: 10,
	},
	{
		id: "anthropic/claude-sonnet-4-6",
		providerId: "anthropic",
		modelKey: "claude-sonnet-4-6",
		displayName: "Claude Sonnet 4.6",
		sortOrder: 20,
	},
	{
		id: "anthropic/claude-sonnet-4-5",
		providerId: "anthropic",
		modelKey: "claude-sonnet-4-5",
		displayName: "Claude Sonnet 4.5",
		sortOrder: 30,
	},
	{
		id: "google/gemini-2.5-pro",
		providerId: "google",
		modelKey: "gemini-2.5-pro",
		displayName: "Gemini 2.5 Pro",
		sortOrder: 10,
	},
	{
		id: "google/gemini-2.5-flash",
		providerId: "google",
		modelKey: "gemini-2.5-flash",
		displayName: "Gemini 2.5 Flash",
		sortOrder: 20,
	},
];

const PROVIDER_NAME_BY_ID = new Map(
	DEFAULT_MODEL_PROVIDERS.map((provider) => [provider.id, provider.name]),
);

export function getProviderNameById(providerId: string): string {
	return PROVIDER_NAME_BY_ID.get(providerId) ?? providerId;
}

export const DEFAULT_MODEL_OPTIONS: DefaultModelOption[] =
	DEFAULT_MODEL_CATALOG.map((entry) => ({
		id: `${entry.providerId}/${entry.modelKey}`,
		name: entry.displayName,
		provider: entry.providerId,
		description: entry.description,
	}));
