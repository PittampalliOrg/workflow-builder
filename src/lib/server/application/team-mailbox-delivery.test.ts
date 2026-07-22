import { describe, expect, it, vi } from "vitest";
import {
	ApplicationTeamMailboxDeliveryService,
	isTeamMailboxSessionEvent,
	TEAM_MAILBOX_DELIVERY_TOPIC,
} from "$lib/server/application/team-mailbox-delivery";
import type { EventBus, SessionEventLog } from "$lib/server/application/ports";
import type { SessionEventEnvelope } from "$lib/types/sessions";

function event(
	id: string,
	type: string,
	data: Record<string, unknown>,
): SessionEventEnvelope {
	return {
		id,
		sessionId: "session-1",
		sequence: Number(id.replace(/\D/g, "")) || 1,
		type,
		data,
		processedAt: null,
		sourceEventId: null,
		createdAt: "2026-07-21T00:00:00.000Z",
		timestamp: "2026-07-21T00:00:00.000Z",
	};
}

function service(pending: boolean) {
	const eventBus: EventBus = { publish: vi.fn(async () => {}) };
	const sessionEvents = {
		hasUnprocessedTeamEvents: vi.fn(async () => pending),
	} as Pick<SessionEventLog, "hasUnprocessedTeamEvents">;
	return {
		service: new ApplicationTeamMailboxDeliveryService({
			sessionEvents,
			eventBus,
		}),
		eventBus,
		sessionEvents,
	};
}

describe("ApplicationTeamMailboxDeliveryService", () => {
	it("keeps ordinary user bootstrap input and reserves team origins for the mailbox", () => {
		const { service: mailbox } = service(false);
		const prompt = event("event-1", "user.message", {
			type: "user.message",
			content: [{ type: "text", text: "initial prompt" }],
		});
		const goalInput = event("event-2", "user.message", {
			type: "user.message",
			origin: "goal-loop",
		});
		const teamEvents = [
			"teammate-message",
			"team-broadcast",
			"team-idle",
			"team-error",
		].map((origin, index) =>
			event(`event-${index + 3}`, "user.message", {
				type: "user.message",
				origin,
			}),
		);

		expect(teamEvents.every(isTeamMailboxSessionEvent)).toBe(true);
		expect(
			mailbox.initialUserEvents([
				prompt,
				goalInput,
				...teamEvents,
				event("event-7", "agent.message", {}),
			]),
		).toEqual([prompt.data, goalInput.data]);
	});

	it("publishes a delivery trigger only when the newly published runtime has mail", async () => {
		const empty = service(false);
		await expect(
			empty.service.requestDeliveryAfterRuntimePublished("session-1"),
		).resolves.toBe("empty");
		expect(empty.eventBus.publish).not.toHaveBeenCalled();

		const pending = service(true);
		await expect(
			pending.service.requestDeliveryAfterRuntimePublished("session-1"),
		).resolves.toBe("published");
		expect(pending.eventBus.publish).toHaveBeenCalledWith(
			TEAM_MAILBOX_DELIVERY_TOPIC,
			{
				recipientSessionId: "session-1",
				reason: "runtime-published",
			},
		);
	});
});
