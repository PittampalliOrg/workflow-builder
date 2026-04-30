/**
 * Aggregate workflow metrics for the admin dashboard.
 *
 * Reads directly from Postgres (workflow_executions + session_events +
 * sessions). No metrics-server / Mimir / Prometheus dependency — the data
 * we need is already produced by Slice 1 instrumentation:
 *   - agent.llm_usage events carry input_tokens / output_tokens / cache_*
 *   - workflow_executions carries status + started_at / completed_at
 *   - sessions carries status + agent_id
 *
 * Polled every ~5 s by the dashboard page; query cost is bounded by the
 * partial indexes on (status), (created_at), and (session_id, type).
 */

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db";

export interface AggregateMetricsSnapshot {
	ts: string;
	/** Workflow execution counts in the last hour, keyed by status. */
	workflows: {
		running: number;
		success: number;
		error: number;
		cancelled: number;
		pending: number;
		failuresLast5Min: number;
	};
	sessions: {
		running: number;
		idle: number;
		rescheduling: number;
		terminated: number;
		uniqueActiveAgents: number;
	};
	/**
	 * Token usage rolled up across every agent.llm_usage event.
	 * lastHour: cumulative since (now() - 1h).
	 * lastMinute: same window scoped to 1m for the rate gauge.
	 */
	tokens: {
		lastHour: TokenWindow;
		lastMinute: TokenWindow;
		/** Tokens (input+output) per second averaged over last minute. */
		ratePerSec: number;
	};
	/** Number of agent.tool_use events seen in the last hour. */
	toolCallsLastHour: number;
}

export interface TokenWindow {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	total: number;
}

function num(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export async function getAggregateMetrics(): Promise<AggregateMetricsSnapshot> {
	if (!db) {
		throw new Error("Database not configured");
	}

	const [workflowsRow, sessionsRow, tokensHourRow, tokensMinuteRow, toolCallsRow] =
		await Promise.all([
			db.execute(sql`
				SELECT
					count(*) FILTER (WHERE status = 'running')                                AS running,
					count(*) FILTER (WHERE status = 'success')                                AS success,
					count(*) FILTER (WHERE status = 'error')                                  AS error,
					count(*) FILTER (WHERE status = 'cancelled')                              AS cancelled,
					count(*) FILTER (WHERE status = 'pending')                                AS pending,
					count(*) FILTER (WHERE status = 'error' AND completed_at > now() - interval '5 minutes') AS failures_5min
				FROM workflow_executions
				WHERE started_at > now() - interval '1 hour' OR status IN ('running', 'pending')
			`),
			db.execute(sql`
				SELECT
					count(*) FILTER (WHERE status = 'running')      AS running,
					count(*) FILTER (WHERE status = 'idle')         AS idle,
					count(*) FILTER (WHERE status = 'rescheduling') AS rescheduling,
					count(*) FILTER (WHERE status = 'terminated')   AS terminated,
					count(DISTINCT agent_id) FILTER (WHERE status IN ('running', 'rescheduling')) AS unique_active_agents
				FROM sessions
				WHERE updated_at > now() - interval '1 hour'
					OR status IN ('running', 'rescheduling')
			`),
			tokenWindow("1 hour"),
			tokenWindow("1 minute"),
			db.execute(sql`
				SELECT count(*)::bigint AS n
				FROM session_events
				WHERE type IN ('agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use')
					AND created_at > now() - interval '1 hour'
			`),
		]);

	const wf = (workflowsRow[0] ?? {}) as Record<string, unknown>;
	const ss = (sessionsRow[0] ?? {}) as Record<string, unknown>;
	const tcLastHour = num(((toolCallsRow[0] ?? {}) as Record<string, unknown>).n);

	const lastHour = tokensHourRow;
	const lastMinute = tokensMinuteRow;

	return {
		ts: new Date().toISOString(),
		workflows: {
			running: num(wf.running),
			success: num(wf.success),
			error: num(wf.error),
			cancelled: num(wf.cancelled),
			pending: num(wf.pending),
			failuresLast5Min: num(wf.failures_5min),
		},
		sessions: {
			running: num(ss.running),
			idle: num(ss.idle),
			rescheduling: num(ss.rescheduling),
			terminated: num(ss.terminated),
			uniqueActiveAgents: num(ss.unique_active_agents),
		},
		tokens: {
			lastHour,
			lastMinute,
			ratePerSec: Math.round((lastMinute.input + lastMinute.output) / 60),
		},
		toolCallsLastHour: tcLastHour,
	};
}

async function tokenWindow(interval: "1 hour" | "1 minute"): Promise<TokenWindow> {
	if (!db) throw new Error("Database not configured");
	const intervalSql =
		interval === "1 hour" ? sql`interval '1 hour'` : sql`interval '1 minute'`;
	const result = await db.execute(sql`
		SELECT
			coalesce(sum((data->>'input_tokens')::bigint), 0)               AS input,
			coalesce(sum((data->>'output_tokens')::bigint), 0)              AS output,
			coalesce(sum((data->>'cache_read_input_tokens')::bigint), 0)    AS cache_read,
			coalesce(sum((data->>'cache_creation_input_tokens')::bigint), 0) AS cache_creation
		FROM session_events
		WHERE type = 'agent.llm_usage'
			AND created_at > now() - ${intervalSql}
	`);
	const row = (result[0] ?? {}) as Record<string, unknown>;
	const input = num(row.input);
	const output = num(row.output);
	const cacheRead = num(row.cache_read);
	const cacheCreation = num(row.cache_creation);
	return {
		input,
		output,
		cacheRead,
		cacheCreation,
		total: input + output + cacheRead + cacheCreation,
	};
}
