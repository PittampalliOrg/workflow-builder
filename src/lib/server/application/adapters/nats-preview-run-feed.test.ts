import { describe, expect, it, vi } from "vitest";
import {
	NatsPreviewRunFeed,
	decodePreviewRunEvent,
} from "$lib/server/application/adapters/nats-preview-run-feed";
import {
	previewStreamName,
	previewWorkflowEventsSubject,
} from "$lib/server/nats-client";
import type { PreviewRunTarget } from "$lib/server/application/ports";

describe("preview stream/subject scheme (verified live on dev)", () => {
	it("matches the runner.sh stream name and Dapr subject prefix", () => {
		expect(previewStreamName("gan-codex")).toBe("ORCHESTRATOR-gan-codex");
		expect(previewWorkflowEventsSubject("gan-codex")).toBe("wbpreview-gan-codex.>");
	});
});

const preview: PreviewRunTarget = { name: "pr-1", url: "https://wfb-pr-1.example", pool: null };

describe("decodePreviewRunEvent", () => {
	it("decodes a direct orchestrator workflow event", () => {
		const event = decodePreviewRunEvent(
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
		const event = decodePreviewRunEvent(
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
		const event = decodePreviewRunEvent(
			{ data: JSON.stringify({ type: "workflow.failed", data: { executionId: "e3", error: "boom" } }) },
			preview,
		);
		expect(event?.status).toBe("failed");
		expect(event?.message).toBe("boom");
	});

	it("extracts phase + progress", () => {
		const event = decodePreviewRunEvent(
			{ type: "workflow.phase.changed", data: { executionId: "e4", phase: "running", progress: 42 } },
			preview,
		);
		expect(event).toMatchObject({ status: "running", phase: "running", progress: 42 });
	});

	it("returns null for non-workflow events", () => {
		expect(decodePreviewRunEvent({ type: "session.updated", data: {} }, preview)).toBeNull();
		expect(decodePreviewRunEvent({ nope: true }, preview)).toBeNull();
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

describe("NatsPreviewRunFeed.subscribe", () => {
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

		const feed = new NatsPreviewRunFeed({
			jetStream: async () => ({ consumers: { get: consumersGet } }) as never,
			jetStreamManager: async () => ({ streams: { info: streamsInfo } }) as never,
		});

		const events: unknown[] = [];
		const unsubscribe = await feed.subscribe({
			previews: [
				{ name: "present", url: null, pool: null },
				{ name: "missing", url: null, pool: null },
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

	it("keys a claimed pool member on the POOL stream/subject, event on the alias", async () => {
		const messages = fakeMessages([
			{ type: "workflow.started", data: { executionId: "ex1" } },
		]);
		const consume = vi.fn(async () => messages);
		const consumersGet = vi.fn(async () => ({ consume }));
		const streamsInfo = vi.fn(async () => ({}));

		const feed = new NatsPreviewRunFeed({
			jetStream: async () => ({ consumers: { get: consumersGet } }) as never,
			jetStreamManager: async () => ({ streams: { info: streamsInfo } }) as never,
		});

		const events: Array<Record<string, unknown>> = [];
		const unsubscribe = await feed.subscribe({
			// alias "gan-claim" claimed from warm-pool member "pool-3".
			previews: [{ name: "gan-claim", url: "https://wfb-gan-claim.example", pool: "pool-3" }],
			onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
		});
		await new Promise((r) => setTimeout(r, 10));

		// Stream + consumer keyed on the POOL name (where the baked orchestrator emits),
		// NOT the claimed alias.
		expect(streamsInfo).toHaveBeenCalledWith("ORCHESTRATOR-pool-3");
		expect(consumersGet).toHaveBeenCalledWith(
			"ORCHESTRATOR-pool-3",
			expect.objectContaining({ filterSubjects: "wbpreview-pool-3.>" }),
		);
		// But the surfaced event carries the ALIAS as display name + deep-link source.
		expect(events[0]).toMatchObject({
			previewName: "gan-claim",
			previewUrl: "https://wfb-gan-claim.example",
			eventType: "workflow.started",
		});

		await unsubscribe();
	});
});
