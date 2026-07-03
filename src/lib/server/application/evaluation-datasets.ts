export class ApplicationEvaluationDatasetError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEvaluationDatasetError";
	}
}

export type EvaluationDatasetCreateInput = {
	projectId: string;
	userId: string;
	name: string;
	description: string | null;
	sourceType: string | null;
	sourceUrl: string | null;
	schema?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	rows: unknown[];
};

export type EvaluationDatasetRepository = {
	list(projectId: string): Promise<unknown[]>;
	get(projectId: string, datasetId: string, limit?: number): Promise<unknown>;
	create(input: EvaluationDatasetCreateInput): Promise<unknown>;
	update(
		projectId: string,
		datasetId: string,
		patch: Record<string, unknown>,
	): Promise<unknown>;
	createRows(
		projectId: string,
		datasetId: string,
		rows: unknown[],
	): Promise<unknown[]>;
	updateRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
		patch: Record<string, unknown>;
	}): Promise<unknown>;
	deleteRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
	}): Promise<unknown>;
};

export class ApplicationEvaluationDatasetService {
	constructor(private readonly repository: EvaluationDatasetRepository) {}

	async list(input: { projectId?: string | null }): Promise<{ datasets: unknown[] }> {
		if (!input.projectId) return { datasets: [] };
		return {
			datasets: await this.runRepositoryCall(() =>
				this.repository.list(input.projectId as string),
			),
		};
	}

	async create(input: {
		projectId: string;
		userId: string;
		body: unknown;
	}): Promise<{ dataset: unknown }> {
		const body = asRecord(input.body);
		return {
			dataset: await this.runRepositoryCall(() =>
				this.repository.create({
					projectId: input.projectId,
					userId: input.userId,
					name: String(body.name ?? ""),
					description:
						typeof body.description === "string" ? body.description : null,
					sourceType: typeof body.sourceType === "string" ? body.sourceType : null,
					sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
					schema: asOptionalRecord(body.schema),
					metadata: asOptionalRecord(body.metadata),
					rows: Array.isArray(body.rows) ? body.rows : [],
				}),
			),
		};
	}

	async get(input: {
		projectId: string;
		datasetId: string;
		limitParam?: string | null;
	}): Promise<{ dataset: unknown }> {
		return {
			dataset: await this.runRepositoryCall(() =>
				this.repository.get(
					input.projectId,
					input.datasetId,
					parseLimit(input.limitParam),
				),
			),
		};
	}

	async update(input: {
		projectId: string;
		datasetId: string;
		body: unknown;
	}): Promise<{ dataset: unknown }> {
		return {
			dataset: await this.runRepositoryCall(() =>
				this.repository.update(
					input.projectId,
					input.datasetId,
					asRecord(input.body),
				),
			),
		};
	}

	async listRows(input: {
		projectId: string;
		datasetId: string;
		limitParam?: string | null;
	}): Promise<{ rows: unknown[] }> {
		const dataset = await this.runRepositoryCall(() =>
			this.repository.get(
				input.projectId,
				input.datasetId,
				parseLimit(input.limitParam),
			),
		);
		return {
			rows:
				isRecord(dataset) && Array.isArray(dataset.rows)
					? dataset.rows
					: [],
		};
	}

	async createRows(input: {
		projectId: string;
		datasetId: string;
		body: unknown;
	}): Promise<{ rows: unknown[] }> {
		return {
			rows: await this.runRepositoryCall(() =>
				this.repository.createRows(
					input.projectId,
					input.datasetId,
					Array.isArray(input.body) ? input.body : [input.body],
				),
			),
		};
	}

	async updateRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
		body: unknown;
	}): Promise<{ row: unknown }> {
		return {
			row: await this.runRepositoryCall(() =>
				this.repository.updateRow({
					projectId: input.projectId,
					datasetId: input.datasetId,
					rowId: input.rowId,
					patch: asRecord(input.body),
				}),
			),
		};
	}

	async deleteRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
	}): Promise<unknown> {
		return this.runRepositoryCall(() => this.repository.deleteRow(input));
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			throw toApplicationError(err);
		}
	}
}

function parseLimit(value: string | null | undefined): number {
	const limit = Number.parseInt(value ?? "500", 10);
	return Number.isFinite(limit) ? limit : 500;
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

function toApplicationError(err: unknown): ApplicationEvaluationDatasetError {
	if (err instanceof ApplicationEvaluationDatasetError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEvaluationDatasetError(status, message);
}
