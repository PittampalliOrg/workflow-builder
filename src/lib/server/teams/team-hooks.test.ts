/**
 * Team task hooks — gate semantics (Claude Code payload/decision parity) with
 * the HTTP boundary mocked. Pins: fail-open on no-config/non-2xx/transport
 * error, block only on an explicit {"decision":"block"}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTeamHook } from "$lib/server/teams/team-hooks";

const fetchMock = vi.fn();

describe("runTeamHook", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		delete process.env.TEAM_HOOKS_URL;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.TEAM_HOOKS_URL;
	});

	it("is a no-op allow when TEAM_HOOKS_URL is not configured", async () => {
		const r = await runTeamHook("TaskCompleted", { teamId: "t1" });
		expect(r).toEqual({ blocked: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks with the hook's reason on an explicit block decision", async () => {
		process.env.TEAM_HOOKS_URL = "http://hooks.local/gate";
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ decision: "block", reason: "tests are red" }), {
				status: 200,
			}),
		);
		const r = await runTeamHook("TaskCompleted", {
			team_name: "t1",
			task: { id: "tk1", title: "ship it" },
		});
		expect(r).toEqual({ blocked: true, reason: "tests are red" });
		// CC-compatible envelope: hook_event_name + payload fields.
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.hook_event_name).toBe("TaskCompleted");
		expect(body.task.id).toBe("tk1");
	});

	it("allows on a 2xx without a block decision", async () => {
		process.env.TEAM_HOOKS_URL = "http://hooks.local/gate";
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		expect(await runTeamHook("TaskCreated", {})).toEqual({ blocked: false });
	});

	it("fails OPEN on non-2xx and on transport errors", async () => {
		process.env.TEAM_HOOKS_URL = "http://hooks.local/gate";
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
		expect(await runTeamHook("TeammateIdle", {})).toEqual({ blocked: false });
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await runTeamHook("TeammateIdle", {})).toEqual({ blocked: false });
	});
});
