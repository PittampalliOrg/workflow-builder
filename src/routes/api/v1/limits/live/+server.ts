import { error, json } from "@sveltejs/kit";
import { sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";

/**
 * GET /api/v1/limits/live
 *
 * Live consumption snapshot for the active workspace. We don't enforce
 * rate limits locally — that's the provider's job — but we can surface
 * the same numbers the limits page already shows as static text, which
 * gives operators a "how close am I to the ceiling right now" view.
 *
 * Shape:
 *   {
 *     activeSessions: number,
 *     byModel: [{ model, sessionsLastHour, tokensInLastHour,
 *                 tokensOutLastHour, tokensInLastMinute,
 *                 tokensOutLastMinute }]
 *   }
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const scopeClause = locals.session.projectId
		? sql`s.project_id = ${locals.session.projectId}`
		: sql`s.user_id = ${locals.session.userId}`;

	// Active sessions (status = 'running')
	const [active] = await db.execute<{ n: number }>(sql`
		SELECT count(*)::int AS n
		FROM sessions s
		WHERE ${scopeClause} AND s.status = 'running'
	`);

	// Per-model aggregates: join agent_versions to recover the model_spec.
	// Sessions in the last hour + output tokens in last minute / last hour.
	const rows = await db.execute<{
		model: string;
		sessions_last_hour: number;
		tokens_in_last_hour: number;
		tokens_out_last_hour: number;
		tokens_in_last_minute: number;
		tokens_out_last_minute: number;
	}>(sql`
		SELECT
			coalesce(av.config->>'modelSpec', 'unknown') AS model,
			count(*) FILTER (WHERE s.created_at > now() - interval '1 hour')::int
				AS sessions_last_hour,
			coalesce(sum((s.usage->>'input_tokens')::int)
				FILTER (WHERE s.updated_at > now() - interval '1 hour'), 0)::int
				AS tokens_in_last_hour,
			coalesce(sum((s.usage->>'output_tokens')::int)
				FILTER (WHERE s.updated_at > now() - interval '1 hour'), 0)::int
				AS tokens_out_last_hour,
			coalesce(sum((s.usage->>'input_tokens')::int)
				FILTER (WHERE s.updated_at > now() - interval '1 minute'), 0)::int
				AS tokens_in_last_minute,
			coalesce(sum((s.usage->>'output_tokens')::int)
				FILTER (WHERE s.updated_at > now() - interval '1 minute'), 0)::int
				AS tokens_out_last_minute
		FROM sessions s
		LEFT JOIN agent_versions av ON av.agent_id = s.agent_id AND av.version = s.agent_version
		WHERE ${scopeClause}
			AND s.created_at > now() - interval '2 hours'
		GROUP BY av.config->>'modelSpec'
		ORDER BY sessions_last_hour DESC
	`);

	return json({
		activeSessions: Number(active?.n ?? 0),
		byModel: rows.map((row) => ({
			model: String(row.model),
			sessionsLastHour: Number(row.sessions_last_hour),
			tokensInLastHour: Number(row.tokens_in_last_hour),
			tokensOutLastHour: Number(row.tokens_out_last_hour),
			tokensInLastMinute: Number(row.tokens_in_last_minute),
			tokensOutLastMinute: Number(row.tokens_out_last_minute),
		})),
		asOf: new Date().toISOString(),
	});
};
