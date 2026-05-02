import type { AgentConfig } from "./agents";

export type PromptTemplateRole = "system" | "user" | "assistant";
export type PromptTemplateFormat = "mustache";

export type PromptTemplateMessage = {
	role: PromptTemplateRole;
	content: string;
};

export type PromptArgumentDefinition = {
	name: string;
	description?: string;
	required?: boolean;
};

export type PromptPresetVersion = {
	id: string;
	promptId: string;
	version: number;
	messages: PromptTemplateMessage[];
	arguments: PromptArgumentDefinition[];
	templateFormat: PromptTemplateFormat;
	templateHash: string;
	metadata: PromptPresetMetadata | null;
	createdByUserId: string | null;
	createdAt: string;
};

export type PromptPresetMetadata = Record<string, unknown> & {
	agentConfigPatch?: Partial<Pick<AgentConfig, "systemPrompt">>;
};

export type PromptPresetSummary = {
	id: string;
	name: string;
	title: string;
	description: string | null;
	version: number;
	isEnabled: boolean;
	metadata: PromptPresetMetadata | null;
	userId: string;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
	latestVersion: PromptPresetVersion | null;
};
