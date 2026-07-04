export class ApplicationEvaluationDefinitionError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEvaluationDefinitionError";
	}
}

export type EvaluationDefinitionCreateInput = {
	projectId: string;
	userId: string;
	name: string;
	description: string | null;
	datasetId: string | null;
	taskConfig?: Record<string, unknown>;
	dataSourceConfig?: Record<string, unknown>;
	testingCriteria?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	graders?: unknown[];
};

export type EvaluationDefinitionRepository = {
	list(projectId: string): Promise<unknown[]>;
	get(projectId: string, evaluationId: string): Promise<unknown | null>;
	create(input: EvaluationDefinitionCreateInput): Promise<unknown>;
	update(input: {
		projectId: string;
		evaluationId: string;
		patch: Record<string, unknown>;
	}): Promise<unknown>;
};

export class ApplicationEvaluationDefinitionService {
	constructor(private readonly repository: EvaluationDefinitionRepository) {}

	async list(input: {
		projectId?: string | null;
	}): Promise<{ evaluations: unknown[] }> {
		if (!input.projectId) return { evaluations: [] };
		return {
			evaluations: await this.runRepositoryCall(() =>
				this.repository.list(input.projectId as string),
			),
		};
	}

	async get(input: {
		projectId: string;
		evaluationId: string;
	}): Promise<{ evaluation: unknown | null }> {
		return {
			evaluation: await this.runRepositoryCall(() =>
				this.repository.get(input.projectId, input.evaluationId),
			),
		};
	}

	async create(input: {
		projectId: string;
		userId: string;
		body: unknown;
	}): Promise<{ evaluation: unknown }> {
		const body = asRecord(input.body);
		return {
			evaluation: await this.runRepositoryCall(() =>
				this.repository.create({
					projectId: input.projectId,
					userId: input.userId,
					name: String(body.name ?? ""),
					description:
						typeof body.description === "string" ? body.description : null,
					datasetId: typeof body.datasetId === "string" ? body.datasetId : null,
					taskConfig: asOptionalRecord(body.taskConfig),
					dataSourceConfig: asOptionalRecord(body.dataSourceConfig),
					testingCriteria: asOptionalRecord(body.testingCriteria),
					metadata: asOptionalRecord(body.metadata),
					graders: Array.isArray(body.graders) ? body.graders : undefined,
				}),
			),
		};
	}

	async update(input: {
		projectId: string;
		evaluationId: string;
		body: unknown;
	}): Promise<{ evaluation: unknown }> {
		return {
			evaluation: await this.runRepositoryCall(() =>
				this.repository.update({
					projectId: input.projectId,
					evaluationId: input.evaluationId,
					patch: asRecord(input.body),
				}),
			),
		};
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

function toApplicationError(err: unknown): ApplicationEvaluationDefinitionError {
	if (err instanceof ApplicationEvaluationDefinitionError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEvaluationDefinitionError(status, message);
}
