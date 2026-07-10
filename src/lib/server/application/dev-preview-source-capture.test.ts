import { describe, expect, it, vi } from "vitest";
import { ApplicationDevPreviewSourceCaptureService } from "$lib/server/application/dev-preview-source-capture";
import type { DevPreviewSourceCapturePort } from "$lib/server/application/ports";

describe("ApplicationDevPreviewSourceCaptureService", () => {
	it("delegates an immutable multi-service capture through the outbound port", async () => {
		const capture: DevPreviewSourceCapturePort = {
			captureAll: vi.fn(async () => ({
				ok: true,
				artifactId: "artifact-1",
				captureId: "capture-1",
				generation: "generation-1",
				services: [
					{ service: "workflow-builder", ok: true },
					{ service: "function-router", ok: true },
				],
			})),
		};
		const service = new ApplicationDevPreviewSourceCaptureService({
			capture,
		});
		const input = {
			executionId: "exec-1",
			nodeId: "dev-preview",
			iteration: 3,
			expectedServices: ["workflow-builder", "function-router"],
		};

		await expect(
			service.captureAcceptanceCandidate(input),
		).resolves.toMatchObject({
			ok: true,
			artifactId: "artifact-1",
			captureId: "capture-1",
		});
		expect(capture.captureAll).toHaveBeenCalledOnce();
		expect(capture.captureAll).toHaveBeenCalledWith({
			...input,
			requireImmutableProvenance: true,
		});
	});
});
