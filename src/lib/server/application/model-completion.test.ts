import { describe, expect, it, vi } from "vitest";
import type { ModelCompletionPort } from "$lib/server/application/ports";
import { ApplicationModelCompletionService } from "./model-completion";

describe("ApplicationModelCompletionService", () => {
	it("delegates completion through the outbound port", async () => {
		const port: ModelCompletionPort = {
			isAvailable: vi.fn(() => true),
			complete: vi.fn(async () => "result"),
			generate: vi.fn(async () => ({ text: "result", steps: [] })),
		};
		const service = new ApplicationModelCompletionService(port);

		expect(service.isAvailable()).toBe(true);
		await expect(
			service.complete({
				maxOutputTokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		).resolves.toBe("result");
		expect(port.complete).toHaveBeenCalledOnce();
	});
});
