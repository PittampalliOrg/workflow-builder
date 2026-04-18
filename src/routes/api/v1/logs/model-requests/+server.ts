import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { queryClickHouse, CLICKHOUSE_DB } from "$lib/server/otel/clickhouse";

/**
 * GET /api/v1/logs/model-requests
 *
 * Return recent model-request spans (one per LLM call) from ClickHouse.
 * Matches CMA's Logs page — each row is a `POST /v1/messages`-style call.
 *
 * Scope: today returns the 100 most recent spans across the cluster. A
 * future revision can filter by span attribute `session.id` to scope to
 * the caller's active workspace, once the exporter consistently stamps
 * it (we already filter the traces endpoint that way).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
	const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100;

	try {
		const rows = await queryClickHouse(`
			SELECT
				TraceId,
				SpanId,
				Timestamp,
				SpanName,
				ServiceName,
				Duration / 1e6 AS DurationMs,
				SpanAttributes['model'] AS Model,
				SpanAttributes['request.id'] AS RequestId,
				SpanAttributes['query_source'] AS QuerySource,
				SpanAttributes['llm_request.context'] AS Context,
				SpanAttributes['service_tier'] AS ServiceTier,
				SpanAttributes['input_tokens'] AS InputTokens,
				SpanAttributes['output_tokens'] AS OutputTokens,
				SpanAttributes['success'] AS Success,
				StatusCode
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE SpanName IN (
				'claude_code.llm_request',
				'dapr-agent-py.call_llm',
				'span.model_request_start',
				'span.model_request_end',
				'anthropic.messages.create'
			) AND Timestamp > now() - INTERVAL 7 DAY
			ORDER BY Timestamp DESC
			LIMIT ${safeLimit}
		`);

		const logs = rows.map((r) => ({
			timestamp: String(r.Timestamp),
			traceId: String(r.TraceId),
			spanId: String(r.SpanId),
			requestId: r.RequestId ? String(r.RequestId) : String(r.SpanId),
			model: r.Model ? String(r.Model) : null,
			sessionId: null,
			type: r.Context ? String(r.Context) : "Streaming",
			serviceTier: r.ServiceTier ? String(r.ServiceTier) : "Standard",
			inputTokens: r.InputTokens ? Number(r.InputTokens) : null,
			outputTokens: r.OutputTokens ? Number(r.OutputTokens) : null,
			durationMs: Math.round(Number(r.DurationMs ?? 0)),
			status:
				(r.StatusCode as string) === "Error" || r.Success === "false"
					? "error"
					: "ok",
		}));

		return json({ logs, asOf: new Date().toISOString() });
	} catch (err) {
		return json(
			{
				logs: [],
				error:
					err instanceof Error ? err.message : "ClickHouse query failed",
				asOf: new Date().toISOString(),
			},
			{ status: 200 },
		);
	}
};
