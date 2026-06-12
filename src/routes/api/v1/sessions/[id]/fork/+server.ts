import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, lte, asc } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessionEvents } from "$lib/server/db/schema";
import { getSession, createSession } from "$lib/server/sessions/registry";
import { appendEvent } from "$lib/server/sessions/events";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { findOrCreateExperimentAgent } from "$lib/server/agents/ephemeral";
import { isAgentConfigEquivalent } from "$lib/utils/agent-config-diff";
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
 * ephemeral agent (see `findOrCreateExperimentAgent`) instead of inheriting
 * the source's agent. The event-replay logic is unchanged — only the new
 * session row's agentId/agentVersion swap.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

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

	const source = await getSession(params.id);
	if (!source) return error(404, "Session not found");

	let forkAgentId = source.agentId;
	let forkAgentVersion = source.agentVersion ?? undefined;

	const tweakedConfig = isAgentConfigShape(body.agentConfig)
		? (body.agentConfig as AgentConfig)
		: null;

	if (tweakedConfig) {
		const baseAgent = await resolveAgentRef({
			id: source.agentId,
			version: source.agentVersion ?? undefined,
		});
		if (baseAgent && !isAgentConfigEquivalent(baseAgent.config, tweakedConfig)) {
			try {
				const experiment = await findOrCreateExperimentAgent({
					baseAgentId: baseAgent.id,
					baseAgentSlug: baseAgent.slug,
					baseAgentName: baseAgent.name,
					agentConfig: tweakedConfig,
					userId: locals.session.userId,
					projectId: locals.session.projectId ?? null,
				});
				forkAgentId = experiment.agentId;
				forkAgentVersion = experiment.agentVersion;
			} catch (err) {
				return error(
					400,
					err instanceof Error ? err.message : "Experiment agent create failed",
				);
			}
		}
	}

	// Create the forked session against the chosen agent (same as source by
	// default, or the experiment when agentConfig was provided + diverged).
	const forked = await createSession({
		agentId: forkAgentId,
		agentVersion: forkAgentVersion,
		environmentId: source.environmentId ?? undefined,
		environmentVersion: source.environmentVersion ?? undefined,
		vaultIds: source.vaultIds,
		title: title ?? `Fork of ${source.title ?? source.id} @ seq ${fromSequence}`,
		userId: locals.session.userId,
	});

	// Replay events up to fromSequence inclusive. appendEvent reassigns the
	// sequence number in the new session (starts from 1), so the order is
	// preserved even though the numeric values differ from the source.
	const rows = await db
		.select()
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, params.id),
				lte(sessionEvents.sequence, fromSequence),
			),
		)
		.orderBy(asc(sessionEvents.sequence));

	for (const row of rows) {
		await appendEvent(forked.id, {
			type: row.type,
			data: (row.data as Record<string, unknown>) ?? {},
			processedAt: row.processedAt ?? null,
			// Prefix source event id so replayed events don't collide with
			// freshly-produced events on the forked session.
			sourceEventId: `fork:${row.id}`,
		});
	}

	return json(
		{
			sessionId: forked.id,
			sourceSessionId: params.id,
			replayed: rows.length,
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
