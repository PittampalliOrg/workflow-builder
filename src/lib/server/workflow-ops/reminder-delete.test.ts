import { describe, expect, it } from "vitest";
import {
	WORKFLOW_ORCHESTRATOR_ACTOR_TYPE,
	validateWorkflowActorReminderDeleteInput,
} from "../workflow-ops";

describe("workflow actor reminder recovery validation", () => {
	it("accepts explicit new-event reminder names for the selected workflow actor", () => {
		expect(
			validateWorkflowActorReminderDeleteInput("workflow-1", {
				reminderNames: [" new-event-abc ", "new-event-def"],
				reason: "operator recovery",
			}),
		).toEqual({
			actorId: "workflow-1",
			actorType: WORKFLOW_ORCHESTRATOR_ACTOR_TYPE,
			reminderNames: ["new-event-abc", "new-event-def"],
			reason: "operator recovery",
		});
	});

	it("rejects non-new-event reminder names", () => {
		expectHttpError(() =>
			validateWorkflowActorReminderDeleteInput("workflow-1", {
				reminderNames: ["delete-all"],
			}),
			400,
			"new-event",
		);
	});

	it("rejects mismatched actor ids", () => {
		expectHttpError(() =>
			validateWorkflowActorReminderDeleteInput("workflow-1", {
				actorId: "workflow-2",
				reminderNames: ["new-event-abc"],
			}),
			400,
			"actorId",
		);
	});

	it("rejects non-workflow actor types", () => {
		expectHttpError(() =>
			validateWorkflowActorReminderDeleteInput("workflow-1", {
				actorType: "some.other.actor",
				reminderNames: ["new-event-abc"],
			}),
			400,
			"actorType",
		);
	});
});

function expectHttpError(fn: () => unknown, status: number, message: string) {
	try {
		fn();
		throw new Error("Expected function to throw");
	} catch (err) {
		expect(err).toMatchObject({
			status,
			body: { message: expect.stringContaining(message) },
		});
	}
}
