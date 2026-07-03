import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agent: { id: "agent-1", name: "Writer" },
	agentCatalog: {
		listAgents: vi.fn(async () => [{ id: "agent-1", name: "Writer" }]),
		createAgent: vi.fn(async () => ({
			status: "created" as const,
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

describe("/api/agents route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates list/create behavior to the agent catalog application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.listAgents");
		expect(source).toContain("agentCatalog.createAgent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/agents/runtime-registry");
		expect(source).not.toContain("$lib/server/agent-profiles");
		expect(source).not.toContain("$lib/server/agent-templates/catalog");
	});

	it("passes query parameters and session project to listAgents", async () => {
		const response = await GET({
			url: new URL(
				"http://localhost/api/agents?q=writer&tag=draft&includeArchived=true&projectId=project-2",
			),
			locals: {
				session: { userId: "user-1", projectId: "project-1" },
			},
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			agents: [{ id: "agent-1", name: "Writer" }],
		});
		expect(mocks.agentCatalog.listAgents).toHaveBeenCalledWith({
			currentProjectId: "project-1",
			query: {
				q: "writer",
				tag: "draft",
				includeArchived: "true",
				includeEphemeral: null,
				projectId: "project-2",
			},
		});
	});

	it("passes request bodies and template slugs to createAgent", async () => {
		const body = { name: "Writer" };
		const response = await POST({
			url: new URL("http://localhost/api/agents?fromTemplate=quickstart"),
			request: new Request("http://localhost/api/agents", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: {
				session: { userId: "user-1", projectId: "project-1" },
			},
		} as never);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			agent: { id: "agent-1", name: "Writer" },
		});
		expect(mocks.agentCatalog.createAgent).toHaveBeenCalledWith({
			userId: "user-1",
			currentProjectId: "project-1",
			templateSlug: "quickstart",
			body,
		});
	});
});
