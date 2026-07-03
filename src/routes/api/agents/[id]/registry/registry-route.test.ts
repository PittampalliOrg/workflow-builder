import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		getRegistryStatus: vi.fn(async () => ({
			status: "ok" as const,
			view: {
				status: "registered",
				syncedAt: "2026-05-15T12:00:00.000Z",
				error: null,
				team: "project-1",
				key: "agents:project-1:writer",
				store: "agent-registry",
				dualWriteEnabled: true,
			},
		})),
		deregisterAgentRegistry: vi.fn(async () => ({
			status: "archived",
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

import { DELETE, GET } from "./+server";

describe("/api/agents/[id]/registry route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates registry read/delete behavior to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.getRegistryStatus");
		expect(source).toContain("agentCatalog.deregisterAgentRegistry");
		expect(source).not.toContain("$lib/server/agents/registry-sync");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes includeMetadata to getRegistryStatus", async () => {
		const response = await GET({
			params: { id: "agent-1" },
			url: new URL("http://localhost/api/agents/agent-1/registry?includeMetadata=1"),
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: "registered",
			syncedAt: "2026-05-15T12:00:00.000Z",
			error: null,
			team: "project-1",
			key: "agents:project-1:writer",
			store: "agent-registry",
			dualWriteEnabled: true,
		});
		expect(mocks.agentCatalog.getRegistryStatus).toHaveBeenCalledWith({
			agentId: "agent-1",
			includeMetadata: true,
		});
	});

	it("delegates DELETE", async () => {
		const response = await DELETE({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: "archived",
			syncedAt: "2026-05-15T12:00:00.000Z",
			error: null,
			team: "project-1",
			key: "agents:project-1:writer",
		});
		expect(mocks.agentCatalog.deregisterAgentRegistry).toHaveBeenCalledWith("agent-1");
	});
});
