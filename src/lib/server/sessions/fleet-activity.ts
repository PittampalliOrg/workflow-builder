/**
 * Batched activity summary for the Fleet view — one bounded query that tells
 * each active row whether it is *doing something right now* (a heartbeat + a
 * micro event-rate sparkline), without opening a per-session SSE per row.
 *
 * Activity is sourced from `session_events`: `session` / `benchmarkInstance`
 * items map to their own session; `workflowRun` items map to their child
 * sessions (the agent turns a workflow spawns). The query is bounded to the
 * last WINDOW_SECONDS over the `idx_session_events_created` / `_session`
 * indexes for ONLY the currently-active item set, so it stays cheap when
 * folded into the page's existing 5s poll.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessionEvents, sessions } from "$lib/server/db/schema";

export type FleetActivityItem = { key: string; kind: string; id: string };

export type FleetActivity = {
	/** ISO timestamp of the most recent event in the window, or null. */
	lastEventAt: string | null;
	/** Total events seen in the window. */
	recentCount: number;
	/** Per-bucket event counts, oldest → newest, for a MetricSparkline. */
	series: { t: string; value: number }[];
	/** Cumulative LLM tokens (input+output) for this item — for workflow runs
	 * this is summed across child sessions. A strong "how much work" measure. */
	tokens: number;
	tokensIn: number;
	tokensOut: number;
};

const WINDOW_SECONDS = 60;
const BUCKET_SECONDS = 5;
const BUCKETS = WINDOW_SECONDS / BUCKET_SECONDS; // 12

export async function summarizeFleetActivity(
	items: FleetActivityItem[],
	projectId: string | null | undefined,
): Promise<Record<string, FleetActivity>> {
	const out: Record<string, FleetActivity> = {};
	if (!db || !projectId || items.length === 0) return out;

	// sessionId -> the Fleet item.key it should roll up into.
	const sessionKeyMap = new Map<string, string>();
	for (const i of items) {
		if (i.kind === "session" || i.kind === "benchmarkInstance") {
			sessionKeyMap.set(i.id, i.key);
		}
	}

	// Workflow runs: attribute their child sessions' activity to the run row.
	const workflowItems = items.filter((i) => i.kind === "workflowRun");
	if (workflowItems.length > 0) {
		const execIds = workflowItems.map((i) => i.id);
		const keyByExecId = new Map(workflowItems.map((i) => [i.id, i.key]));
		const childRows = await db
			.select({ id: sessions.id, executionId: sessions.workflowExecutionId })
			.from(sessions)
			.where(
				and(
					eq(sessions.projectId, projectId),
					inArray(sessions.workflowExecutionId, execIds),
				),
			);
		for (const r of childRows) {
			const key = r.executionId ? keyByExecId.get(r.executionId) : undefined;
			// A child session that is ALSO listed as its own Fleet row keeps its own
			// mapping (don't clobber a direct session row with its parent's key).
			if (key && !sessionKeyMap.has(r.id)) sessionKeyMap.set(r.id, key);
		}
	}

	const sessionIds = [...sessionKeyMap.keys()];
	if (sessionIds.length === 0) return out;

	const windowStartMs = Date.now() - WINDOW_SECONDS * 1000;
	const since = new Date(windowStartMs);
	const rows = await db
		.select({
			sessionId: sessionEvents.sessionId,
			createdAt: sessionEvents.createdAt,
		})
		.from(sessionEvents)
		.where(
			and(
				inArray(sessionEvents.sessionId, sessionIds),
				gte(sessionEvents.createdAt, since),
			),
		);

	const acc = new Map<string, { last: number; series: number[] }>();
	for (const r of rows) {
		const key = sessionKeyMap.get(r.sessionId);
		if (!key) continue;
		const ts = r.createdAt.getTime();
		let a = acc.get(key);
		if (!a) {
			a = { last: 0, series: new Array<number>(BUCKETS).fill(0) };
			acc.set(key, a);
		}
		if (ts > a.last) a.last = ts;
		const bucket = Math.min(
			BUCKETS - 1,
			Math.max(0, Math.floor((ts - windowStartMs) / (BUCKET_SECONDS * 1000))),
		);
		a.series[bucket] += 1;
	}

	// Cumulative tokens per item from the session usage rollup — for workflow
	// runs this sums across their child sessions. A small separate read so a
	// quiet-but-token-heavy item still reports tokens with no recent events.
	const tokensByKey = new Map<string, { in: number; out: number }>();
	const usageRows = await db
		.select({ id: sessions.id, usage: sessions.usage })
		.from(sessions)
		.where(inArray(sessions.id, sessionIds));
	for (const r of usageRows) {
		const key = sessionKeyMap.get(r.id);
		if (!key) continue;
		const u = (r.usage ?? {}) as Record<string, unknown>;
		const t = tokensByKey.get(key) ?? { in: 0, out: 0 };
		t.in += Number(u.input_tokens) || 0;
		t.out += Number(u.output_tokens) || 0;
		tokensByKey.set(key, t);
	}

	const emptySeries = () =>
		Array.from({ length: BUCKETS }, (_, i) => ({
			t: new Date(windowStartMs + i * BUCKET_SECONDS * 1000).toISOString(),
			value: 0,
		}));

	for (const key of new Set<string>([...acc.keys(), ...tokensByKey.keys()])) {
		const a = acc.get(key);
		const tok = tokensByKey.get(key) ?? { in: 0, out: 0 };
		out[key] = {
			lastEventAt: a?.last ? new Date(a.last).toISOString() : null,
			recentCount: a ? a.series.reduce((s, v) => s + v, 0) : 0,
			series: a
				? a.series.map((value, i) => ({
						t: new Date(windowStartMs + i * BUCKET_SECONDS * 1000).toISOString(),
						value,
					}))
				: emptySeries(),
			tokens: tok.in + tok.out,
			tokensIn: tok.in,
			tokensOut: tok.out,
		};
	}
	return out;
}
