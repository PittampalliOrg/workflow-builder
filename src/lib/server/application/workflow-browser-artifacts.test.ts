import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowBrowserArtifactsService } from "$lib/server/application/workflow-browser-artifacts";

describe("ApplicationWorkflowBrowserArtifactsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowBrowserArtifactsService
	>[0]["workflowData"];
	let service: ApplicationWorkflowBrowserArtifactsService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			listWorkflowBrowserArtifactsByExecutionId: vi.fn(async () => [
				browserArtifact(),
			]),
			getWorkflowBrowserBlobPayload: vi.fn(async () => ({
				payloadBase64: Buffer.from("pixels").toString("base64"),
				contentType: "image/png",
			})),
		};
		service = new ApplicationWorkflowBrowserArtifactsService({ workflowData });
	});

	it("returns only screenshot payloads referenced by the scoped execution manifest", async () => {
		await expect(
			service.getScreenshot({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				storageRef: screenshotRef(),
				maxBytes: 1024,
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: {
				storageRef: screenshotRef(),
				contentType: "image/png",
				sizeBytes: 6,
			},
		});
		expect(workflowData.getWorkflowBrowserBlobPayload).toHaveBeenCalledWith(
			screenshotRef(),
		);
	});

	it("does not dereference a storage ref outside the scoped execution manifest", async () => {
		await expect(
			service.getScreenshot({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			storageRef: metadataOnlyRef(),
				maxBytes: 1024,
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Screenshot not found",
		});
		expect(workflowData.getWorkflowBrowserBlobPayload).not.toHaveBeenCalled();
	});

	it("rejects non-image and oversized screenshot payloads", async () => {
		vi.mocked(workflowData.getWorkflowBrowserBlobPayload)
			.mockResolvedValueOnce({
				payloadBase64: Buffer.from("video").toString("base64"),
				contentType: "video/webm",
			})
			.mockResolvedValueOnce({
				payloadBase64: Buffer.from("too-large").toString("base64"),
				contentType: "image/png",
			});

		const input = {
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			storageRef: screenshotRef(),
			maxBytes: 100,
		};
		await expect(
			service.getScreenshot(input),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 404,
		});
		await expect(
			service.getScreenshot({ ...input, maxBytes: 4 }),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 413,
		});
	});

	it("does not authorize caller-controlled refs outside the execution namespace", async () => {
		vi.mocked(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).mockResolvedValueOnce([
			browserArtifact({
				assets: [
					{
						kind: "screenshot",
						storageRef:
							"workflow-browser-artifacts/exec-foreign/bwf_foreign/screenshot-1.png",
					},
				],
			}),
		]);

		await expect(
			service.getScreenshot({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				storageRef:
					"workflow-browser-artifacts/exec-foreign/bwf_foreign/screenshot-1.png",
				maxBytes: 1024,
			}),
		).resolves.toMatchObject({ status: "error", httpStatus: 404 });
		expect(workflowData.getWorkflowBrowserBlobPayload).not.toHaveBeenCalled();
	});

	it("requires a screenshot asset instead of an image-shaped non-screenshot ref", async () => {
		const traceRef = "workflow-browser-artifacts/exec-1/bwf_1/trace-1.png";
		vi.mocked(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).mockResolvedValueOnce([
			browserArtifact({ assets: [{ kind: "trace", storageRef: traceRef }] }),
		]);

		await expect(
			service.getScreenshot({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				storageRef: traceRef,
				maxBytes: 1024,
			}),
		).resolves.toMatchObject({ status: "error", httpStatus: 404 });
		expect(workflowData.getWorkflowBrowserBlobPayload).not.toHaveBeenCalled();
	});

	it("lists browser artifacts after scoped execution access", async () => {
		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: { artifacts: [browserArtifact()] },
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).toHaveBeenCalledWith("exec-1");
	});

	it("hides missing or out-of-scope executions before loading artifacts", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).not.toHaveBeenCalled();
	});
});

function screenshotRef() {
	return "workflow-browser-artifacts/exec-1/bwf_1/screenshot-1.png";
}

function metadataOnlyRef() {
	return "workflow-browser-artifacts/exec-1/bwf_1/screenshot-metadata.png";
}

function browserArtifact(
	overrides: { assets?: Array<Record<string, unknown>> } = {},
) {
	return {
		id: "bwf_1",
		workflowExecutionId: "exec-1",
		workflowId: "wf-1",
		nodeId: "browser",
		workspaceRef: null,
		artifactType: "capture_flow_v1" as const,
		artifactVersion: 1,
		status: "completed" as const,
		manifestJson: {
			assets: overrides.assets ?? [
				{
					kind: "screenshot",
					storageRef: screenshotRef(),
					contentType: "image/png",
				},
			],
			metadata: { storageRef: metadataOnlyRef() },
		},
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}
