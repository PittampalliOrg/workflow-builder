import { describe, expect, it } from "vitest";
import {
	classifySessionKind,
	DEV_SESSION_WORKFLOW_ID,
	isSessionKind,
} from "./session-kind";

describe("classifySessionKind", () => {
	it("defaults a direct session to interactive", () => {
		expect(classifySessionKind({})).toBe("interactive");
		expect(
			classifySessionKind({ agentSlug: "claude-code", workflowId: null }),
		).toBe("interactive");
	});

	it("classifies a workflow-driven session", () => {
		expect(
			classifySessionKind({ workflowExecutionId: "exec-1", workflowId: "wf-a" }),
		).toBe("workflow");
		// a wf-ephemeral agent slug is still a workflow session, not experiment
		expect(
			classifySessionKind({
				workflowExecutionId: "exec-1",
				agentSlug: "wf-node3",
			}),
		).toBe("workflow");
	});

	it("classifies an experiment fork by the exp- slug prefix", () => {
		expect(classifySessionKind({ agentSlug: "exp-abc123" })).toBe("experiment");
		// experiment takes precedence over a plain workflow signal (matches the
		// session-detail right-rail badge order)
		expect(
			classifySessionKind({ agentSlug: "exp-abc", workflowExecutionId: "e1" }),
		).toBe("experiment");
	});

	it("classifies a dev session by the template id (unforked)", () => {
		expect(classifySessionKind({ workflowId: DEV_SESSION_WORKFLOW_ID })).toBe(
			"dev",
		);
	});

	it("classifies a dev session by the resolved (project-forked) workflow id", () => {
		expect(classifySessionKind({ workflowId: "wf-dev-42" }, "wf-dev-42")).toBe(
			"dev",
		);
	});

	it("prefers dev over experiment/workflow", () => {
		// a dev session whose agent happens to be experiment-forked is still dev
		expect(
			classifySessionKind(
				{ workflowId: "wf-dev-42", agentSlug: "exp-x", workflowExecutionId: "e" },
				"wf-dev-42",
			),
		).toBe("dev");
	});

	it("does not classify as dev when the resolved id does not match", () => {
		expect(classifySessionKind({ workflowId: "wf-other" }, "wf-dev-42")).toBe(
			"workflow",
		);
	});
});

describe("isSessionKind", () => {
	it("guards the kind union", () => {
		expect(isSessionKind("dev")).toBe(true);
		expect(isSessionKind("interactive")).toBe(true);
		expect(isSessionKind("nope")).toBe(false);
	});
});
