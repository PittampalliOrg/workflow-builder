import { describe, expect, it, vi } from "vitest";
import {
	NatsCrossPreviewRunFeed,
	decodeCrossPreviewRunEvent,
} from "$lib/server/application/adapters/nats-cross-preview-run-feed";
import type { CrossPreviewTarget } from "$lib/server/application/ports";

const preview: CrossPreviewTarget = { name: "pr-1", url: "https://wfb-pr-1.example" };

describe("decodeCrossPreviewRunEvent", () => {
	it("decodes a direct orchestrator workflow event", () => {
		const event = decodeCrossPreviewRunEvent(
			{
				type: "workflow.started",
				data: { executionId: "e1", workflowId: "w1", workflowName: "WF", timestamp: "2026-07-04T00:00:00Z" },
			},
			preview,
		);
		expect(event).toMatchObject({
			previewName: "pr-1",
			previewUrl: "https://wfb-pr-1.example",
			eventType: "workflow.started",
			executionId: "e1",
			workflowId: "w1",
			workflowName: "WF",
			status: "running",
			at: "2026-07-04T00:00:00Z",
		});
	});

	it("unwraps a Dapr CloudEvent envelope", () => {
		const event = decodeCrossPreviewRunEvent(
			{
				type: "com.dapr.event.sent",
				time: "2026-07-04T01:00:00Z",
				data: { type: "workflow.completed", data: { executionId: "e2" } },
			},
			preview,
		);
		expect(event?.status).toBe("completed");
		expect(event?.executionId).toBe("e2");
		expect(event?.at).toBe("2026-07-04T01:00:00Z");
	});

	it("parses a JSON-string data payload and maps failure + error message", () => {
		const event = decodeCrossPreviewRunEvent(
			{ data: JSON.stringify({ type: "workflow.failed", data: { executionId: "e3", error: "boom" } }) },
			preview,
		);
		expect(event?.status).toBe("failed");
		expect(event?.message).toBe("boom");
	});

	it("extracts phase + progress", () => {
		const event = decodeCrossPreviewRunEvent(
			{ type: "workflow.phase.changed", data: { executionId: "e4", phase: "running", progress: 42 } },
			preview,
		);
		expect(event).toMatchObject({ status: "running", phase: "running", progress: 42 });
	});

	it("returns null for non-workflow events", () => {
		expect(decodeCrossPreviewRunEvent({ type: "session.updated", data: {} }, preview)).toBeNull();
		expect(decodeCrossPreviewRunEvent({ nope: true }, preview)).toBeNull();
	});
});

function fakeMessages(payloads: unknown[]) {
	const stop = vi.fn();
	return {
		stop,
		async *[Symbol.asyncIterator]() {
			for (const payload of payloads) yield { json: () => payload };
		},
	};
}

describe("NatsCrossPreviewRunFeed.subscribe", () => {
	it("opens a consumer per existing stream, decodes, and skips streams that don't exist", async () => {
		const messages = fakeMessages([
			{ type: "workflow.started", data: { executionId: "e1" } },
			{ type: "session.other", data: {} }, // filtered out by decode
		]);
		const consume = vi.fn(async () => messages);
		const consumersGet = vi.fn(async () => ({ consume }));
		const streamsInfo = vi.fn(async (stream: string) => {
			if (stream === "ORCHESTRATOR-missing") throw new Error("stream not found");
			return {};
		});

		const feed = new NatsCrossPreviewRunFeed({
			jetStream: async () => ({ consumers: { get: consumersGet } }) as never,
			jetStreamManager: async () => ({ streams: { info: streamsInfo } }) as never,
		});

		const events: unknown[] = [];
		const unsubscribe = await feed.subscribe({
			previews: [
				{ name: "present", url: null },
				{ name: "missing", url: null },
			],
			onEvent: (e) => events.push(e),
		});

		await new Promise((r) => setTimeout(r, 10));

		expect(streamsInfo).toHaveBeenCalledWith("ORCHESTRATOR-present");
		expect(streamsInfo).toHaveBeenCalledWith("ORCHESTRATOR-missing");
		// Only the present stream opens a consumer.
		expect(consumersGet).toHaveBeenCalledTimes(1);
		// Only the workflow.* event is surfaced.
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ previewName: "present", eventType: "workflow.started" });

		await unsubscribe();
		expect(messages.stop).toHaveBeenCalled();
	});
});
