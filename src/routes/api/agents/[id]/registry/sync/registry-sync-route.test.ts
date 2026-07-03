import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		syncAgentRegistry: vi.fn(async () => ({
			status: "registered",
			syncedAt: "2026-05-15T12:00:00.000Z",
			error: null,
			team: "project-1",
			key: "agents:project-1:writer",
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { POST } from "./+server";

describe("/api/agents/[id]/registry/sync route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates registry sync to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.syncAgentRegistry");
		expect(source).not.toContain("$lib/server/agents/registry-sync");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates POST sync", async () => {
		const response = await POST({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: "registered",
			syncedAt: "2026-05-15T12:00:00.000Z",
			error: null,
			team: "project-1",
			key: "agents:project-1:writer",
		});
		expect(mocks.agentCatalog.syncAgentRegistry).toHaveBeenCalledWith("agent-1");
	});
});
