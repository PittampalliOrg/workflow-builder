// Phase G — scorer runner. Invoked from `recomputeRunSummary` after the
// harness completes. Each scorer is a thin function that consumes the
// benchmark instance row + linked context and emits a 0..1 score plus
// optional reasoning text.
//
// Three starter scorers:
//   - patch_files_overlap_gold (deterministic): re-uses Phase C's
//     patch_files_overlap_gold column. 1.0 if any file overlap, scaled by
//     overlap-fraction otherwise.
//   - edit_minimality (LLM-judge): asks Claude to rate how surgical the
//     agent's patch is. Skipped if ANTHROPIC_API_KEY is missing.
//   - ran_tests_locally (deterministic): scans session_events for
//     `agent.tool_use` events with name='Bash' and arg containing
//     pytest|test_*|nose|unittest. 1.0 if any, else 0.0.
//
// Idempotent: skips per (run_instance_id, scorer_name, scorer_version) if
// already in benchmark_run_instance_scores.

import { and, eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRunInstanceScores,
	benchmarkRunInstances,
	benchmarkRuns,
	sessionEvents,
} from "$lib/server/db/schema";
import { sql } from "drizzle-orm";
import { EDIT_MINIMALITY_PROMPT, REASONING_QUALITY_PROMPT } from "./score-prompts";

export type ScorerName =
	| "patch_files_overlap_gold"
	| "edit_minimality"
	| "ran_tests_locally"
	| "reasoning_quality";

type ScorerResult = {
	score: number;
	reasoning?: string;
	metadata?: Record<string, unknown>;
};

type RunInstanceContext = {
	id: string;
	instanceId: string;
	sessionId: string | null;
	modelPatch: string | null;
	patchFilesTouched: number | null;
	patchFilesOverlapGold: number | null;
	problemStatement: string | null;
	goldPatch: string | null;
};

const SCORER_VERSION_BY_NAME: Record<ScorerName, number> = {
	patch_files_overlap_gold: 1,
	edit_minimality: 1,
	ran_tests_locally: 1,
	reasoning_quality: 1,
};

/**
 * Run all scorers for every instance in the run. Skips instances that
 * already have a score for the given (scorer_name, scorer_version) pair.
 * Failures on individual scorers are logged + skipped (don't block other
 * scorers or other instances).
 */
export async function runScorersForRun(runId: string): Promise<void> {
	if (!db) return;
	const rows = await loadRunContext(runId);
	for (const row of rows) {
		// Deterministic scorers — fast, no LLM cost.
		await tryScorer(row, "patch_files_overlap_gold", scorePatchFilesOverlapGold);
		await tryScorer(row, "ran_tests_locally", scoreRanTestsLocally);
		// LLM-judge scorers — only if API key present.
		if (env.ANTHROPIC_API_KEY && row.modelPatch && row.problemStatement) {
			await tryScorer(row, "edit_minimality", scoreEditMinimality);
			await tryScorer(row, "reasoning_quality", scoreReasoningQuality);
		}
	}
}

async function loadRunContext(runId: string): Promise<RunInstanceContext[]> {
	if (!db) return [];
	const rows = await db
		.select({
			id: benchmarkRunInstances.id,
			instanceId: benchmarkRunInstances.instanceId,
			sessionId: benchmarkRunInstances.sessionId,
			modelPatch: benchmarkRunInstances.modelPatch,
			patchFilesTouched: benchmarkRunInstances.patchFilesTouched,
			patchFilesOverlapGold: benchmarkRunInstances.patchFilesOverlapGold,
			problemStatement: benchmarkInstances.problemStatement,
			goldPatch: benchmarkInstances.goldPatch,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.suiteId, benchmarkRuns.suiteId),
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
			),
		)
		.where(eq(benchmarkRunInstances.runId, runId));
	return rows;
}

async function tryScorer(
	row: RunInstanceContext,
	name: ScorerName,
	fn: (row: RunInstanceContext) => Promise<ScorerResult | null>,
): Promise<void> {
	if (!db) return;
	const version = SCORER_VERSION_BY_NAME[name];
	// Idempotency check.
	const existing = await db
		.select({ id: benchmarkRunInstanceScores.id })
		.from(benchmarkRunInstanceScores)
		.where(
			and(
				eq(benchmarkRunInstanceScores.runInstanceId, row.id),
				eq(benchmarkRunInstanceScores.scorerName, name),
				eq(benchmarkRunInstanceScores.scorerVersion, version),
			),
		)
		.limit(1);
	if (existing.length > 0) return;

	let result: ScorerResult | null = null;
	try {
		result = await fn(row);
	} catch (err) {
		console.warn(
			`[bench-scorer] ${name} failed for instance ${row.instanceId}:`,
			(err as Error)?.message ?? err,
		);
		return;
	}
	if (!result) return;

	try {
		await db.insert(benchmarkRunInstanceScores).values({
			runInstanceId: row.id,
			scorerName: name,
			scorerVersion: version,
			score: result.score,
			reasoning: result.reasoning ?? null,
			metadata: result.metadata ?? {},
		});
	} catch (err) {
		console.warn(
			`[bench-scorer] insert ${name} for ${row.instanceId} failed:`,
			(err as Error)?.message ?? err,
		);
	}
}

