import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { browseUrlFor, detailsOf, devPreviewServiceCatalog } from "./dev-environments";

describe("dev-environments module boundary", () => {
	it("keeps dev environment read-model helpers free of persistence imports", () => {
		const source = readFileSync(
			new URL("./dev-environments.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowWorkspaceSessions");
		expect(source).not.toContain("workflowExecutions");
	});
});

describe("dev environment helpers", () => {
	it("extracts preview details and reconstructs catalog URLs", () => {
		expect(
			detailsOf({
				details: {
					kind: "dev-preview",
					service: "workflow-builder",
					ready: true,
				},
			}),
		).toMatchObject({
			kind: "dev-preview",
			service: "workflow-builder",
			ready: true,
		});

		expect(browseUrlFor("workflow-builder", null)).toMatch(/^http:\/\//);
		expect(browseUrlFor("workflow-builder", "https://stored.example.test")).toBe(
			"https://stored.example.test",
		);
		expect(devPreviewServiceCatalog()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ service: "workflow-builder" }),
			]),
		);
	});
});
