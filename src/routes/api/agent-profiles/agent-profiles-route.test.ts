import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentProfiles: {
		listProfiles: vi.fn(async () => [
			{
				id: "profile-1",
				templateId: "profile-1",
				slug: "profile-1",
				name: "Profile 1",
				description: null,
				category: null,
				version: 1,
				source: "database",
				config: {
					builtinTools: [],
					mcpConnectionMode: "explicit",
					mcpServers: [],
					skills: [],
					runtimeOverridePolicy: {
						allowToolNarrowing: true,
						allowServerAdditions: false,
						allowCredentialBinding: true,
						allowSkillAdditions: false,
						allowSkillNarrowing: true,
					},
				},
			},
		]),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		agentProfiles: mocks.agentProfiles,
	}),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

describe("agent profiles route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("agentProfiles.listProfiles");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("listAgentProfiles");
	});

	it("lists profiles through the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			profiles: [
				expect.objectContaining({
					id: "profile-1",
					slug: "profile-1",
				}),
			],
		});
		expect(mocks.agentProfiles.listProfiles).toHaveBeenCalledTimes(1);
	});

	it("rejects unauthenticated callers", async () => {
		await expect(GET(event({ locals: { session: null } }) as never)).rejects.toMatchObject({
			status: 401,
		});
		expect(mocks.agentProfiles.listProfiles).not.toHaveBeenCalled();
	});
});
