import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		listVersions: vi.fn(async () => [{ id: "version-1", version: 1 }]),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { GET } from "./+server";

describe("/api/agents/[id]/versions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates version listing to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.listVersions");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns versions", async () => {
		const response = await GET({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			versions: [{ id: "version-1", version: 1 }],
		});
		expect(mocks.agentCatalog.listVersions).toHaveBeenCalledWith("agent-1");
	});
});
