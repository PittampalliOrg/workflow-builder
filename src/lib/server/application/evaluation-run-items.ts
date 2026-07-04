export class ApplicationEvaluationRunItemError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEvaluationRunItemError";
	}
}

export type EvaluationRunItemOutputInput = {
	runId: string;
	itemId: string;
	generatedOutput: unknown;
	usage?: Record<string, unknown>;
	traceIds?: string[];
	autoGrade: boolean;
};

export type EvaluationRunItemRepository = {
	getRun(projectId: string, runId: string): Promise<unknown | null>;
	getItem(
		projectId: string,
		runId: string,
		itemId: string,
	): Promise<unknown | null>;
	updateOutput(input: EvaluationRunItemOutputInput): Promise<unknown | null>;
};

export class ApplicationEvaluationRunItemService {
	constructor(private readonly repository: EvaluationRunItemRepository) {}

	async get(input: {
		projectId: string;
		runId: string;
		itemId: string;
	}): Promise<{ item: unknown }> {
		const item = await this.runRepositoryCall(() =>
			this.repository.getItem(input.projectId, input.runId, input.itemId),
		);
		if (!item) {
			throw new ApplicationEvaluationRunItemError(
				404,
				"Evaluation run item not found",
			);
		}
		return { item };
	}

	async updatePublicOutput(input: {
		projectId: string;
		runId: string;
		itemId: string;
		body: unknown;
	}): Promise<{ item: unknown; run: unknown | null }> {
		const run = await this.runRepositoryCall(() =>
			this.repository.getRun(input.projectId, input.runId),
		);
		if (!run) {
			throw new ApplicationEvaluationRunItemError(
				404,
				"Evaluation run not found",
			);
		}
		const item = await this.updateOutput(input.runId, input.itemId, input.body);
		const updatedRun = await this.runRepositoryCall(() =>
			this.repository.getRun(input.projectId, input.runId),
		);
		return { item, run: updatedRun };
	}

	async updateInternalOutput(input: {
		runId: string;
		itemId: string;
		body: unknown;
	}): Promise<{ success: true; item: unknown }> {
		const item = await this.updateOutput(input.runId, input.itemId, input.body);
		return { success: true, item };
	}

	private async updateOutput(
		runId: string,
		itemId: string,
		bodyValue: unknown,
	): Promise<unknown> {
		const body = asRecord(bodyValue);
		const item = await this.runRepositoryCall(() =>
			this.repository.updateOutput({
				runId,
				itemId,
				generatedOutput: body.generatedOutput ?? body.output,
				usage: asOptionalRecord(body.usage),
				traceIds: Array.isArray(body.traceIds)
					? body.traceIds.map((traceId) => String(traceId))
					: undefined,
				autoGrade: body.autoGrade !== false,
			}),
		);
		if (!item) {
			throw new ApplicationEvaluationRunItemError(
				404,
				"Evaluation run item not found",
			);
		}
		return item;
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			throw toApplicationError(err);
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toApplicationError(err: unknown): ApplicationEvaluationRunItemError {
	if (err instanceof ApplicationEvaluationRunItemError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEvaluationRunItemError(status, message);
}
