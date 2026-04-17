import { error, json } from "@sveltejs/kit";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { sessions, sessionEvents } from "$lib/server/db/schema";

/**
 * Usage analytics for a time range. Mirrors CMA's Usage page data shape:
 * total tokens in/out, per-day stacked bars, per-agent breakdown.
 *
 * Query params: ?start=ISO&end=ISO&groupBy=agent|day (default: day)
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const now = new Date();
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const start = url.searchParams.get("start")
		? new Date(url.searchParams.get("start") as string)
		: monthStart;
	const end = url.searchParams.get("end")
		? new Date(url.searchParams.get("end") as string)
		: now;
	const groupBy = url.searchParams.get("groupBy") ?? "day";

	const filters = and(
		eq(sessions.userId, locals.session.userId),
		sql`${sessions.createdAt} >= ${start.toISOString()}`,
		sql`${sessions.createdAt} <= ${end.toISOString()}`,
	);

	// Totals for the top-stat row
	const [totals] = await db
		.select({
			tokensIn: sql<number>`coalesce(sum((usage->>'input_tokens')::int), 0)`,
			tokensOut: sql<number>`coalesce(sum((usage->>'output_tokens')::int), 0)`,
			cacheRead: sql<number>`coalesce(sum((usage->>'cache_read_input_tokens')::int), 0)`,
			cacheCreate: sql<number>`coalesce(sum((usage->>'cache_creation_input_tokens')::int), 0)`,
			sessionCount: sql<number>`count(*)`,
		})
		.from(sessions)
		.where(filters);

	// Daily breakdown (one row per day in range, zero-filled via SQL series)
	const daily = await db.execute<{
		day: string;
		tokens_in: number;
		tokens_out: number;
	}>(sql`
		WITH days AS (
			SELECT generate_series(${start.toISOString()}::date, ${end.toISOString()}::date, '1 day'::interval)::date AS day
		)
		SELECT
			days.day::text AS day,
			coalesce(sum((s.usage->>'input_tokens')::int), 0) AS tokens_in,
			coalesce(sum((s.usage->>'output_tokens')::int), 0) AS tokens_out
		FROM days
		LEFT JOIN ${sessions} s
			ON s.user_id = ${locals.session.userId}
			AND date(s.created_at) = days.day
		GROUP BY days.day
		ORDER BY days.day ASC
	`);

	// Breakdown by agent
	const byAgent = await db.execute<{
		agent_id: string;
		tokens_in: number;
		tokens_out: number;
		sessions: number;
	}>(sql`
		SELECT
			s.agent_id AS agent_id,
			coalesce(sum((s.usage->>'input_tokens')::int), 0) AS tokens_in,
			coalesce(sum((s.usage->>'output_tokens')::int), 0) AS tokens_out,
			count(*) AS sessions
		FROM ${sessions} s
		WHERE s.user_id = ${locals.session.userId}
			AND s.created_at >= ${start.toISOString()}
			AND s.created_at <= ${end.toISOString()}
		GROUP BY s.agent_id
		ORDER BY tokens_out DESC
		LIMIT 20
	`);

	// Tool-call count (from session_events where type starts with "agent.tool_use")
	const [toolCalls] = await db
		.select({
			count: sql<number>`count(*)`,
		})
		.from(sessionEvents)
		.where(
			sql`${sessionEvents.type} IN ('agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use')
					AND ${sessionEvents.createdAt} >= ${start.toISOString()}
					AND ${sessionEvents.createdAt} <= ${end.toISOString()}`,
		);

	return json({
		range: { start: start.toISOString(), end: end.toISOString() },
		groupBy,
		totals: {
			tokensIn: Number(totals?.tokensIn ?? 0),
			tokensOut: Number(totals?.tokensOut ?? 0),
			cacheReadTokens: Number(totals?.cacheRead ?? 0),
			cacheCreateTokens: Number(totals?.cacheCreate ?? 0),
			sessionCount: Number(totals?.sessionCount ?? 0),
			toolCalls: Number(toolCalls?.count ?? 0),
		},
		daily: daily.map((row) => ({
			day: String(row.day),
			tokensIn: Number(row.tokens_in),
			tokensOut: Number(row.tokens_out),
		})),
		byAgent: byAgent.map((row) => ({
			agentId: String(row.agent_id),
			tokensIn: Number(row.tokens_in),
			tokensOut: Number(row.tokens_out),
			sessions: Number(row.sessions),
		})),
	});
};
