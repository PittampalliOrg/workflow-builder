import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { runTeamHook } from "$lib/server/teams/team-hooks";

/**
 * POST /api/internal/team/[teamId]/tasks/[taskId]/complete  { sessionId?, note? }
 *
 * The single completion path — the MCP `update_task` tool routes here so the
 * TaskCompleted quality gate is unbypassable. A configured hook
 * (TEAM_HOOKS_URL, Claude Code payload shape) can BLOCK completion:
 * 422 { blocked: true, reason } — returned to the agent as tool feedback so it
 * fixes the work instead of walking away ("completed without doing the work"
 * is exactly what this gate exists to catch).
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		sessionId?: string;
		note?: string;
	};
	const store = getApplicationAdapters().teamStore;

	const tasks = await store.listTeamTasks(params.teamId);
	const existing = tasks.find((t) => t.id === params.taskId);
	if (!existing) return error(404, `no task ${params.taskId} in this team`);
	if (existing.status === "completed") {
		return json({ ok: true, task: existing, alreadyCompleted: true });
	}

	const completer = body.sessionId
		? await store.getMemberBySession(body.sessionId).catch(() => null)
		: null;
	const gate = await runTeamHook("TaskCompleted", {
		team_name: params.teamId,
		teamId: params.teamId,
		task: {
			id: existing.id,
			title: existing.title,
			status: existing.status,
			assignee: existing.assignee_session_id,
			note: body.note ?? null,
		},
		teammate: completer ? { name: completer.name, status: completer.status } : null,
		sessionId: body.sessionId ?? null,
	});
	if (gate.blocked) {
		return json({ blocked: true, reason: gate.reason }, { status: 422 });
	}

	const task = await store.completeTask({ teamId: params.teamId, taskId: params.taskId });
	await store.refreshTeamRunStatus(params.teamId).catch(() => {});
	return json({ ok: true, task });
};
