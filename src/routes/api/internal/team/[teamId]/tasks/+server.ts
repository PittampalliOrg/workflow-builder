import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { runTeamHook } from "$lib/server/teams/team-hooks";

/**
 * POST /api/internal/team/[teamId]/tasks
 *   { title, description?, dependsOn?: taskIds, assignTo?: memberName,
 *     assignMode?: 'direct'|'queue', createdBySessionId? }
 *
 * The single task-authoring path (the dynamic-script `team.task()` primitive
 * AND the MCP `create_task` tool both route here, so the TaskCreated gate is
 * unbypassable). `assignTo` resolves a member by name (404 when unknown);
 * assignMode:
 *   • 'direct' (default): row created assigned + in_progress — a direct hand
 *     the claim query skips (script-authored teams' existing semantics);
 *   • 'queue': row created assigned + PENDING — claimable ONLY by the designee,
 *     who picks it up before any open task (role-affinity claiming).
 *
 * A configured TaskCreated hook (TEAM_HOOKS_URL, Claude Code payload shape)
 * can BLOCK creation: 422 { blocked: true, reason } — deterministic, so team
 * ops surface it as a catchable script error and MCP tools as tool feedback.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		title?: string;
		description?: string;
		dependsOn?: string[];
		assignTo?: string;
		assignMode?: "direct" | "queue";
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

	const gate = await runTeamHook("TaskCreated", {
		team_name: params.teamId,
		teamId: params.teamId,
		task: {
			title: body.title.trim(),
			description: body.description ?? null,
			assignee: body.assignTo ?? null,
			dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : [],
		},
		sessionId: body.createdBySessionId ?? null,
	});
	if (gate.blocked) {
		return json({ blocked: true, reason: gate.reason }, { status: 422 });
	}

	const task = await store.createTask({
		teamId: params.teamId,
		title: body.title.trim(),
		description: body.description ?? null,
		dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : [],
		createdBySessionId: body.createdBySessionId ?? null,
		assigneeSessionId,
		status:
			assigneeSessionId && body.assignMode !== "queue" ? "in_progress" : "pending",
	});

	// Keep the (synthetic) container run's progress current; a no-op for
	// adopted script executions (engine guard in refreshTeamRunStatus).
	await store.refreshTeamRunStatus(params.teamId).catch(() => {});

	return json({ ok: true, task });
};
