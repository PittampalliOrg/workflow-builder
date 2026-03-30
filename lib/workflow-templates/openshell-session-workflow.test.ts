import { describe, expect, it } from "vitest";
import { buildOpenShellSessionWorkflow } from "./openshell-session-workflow";

describe("buildOpenShellSessionWorkflow", () => {
	it("builds the expected repo-backed OpenShell Claude session template", () => {
		const template = buildOpenShellSessionWorkflow();

		expect(template.nodes.map((node) => node.label)).toEqual([
			"Manual Trigger",
			"Workspace Profile",
			"Workspace Clone",
			"OpenShell Session Start",
		]);

		const sessionNode = template.nodes.find(
			(node) => node.id === "openshell-session-start",
		);
		const triggerNode = template.nodes.find(
			(node) => node.id === "trigger-session",
		);
		const cloneNode = template.nodes.find(
			(node) => node.id === "workspace-clone",
		);
		expect(sessionNode?.config.actionType).toBe("openshell/session-start");
		expect(String(sessionNode?.config.repositoryUrl)).toContain(
			"{{@workspace-clone:Workspace Clone.repository}}",
		);
		expect(sessionNode?.config.repositoryBranch).toBe(
			"{{@workspace-clone:Workspace Clone.branch}}",
		);
		expect(cloneNode?.config.auth).toBe("{{connections['github']}}");
		expect(String(triggerNode?.config.inputSchema)).not.toContain(
			"repository_owner",
		);
		expect(sessionNode?.config.keepSandbox).toBe("true");
		expect(template.edges).toHaveLength(3);
	});
});
