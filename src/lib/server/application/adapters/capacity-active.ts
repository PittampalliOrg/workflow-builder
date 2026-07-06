import { and, eq, gte, inArray } from "drizzle-orm";
import type {
	CapacityFleetActivity,
	CapacityFleetActivityItem,
	CapacityFleetActivityPort,
} from "$lib/server/application/capacity-active";
import { db as defaultDb } from "$lib/server/db";
import { sessionEvents, sessions } from "$lib/server/db/schema";

type Database = typeof defaultDb;

const WINDOW_SECONDS = 60;
const BUCKET_SECONDS = 5;
const BUCKETS = WINDOW_SECONDS / BUCKET_SECONDS;

export class SessionFleetActivityAdapter implements CapacityFleetActivityPort {
	constructor(private readonly database: Database = defaultDb) {}

	async summarize(
		items: CapacityFleetActivityItem[],
		projectId?: string | null,
	): Promise<Record<string, CapacityFleetActivity>> {
		const out: Record<string, CapacityFleetActivity> = {};
		const database = this.database;
		if (!database || !projectId || items.length === 0) return out;

		const sessionKeyMap = new Map<string, string>();
		for (const item of items) {
			if (item.kind === "session" || item.kind === "benchmarkInstance") {
				sessionKeyMap.set(item.id, item.key);
			}
		}

		const workflowItems = items.filter((item) => item.kind === "workflowRun");
		if (workflowItems.length > 0) {
			const executionIds = workflowItems.map((item) => item.id);
			const keyByExecutionId = new Map(
				workflowItems.map((item) => [item.id, item.key]),
			);
			const childRows = await database
				.select({ id: sessions.id, executionId: sessions.workflowExecutionId })
				.from(sessions)
				.where(
					and(
						eq(sessions.projectId, projectId),
						inArray(sessions.workflowExecutionId, executionIds),
					),
				);
			for (const row of childRows) {
				const key = row.executionId
					? keyByExecutionId.get(row.executionId)
					: undefined;
				if (key && !sessionKeyMap.has(row.id)) {
					sessionKeyMap.set(row.id, key);
				}
			}
		}

		const sessionIds = [...sessionKeyMap.keys()];
		if (sessionIds.length === 0) return out;

		const windowStartMs = Date.now() - WINDOW_SECONDS * 1000;
		const since = new Date(windowStartMs);
		const eventRows = await database
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

		const activityByKey = new Map<string, { last: number; series: number[] }>();
		for (const row of eventRows) {
			const key = sessionKeyMap.get(row.sessionId);
			if (!key) continue;
			const timestamp = row.createdAt.getTime();
			let activity = activityByKey.get(key);
			if (!activity) {
				activity = { last: 0, series: new Array<number>(BUCKETS).fill(0) };
				activityByKey.set(key, activity);
			}
			if (timestamp > activity.last) activity.last = timestamp;
			const bucket = Math.min(
				BUCKETS - 1,
				Math.max(
					0,
					Math.floor((timestamp - windowStartMs) / (BUCKET_SECONDS * 1000)),
				),
			);
			activity.series[bucket] += 1;
		}

		const tokensByKey = new Map<string, { in: number; out: number }>();
		// Fallback liveness stamp for sessions whose last event predates the 60s
		// activity window (so `activityByKey` has no row): the throttled
		// `last_event_at` column (migration 0095) still reflects when the session
		// was last alive, which the reconciler/UI need to tell "quiet" from "dead".
		const lastEventFallbackByKey = new Map<string, number>();
		const usageRows = await database
			.select({
				id: sessions.id,
				usage: sessions.usage,
				lastEventAt: sessions.lastEventAt,
			})
			.from(sessions)
			.where(inArray(sessions.id, sessionIds));
		for (const row of usageRows) {
			const key = sessionKeyMap.get(row.id);
			if (!key) continue;
			const usage = (row.usage ?? {}) as Record<string, unknown>;
			const tokens = tokensByKey.get(key) ?? { in: 0, out: 0 };
			tokens.in += Number(usage.input_tokens) || 0;
			tokens.out += Number(usage.output_tokens) || 0;
			tokensByKey.set(key, tokens);
			if (row.lastEventAt) {
				const ts = row.lastEventAt.getTime();
				const existing = lastEventFallbackByKey.get(key);
				if (existing === undefined || ts > existing) {
					lastEventFallbackByKey.set(key, ts);
				}
			}
		}

		const emptySeries = () =>
			Array.from({ length: BUCKETS }, (_, index) => ({
				t: new Date(
					windowStartMs + index * BUCKET_SECONDS * 1000,
				).toISOString(),
				value: 0,
			}));

		for (const key of new Set<string>([
			...activityByKey.keys(),
			...tokensByKey.keys(),
			...lastEventFallbackByKey.keys(),
		])) {
			const activity = activityByKey.get(key);
			const tokens = tokensByKey.get(key) ?? { in: 0, out: 0 };
			const fallbackLast = lastEventFallbackByKey.get(key);
			out[key] = {
				lastEventAt: activity?.last
					? new Date(activity.last).toISOString()
					: fallbackLast !== undefined
						? new Date(fallbackLast).toISOString()
						: null,
				recentCount: activity
					? activity.series.reduce((sum, value) => sum + value, 0)
					: 0,
				series: activity
					? activity.series.map((value, index) => ({
							t: new Date(
								windowStartMs + index * BUCKET_SECONDS * 1000,
							).toISOString(),
							value,
						}))
					: emptySeries(),
				tokens: tokens.in + tokens.out,
				tokensIn: tokens.in,
				tokensOut: tokens.out,
			};
		}

		return out;
	}
}
