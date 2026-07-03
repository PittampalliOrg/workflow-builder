import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentRegistryBrowser: {
		listRegistryAgents: vi.fn(async () => ({
			source: "dapr-agent-registry" as const,
			storeName: "agent-registry",
			teams: ["team-a"],
			agents: [],
			diagnostics: [],
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentRegistryBrowser: mocks.agentRegistryBrowser,
	}),
}));

import { GET } from "./+server";

describe("/api/agents/registry route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates registry browser behavior to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentRegistryBrowser.listRegistryAgents");
		expect(source).not.toContain("$env/dynamic/private");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("daprFetch");
	});

	it("returns the registry read model", async () => {
		const response = await GET({} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			source: "dapr-agent-registry",
			storeName: "agent-registry",
			teams: ["team-a"],
			agents: [],
			diagnostics: [],
		});
		expect(mocks.agentRegistryBrowser.listRegistryAgents).toHaveBeenCalled();
	});
});
