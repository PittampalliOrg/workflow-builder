import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createSession,
	listSessions,
	type CreateSessionInput,
} from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const agentId = url.searchParams.get("agentId") ?? undefined;
	const status = url.searchParams.get("status") as
		| "rescheduling"
		| "running"
		| "idle"
		| "terminated"
		| null;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const sessions = await listSessions({
		userId: locals.session.userId,
		agentId,
		status: status ?? undefined,
		includeArchived,
		limit: Number.isFinite(limit) ? limit : undefined,
	});
	return json({ sessions });
};

/**
 * Create a session. Body:
 *   { agentId, agentVersion?, environmentId?, environmentVersion?,
 *     vaultIds?, title?, initialMessage? }
 *
 * If `initialMessage` is present, it's appended as a `user.message` event
 * immediately so the session has a kickoff without a second round-trip.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const agentId = typeof body.agentId === "string" ? body.agentId : "";
	if (!agentId) return error(400, "agentId is required");

	const input: CreateSessionInput = {
		agentId,
		agentVersion:
			typeof body.agentVersion === "number" ? body.agentVersion : undefined,
		environmentId:
			typeof body.environmentId === "string"
				? (body.environmentId as string)
				: undefined,
		environmentVersion:
			typeof body.environmentVersion === "number"
				? body.environmentVersion
				: undefined,
		vaultIds: Array.isArray(body.vaultIds)
			? (body.vaultIds as unknown[]).filter(
					(v): v is string => typeof v === "string",
				)
			: undefined,
		title: typeof body.title === "string" ? body.title : undefined,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	};

	try {
		const session = await createSession(input);
		if (typeof body.initialMessage === "string" && body.initialMessage.trim()) {
			await sendUserEvent(session.id, {
				type: "user.message",
				content: [{ type: "text", text: body.initialMessage }],
			});
		}
		// Spawn the Dapr workflow instance. Failures here don't roll back the
		// session row — the UI can retry via POST /api/v1/sessions/[id]/spawn,
		// and a future idle sweep could garbage-collect orphaned sessions.
		try {
			const { instanceId, natsSubject } = await spawnSessionWorkflow(session.id);
			session.daprInstanceId = instanceId;
			session.natsSubject = natsSubject;
		} catch (spawnErr) {
			console.error("[sessions] spawn failed:", spawnErr);
			session.errorMessage =
				spawnErr instanceof Error ? spawnErr.message : "Workflow spawn failed";
		}
		return json({ session }, { status: 201 });
	} catch (err) {
		return error(
			400,
			err instanceof Error ? err.message : "Session create failed",
		);
	}
};
