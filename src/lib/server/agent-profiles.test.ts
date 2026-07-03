import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	listBuiltInAgentProfiles,
	normalizeAgentProfileConfig,
} from "./agent-profiles";

describe("agent profile definitions", () => {
	it("keeps built-in profile definitions available without infrastructure", () => {
		expect(listBuiltInAgentProfiles().map((profile) => profile.slug)).toContain(
			"default-sandbox-agent",
		);
	});

	it("normalizes profile facet config", () => {
		expect(
			normalizeAgentProfileConfig({
				toolPolicy: {
					builtinTools: ["read_file"],
					mcpConnectionMode: "project",
					runtimeOverridePolicy: { allowServerAdditions: true },
				},
				model: { model: "openai/gpt-5.5" },
				execution: { maxTurns: "12", timeoutMinutes: "30" },
			}),
		).toMatchObject({
			builtinTools: ["read_file"],
			mcpConnectionMode: "project",
			modelSpec: "openai/gpt-5.5",
			maxTurns: 12,
			timeoutMinutes: 30,
			runtimeOverridePolicy: {
				allowServerAdditions: true,
				allowCredentialBinding: true,
			},
		});
	});

	it("does not import direct DB infrastructure", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "agent-profiles.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
