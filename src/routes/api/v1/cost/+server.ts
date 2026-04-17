import { error, json } from "@sveltejs/kit";
import { sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { costFor, MODEL_PRICING } from "$lib/server/pricing/model-pricing";

/**
 * Cost aggregation for a time range. Pricing comes from MODEL_PRICING;
 * per-session usage is read from `sessions.usage`. Returns total cost +
 * breakdowns by model and by agent. The `api_key` query param is accepted
 * but currently a no-op: sessions are not yet tagged with api_key_id.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const now = new Date();
	const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const start = url.searchParams.get("start")
		? new Date(url.searchParams.get("start") as string)
		: defaultStart;
	const end = url.searchParams.get("end")
		? new Date(url.searchParams.get("end") as string)
		: now;

	type Row = {
		agent_id: string;
		model_spec: string | null;
		agent_name: string | null;
		sessions: number;
		input_tokens: number;
		output_tokens: number;
		cache_read: number;
		cache_create: number;
	};

	const rows = await db.execute<Row>(sql`
		SELECT
			s.agent_id AS agent_id,
			coalesce(av.config->>'modelSpec', 'unknown') AS model_spec,
			a.name AS agent_name,
			count(*) AS sessions,
			coalesce(sum((s.usage->>'input_tokens')::int), 0) AS input_tokens,
			coalesce(sum((s.usage->>'output_tokens')::int), 0) AS output_tokens,
			coalesce(sum((s.usage->>'cache_read_input_tokens')::int), 0) AS cache_read,
			coalesce(sum((s.usage->>'cache_creation_input_tokens')::int), 0) AS cache_create
		FROM sessions s
		LEFT JOIN agents a ON a.id = s.agent_id
		LEFT JOIN agent_versions av ON av.agent_id = s.agent_id AND av.version = s.agent_version
		WHERE s.user_id = ${locals.session.userId}
			AND s.created_at >= ${start.toISOString()}
			AND s.created_at <= ${end.toISOString()}
		GROUP BY s.agent_id, av.config->>'modelSpec', a.name
	`);

	let totalCost = 0;
	const byAgent = new Map<
		string,
		{ agentId: string; agentName: string; sessions: number; cost: number }
	>();
	const byModel = new Map<
		string,
		{ model: string; sessions: number; inputTokens: number; outputTokens: number; cost: number }
	>();

	for (const row of rows) {
		const usage = {
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read),
			cacheCreateTokens: Number(row.cache_create),
		};
		const rowCost = costFor(row.model_spec, usage);
		totalCost += rowCost;

		const agentKey = row.agent_id;
		const agentEntry = byAgent.get(agentKey) ?? {
			agentId: row.agent_id,
			agentName: row.agent_name ?? row.agent_id,
			sessions: 0,
			cost: 0,
		};
		agentEntry.sessions += Number(row.sessions);
		agentEntry.cost += rowCost;
		byAgent.set(agentKey, agentEntry);

		const modelKey = row.model_spec ?? "unknown";
		const modelEntry = byModel.get(modelKey) ?? {
			model: modelKey,
			sessions: 0,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
		};
		modelEntry.sessions += Number(row.sessions);
		modelEntry.inputTokens += usage.inputTokens;
		modelEntry.outputTokens += usage.outputTokens;
		modelEntry.cost += rowCost;
		byModel.set(modelKey, modelEntry);
	}

	return json({
		range: { start: start.toISOString(), end: end.toISOString() },
		totalCost,
		priceBook: Object.entries(MODEL_PRICING).map(([model, p]) => ({
			model,
			inputPerMillion: p.inputPerMillion,
			outputPerMillion: p.outputPerMillion,
		})),
		byAgent: [...byAgent.values()].sort((a, b) => b.cost - a.cost),
		byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
	});
};
