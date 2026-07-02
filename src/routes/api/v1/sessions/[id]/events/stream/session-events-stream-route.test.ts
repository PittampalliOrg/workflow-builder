import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type SessionSnapshot = {
		id: string;
		projectId: string;
		status: string;
	} | null;
	const workflowData = {
		getSessionEventStreamSnapshot: vi.fn<() => Promise<SessionSnapshot>>(async () => ({
			id: "session-1",
			projectId: "project-1",
			status: "running",
		})),
		listSessionEvents: vi.fn(async () => []),
		listenSessionEventNotifications: vi.fn(async () => ({
			unlisten: vi.fn(async () => undefined),
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		request: new Request("http://test.local/api/v1/sessions/session-1/events/stream", {
			headers: { "last-event-id": "7" },
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

describe("session events stream route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getSessionEventStreamSnapshot.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			status: "running",
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionEventStreamSnapshot");
		expect(source).toContain("workflowData.listSessionEvents");
		expect(source).toContain("workflowData.listenSessionEventNotifications");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/");
		expect(source).not.toContain("sql.listen");
	});

	it("requires authentication before opening a stream", async () => {
		const response = (await GET(
			event({ locals: { session: null } }) as never,
		)) as Response;

		expect(response.status).toBe(401);
		expect(mocks.workflowData.getSessionEventStreamSnapshot).not.toHaveBeenCalled();
	});

	it("hides sessions outside workflowData scope", async () => {
		mocks.workflowData.getSessionEventStreamSnapshot.mockResolvedValueOnce(null);

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(404);
		expect(mocks.workflowData.getSessionEventStreamSnapshot).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
		});
		expect(mocks.workflowData.listSessionEvents).not.toHaveBeenCalled();
		expect(mocks.workflowData.listenSessionEventNotifications).not.toHaveBeenCalled();
	});
});
