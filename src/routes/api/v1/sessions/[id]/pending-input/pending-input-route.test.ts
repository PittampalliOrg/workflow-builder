import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionDetailMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			getSessionDetail: (...args: unknown[]) => getSessionDetailMock(...args),
		},
	}),
}));

import { GET } from "./+server";

describe("session pending-input route", () => {
	beforeEach(() => {
		getSessionDetailMock.mockReset();
	});

	it("401s without an authenticated session", async () => {
		await expect(GET(anonEvent())).rejects.toMatchObject({ status: 401 });
		expect(getSessionDetailMock).not.toHaveBeenCalled();
	});

	it("404s when the (project-scoped) session is not visible", async () => {
		getSessionDetailMock.mockResolvedValue(null);
		await expect(GET(sessionEvent())).rejects.toMatchObject({ status: 404 });
		expect(getSessionDetailMock).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("returns the pending_input cache value for a visible session", async () => {
		const pendingInput = {
			kind: "permission",
			toolUseId: "tool-9",
			prompt: "Bash",
			eventId: "event-1",
			since: "2026-01-01T00:00:00.000Z",
		};
		getSessionDetailMock.mockResolvedValue({ id: "session-1", pendingInput });
		const response = (await GET(sessionEvent())) as Response;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ pendingInput });
	});

	it("returns null when the session is not waiting on input", async () => {
		getSessionDetailMock.mockResolvedValue({ id: "session-1", pendingInput: null });
		const response = (await GET(sessionEvent())) as Response;
		expect(await response.json()).toEqual({ pendingInput: null });
	});
});

function sessionEvent(): never {
	return {
		params: { id: "session-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	} as never;
}

function anonEvent(): never {
	return { params: { id: "session-1" }, locals: {} } as never;
}
