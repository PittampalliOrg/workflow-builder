import {
	PromptPresetValidationError,
	archivePromptPreset,
	createPromptPreset,
	listPromptPresets,
	updatePromptPreset,
} from "$lib/server/prompt-presets";
import {
	ApplicationPromptPresetValidationError,
	type PromptPresetRepository,
} from "$lib/server/application/prompt-presets";

export class LegacyPromptPresetRepository implements PromptPresetRepository {
	async list(input: Parameters<PromptPresetRepository["list"]>[0]) {
		return mapValidationError(() => listPromptPresets(input));
	}

	async create(input: Parameters<PromptPresetRepository["create"]>[0]) {
		return mapValidationError(() => createPromptPreset(input));
	}

	async update(input: Parameters<PromptPresetRepository["update"]>[0]) {
		return mapValidationError(() => updatePromptPreset(input));
	}

	async archive(input: Parameters<PromptPresetRepository["archive"]>[0]) {
		return mapValidationError(() => archivePromptPreset(input));
	}
}

async function mapValidationError<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (err) {
		if (err instanceof PromptPresetValidationError) {
			throw new ApplicationPromptPresetValidationError(err.message);
		}
		throw err;
	}
}
