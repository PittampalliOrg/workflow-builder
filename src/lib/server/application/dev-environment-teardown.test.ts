import { describe, expect, it, vi } from "vitest";

import { ApplicationDevEnvironmentTeardownService } from "./dev-environment-teardown";

const EXECUTION_ID = "exec-1";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const SERVICES = ["workflow-builder", "workflow-orchestrator"] as const;
const GENERATION = "generation-1";
const BUILDER_DIGEST = `sha256:${"a".repeat(64)}` as const;
const ORCHESTRATOR_DIGEST = `sha256:${"b".repeat(64)}` as const;
const BASE_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);

const environment = {
	executionId: EXECUTION_ID,
	service: SERVICES[0],
	sessionId: "session-1",
	runStatus: "running",
};

const freezeReceipt = {
	executionId: EXECUTION_ID,
	generation: GENERATION,
	services: [
		{
			service: SERVICES[0],
			generation: GENERATION,
			contentSha256: BUILDER_DIGEST,
		},
		{
			service: SERVICES[1],
			generation: GENERATION,
			contentSha256: ORCHESTRATOR_DIGEST,
		},
	],
} as const;

const promotionReceipt = {
	receiptId: "pspr-receipt-1",
	centralArtifactId: "central-artifact-1",
	repository: "PittampalliOrg/workflow-builder",
	pullRequestNumber: 42,
	prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
	branch: "preview-feature-exec-1",
	baseSha: BASE_SHA,
	headSha: HEAD_SHA,
	commitSha: HEAD_SHA,
	draft: true,
	mode: "pr",
} as const;

function sourceArtifact(
	overrides: {
		id?: string;
		inlinePayload?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
		createdAt?: Date;
	} = {},
): Record<string, any> {
	return {
		id: overrides.id ?? "artifact-1",
		workflowExecutionId: EXECUTION_ID,
		kind: "source-bundle",
		fileId: "file-1",
		inlinePayload: overrides.inlinePayload ?? {
			tier: "tar-overlay-set",
			captureProtocol: "atomic-generation-v2",
			acceptanceEligible: true,
			generation: GENERATION,
			services: [...SERVICES],
			overlayDigests: {
				[SERVICES[0]]: BUILDER_DIGEST,
				[SERVICES[1]]: ORCHESTRATOR_DIGEST,
			},
		},
		metadata: overrides.metadata ?? {},
		createdAt: overrides.createdAt ?? new Date("2026-07-14T00:00:01.000Z"),
	};
}

function teardownMarker(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 2,
		executionId: EXECUTION_ID,
		artifactId: "artifact-1",
		receiptId: promotionReceipt.receiptId,
		centralArtifactId: promotionReceipt.centralArtifactId,
		repository: promotionReceipt.repository,
		pullRequestNumber: promotionReceipt.pullRequestNumber,
		prUrl: promotionReceipt.prUrl,
		branch: promotionReceipt.branch,
		headSha: promotionReceipt.headSha,
		generation: GENERATION,
		services: freezeReceipt.services.map((receipt) => ({ ...receipt })),
		requestedAt: "2026-07-14T00:00:03.000Z",
		requestedBy: USER_ID,
		...overrides,
	};
}

function captureResponse(artifactId = "artifact-1") {
	return {
		status: "ok" as const,
		httpStatus: 200 as const,
		body: {
			action: "capture" as const,
			ok: true as const,
			artifactId,
			services: SERVICES.map((service) => ({ service, ok: true })),
		},
	};
}

function promotionResponse(artifactId = "artifact-1") {
	return {
		status: "ok" as const,
		httpStatus: 200 as const,
		body: {
			action: "promote" as const,
			ok: true as const,
			artifactId,
			receiptId: promotionReceipt.receiptId,
			services: [...SERVICES],
			branch: promotionReceipt.branch,
			prUrl: promotionReceipt.prUrl,
			pullRequest: {
				repository: promotionReceipt.repository,
				number: promotionReceipt.pullRequestNumber,
			},
			draft: true as const,
		},
	};
}

