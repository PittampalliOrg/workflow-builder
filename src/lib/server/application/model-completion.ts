import type {
	ModelCompletionPort,
	ModelCompletionRequest,
	ModelGenerationRequest,
	ModelGenerationResult,
} from "$lib/server/application/ports";

export class ApplicationModelCompletionService {
	constructor(private readonly completion: ModelCompletionPort) {}

	isAvailable(): boolean {
		return this.completion.isAvailable();
	}

	complete(input: ModelCompletionRequest): Promise<string> {
		return this.completion.complete(input);
	}

	generate(input: ModelGenerationRequest): Promise<ModelGenerationResult> {
		return this.completion.generate(input);
	}
}
