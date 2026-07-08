/**
 * Run-digest contract — the deterministic "what happened" summary of a
 * workflow run. Shared boundary type: produced server-side
 * (src/lib/server/observability/run-digest.ts), consumed by the digest card,
 * the issues rail, and the trace-analyst tools.
 */

export type RunIssueKind = 'run_error' | 'call_error' | 'call_retries' | 'span_error';

export type RunIssue = {
	kind: RunIssueKind;
	/** Short human summary ("judge failed", "3 retries on pro"). */
	label: string;
	detail: string | null;
	/** Graph node to select (journal callId) when the issue maps to a call. */
	callId: string | null;
	spanId: string | null;
	traceId: string | null;
	/** Failure ancestry root→leaf (first span error only): the causal path. */
	chain?: { name: string; service: string; spanId: string }[];
};

export type RunDigestPhase = {
	title: string;
	calls: number;
	done: number;
	errors: number;
	running: number;
	durationMs: number;
	tokens: number;
	costUsd: number;
};

export type RunDigest = {
	executionId: string;
	status: string;
	startedAt: string | null;
	completedAt: string | null;
	wallClockMs: number | null;
	totals: {
		calls: number;
		sessions: number;
		llmCalls: number;
		tokensIn: number;
		tokensOut: number;
		cacheRead: number;
		cacheCreation: number;
		tokens: number;
		costUsd: number;
		/** cacheRead / (cacheRead + tokensIn); null when no input observed. */
		cacheHitRate: number | null;
	};
	phases: RunDigestPhase[];
	criticalPath: {
		labels: string[];
		ids: string[];
		durationMs: number;
		/** Share of wall-clock the critical path explains (null while running). */
		pctOfWallClock: number | null;
	} | null;
	budget: { total: number; spentTokens: number } | null;
	issues: RunIssue[];
};
