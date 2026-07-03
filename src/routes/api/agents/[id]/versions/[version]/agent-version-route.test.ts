import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		getVersion: vi.fn(async () => ({
			status: "ok" as const,
			version: { summary: { id: "version-2", version: 2 }, config: {} },
		})),
		restoreVersion: vi.fn(async () => ({
			status: "restored" as const,
			agent: { id: "agent-1", name: "Writer" },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/agents/[id]/versions/[version] route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates version get/restore behavior to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.getVersion");
		expect(source).toContain("agentCatalog.restoreVersion");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates GET", async () => {
		const response = await GET({
			params: { id: "agent-1", version: "2" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			summary: { id: "version-2", version: 2 },
			config: {},
		});
		expect(mocks.agentCatalog.getVersion).toHaveBeenCalledWith({
			agentId: "agent-1",
			version: "2",
		});
	});

	it("delegates POST restore", async () => {
		const response = await POST({
			params: { id: "agent-1", version: "2" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			agent: { id: "agent-1", name: "Writer" },
		});
		expect(mocks.agentCatalog.restoreVersion).toHaveBeenCalledWith({
			agentId: "agent-1",
			version: "2",
			userId: "user-1",
		});
	});
});
