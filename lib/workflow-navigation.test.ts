import { describe, expect, it } from "vitest";
import {
	getNavigableWorkflows,
	pickWorkflowRedirectId,
} from "./workflow-navigation";

describe("getNavigableWorkflows", () => {
	it("filters internal current workflow rows", () => {
		const workflows = [
			{ id: "wf-1", name: "Untitled 1", updatedAt: "2026-02-16T12:00:00.000Z" },
			{
				id: "wf-2",
				name: "__current__",
				updatedAt: "2026-02-16T13:00:00.000Z",
			},
			{
				id: "wf-3",
				name: "~~__CURRENT__~~",
				updatedAt: "2026-02-16T14:00:00.000Z",
			},
		];

		const result = getNavigableWorkflows(workflows);

		expect(result.map((workflow) => workflow.id)).toEqual(["wf-1"]);
	});
});

describe("pickWorkflowRedirectId", () => {
	it("prefers the selected workflow when it exists", () => {
		const workflows = [
			{ id: "wf-1", name: "A", updatedAt: "2026-02-16T12:00:00.000Z" },
			{ id: "wf-2", name: "B", updatedAt: "2026-02-16T13:00:00.000Z" },
		];

		const result = pickWorkflowRedirectId(workflows, "wf-1");

		expect(result).toBe("wf-1");
	});

	it("falls back to most recently updated workflow when preferred id is missing", () => {
		const workflows = [
			{ id: "wf-1", name: "A", updatedAt: "2026-02-16T12:00:00.000Z" },
			{ id: "wf-2", name: "B", updatedAt: "2026-02-16T13:00:00.000Z" },
		];

		const result = pickWorkflowRedirectId(workflows, "wf-999");

		expect(result).toBe("wf-2");
	});

	it("returns null when there are no workflows", () => {
		const result = pickWorkflowRedirectId([], "wf-1");

		expect(result).toBeNull();
	});
});
