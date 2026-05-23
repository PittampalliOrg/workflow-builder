import { describe, expect, it } from "vitest";
import { __daprWorkflowCapacityForTest } from "./dapr-workflow-capacity";

describe("Dapr workflow capacity diagnostics", () => {
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
});
