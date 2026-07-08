import { describe, expect, it } from "vitest";
import { registerWorkflowTools } from "./workflow-tools.js";

function fakeServer() {
	const captured: Array<{ name: string }> = [];
	const server = {
		registerTool(name: string) {
			captured.push({ name });
		},
	};
	return { server, captured };
}

describe("workflow tools registration", () => {
	it("exposes only current workflow operational tools", () => {
		const { server, captured } = fakeServer();
		const tools = registerWorkflowTools(server as any);
		const names = tools.map((tool) => tool.name);

		expect(captured.map((tool) => tool.name)).toEqual(names);
		expect(names).toEqual([
			"list_workflows",
			"get_workflow",
			"list_available_actions",
			"execute_workflow",
			"get_execution_status",
			"get_execution_results",
		]);
		expect(names).not.toContain("create_workflow");
		expect(names).not.toContain("add_node");
		expect(names).not.toContain("approve_workflow");
		expect(names).not.toContain("get_workflow_observability");
	});
});
