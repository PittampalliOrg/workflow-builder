import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";
import { nanoid } from "nanoid";

/**
 * POST /api/internal/team/[teamId]/plan-approval
 *   { requestedBySessionId, name, approved, feedback? }
 *
 * The lead's half of the plan-approval handshake (Claude Code parity):
 *   • approved=true  → plan_mode_required flips off (claim_task unblocks) and
 *     the member is told to proceed;
 *   • approved=false → the gate STAYS, and the member receives the feedback to
 *     revise + resubmit (submit_plan again).
 * The member's half is the submit_plan MCP tool (a structured message to the
 * lead). Only the team's lead may decide.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		requestedBySessionId?: string;
		name?: string;
		approved?: boolean;
		feedback?: string;
	};
	if (!body.requestedBySessionId || !body.name || typeof body.approved !== "boolean") {
		return error(400, "requestedBySessionId, name, and approved are required");
	}
	const store = getApplicationAdapters().teamStore;

	const team = await store.getTeam(params.teamId);
	if (!team) return error(404, "no such team");
	if (team.lead_session_id !== body.requestedBySessionId) {
		return error(403, "only the team lead can approve or reject a plan");
	}

	const member = await store.getMemberByName(params.teamId, body.name);
	if (!member) return error(404, `no teammate '${body.name}' in this team`);
	if (!member.plan_mode_required) {
		return json({ ok: true, name: body.name, planModeRequired: false, note: "already approved" });
	}

	if (body.approved) {
		await store.setMemberPlanApproved(member.session_id);
	}
	await injectTeamMessage({
		recipientSessionId: member.session_id,
		fromName: "lead",
		content: body.approved
			? `Your plan is APPROVED${body.feedback?.trim() ? ` — ${body.feedback.trim()}` : ""}. Plan mode is lifted: call claim_task and begin implementation.`
			: `Your plan needs revision: ${body.feedback?.trim() || "the lead rejected it without detail"}. Update the plan and call submit_plan again — you still cannot claim tasks.`,
		kind: "teammate-message",
		sourceEventId: `team-plan-decision:${member.session_id}:${nanoid(8)}`,
	});

	return json({ ok: true, name: body.name, approved: body.approved, planModeRequired: !body.approved });
};
