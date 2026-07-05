import { describe, expect, it } from "vitest";
import { ApplicationPreviewRunFeedService } from "$lib/server/application/preview-run-feed";
import type {
	PreviewRunEvent,
	PreviewRunFeedPort,
} from "$lib/server/application/ports";

async function readSse(stream: ReadableStream<Uint8Array>, until: RegExp): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (let i = 0; i < 20 && !until.test(text); i++) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) text += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return text;
}

describe("ApplicationPreviewRunFeedService", () => {
	it("streams the preview list and per-preview run events as SSE", async () => {
		const runEvent: PreviewRunEvent = {
			previewName: "pr-1",
			previewUrl: null,
			eventType: "workflow.started",
			executionId: "e1",
			workflowId: null,
			workflowName: "WF",
			phase: null,
			progress: null,
			status: "running",
			message: null,
			at: "2026-07-04T00:00:00Z",
		};
		const feed: PreviewRunFeedPort = {
			async subscribe({ onEvent }) {
				onEvent(runEvent);
				return async () => {};
			},
		};
		const service = new ApplicationPreviewRunFeedService({
			feed,
			listPreviews: async () => [{ name: "pr-1", url: null, pool: null }],
			heartbeatIntervalMs: 60_000,
			previewRefreshIntervalMs: 60_000,
		});

		const text = await readSse(service.createEventStream(), /event: run/);

		expect(text).toContain("event: previews");
		expect(text).toContain('"name":"pr-1"');
		expect(text).toContain("event: run");
		expect(text).toContain('"eventType":"workflow.started"');
		expect(text).toContain('"executionId":"e1"');
	});

	it("emits no run subscription when there are no previews", async () => {
		let subscribed = false;
		const feed: PreviewRunFeedPort = {
			async subscribe() {
				subscribed = true;
				return async () => {};
			},
		};
		const service = new ApplicationPreviewRunFeedService({
			feed,
			listPreviews: async () => [],
			heartbeatIntervalMs: 60_000,
			previewRefreshIntervalMs: 60_000,
		});

		const text = await readSse(service.createEventStream(), /event: previews/);
		expect(text).toContain("event: previews");
		expect(subscribed).toBe(false);
	});
});
