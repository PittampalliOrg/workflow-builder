import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflowData: {
		getHomePageReadModel: vi.fn(),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
	}),
}));

import { load } from "./+page.server";

describe("home page loader", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getHomePageReadModel.mockResolvedValue({
			user: { name: "Ada", email: "ada@example.com" },
			recentSessions: [],
			recentRuns: [],
		});
	});

	it("returns empty recents for unauthenticated users", async () => {
		const result = await load({ locals: {} } as never);

		expect(result).toEqual({ user: null, recentSessions: [], recentRuns: [] });
		expect(mocks.workflowData.getHomePageReadModel).not.toHaveBeenCalled();
	});

	it("loads the dashboard read model through workflow-data", async () => {
		const result = await load({
			locals: {
				session: {
					userId: "user-1",
					projectId: "project-1",
				},
			},
		} as never);

		expect(mocks.workflowData.getHomePageReadModel).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			limit: 5,
		});
		expect(result).toEqual({
			user: { name: "Ada", email: "ada@example.com" },
			recentSessions: [],
			recentRuns: [],
		});
	});

	it("keeps home reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getHomePageReadModel");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/workflows/runs");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("users.");
	});
});
