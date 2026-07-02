import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		listConnectablePieces: vi.fn(async () => [
			{
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				authType: "OAUTH2",
			},
		]),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

describe("pieces route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps connectable piece reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listConnectablePieces");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("pieceMetadata");
	});

	it("passes auth filter to workflow-data and returns the read model", async () => {
		const response = (await GET({
			url: new URL("http://localhost/api/pieces?auth=true"),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			{
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				authType: "OAUTH2",
			},
		]);
		expect(mocks.workflowData.listConnectablePieces).toHaveBeenCalledWith({
			authOnly: true,
		});
	});
});