/* -------------------------------------------------------------------------- */
/*                           Scorer implementations                            */
/* -------------------------------------------------------------------------- */

async function scorePatchFilesOverlapGold(
	row: RunInstanceContext,
): Promise<ScorerResult | null> {
	const overlap = row.patchFilesOverlapGold;
	const touched = row.patchFilesTouched;
	if (overlap === null || touched === null || touched === 0) return null;
	// Score = overlap / touched (clamped). 1.0 means every file the model
	// changed was also in the gold patch — model didn't sprawl into unrelated
	// files. 0.0 means zero overlap.
	const score = Math.min(1, Math.max(0, overlap / touched));
	return {
		score,
		reasoning: `${overlap} of ${touched} touched file(s) overlap the gold patch`,
		metadata: {
			files_overlap_gold: overlap,
			files_touched: touched,
		},
	};
}

async function scoreRanTestsLocally(
	row: RunInstanceContext,
): Promise<ScorerResult | null> {
	if (!db || !row.sessionId) return null;
	// Look at agent.tool_use events for Bash invocations matching common
	// test runners. Doesn't require the test to have *passed* — just that
	// the agent attempted self-verification.
	const result = await db.execute(sql`
		SELECT COUNT(*)::int AS n
		FROM session_events
		WHERE session_id = ${row.sessionId}
			AND type = 'agent.tool_use'
			AND data->>'name' = 'Bash'
			AND (
				data->'input'->>'command' ~ 'pytest|test_|nose|unittest|python -m test|python test'
				OR data::text ~ 'pytest|test_'
			)
	`);
	// Drizzle returns an array; first row's `n` is the count.
	const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ?? (result as unknown as Array<{ n: number }>);
	const n = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].n) : 0;
	const score = n > 0 ? 1 : 0;
	return {
		score,
		reasoning:
			n > 0
				? `agent ran a test command ${n} time(s) before submitting`
				: "no test execution observed in trace",
		metadata: { test_invocations: n },
	};
}

async function scoreEditMinimality(
	row: RunInstanceContext,
): Promise<ScorerResult | null> {
	if (!row.modelPatch || !row.problemStatement) return null;
	const llm = await callJudge({
		system: EDIT_MINIMALITY_PROMPT.system,
		user: EDIT_MINIMALITY_PROMPT.user({
			instanceId: row.instanceId,
			problemStatement: row.problemStatement,
			modelPatch: row.modelPatch,
			goldPatch: row.goldPatch,
		}),
	});
	if (!llm) return null;
	return {
		score: llm.score,
		reasoning: llm.reasoning,
		metadata: { judge_model: llm.model },
	};
}

async function scoreReasoningQuality(
	row: RunInstanceContext,
): Promise<ScorerResult | null> {
	if (!row.modelPatch || !row.problemStatement) return null;
	const llm = await callJudge({
		system: REASONING_QUALITY_PROMPT.system,
		user: REASONING_QUALITY_PROMPT.user({
			instanceId: row.instanceId,
			problemStatement: row.problemStatement,
			modelPatch: row.modelPatch,
		}),
	});
	if (!llm) return null;
	return {
		score: llm.score,
		reasoning: llm.reasoning,
		metadata: { judge_model: llm.model },
	};
}

/* -------------------------------------------------------------------------- */
/*                              LLM-judge call                                 */
/* -------------------------------------------------------------------------- */

const JUDGE_MODEL = "claude-haiku-4-5";

async function callJudge(params: {
	system: string;
	user: string;
}): Promise<{ score: number; reasoning?: string; model: string } | null> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) return null;
	let response: Response;
	try {
		response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: JUDGE_MODEL,
				max_tokens: 200,
				system: params.system,
				messages: [{ role: "user", content: params.user }],
			}),
		});
	} catch (err) {
		console.warn("[bench-scorer] judge fetch failed:", (err as Error)?.message ?? err);
		return null;
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		console.warn(
			`[bench-scorer] judge returned ${response.status}: ${text.slice(0, 200)}`,
		);
		return null;
	}
	const data = (await response.json().catch(() => null)) as
		| { content?: Array<{ text?: string }> }
		| null;
	const raw = data?.content?.[0]?.text;
	if (!raw) return null;
	// Parse JSON from the response. Tolerate code-fence wrapping.
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]) as { score: unknown; reasoning?: unknown };
		const score = Number(parsed.score);
		if (!Number.isFinite(score)) return null;
		return {
			score: Math.max(0, Math.min(1, score)),
			reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
			model: JUDGE_MODEL,
		};
	} catch {
		return null;
	}
}
