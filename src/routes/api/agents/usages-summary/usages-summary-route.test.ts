import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		findAllAgentUsageCounts: vi.fn(async () => ({
			"agent-1": { workflowCount: 1, nodeCount: 2 },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { GET } from "./+server";

describe("/api/agents/usages-summary route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates usage summary lookup to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.findAllAgentUsageCounts");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns usage counts", async () => {
		const response = await GET({
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			counts: { "agent-1": { workflowCount: 1, nodeCount: 2 } },
		});
		expect(mocks.agentCatalog.findAllAgentUsageCounts).toHaveBeenCalled();
	});
});
