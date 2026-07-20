import type { ModelCompletionPort } from "$lib/server/application/ports";

export type EvaluationJudgeRequest = {
	prompt: string;
	name?: string | null;
	abortSignal?: AbortSignal;
};

export type EvaluationJudgeResult = {
	model: string;
	score: number;
	rationale: string | null;
	raw: Record<string, unknown>;
};

export type EvaluationJudge = {
	isAvailable(): boolean;
	judge(input: EvaluationJudgeRequest): Promise<EvaluationJudgeResult>;
};

type EvaluationJudgeOptions = {
	modelName?: string;
};

/** Application-owned LLM judge use case backed by the configured model port. */
export class ApplicationEvaluationJudgeService implements EvaluationJudge {
	private readonly modelName: string;

	constructor(
		private readonly completion: Pick<ModelCompletionPort, "isAvailable" | "complete">,
		options: EvaluationJudgeOptions = {},
	) {
		this.modelName = options.modelName?.trim() || "default";
	}

	isAvailable(): boolean {
		return this.completion.isAvailable();
	}

	async judge(input: EvaluationJudgeRequest): Promise<EvaluationJudgeResult> {
		if (!this.isAvailable()) {
			throw new Error("Evaluation judge model is unavailable");
		}
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("Evaluation judge prompt is required");

		const text = await this.completion.complete({
			messages: [
				{
					role: "system",
					content:
						"Evaluate the supplied response against the rubric. Return one JSON object with score (a number from 0 to 1), verdict (GOOD or BAD), and rationale (a concise string).",
				},
				{
					role: "user",
					content: input.name?.trim()
						? `Evaluation: ${input.name.trim()}\n\n${prompt}`
						: prompt,
				},
			],
			maxOutputTokens: 1_024,
			responseFormat: { type: "json_object" },
			abortSignal: input.abortSignal,
		});
		const raw = parseJudgeObject(text);
		const score = judgeScore(raw);
		if (score == null) {
			throw new Error("Evaluation judge returned no valid score or verdict");
		}
		return {
			model: this.modelName,
			score,
			rationale: judgeRationale(raw),
			raw,
		};
	}
}

function parseJudgeObject(value: string): Record<string, unknown> {
	const trimmed = value.trim();
	const unfenced = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	try {
		const parsed = JSON.parse(unfenced) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// The model port requested JSON; expose a stable application error below.
	}
	throw new Error("Evaluation judge returned invalid JSON");
}

function judgeScore(value: Record<string, unknown>): number | null {
	if (typeof value.score === "number" && Number.isFinite(value.score)) {
		return Math.min(1, Math.max(0, value.score));
	}
	const verdict = String(value.verdict ?? value.result ?? "").trim().toUpperCase();
	if (verdict === "GOOD" || verdict === "PASS" || verdict === "PASSED") return 1;
	if (verdict === "BAD" || verdict === "FAIL" || verdict === "FAILED") return 0;
	return null;
}

function judgeRationale(value: Record<string, unknown>): string | null {
	for (const candidate of [value.rationale, value.reasoning, value.explanation]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return null;
}
