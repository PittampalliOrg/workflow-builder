import { describe, expect, it, vi } from "vitest";
import { persistSourceBundle } from "./source-bundle";

function persistence() {
	let file = 0;
	return {
		createFile: vi.fn(async () => ({
			file: { id: `file-${++file}` },
			deduplicated: false,
		})),
		upsertWorkflowArtifact: vi.fn(async (input) => input),
	};
}

function input(captureId?: string) {
	return {
		executionId: "exec-1",
		userId: "user-1",
		projectId: "project-1",
		nodeId: "snapshot",
		iteration: 4,
		bytes: Buffer.from("overlay-set"),
		contentType: "application/gzip",
		meta: {
			tier: "tar-overlay-set",
			iteration: 4,
			...(captureId ? { captureId } : {}),
			captureProtocol: captureId ? "atomic-generation-v2" : "legacy",
			acceptanceEligible: Boolean(captureId),
			services: ["workflow-builder", "workflow-orchestrator"],
			generation: captureId ? "generation-1" : null,
			overlayDigests: captureId ? { "workflow-builder": `sha256:${"a".repeat(64)}` } : null,
			catalogDigest: captureId ? `sha256:${"b".repeat(64)}` : null,
			sourceRevision: captureId ? "c".repeat(40) : null,
			platformRevision: captureId ? "d".repeat(40) : null,
		},
	};
}

describe("source-bundle capture identity", () => {
	it("gives repeated same-iteration atomic captures distinct artifact ids", async () => {
		const store = persistence();
		const first = await persistSourceBundle(input("capture-1"), store as never);
		const second = await persistSourceBundle(input("capture-2"), store as never);

		expect(first.id).not.toBe(second.id);
		expect(first.fileId).not.toBe(second.fileId);
		expect(store.upsertWorkflowArtifact).toHaveBeenCalledTimes(2);
		const payload = store.upsertWorkflowArtifact.mock.calls[0]?.[0].inlinePayload;
		expect(payload).toMatchObject({
			captureId: "capture-1",
			captureProtocol: "atomic-generation-v2",
			acceptanceEligible: true,
			services: ["workflow-builder", "workflow-orchestrator"],
			generation: "generation-1",
			sourceRevision: "c".repeat(40),
			platformRevision: "d".repeat(40),
		});
	});

	it("keeps legacy deterministic identity when captureId is absent", async () => {
		const store = persistence();
		const first = await persistSourceBundle(input(), store as never);
		const second = await persistSourceBundle(input(), store as never);
		expect(first.id).toBe(second.id);
	});
});