function makeHarness() {
	const artifact = sourceArtifact();
	const artifacts: Array<Record<string, any>> = [];
	const workflowData = {
		getDevEnvironmentOrPending: vi.fn(async (): Promise<any> => environment),
		getDevEnvironmentTeardownTarget: vi.fn(async (): Promise<any> => null),
		getScopedExecutionById: vi.fn(async (): Promise<any> => ({
			id: EXECUTION_ID,
			input: { services: [...SERVICES] },
		})),
		listDevEnvironmentGroups: vi.fn(async (): Promise<any[]> => [
			{
				executionId: EXECUTION_ID,
				services: SERVICES.map((service) => ({ service })),
				primary: environment,
			},
		]),
		isPlatformAdmin: vi.fn(async () => true),
		listWorkflowArtifactsByExecutionId: vi.fn(async () => artifacts),
		getWorkflowArtifactForExecution: vi.fn(async ({ artifactId }: any) =>
			artifactId === artifact.id ? artifact : null,
		),
		mergeWorkflowArtifactMetadata: vi.fn(async (input: any) => {
			if (
				input.ifAbsentMetadataKey &&
				Object.hasOwn(artifact.metadata, input.ifAbsentMetadataKey)
			) {
				return null;
			}
			artifact.metadata = { ...artifact.metadata, ...input.patch };
			artifacts.splice(0, artifacts.length, artifact);
			return artifact;
		}),
	};
	const continuation = {
		continue: vi.fn(async (input: any): Promise<any> => {
			if (input.action.action === "promote") {
				artifact.metadata = {
					...artifact.metadata,
					promotion: { ...promotionReceipt },
				};
				return promotionResponse(artifact.id);
			}
			return captureResponse(artifact.id);
		}),
	};
	const previews = {
		freezeSourcesForTeardown: vi.fn(async (): Promise<any> => freezeReceipt),
		teardown: vi.fn(async (): Promise<any> => ({
			ok: true,
			complete: false,
			pending: true,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		})),
	};
	const sessions = {
		stopSession: vi.fn(async (): Promise<any> => ({ confirmed: true, state: "confirmed" })),
	};
	const executions = {
		stopExecution: vi.fn(async (): Promise<any> => ({
			confirmed: true,
			state: "confirmed",
		})),
	};
	const service = new ApplicationDevEnvironmentTeardownService({
		workflowData,
		continuation,
		previews,
		sessions,
		executions,
		now: () => new Date("2026-07-14T00:00:03.000Z"),
	} as never);

	return {
		service,
		artifact,
		artifacts,
		workflowData,
		continuation,
		previews,
		sessions,
		executions,
	};
}

function teardown(
	harness: ReturnType<typeof makeHarness>,
	overrides: Record<string, unknown> = {},
) {
	return harness.service.teardown({
		executionId: EXECUTION_ID,
		userId: USER_ID,
		projectId: PROJECT_ID,
		...overrides,
	});
}

function expectNoDestructiveWork(harness: ReturnType<typeof makeHarness>) {
	expect(harness.continuation.continue).not.toHaveBeenCalled();
	expect(harness.previews.teardown).not.toHaveBeenCalled();
	expect(harness.sessions.stopSession).not.toHaveBeenCalled();
	expect(harness.executions.stopExecution).not.toHaveBeenCalled();
}

