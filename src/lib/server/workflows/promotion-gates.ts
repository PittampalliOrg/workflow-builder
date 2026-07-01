type JsonRecord = Record<string, unknown>;

export type PromotionGateDecision = {
	required: boolean;
	allowed: boolean;
	reason: string;
	accepted: boolean | null;
	score: number | null;
	minScore: number;
	artifactIteration: number | null;
	acceptedIteration: number | null;
};

export type PromotionGateInput = {
	mode: "pr" | "branch";
	artifactPayload: unknown;
	executionOutput: unknown;
	summaryOutput: unknown;
	minScore?: number;
};

const DEFAULT_MIN_SCORE = 8;

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function normalizeScore(value: unknown): number | null {
	const score = numberOrNull(value);
	if (score == null) return null;
	return score > 10 ? score / 10 : score;
}

function findVerdict(value: unknown, depth = 0): JsonRecord | null {
	if (depth > 8) return null;
	const record = asRecord(value);
	if (!record) return null;
	if ("meets_criteria" in record || "score" in record || "feedback" in record) {
		return record;
	}
	const preferred = ["verdict", "critique", "evaluate", "last", "summary", "data", "as"];
	for (const key of preferred) {
		if (key in record) {
			const found = findVerdict(record[key], depth + 1);
			if (found) return found;
		}
	}
	for (const value of Object.values(record)) {
		const found = findVerdict(value, depth + 1);
		if (found) return found;
	}
	return null;
}

function findAccepted(value: unknown, depth = 0): boolean | null {
	if (depth > 8) return null;
	const record = asRecord(value);
	if (!record) return null;
	if (typeof record.accepted === "boolean") return record.accepted;
	const preferred = ["summary", "data", "as", "loop", "result"];
	for (const key of preferred) {
		if (key in record) {
			const found = findAccepted(record[key], depth + 1);
			if (found != null) return found;
		}
	}
	for (const value of Object.values(record)) {
		const found = findAccepted(value, depth + 1);
		if (found != null) return found;
	}
	return null;
}

function acceptedIteration(value: unknown): number | null {
	const record = asRecord(value);
	if (!record) return null;
	const iterations = numberOrNull(record.iterations);
	if (iterations != null && iterations > 0) return Math.floor(iterations) - 1;
	const loop = asRecord(record.loop);
	const loopIterations = numberOrNull(loop?.iterations);
	return loopIterations != null && loopIterations > 0
		? Math.floor(loopIterations) - 1
		: null;
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateDecision {
	const payload = asRecord(input.artifactPayload);
	const tier = typeof payload?.tier === "string" ? payload.tier : null;
	const artifactIteration = numberOrNull(payload?.iteration);
	const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

	if (input.mode !== "pr" || tier !== "tar-overlay") {
		return {
			required: false,
			allowed: true,
			reason: "not_required",
			accepted: null,
			score: null,
			minScore,
			artifactIteration: artifactIteration == null ? null : Math.floor(artifactIteration),
			acceptedIteration: null,
		};
	}

	const summary = asRecord(input.summaryOutput);
	const output = asRecord(input.executionOutput);
	const verdict = findVerdict(summary) ?? findVerdict(output);
	const accepted = findAccepted(summary) ?? findAccepted(output) ?? (verdict?.meets_criteria === true);
	const score = normalizeScore(verdict?.score);
	const acceptedIter = acceptedIteration(summary) ?? acceptedIteration(output);
	const artifactIter =
		artifactIteration == null ? null : Math.floor(artifactIteration);

	if (accepted !== true) {
		return {
			required: true,
			allowed: false,
			reason: "accepted_false_or_missing",
			accepted: accepted ?? null,
			score,
			minScore,
			artifactIteration: artifactIter,
			acceptedIteration: acceptedIter,
		};
	}
	if (score == null || score < minScore) {
		return {
			required: true,
			allowed: false,
			reason: "score_below_threshold",
			accepted: true,
			score,
			minScore,
			artifactIteration: artifactIter,
			acceptedIteration: acceptedIter,
		};
	}
	if (artifactIter != null && acceptedIter != null && artifactIter !== acceptedIter) {
		return {
			required: true,
			allowed: false,
			reason: "artifact_not_accepted_iteration",
			accepted: true,
			score,
			minScore,
			artifactIteration: artifactIter,
			acceptedIteration: acceptedIter,
		};
	}
	return {
		required: true,
		allowed: true,
		reason: "accepted",
		accepted: true,
		score,
		minScore,
		artifactIteration: artifactIter,
		acceptedIteration: acceptedIter,
	};
}
