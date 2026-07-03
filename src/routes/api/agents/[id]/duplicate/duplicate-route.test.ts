import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		duplicateAgent: vi.fn(async () => ({
			status: "created" as const,
			agent: { id: "agent-copy", name: "Copy" },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { POST } from "./+server";

describe("/api/agents/[id]/duplicate route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates duplicate behavior to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.duplicateAgent");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes request body and session ownership to duplicateAgent", async () => {
		const body = { name: "Copy" };
		const response = await POST({
			params: { id: "agent-1" },
			request: new Request("http://localhost/api/agents/agent-1/duplicate", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: {
				session: { userId: "user-1", projectId: "project-1" },
			},
		} as never);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			agent: { id: "agent-copy", name: "Copy" },
		});
		expect(mocks.agentCatalog.duplicateAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			userId: "user-1",
			currentProjectId: "project-1",
			body,
		});
	});
});
