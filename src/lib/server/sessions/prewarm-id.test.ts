import { describe, it, expect } from "vitest";
import { reconstructChildSessionId } from "./prewarm-id";

/**
 * Sanitizer-drift guard. These expected values mirror the Python orchestrator's
 * deterministic id construction; if either side changes its format, identity-bound
 * prewarm silently stops adopting (wasted pod, no benefit). Keep in lockstep with:
 *   - app.py:3294        sw-{re.sub('[^a-z0-9-]','-', name.lower()).strip('-')[:40]}-exec-{id}
 *   - sw_workflow.py:1577 {instance_id}__{instance_prefix}__{re.sub('[^A-Za-z0-9_.-]','-',task)}__run__{index}
 */
describe("reconstructChildSessionId", () => {
	it("matches the orchestrator format for a simple dapr-agent-py entry node", () => {
		// Mirrors a real run id seen on ryzen, e.g. the gan-harness/run-diff fixtures:
		// sw-run-diff-verify-dapr-exec-<execId>__durable__dapr_write__run__0
		expect(
			reconstructChildSessionId({
				workflowName: "run-diff-verify-dapr",
				executionId: "PrO2_ofOh8iAJ_qaSdJT2",
				instancePrefix: "durable",
				taskName: "dapr_write",
			}),
		).toBe("sw-run-diff-verify-dapr-exec-PrO2_ofOh8iAJ_qaSdJT2__durable__dapr_write__run__0");
	});

	it("lowercases + replaces non [a-z0-9-] in the workflow name and trims leading/trailing dashes", () => {
		expect(
			reconstructChildSessionId({
				workflowName: "  My Cool Workflow! ",
				executionId: "exec1",
				instancePrefix: "durable",
				taskName: "agent",
			}),
		).toBe("sw-my-cool-workflow-exec-exec1__durable__agent__run__0");
	});

	it("truncates the safe workflow name to 40 chars", () => {
		const longName = "a".repeat(60);
		const id = reconstructChildSessionId({
			workflowName: longName,
			executionId: "e",
			instancePrefix: "durable",
			taskName: "t",
		});
		// "sw-" + 40 a's + "-exec-e__durable__t__run__0"
		expect(id).toBe(`sw-${"a".repeat(40)}-exec-e__durable__t__run__0`);
	});

	it("preserves _ . - in task names but replaces other chars", () => {
		expect(
			reconstructChildSessionId({
				workflowName: "wf",
				executionId: "e",
				instancePrefix: "durable",
				taskName: "negotiate/propose[0]",
			}),
		).toBe("sw-wf-exec-e__durable__negotiate-propose-0-__run__0");
	});

	it("honors a non-zero run index (loop re-entry)", () => {
		expect(
			reconstructChildSessionId({
				workflowName: "wf",
				executionId: "e",
				instancePrefix: "durable",
				taskName: "t",
				runIndex: 2,
			}),
		).toBe("sw-wf-exec-e__durable__t__run__2");
	});
});
