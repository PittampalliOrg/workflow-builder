import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, lte, asc } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessionEvents } from "$lib/server/db/schema";
import { getSession, createSession } from "$lib/server/sessions/registry";
import { appendEvent } from "$lib/server/sessions/events";

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
 *   { fromSequence: number, title?: string }
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

	// Create the forked session with the same agent/env/vaults.
	const forked = await createSession({
		agentId: source.agentId,
		agentVersion: source.agentVersion ?? undefined,
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
