/**
 * Human classification of raw team member events for the Live board: one
 * event → {label, tone}. Turns "mcp.tool_call wfb_goal_claim_task" into
 * "claiming a task" so the board reads like a newsroom ticker, not a log.
 */

export type TeamLiveEvent = {
	type: string;
	tool?: string | null;
	origin?: string | null;
	from?: string | null;
	preview?: string | null;
};

export type ActivityTone =
	| "working" // actively producing (teal)
	| "coord" // team coordination: tasks/messages/knowledge (violet)
	| "idle" // finished / waiting (muted)
	| "error"; // failed (red)

/** Friendly verbs for the team MCP tools (wfb_goal_-prefixed on the wire). */
const MCP_VERBS: Record<string, string> = {
	claim_task: "claiming a task",
	update_task: "completing a task",
	create_task: "adding a task",
	send_message: "messaging a teammate",
	broadcast: "broadcasting to the team",
	list_teammates: "checking the roster",
	publish_knowledge: "publishing knowledge",
	read_knowledge: "reading the knowledge bundle",
	submit_plan: "submitting a plan",
	approve_plan: "deciding a plan",
	wait_teammates: "waiting for the team",
	spawn_teammate: "spawning a teammate",
	revive_teammate: "reviving a teammate",
	shutdown_teammate: "shutting a teammate down",
};

function mcpVerb(tool: string): string | null {
	const bare = tool.replace(/^wfb_goal_/, "").replace(/^wfb_/, "");
	return MCP_VERBS[bare] ?? null;
}

export function classifyTeamEvent(e: TeamLiveEvent): { label: string; tone: ActivityTone } {
	switch (e.type) {
		case "agent.thinking":
			return { label: "thinking", tone: "working" };
		case "agent.message":
			return { label: "responding", tone: "working" };
		case "agent.tool_use": {
			const tool = e.tool ?? "a tool";
			const verb = e.tool ? mcpVerb(e.tool) : null;
			return { label: verb ?? `running ${tool}`, tone: verb ? "coord" : "working" };
		}
		case "mcp.tool_call": {
			const verb = e.tool ? mcpVerb(e.tool) : null;
			return { label: verb ?? `calling ${e.tool ?? "an MCP tool"}`, tone: "coord" };
		}
		case "user.message": {
			if (e.origin === "team-broadcast")
				return { label: `received a broadcast from ${e.from ?? "the lead"}`, tone: "coord" };
			if (e.origin === "team-error")
				return { label: "notified of a teammate failure", tone: "error" };
			if (e.origin === "team-idle") return { label: "nudged by the team", tone: "coord" };
			if (e.origin === "teammate-message")
				return { label: `received a message from ${e.from ?? "a teammate"}`, tone: "coord" };
			return { label: "received instructions", tone: "coord" };
		}
		case "session.status_running":
			return { label: "starting a turn", tone: "working" };
		case "session.status_idle":
			return { label: "finished its turn", tone: "idle" };
		case "session.host_suspended":
			return { label: "hibernating (scaled to zero)", tone: "idle" };
		case "session.host_woken":
			return { label: "waking up", tone: "coord" };
		case "session.error":
			return { label: "hit an error", tone: "error" };
		default:
			return { label: e.type, tone: "idle" };
	}
}

/** Member-status fallback when a member has no events yet (booting). */
export function classifyMemberStatus(status: string): { label: string; tone: ActivityTone } {
	if (status === "working") return { label: "starting up", tone: "working" };
	if (status === "suspended") return { label: "hibernating", tone: "idle" };
	if (status === "failed") return { label: "failed", tone: "error" };
	if (status === "shutdown") return { label: "shut down", tone: "idle" };
	return { label: status, tone: "idle" };
}
