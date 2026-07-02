import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { AgentConfig } from "$lib/types/agents";

/**
 * Fork a session from a specific event sequence. Creates a fresh session row
 * against the same agent + environment + vaults, then replays all events up
 * to (and including) `fromSequence` into the new session's event log so the
 * timeline reads identically up to the fork point.
 *
 * The new session starts in `rescheduling` status. The caller (UI) typically
 * opens the new session detail page; it will transition to `running` when
 * the agent picks up the replayed user.message / tool_result queue.
 *
 * Body:
 *   { fromSequence: number, title?: string, agentConfig? }
 *
 * If `agentConfig` is present AND it differs from the resolved source
 * session's agent config, the fork is pointed at a `session-experiment`
 * ephemeral agent instead of inheriting the source's agent. The event-replay
 * logic is unchanged; only the new session row's agentId/agentVersion swap.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const fromSequence = Number(body.fromSequence);
	if (!Number.isFinite(fromSequence) || fromSequence < 1) {
		return error(400, "fromSequence must be a positive integer");
	}
	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title.trim()
			: null;

	const tweakedConfig = isAgentConfigShape(body.agentConfig)
		? (body.agentConfig as AgentConfig)
		: null;
	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.forkSessionFromEvent({
		sourceSessionId: params.id,
		fromSequence,
		title,
		agentConfig: tweakedConfig,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	if (result.status === "not_found") return error(404, "Session not found");
	if (result.status === "bad_request") return error(400, result.message);

	return json(
		{
			sessionId: result.sessionId,
			sourceSessionId: result.sourceSessionId,
			replayed: result.replayed,
		},
		{ status: 201 },
	);
};

function isAgentConfigShape(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.runtime === "string" ||
		typeof v.modelSpec === "string" ||
		typeof v.systemPrompt === "string" ||
		Array.isArray(v.skills) ||
		Array.isArray(v.mcpServers) ||
		Array.isArray(v.builtinTools) ||
		Array.isArray(v.bundleRefs)
	);
}
