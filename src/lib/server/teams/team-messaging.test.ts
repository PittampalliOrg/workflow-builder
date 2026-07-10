/**
 * team-messaging publish contract: every injectTeamMessage appends the durable
 * mailbox row (unchanged shape) and then publishes exactly one delivery trigger
 * to workflow.team-message — content stays OUT of the payload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendMock = vi.fn(async () => ({ id: "ev-1" }));
const publishMock = vi.fn(async () => {});
vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: { appendSessionEvent: appendMock },
		eventBus: { publish: publishMock },
	}),
}));

// Import AFTER the mock is registered.
import {
	injectTeamMessage,
	TEAM_MESSAGE_TOPIC,
} from "$lib/server/teams/team-messaging";

describe("injectTeamMessage", () => {
	beforeEach(() => {
		appendMock.mockClear();
		publishMock.mockClear();
	});

	it("appends the durable mailbox row then publishes the delivery trigger", async () => {
		await injectTeamMessage({
			recipientSessionId: "sess-1",
			fromName: "lead",
			content: "hello",
			kind: "teammate-message",
			sourceEventId: "team-msg:abc",
		});

		expect(appendMock).toHaveBeenCalledTimes(1);
		const [sessionId, event] = appendMock.mock.calls[0] as unknown as [
			string,
			{
				type: string;
				data: Record<string, unknown>;
				processedAt: Date | null;
				sourceEventId: string;
			},
		];
		expect(sessionId).toBe("sess-1");
		expect(event.type).toBe("user.message");
		expect(event.processedAt).toBeNull(); // claimable until raised
		expect(event.sourceEventId).toBe("team-msg:abc");
		expect(event.data).toMatchObject({
			origin: "teammate-message",
			fromAgent: "lead",
			content: [{ type: "text", text: "hello" }],
		});

		expect(publishMock).toHaveBeenCalledTimes(1);
		expect(publishMock).toHaveBeenCalledWith(TEAM_MESSAGE_TOPIC, {
			recipientSessionId: "sess-1",
			sourceEventId: "team-msg:abc",
			kind: "teammate-message",
		});
		// Content must NOT ride the topic — the subscriber claims durable rows.
		const payload = (publishMock.mock.calls[0] as unknown[])[1] as Record<
			string,
			unknown
		>;
		expect(payload.content).toBeUndefined();
		// Ordering: durable record before delivery trigger.
		expect(appendMock.mock.invocationCallOrder[0]).toBeLessThan(
			publishMock.mock.invocationCallOrder[0],
		);
	});

	it("propagates append failures without publishing", async () => {
		appendMock.mockRejectedValueOnce(new Error("db down"));
		await expect(
			injectTeamMessage({
				recipientSessionId: "sess-1",
				fromName: "lead",
				content: "x",
				kind: "team-idle",
				sourceEventId: "team-idle:1",
			}),
		).rejects.toThrow("db down");
		expect(publishMock).not.toHaveBeenCalled();
	});
});
