import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		countActiveTriggeredWorkflowRuns: vi.fn(async () => 0),
	};
	return { workflowData };
});

vi.mock("$env/dynamic/private", () => ({
	env: {},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import {
	admitTriggeredRun,
	countActiveTriggeredRuns,
	triggerConcurrencyCap,
} from "./trigger-gate";

describe("trigger gate", () => {
	const originalCap = process.env.EVENT_TRIGGER_MAX_CONCURRENT;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.EVENT_TRIGGER_MAX_CONCURRENT;
		mocks.workflowData.countActiveTriggeredWorkflowRuns.mockResolvedValue(0);
	});

	afterEach(() => {
		if (originalCap === undefined) {
			delete process.env.EVENT_TRIGGER_MAX_CONCURRENT;
		} else {
			process.env.EVENT_TRIGGER_MAX_CONCURRENT = originalCap;
		}
	});

	it("keeps active triggered-run counting behind workflow-data services", async () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "trigger-gate.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.countActiveTriggeredWorkflowRuns");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowExecutions");

		await expect(countActiveTriggeredRuns()).resolves.toBe(0);
		expect(mocks.workflowData.countActiveTriggeredWorkflowRuns).toHaveBeenCalledWith({
			statuses: ["running", "pending"],
		});
	});

	it("uses EVENT_TRIGGER_MAX_CONCURRENT as the admission cap", async () => {
		process.env.EVENT_TRIGGER_MAX_CONCURRENT = "2";
		mocks.workflowData.countActiveTriggeredWorkflowRuns.mockResolvedValueOnce(2);

		await expect(admitTriggeredRun()).resolves.toEqual({
			admit: false,
			active: 2,
			cap: 2,
		});
		expect(triggerConcurrencyCap()).toBe(2);
	});

	it("admits when the count is below the cap", async () => {
		process.env.EVENT_TRIGGER_MAX_CONCURRENT = "3";
		mocks.workflowData.countActiveTriggeredWorkflowRuns.mockResolvedValueOnce(1);

		await expect(admitTriggeredRun()).resolves.toEqual({
			admit: true,
			active: 1,
			cap: 3,
		});
	});

	it("returns zero for an unconfigured database, matching the previous no-db count behavior", async () => {
		mocks.workflowData.countActiveTriggeredWorkflowRuns.mockRejectedValueOnce(
			new Error("Database not configured"),
		);

		await expect(countActiveTriggeredRuns()).resolves.toBe(0);
	});

	it("fails open when the count path throws a real error", async () => {
		process.env.EVENT_TRIGGER_MAX_CONCURRENT = "4";
		mocks.workflowData.countActiveTriggeredWorkflowRuns.mockRejectedValueOnce(
			new Error("count failed"),
		);

		await expect(admitTriggeredRun()).resolves.toEqual({
			admit: true,
			active: -1,
			cap: 4,
		});
	});
});
