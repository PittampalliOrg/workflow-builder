export class ApplicationEvaluationRunError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEvaluationRunError";
	}
}

export type EvaluationRunStatusInput =
	| "queued"
	| "running"
	| "grading"
	| "completed"
	| "failed"
	| "cancelled";

export type EvaluationArtifactKindInput =
	| "dataset_import"
	| "generated_output"
	| "grader_result"
	| "external_harness"
	| "logs"
	| "report"
	| "predictions_jsonl";

export type EvaluationRunRepository = {
	getInternalRun(
		runId: string,
		options?: { itemMode?: "summary" | "full" },
	): Promise<unknown | null>;
	markStatus(
		runId: string,
		status: EvaluationRunStatusInput,
		extra: Record<string, unknown>,
	): Promise<unknown | null>;
	recomputeSummary(runId: string): Promise<unknown>;
	recordArtifact(input: {
		runId: string;
		runItemId: string | null;
		kind: EvaluationArtifactKindInput;
		path: string | null;
		content: unknown;
		contentType: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<unknown>;
	gradeRun(projectId: string, runId: string): Promise<unknown>;
	buildPredictionsJsonl(projectId: string, runId: string): Promise<string>;
};

export class ApplicationEvaluationRunService {
	constructor(private readonly repository: EvaluationRunRepository) {}

	async getInternalStatus(input: { runId: string }): Promise<{ run: unknown }> {
		const run = await this.runRepositoryCall(() =>
			this.repository.getInternalRun(input.runId, { itemMode: "summary" }),
		);
		if (!run) {
			throw new ApplicationEvaluationRunError(
				404,
				"Evaluation run not found",
			);
		}
		return { run };
	}

	async markStatus(input: {
		runId: string;
		body: unknown;
	}): Promise<{ success: true; run: unknown }> {
		const body = asRecord(input.body);
		const status = String(body.status ?? "");
		if (!isEvaluationRunStatus(status)) {
			throw new ApplicationEvaluationRunError(
				400,
				"Invalid evaluation run status",
			);
		}
		const extra: Record<string, unknown> = {};
		if (typeof body.error === "string" || body.error === null) {
			extra.error = body.error;
		}
		if (typeof body.coordinatorExecutionId === "string") {
			extra.coordinatorExecutionId = body.coordinatorExecutionId;
		}
		if (isRecord(body.summary)) extra.summary = body.summary;
		if (isRecord(body.usage)) extra.usage = body.usage;
		const run = await this.runRepositoryCall(() =>
			this.repository.markStatus(input.runId, status, extra),
		);
		if (!run) {
			throw new ApplicationEvaluationRunError(
				404,
				"Evaluation run not found",
			);
		}
		await this.runRepositoryCall(() =>
			this.repository.recomputeSummary(input.runId),
		);
		return { success: true, run };
	}

	async recordArtifact(input: {
		runId: string;
		body: unknown;
	}): Promise<{ success: true; artifact: unknown }> {
		const body = asRecord(input.body);
		const kind = String(body.kind ?? "");
		if (!isEvaluationArtifactKind(kind)) {
			throw new ApplicationEvaluationRunError(400, "Invalid artifact kind");
		}
		const artifact = await this.runRepositoryCall(() =>
			this.repository.recordArtifact({
				runId: input.runId,
				runItemId: typeof body.runItemId === "string" ? body.runItemId : null,
				kind,
				path: typeof body.path === "string" ? body.path : null,
				content: body.content,
				contentType:
					typeof body.contentType === "string" ? body.contentType : null,
				metadata: asOptionalRecord(body.metadata),
			}),
		);
		return { success: true, artifact };
	}

	async gradeRun(input: {
		projectId: string;
		runId: string;
	}): Promise<{ run: unknown }> {
		return {
			run: await this.runRepositoryCall(() =>
				this.repository.gradeRun(input.projectId, input.runId),
			),
		};
	}

	async buildPredictionsJsonl(input: {
		projectId: string;
		runId: string;
	}): Promise<string> {
		return this.runRepositoryCall(() =>
			this.repository.buildPredictionsJsonl(input.projectId, input.runId),
		);
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
	return isRecord(value) ? value : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EVALUATION_RUN_STATUSES = new Set<EvaluationRunStatusInput>([
	"queued",
	"running",
	"grading",
	"completed",
	"failed",
	"cancelled",
]);

function isEvaluationRunStatus(status: string): status is EvaluationRunStatusInput {
	return EVALUATION_RUN_STATUSES.has(status as EvaluationRunStatusInput);
}

const EVALUATION_ARTIFACT_KINDS = new Set<EvaluationArtifactKindInput>([
	"dataset_import",
	"generated_output",
	"grader_result",
	"external_harness",
	"logs",
	"report",
	"predictions_jsonl",
]);

function isEvaluationArtifactKind(
	kind: string,
): kind is EvaluationArtifactKindInput {
	return EVALUATION_ARTIFACT_KINDS.has(kind as EvaluationArtifactKindInput);
}

function toApplicationError(err: unknown): ApplicationEvaluationRunError {
	if (err instanceof ApplicationEvaluationRunError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEvaluationRunError(status, message);
}
