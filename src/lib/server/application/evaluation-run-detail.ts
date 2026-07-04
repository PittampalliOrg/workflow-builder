export type EvaluationRunDetail = Record<string, unknown>;

export type EvaluationRunItemMode = "full" | "summary";

export type EvaluationRunDetailReadPort = {
	getRun(
		projectId: string,
		runId: string,
		options: { itemMode: EvaluationRunItemMode },
	): Promise<EvaluationRunDetail | null>;
};

export type EvaluationRunDetailResult =
	| { status: "ok"; body: { run: EvaluationRunDetail } }
	| { status: "not_found"; message: string };

export class ApplicationEvaluationRunDetailService {
	constructor(private readonly readModel: EvaluationRunDetailReadPort) {}

	async getRun(input: {
		projectId?: string | null;
		runId: string;
		itemMode: EvaluationRunItemMode;
	}): Promise<EvaluationRunDetailResult> {
		if (!input.projectId) return evaluationRunNotFound();

		const run = await this.readModel.getRun(input.projectId, input.runId, {
			itemMode: input.itemMode,
		});
		if (!run) return evaluationRunNotFound();

		return { status: "ok", body: { run } };
	}
}

function evaluationRunNotFound(): EvaluationRunDetailResult {
	return { status: "not_found", message: "Evaluation run not found" };
}
