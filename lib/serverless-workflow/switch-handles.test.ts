import { describe, expect, it } from "vitest";
import { buildSwitchSourceHandles } from "@/components/workflow/nodes/sw-task-nodes";

describe("buildSwitchSourceHandles", () => {
	it("creates one source handle per switch case name", () => {
		const handles = buildSwitchSourceHandles({
			switch: [
				{
					changesRequired: {
						when: "${ .plan.hasChanges == true }",
						then: "implement",
					},
				},
				{
					noChanges: {
						then: "emitNoChanges",
					},
				},
			],
		});

		expect(handles.map((handle) => handle.id)).toEqual([
			"changesRequired",
			"noChanges",
		]);
		expect(handles.map((handle) => handle.label)).toEqual([
			"changesRequired",
			"noChanges",
		]);
	});

	it("falls back to a single generic handle when no cases exist", () => {
		const handles = buildSwitchSourceHandles({});

		expect(handles).toHaveLength(1);
		expect(handles[0]).toMatchObject({
			id: "case",
			label: "case",
		});
	});
});
