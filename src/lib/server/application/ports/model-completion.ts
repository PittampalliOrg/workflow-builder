export type ModelCompletionMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type ModelCompletionResponseFormat = {
	type: "json_object";
};

export type ModelCompletionRequest = {
	messages: ModelCompletionMessage[];
	maxOutputTokens: number;
	responseFormat?: ModelCompletionResponseFormat;
	abortSignal?: AbortSignal;
};

export type ModelGenerationMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ModelGenerationRequest = {
	system: string;
	messages: ModelGenerationMessage[];
	maxOutputTokens: number;
	maxSteps?: number;
	tools?: Record<string, unknown>;
	abortSignal?: AbortSignal;
};

export type ModelGenerationStep = {
	toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
	toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
};

export type ModelGenerationResult = {
	text: string;
	steps: ReadonlyArray<ModelGenerationStep>;
};

/** Outbound model-completion boundary owned by the application layer. */
export interface ModelCompletionPort {
	isAvailable(): boolean;
	complete(input: ModelCompletionRequest): Promise<string>;
	generate(input: ModelGenerationRequest): Promise<ModelGenerationResult>;
}
