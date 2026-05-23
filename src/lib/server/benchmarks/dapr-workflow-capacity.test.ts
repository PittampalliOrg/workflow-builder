import { afterEach, describe, expect, it } from "vitest";
import { __daprWorkflowCapacityForTest } from "./dapr-workflow-capacity";

describe("Dapr workflow capacity diagnostics", () => {
	afterEach(() => {
		delete process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS;
	});

	it("does not count normal actor placement logs as runtime pressure", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-23T11:47:26Z" level=info msg="Dissemination complete for version 75, unlocking disseminator workflow-builder/workflow-orchestrator" scope=dapr.runtime.actors.placement.loops.disseminator',
				'time="2026-05-23T11:51:39Z" level=info msg="Scheduler stream connected for [JOB_TARGET_TYPE_JOB JOB_TARGET_TYPE_ACTOR_REMINDER]" scope=dapr.runtime.scheduler.cluster',
			].join("\n"),
		);

		expect(counts).toEqual({ actorErrors: 0, reminderErrors: 0 });
	});

	it("counts actor and reminder error lines", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-23T11:57:00Z" level=error msg="actor reminder failed: no such instance exists"',
				'time="2026-05-23T11:57:01Z" level=warn msg="actor lock timeout while processing workflow"',
			].join("\n"),
		);

		expect(counts).toEqual({ actorErrors: 2, reminderErrors: 1 });
	});

	it("ignores terminating pods for readiness-sensitive pressure checks", () => {
		const ready = __daprWorkflowCapacityForTest.podIsReady({
			metadata: { name: "workflow-orchestrator-current" },
			status: {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			},
		});
		const terminating = __daprWorkflowCapacityForTest.podIsReady({
			metadata: {
				name: "workflow-orchestrator-old",
				deletionTimestamp: "2026-05-23T19:30:00Z",
			},
			status: {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			},
		});

		expect(ready).toBe(true);
		expect(terminating).toBe(false);
	});

	it("uses a short default Dapr log window but allows operator tuning", () => {
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(300);

		process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS = "45";
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(45);

		process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS = "0";
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(300);
	});
});