describe("ApplicationDevEnvironmentTeardownService", () => {
	it("freezes the trusted exact service set before capture and teardown", async () => {
		const harness = makeHarness();
		harness.workflowData.getScopedExecutionById.mockResolvedValueOnce({
			id: EXECUTION_ID,
			input: { services: [SERVICES[1], SERVICES[0]] },
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({ status: "ok", httpStatus: 202 });
		expect(harness.previews.freezeSourcesForTeardown).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			services: [...SERVICES],
		});
		expect(harness.continuation.continue).toHaveBeenNthCalledWith(1, {
			executionId: EXECUTION_ID,
			userId: USER_ID,
			projectId: PROJECT_ID,
			action: { action: "capture", services: [...SERVICES] },
		});
		expect(
			harness.previews.freezeSourcesForTeardown.mock.invocationCallOrder[0],
		).toBeLessThan(harness.continuation.continue.mock.invocationCallOrder[0]);
		expect(
			harness.continuation.continue.mock.invocationCallOrder[0],
		).toBeLessThan(harness.previews.teardown.mock.invocationCallOrder[0]);
		expect(harness.previews.teardown).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			sourceCheckpoint: expect.objectContaining({
				status: "promoted",
				artifactId: harness.artifact.id,
				generation: GENERATION,
				services: freezeReceipt.services,
			}),
		});
	});

	it.each([
		["partial", [{ service: SERVICES[0] }]],
		[
			"extra",
			[
				...SERVICES.map((service) => ({ service })),
				{ service: "mcp-gateway" },
			],
		],
		[
			"duplicate",
			[
				{ service: SERVICES[0] },
				{ service: SERVICES[0] },
				{ service: SERVICES[1] },
			],
		],
	])("fails closed when active rows are %s", async (_name, rows) => {
		const harness = makeHarness();
		harness.workflowData.listDevEnvironmentGroups.mockResolvedValueOnce([
			{
				executionId: EXECUTION_ID,
				services: rows,
				primary: environment,
			},
		]);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("service set is incomplete") },
		});
		expect(harness.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expectNoDestructiveWork(harness);
	});

	it.each([
		["duplicate", { services: [SERVICES[0], SERVICES[0]] }],
		["empty", { services: [] }],
		["whitespace", { services: [` ${SERVICES[0]}`, SERVICES[1]] }],
		["invalid characters", { services: [SERVICES[0], "bad/service"] }],
		["wrong type", { services: SERVICES[0] }],
		["missing", {}],
	])("fails closed for %s trusted execution input", async (_name, input) => {
		const harness = makeHarness();
		harness.workflowData.getScopedExecutionById.mockResolvedValueOnce({
			id: EXECUTION_ID,
			input,
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({ status: "error", httpStatus: 409 });
		expect(harness.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expectNoDestructiveWork(harness);
	});

	it("fails closed when freezing throws", async () => {
		const harness = makeHarness();
		harness.previews.freezeSourcesForTeardown.mockRejectedValueOnce(
			new Error("receiver unavailable"),
		);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("receiver unavailable") },
		});
		expect(harness.continuation.continue).not.toHaveBeenCalled();
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it.each([
		["wrong execution", { ...freezeReceipt, executionId: "exec-other" }],
		["invalid generation", { ...freezeReceipt, generation: "bad generation" }],
		[
			"mixed generations",
			{
				...freezeReceipt,
				services: [
					freezeReceipt.services[0],
					{ ...freezeReceipt.services[1], generation: "generation-2" },
				],
			},
		],
		[
			"missing service",
			{ ...freezeReceipt, services: [freezeReceipt.services[0]] },
		],
		[
			"duplicate service",
			{
				...freezeReceipt,
				services: [freezeReceipt.services[0], freezeReceipt.services[0]],
			},
		],
		[
			"invalid digest",
			{
				...freezeReceipt,
				services: [
					{ ...freezeReceipt.services[0], contentSha256: "sha256:nope" },
					freezeReceipt.services[1],
				],
			},
		],
	])("rejects an invalid freeze receipt: %s", async (_name, receipt) => {
		const harness = makeHarness();
		harness.previews.freezeSourcesForTeardown.mockResolvedValueOnce(receipt as never);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("freeze receipt is invalid") },
		});
		expect(harness.continuation.continue).not.toHaveBeenCalled();
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it.each([
		[
			"generation",
			{
				...sourceArtifact().inlinePayload,
				generation: "generation-2",
			},
		],
		[
			"service set",
			{
				...sourceArtifact().inlinePayload,
				services: [SERVICES[0]],
			},
		],
	])("rejects a captured artifact with mismatched %s", async (_name, payload) => {
		const harness = makeHarness();
		harness.artifact.inlinePayload = payload;

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("does not match the frozen") },
		});
		expect(harness.continuation.continue).toHaveBeenCalledTimes(1);
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("does not teardown when capture fails", async () => {
		const harness = makeHarness();
		harness.continuation.continue.mockResolvedValueOnce({
			status: "error",
			httpStatus: 502,
			message: "capture broker unavailable",
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("capture broker unavailable") },
		});
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("does not teardown when promotion fails", async () => {
		const harness = makeHarness();
		harness.continuation.continue.mockImplementation(async (input: any) =>
			input.action.action === "capture"
				? captureResponse(harness.artifact.id)
				: {
						status: "error",
						httpStatus: 502,
						message: "promotion broker unavailable",
					},
		);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("promotion broker unavailable") },
		});
		expect(harness.workflowData.mergeWorkflowArtifactMetadata).not.toHaveBeenCalled();
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("does not teardown when the persisted promotion receipt cannot be verified", async () => {
		const harness = makeHarness();
		harness.continuation.continue.mockImplementation(async (input: any) => {
			if (input.action.action === "capture") return captureResponse();
			harness.artifact.metadata = {
				promotion: { ...promotionReceipt, headSha: "e".repeat(40) },
			};
			return promotionResponse();
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("could not be verified") },
		});
		expect(harness.workflowData.mergeWorkflowArtifactMetadata).not.toHaveBeenCalled();
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("does not teardown when the receipt marker cannot be persisted", async () => {
		const harness = makeHarness();
		harness.workflowData.mergeWorkflowArtifactMetadata.mockResolvedValueOnce(null);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { error: expect.stringContaining("could not be recorded") },
		});
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("reuses only an exact v2 frozen checkpoint on retry", async () => {
		const harness = makeHarness();
		harness.workflowData.listDevEnvironmentGroups.mockResolvedValueOnce([
			{
				executionId: EXECUTION_ID,
				services: [{ service: SERVICES[0] }],
				primary: environment,
			},
		]);
		harness.artifact.metadata = {
			promotion: { ...promotionReceipt },
			teardownCheckpoint: teardownMarker(),
		};
		harness.artifacts.push(harness.artifact);

		const result = await teardown(harness);

		expect(result).toMatchObject({ status: "ok", httpStatus: 202 });
		expect(harness.workflowData.listDevEnvironmentGroups).not.toHaveBeenCalled();
		expect(harness.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expect(harness.continuation.continue).not.toHaveBeenCalled();
		expect(harness.workflowData.mergeWorkflowArtifactMetadata).not.toHaveBeenCalled();
		expect(harness.previews.teardown).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			sourceCheckpoint: expect.objectContaining({
				artifactId: harness.artifact.id,
				generation: GENERATION,
				services: freezeReceipt.services,
			}),
		});
	});

	it.each([
		["generation", teardownMarker({ generation: "generation-0" })],
		["receipt identity", teardownMarker({ receiptId: "pspr-stale" })],
	])("does not reuse a stale v2 marker with different %s", async (_name, marker) => {
		const harness = makeHarness();
		harness.artifact.metadata = {
			promotion: { ...promotionReceipt },
			teardownCheckpoint: marker,
		};
		harness.artifacts.push(harness.artifact);

		const result = await teardown(harness);

		expect(result).toMatchObject({ status: "error", httpStatus: 409 });
		expect(harness.continuation.continue).toHaveBeenCalledWith(
			expect.objectContaining({ action: { action: "capture", services: [...SERVICES] } }),
		);
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("allows only a platform admin to discard uncaptured changes", async () => {
		const denied = makeHarness();
		denied.workflowData.isPlatformAdmin.mockResolvedValueOnce(false);

		const deniedResult = await teardown(denied, { discardUncaptured: true });

		expect(deniedResult).toMatchObject({ status: "error", httpStatus: 403 });
		expect(denied.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expectNoDestructiveWork(denied);

		const allowed = makeHarness();
		const allowedResult = await teardown(allowed, { discardUncaptured: true });

		expect(allowedResult).toMatchObject({ status: "ok", httpStatus: 202 });
		expect(allowed.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expect(allowed.continuation.continue).not.toHaveBeenCalled();
		expect(allowed.previews.teardown).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			sourceCheckpoint: { status: "discard-authorized" },
		});
	});

	it("authorizes checkpoint-preserving teardown before establishing a source freeze", async () => {
		const harness = makeHarness();
		harness.workflowData.isPlatformAdmin.mockResolvedValueOnce(false);

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 403,
			body: { error: expect.stringContaining("platform administrator") },
		});
		expect(harness.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expect(harness.continuation.continue).not.toHaveBeenCalled();
		expect(harness.previews.teardown).not.toHaveBeenCalled();
	});

	it("resumes teardown from a scoped tombstone without freezing or recapturing", async () => {
		const harness = makeHarness();
		harness.workflowData.getDevEnvironmentOrPending.mockResolvedValueOnce(null);
		harness.workflowData.getDevEnvironmentTeardownTarget.mockResolvedValueOnce({
			...environment,
			runStatus: "success",
		});
		harness.previews.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		harness.sessions.stopSession.mockResolvedValueOnce({
			confirmed: true,
			notFound: true,
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "ok",
			httpStatus: 200,
			body: { sessionStopped: "notFound", runStopped: null },
		});
		expect(harness.workflowData.getDevEnvironmentTeardownTarget).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			projectId: PROJECT_ID,
		});
		expect(harness.previews.freezeSourcesForTeardown).not.toHaveBeenCalled();
		expect(harness.continuation.continue).not.toHaveBeenCalled();
		expect(harness.previews.teardown).toHaveBeenCalledWith({
			executionId: EXECUTION_ID,
			sourceCheckpoint: { status: "teardown-resume" },
		});
	});

	it("returns 200 when preview and lifecycle cleanup are confirmed", async () => {
		const harness = makeHarness();
		harness.previews.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "ok",
			httpStatus: 200,
			body: {
				ok: true,
				complete: true,
				pending: false,
				sessionStopped: "confirmed",
				runStopped: "confirmed",
			},
		});
		expect(harness.sessions.stopSession).toHaveBeenCalledWith("session-1", {
			mode: "purge",
			reason: "Dev environment torn down by user",
		});
		expect(harness.executions.stopExecution).toHaveBeenCalledWith(EXECUTION_ID, {
			mode: "purge",
			reason: "Dev environment torn down by user",
		});
	});

	it("returns 202 while either lifecycle controller is still stopping", async () => {
		const harness = makeHarness();
		harness.previews.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		harness.sessions.stopSession.mockResolvedValueOnce({
			confirmed: false,
			state: "stopping",
		});

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "ok",
			httpStatus: 202,
			body: {
				ok: true,
				complete: false,
				pending: true,
				sessionStopped: "stopping",
				runStopped: "confirmed",
			},
		});
	});

	it("returns 503 and incomplete when lifecycle cleanup errors", async () => {
		const harness = makeHarness();
		harness.previews.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		harness.sessions.stopSession.mockRejectedValueOnce(new Error("Dapr unavailable"));

		const result = await teardown(harness);

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 503,
			body: {
				ok: false,
				complete: false,
				pending: false,
				error: expect.stringContaining("Dapr unavailable"),
			},
		});
	});
});
