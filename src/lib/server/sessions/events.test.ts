import { describe, expect, it } from "vitest";

import {
	rowToEnvelope,
	sanitizeSessionEventDataForPostgres,
} from "./events";

describe("sanitizeSessionEventDataForPostgres", () => {
	it("removes NUL bytes from nested event payload strings", () => {
		const value = sanitizeSessionEventDataForPostgres({
			output: "system_u:system_r:pod_t:s0\u0000",
			content: [{ text: "ok\u0000done" }],
			"bad\u0000key": "value",
		});

		expect(value).toEqual({
			output: "system_u:system_r:pod_t:s0",
			content: [{ text: "okdone" }],
			badkey: "value",
		});
	});
});

describe("rowToEnvelope", () => {
	it("mirrors createdAt into timestamp for CMA-compatible event consumers", () => {
		const createdAt = new Date("2026-06-14T19:33:15.777Z");
		const envelope = rowToEnvelope({
			id: "sevt_test",
			sessionId: "session-1",
			sequence: 1,
			type: "session.turn_completed",
			data: { output_preview: "done" },
			processedAt: null,
			sourceEventId: "source-1",
			producerId: "codex-cli",
			producerEpoch: "epoch-1",
			createdAt,
		});

		expect(envelope.createdAt).toBe("2026-06-14T19:33:15.777Z");
		expect(envelope.timestamp).toBe(envelope.createdAt);
	});
});
