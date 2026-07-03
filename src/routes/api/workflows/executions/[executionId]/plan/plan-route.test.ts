import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowPlan = {
		getExecutionPlan: vi.fn(async (): Promise<{ plan: string | null }> => ({ plan: "## Plan" })),
	};
	return { workflowPlan };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowPlan: mocks.workflowPlan }),
}));

import { GET } from "./+server";

function event() {
	return {
		params: { executionId: "exec-1" },
	};
}

describe("workflow execution plan route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowPlan.getExecutionPlan.mockResolvedValue({ plan: "## Plan" });
	});

	it("keeps plan lookup behind workflow plan application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowPlan.getExecutionPlan");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the plan read model from the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ plan: "## Plan" });
		expect(mocks.workflowPlan.getExecutionPlan).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
	});

	it("passes null plans through from the application service", async () => {
		mocks.workflowPlan.getExecutionPlan.mockResolvedValueOnce({ plan: null });

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ plan: null });
	});
});
