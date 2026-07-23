import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowBrowserEvidenceService } from "$lib/server/application/workflow-browser-evidence";

describe("ApplicationWorkflowBrowserEvidenceService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowBrowserEvidenceService
	>[0]["workflowData"];
	let service: ApplicationWorkflowBrowserEvidenceService;

	beforeEach(() => {
		workflowData = {
			listWorkflowBrowserArtifactsByExecutionId: vi.fn(async () => [
				browserArtifact(),
			]),
			getWorkflowBrowserBlobPayload: vi.fn(async () => ({
				payloadBase64: png(1440, 1000).toString("base64"),
				contentType: "image/png",
			})),
		};
		service = new ApplicationWorkflowBrowserEvidenceService({ workflowData });
	});

	it("attests execution-owned PNG refs and actual IHDR dimensions", async () => {
		await expect(
			service.verify({
				executionId: "exec-1",
				evidence: [
					{ storageRef: screenshotRef(), width: 1440, height: 1000 },
				],
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				ok: true,
				executionId: "exec-1",
				evidence: [
					{
						storageRef: screenshotRef(),
						width: 1440,
						height: 1000,
						artifactId: "bwf_1",
						contentType: "image/png",
						sizeBytes: 58,
					},
				],
			},
		});
	});

	it("rejects fabricated, cross-execution, and duplicate refs", async () => {
		for (const storageRef of [
			"workflow-browser-artifacts/exec-1/fabricated/screenshot.png",
			"workflow-browser-artifacts/exec-foreign/bwf_1/screenshot.png",
		]) {
			await expect(
				service.verify({
					executionId: "exec-1",
					evidence: [{ storageRef, width: 1440, height: 1000 }],
				}),
			).resolves.toMatchObject({ status: "error", httpStatus: 404 });
		}
		await expect(
			service.verify({
				executionId: "exec-1",
				evidence: [
					{ storageRef: screenshotRef(), width: 1440, height: 1000 },
					{ storageRef: screenshotRef(), width: 1440, height: 1000 },
				],
			}),
		).resolves.toMatchObject({ status: "error", httpStatus: 400 });
		expect(workflowData.getWorkflowBrowserBlobPayload).not.toHaveBeenCalled();
	});

	it("rejects header-only PNG bytes and false dimensions", async () => {
		vi.mocked(workflowData.getWorkflowBrowserBlobPayload)
			.mockResolvedValueOnce({
				payloadBase64: png(1440, 1000).subarray(0, 24).toString("base64"),
				contentType: "image/png",
			})
			.mockResolvedValueOnce({
				payloadBase64: png(390, 844).toString("base64"),
				contentType: "image/png",
			});
		const claim = {
			executionId: "exec-1",
			evidence: [
				{ storageRef: screenshotRef(), width: 1440, height: 1000 },
			],
		};
		await expect(service.verify(claim)).resolves.toMatchObject({
			status: "error",
			httpStatus: 422,
		});
		await expect(service.verify(claim)).resolves.toMatchObject({
			status: "error",
			httpStatus: 422,
			message: "Screenshot evidence dimensions do not match the claim",
		});
	});
});

function png(width: number, height: number): Buffer {
	const payload = Buffer.alloc(58);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(payload, 0);
	payload.writeUInt32BE(13, 8);
	payload.write("IHDR", 12, "ascii");
	payload.writeUInt32BE(width, 16);
	payload.writeUInt32BE(height, 20);
	payload.writeUInt32BE(1, 33);
	payload.write("IDAT", 37, "ascii");
	payload[41] = 1;
	payload.writeUInt32BE(0, 46);
	payload.write("IEND", 50, "ascii");
	return payload;
}

function screenshotRef(): string {
	return "workflow-browser-artifacts/exec-1/bwf_1/screenshot.png";
}

function browserArtifact() {
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
			assets: [
				{
					kind: "screenshot",
					storageRef: screenshotRef(),
					contentType: "image/png",
				},
			],
		},
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}
