import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	upsertWorkflowArtifact: vi.fn(async () => ({ id: "artifact-1" })),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			upsertWorkflowArtifact: mocks.upsertWorkflowArtifact,
		},
	}),
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		params: { executionId: "exec-1" },
		request: new Request("http://localhost/internal/artifacts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	};
}

async function statusOf(run: unknown): Promise<number> {
	try {
		return ((await run) as Response).status;
	} catch (cause) {
		return (cause as { status?: number }).status ?? 0;
	}
}

describe("generic workflow artifact ingress", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejects forged source bundles and nested acceptance attestations", async () => {
		await expect(
			statusOf(
				POST(
					event({
						id: "forged-source",
						kind: "source-bundle",
						title: "forged",
						inlinePayload: { acceptanceEligible: true },
					}) as never,
				),
			),
		).resolves.toBe(400);
		await expect(
			statusOf(
				POST(
					event({
						id: "forged-token",
						kind: "result",
						title: "forged",
						inlinePayload: { ok: true },
						metadata: {
							nested: { previewAcceptanceAttestationV1: "forged" },
						},
					}) as never,
				),
			),
		).resolves.toBe(400);
		expect(mocks.upsertWorkflowArtifact).not.toHaveBeenCalled();
	});

	it("continues to accept ordinary artifacts", async () => {
		const response = (await POST(
			event({
				id: "result-1",
				kind: "result",
				title: "Result",
				inlinePayload: { ok: true },
				metadata: { producer: "workflow-orchestrator" },
			}) as never,
		)) as Response;
		expect(response.status).toBe(200);
		expect(mocks.upsertWorkflowArtifact).toHaveBeenCalledOnce();
	});
});
