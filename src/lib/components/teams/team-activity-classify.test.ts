import { describe, expect, it } from "vitest";
import {
	classifyMemberStatus,
	classifyTeamEvent,
} from "$lib/components/teams/team-activity-classify";

describe("classifyTeamEvent", () => {
	it("maps team MCP tools to friendly verbs (wfb_goal_ prefix stripped)", () => {
		expect(classifyTeamEvent({ type: "mcp.tool_call", tool: "wfb_goal_claim_task" })).toEqual({
			label: "claiming a task",
			tone: "coord",
		});
		expect(
			classifyTeamEvent({ type: "agent.tool_use", tool: "wfb_goal_publish_knowledge" }).label,
		).toBe("publishing knowledge");
	});
	it("keeps plain tools as 'running X' with the working tone", () => {
		expect(classifyTeamEvent({ type: "agent.tool_use", tool: "Bash" })).toEqual({
			label: "running Bash",
			tone: "working",
		});
	});
	it("classifies team-origin inbox messages by origin", () => {
		expect(
			classifyTeamEvent({ type: "user.message", origin: "team-broadcast", from: "lead" }).label,
		).toContain("broadcast from lead");
		expect(classifyTeamEvent({ type: "user.message", origin: "team-error" }).tone).toBe("error");
		expect(classifyTeamEvent({ type: "user.message", origin: "team-idle" }).label).toBe(
			"nudged by the team",
		);
	});
	it("maps lifecycle + terminal states", () => {
		expect(classifyTeamEvent({ type: "session.host_suspended" }).label).toContain("hibernating");
		expect(classifyTeamEvent({ type: "session.error" }).tone).toBe("error");
		expect(classifyMemberStatus("failed")).toEqual({ label: "failed", tone: "error" });
		expect(classifyMemberStatus("suspended").label).toBe("hibernating");
	});
});
