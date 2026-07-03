import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentCatalog: {
		compileCapabilities: vi.fn(async () => ({
			status: "ok" as const,
			compiled: { agent: { id: "agent-1" } },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentCatalog: mocks.agentCatalog,
	}),
}));

import { GET } from "./+server";

describe("/api/agents/[id]/compiled route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates compiled capabilities to the agent catalog service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("agentCatalog.compileCapabilities");
		expect(source).not.toContain("$lib/server/agents/compiled-capabilities");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns compiled capabilities", async () => {
		const response = await GET({
			params: { id: "agent-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			compiled: { agent: { id: "agent-1" } },
		});
		expect(mocks.agentCatalog.compileCapabilities).toHaveBeenCalledWith("agent-1");
	});
});
