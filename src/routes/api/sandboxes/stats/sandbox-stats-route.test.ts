import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getSandboxStats: vi.fn(async () => ({
			total: 2,
			byPhase: { READY: 1, PROVISIONING: 1 },
			executions24h: 7,
			avgAgeMinutes: 45,
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

describe("sandbox stats route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps sandbox stats behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getSandboxStats");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("openshellRuntimeFetch");
	});

	it("returns the workflow-data stats read model", async () => {
		const response = (await GET({} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			total: 2,
			byPhase: { READY: 1, PROVISIONING: 1 },
			executions24h: 7,
			avgAgeMinutes: 45,
		});
		expect(mocks.workflowData.getSandboxStats).toHaveBeenCalledWith();
	});
});
