import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		getAgent: vi.fn(async () => ({
			status: "ok" as const,
			agent: { id: "agent-1", name: "Writer" },
		})),
		updateAgent: vi.fn(async () => ({
			status: "updated" as const,
			agent: { id: "agent-1", name: "Updated" },
		})),
		archiveAgent: vi.fn(async () => ({ status: "archived" as const })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { DELETE, GET, PUT } from "./+server";

describe("/api/agents/[id] route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates detail/update/archive behavior to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.getAgent");
		expect(source).toContain("agentCatalog.updateAgent");
		expect(source).toContain("agentCatalog.archiveAgent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/agents/runtime-registry");
	});

	it("delegates GET", async () => {
		const response = await GET({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			agent: { id: "agent-1", name: "Writer" },
		});
		expect(mocks.agentCatalog.getAgent).toHaveBeenCalledWith("agent-1");
	});

	it("delegates PUT", async () => {
		const body = { name: "Updated" };
		const response = await PUT({
			params: { id: "agent-1" },
			request: new Request("http://localhost/api/agents/agent-1", {
				method: "PUT",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			agent: { id: "agent-1", name: "Updated" },
		});
		expect(mocks.agentCatalog.updateAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			userId: "user-1",
			body,
		});
	});

	it("delegates DELETE", async () => {
		const response = await DELETE({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ archived: true });
		expect(mocks.agentCatalog.archiveAgent).toHaveBeenCalledWith("agent-1");
	});
});
