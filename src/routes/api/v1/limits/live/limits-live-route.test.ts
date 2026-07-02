import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getLiveLimitSnapshot: vi.fn(async () => ({
			activeSessions: 2,
			byModel: [
				{
					model: "claude-opus-4-8",
					sessionsLastHour: 2,
					tokensInLastHour: 100,
					tokensOutLastHour: 25,
					tokensInLastMinute: 10,
					tokensOutLastMinute: 3,
				},
			],
			asOf: "2026-07-02T00:00:00.000Z",
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event() {
	return {
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	};
}

describe("live limits route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps live limit reporting behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getLiveLimitSnapshot");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes authenticated scope to workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			activeSessions: 2,
			asOf: "2026-07-02T00:00:00.000Z",
		});
		expect(mocks.workflowData.getLiveLimitSnapshot).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
		});
	});
});
