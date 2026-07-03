import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	ApplicationAgentProfileService,
	mergeAgentProfiles,
	type AgentProfileReadPort,
} from "./agent-profiles";
import type { AgentProfileSummary } from "$lib/server/agent-profiles";

function profile(overrides: Partial<AgentProfileSummary>): AgentProfileSummary {
	return {
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
		...overrides,
	};
}

describe("ApplicationAgentProfileService", () => {
	let port: AgentProfileReadPort;

	beforeEach(() => {
		port = {
			listDatabaseAgentProfiles: vi.fn(async () => [
				profile({
					id: "db-default",
					templateId: "db-default",
					slug: "default-sandbox-agent",
					name: "Database Default",
				}),
				profile({
					id: "db-custom",
					templateId: "db-custom",
					slug: "custom-db-profile",
					name: "Custom DB Profile",
				}),
			]),
		};
	});

	it("merges database profiles over built-in profiles by slug", async () => {
		const service = new ApplicationAgentProfileService(port);

		const profiles = await service.listProfiles();

		expect(profiles.find((item) => item.slug === "default-sandbox-agent")).toMatchObject({
			id: "db-default",
			name: "Database Default",
			source: "database",
		});
		expect(profiles.find((item) => item.slug === "custom-db-profile")).toMatchObject({
			id: "db-custom",
		});
	});

	it("falls back to built-ins when the profile port fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		port.listDatabaseAgentProfiles = vi.fn(async () => {
			throw new Error("database unavailable");
		});

		const profiles = await new ApplicationAgentProfileService(port).listProfiles();

		expect(profiles.some((item) => item.slug === "default-sandbox-agent")).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"[agent-profiles] Failed loading DB profiles, using built-ins:",
			expect.any(Error),
		);
		warn.mockRestore();
	});
});

describe("mergeAgentProfiles", () => {
	it("keeps built-in order and appends new database profiles", () => {
		const merged = mergeAgentProfiles(
			[
				profile({ id: "builtin-a", slug: "a", source: "builtin" }),
				profile({ id: "builtin-b", slug: "b", source: "builtin" }),
			],
			[
				profile({ id: "db-b", slug: "b" }),
				profile({ id: "db-c", slug: "c" }),
			],
		);

		expect(merged.map((item) => [item.slug, item.id])).toEqual([
			["a", "builtin-a"],
			["b", "db-b"],
			["c", "db-c"],
		]);
	});
});
