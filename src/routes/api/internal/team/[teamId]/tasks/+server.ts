import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/internal/team/[teamId]/tasks
 *   { title, description?, dependsOn?: taskIds, assignTo?: memberName,
 *     createdBySessionId? }
 *
 * Task authoring for script-led teams (the dynamic-script `team.task()`
 * primitive) — the imperative MCP `create_task` tool writes via the mcp-server's
 * own db client; this is the BFF-side equivalent with member-name assignment.
 * `assignTo` resolves a member by name (404 when unknown) and creates the row
 * already assigned + in_progress so the claim query skips it; unassigned tasks
 * are claimable by idle teammates as usual.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		title?: string;
		description?: string;
		dependsOn?: string[];
		assignTo?: string;
		createdBySessionId?: string;
	};
	if (!body.title || !body.title.trim()) return error(400, "title is required");
	const store = getApplicationAdapters().teamStore;

	let assigneeSessionId: string | null = null;
	if (body.assignTo) {
		const member = await store.getMemberByName(params.teamId, body.assignTo);
		if (!member) return error(404, `no teammate '${body.assignTo}' in this team`);
		assigneeSessionId = member.session_id;
	}

	const task = await store.createTask({
		teamId: params.teamId,
		title: body.title.trim(),
		description: body.description ?? null,
		dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : [],
		createdBySessionId: body.createdBySessionId ?? null,
		assigneeSessionId,
		status: assigneeSessionId ? "in_progress" : "pending",
	});

	// Keep the (synthetic) container run's progress current; a no-op for
	// adopted script executions (engine guard in refreshTeamRunStatus).
	await store.refreshTeamRunStatus(params.teamId).catch(() => {});

	return json({ ok: true, task });
};
