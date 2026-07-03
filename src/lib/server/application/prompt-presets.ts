import type { PromptPresetSummary } from "$lib/types/prompt-presets";

export class ApplicationPromptPresetValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplicationPromptPresetValidationError";
	}
}

export type PromptPresetCommandBody = Record<string, unknown>;

export type PromptPresetRepository = {
	list(input: {
		projectId: string;
		includeDisabled?: boolean;
	}): Promise<PromptPresetSummary[]>;
	create(input: {
		projectId: string;
		userId: string;
		body: PromptPresetCommandBody;
	}): Promise<PromptPresetSummary>;
	update(input: {
		id: string;
		projectId: string;
		userId: string;
		body: PromptPresetCommandBody;
	}): Promise<PromptPresetSummary | null>;
	archive(input: { id: string; projectId: string }): Promise<boolean>;
};

export class ApplicationPromptPresetService {
	constructor(private readonly repository: PromptPresetRepository) {}

	async list(input: {
		projectId: string;
		includeDisabled?: boolean;
	}): Promise<{ presets: PromptPresetSummary[] }> {
		return {
			presets: await this.repository.list({
				projectId: input.projectId,
				includeDisabled: input.includeDisabled,
			}),
		};
	}

	async create(input: {
		projectId: string;
		userId: string;
		body: PromptPresetCommandBody;
	}): Promise<{ preset: PromptPresetSummary }> {
		return {
			preset: await this.repository.create(input),
		};
	}

	async update(input: {
		id: string;
		projectId: string;
		userId: string;
		body: PromptPresetCommandBody;
	}): Promise<{ preset: PromptPresetSummary } | null> {
		const preset = await this.repository.update(input);
		return preset ? { preset } : null;
	}

	async archive(input: {
		id: string;
		projectId: string;
	}): Promise<{ archived: true } | null> {
		const archived = await this.repository.archive(input);
		return archived ? { archived: true } : null;
	}
}
