import type { PromptPresetSummary } from "$lib/types/prompt-presets";
import type { PromptPresetRef } from "$lib/types/agents";
import {
	type CompiledPromptStack,
	isValidPresetRef,
	resolveCompiledPromptStack,
} from "$lib/server/prompt-presets";

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

export type PromptStackPresetRow = {
	promptId: string;
	version: number;
	messages: unknown;
	promptVersionId?: string | null;
	mlflowUri?: string | null;
};

export type PromptStackPresetReadPort = {
	listPromptStackPresetRows(input: {
		projectId: string;
		promptIds: string[];
	}): Promise<PromptStackPresetRow[]>;
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

export class ApplicationPromptStackCompilerService {
	constructor(private readonly presets: PromptStackPresetReadPort) {}

	async compilePromptStack(
		agentConfig: Record<string, unknown> | null | undefined,
		opts: { projectId: string },
	): Promise<CompiledPromptStack> {
		const empty = emptyPromptStack();
		if (!agentConfig) return empty;
		const staticRefs = Array.isArray(agentConfig.staticPromptPresetRefs)
			? (agentConfig.staticPromptPresetRefs as unknown[]).filter(
					isValidPresetRef,
				)
			: [];
		const dynamicRefs = Array.isArray(agentConfig.dynamicPromptPresetRefs)
			? (agentConfig.dynamicPromptPresetRefs as unknown[]).filter(
					isValidPresetRef,
				)
			: [];
		if (staticRefs.length === 0 && dynamicRefs.length === 0) return empty;

		const rows = await this.presets.listPromptStackPresetRows({
			projectId: opts.projectId,
			promptIds: promptIdsForRefs(staticRefs, dynamicRefs),
		});

		return resolveCompiledPromptStack(
			staticRefs,
			dynamicRefs,
			rows,
			`projectId=${opts.projectId}`,
		);
	}
}

function promptIdsForRefs(
	staticRefs: PromptPresetRef[],
	dynamicRefs: PromptPresetRef[],
): string[] {
	return [...new Set([...staticRefs, ...dynamicRefs].map((ref) => ref.id))];
}

export function emptyPromptStack(): CompiledPromptStack {
	return {
		static: [],
		dynamic: [],
		staticManifest: [],
		dynamicManifest: [],
	};
}
