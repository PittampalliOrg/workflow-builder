import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const environment = {
		executionId: "exec-1",
		sessionId: "session-1",
		runStatus: "running",
	};
	const workflowData = {
		getDevEnvironmentOrPending: vi.fn(
			async (): Promise<typeof environment | null> => environment,
		),
		getDevEnvironmentTeardownTarget: vi.fn(
			async (): Promise<typeof environment | null> => null,
		),
	};
	const previewEnvironmentProvisioner = {
		teardown: vi.fn(async () => ({
			ok: true,
			complete: false,
			pending: true,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		})),
	};
	const stopDurableRun = vi.fn(async () => ({ state: "confirmed" }));
	return {
		environment,
		workflowData,
		previewEnvironmentProvisioner,
		stopDurableRun,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		previewEnvironmentProvisioner: mocks.previewEnvironmentProvisioner,
	}),
}));

vi.mock("$lib/server/lifecycle", () => ({
	stopDurableRun: mocks.stopDurableRun,
}));

import { DELETE } from "./+server";

function event() {
	return {
		params: { executionId: "exec-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	};
}

describe("dev environment detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(
			mocks.environment,
		);
		mocks.workflowData.getDevEnvironmentTeardownTarget.mockResolvedValue(
			null,
		);
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValue({
			ok: true,
			complete: false,
			pending: true,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		mocks.stopDurableRun.mockResolvedValue({ state: "confirmed" });
	});

	it("scopes environment lookup through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getDevEnvironmentOrPending");
		expect(source).toContain(
			"workflowData.getDevEnvironmentTeardownTarget",
		);
		expect(source).toContain(
			"const complete = preview.complete && ok && !pending",
		);
		expect(source).toContain(
			"const pending = preview.pending || lifecyclePending",
		);
		expect(source).toContain("preview.complete && environment.sessionId");
		expect(source).toContain(
			"!ok ? 503 : pending ? 202 : complete ? 200 : 503",
		);
		expect(source).not.toContain("$lib/server/workflows/dev-environments");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns 202 before lifecycle stops when response-path cleanup is pending", async () => {
		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			complete: false,
			pending: true,
			sessionStopped: null,
			runStopped: null,
		});
		expect(mocks.stopDurableRun).not.toHaveBeenCalled();
	});

	it("performs lifecycle stops only after a later teardown proves completion", async () => {
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});

		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.stopDurableRun).toHaveBeenNthCalledWith(
			1,
			{ kind: "session", id: "session-1" },
			{ mode: "purge", reason: "Dev environment torn down by user" },
		);
		expect(mocks.stopDurableRun).toHaveBeenNthCalledWith(
			2,
			{ kind: "workflowExecution", id: "exec-1" },
			{ mode: "purge", reason: "Dev environment torn down by user" },
		);
	});

	it("returns 503 incomplete when lifecycle cleanup throws", async () => {
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		mocks.stopDurableRun.mockRejectedValue(new Error("Dapr unavailable"));

		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			complete: false,
			pending: false,
			error: expect.stringContaining("Dapr unavailable"),
		});
	});

	it("returns 202 incomplete while lifecycle cleanup is still converging", async () => {
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValueOnce({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		mocks.stopDurableRun.mockResolvedValue({ state: "stopping" });

		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			complete: false,
			pending: true,
			sessionStopped: "stopping",
			runStopped: "stopping",
		});
	});

	it("resumes lifecycle cleanup from a cleaned-row tombstone after a 202", async () => {
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValue({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		mocks.stopDurableRun.mockResolvedValue({ state: "stopping" });

		const first = (await DELETE(event() as never)) as Response;
		expect(first.status).toBe(202);

		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(null);
		mocks.workflowData.getDevEnvironmentTeardownTarget.mockResolvedValue({
			...mocks.environment,
			runStatus: "cancelled",
		});
		mocks.stopDurableRun.mockResolvedValue({ state: "confirmed" });
		const second = (await DELETE(event() as never)) as Response;

		expect(second.status).toBe(200);
		expect(
			mocks.workflowData.getDevEnvironmentTeardownTarget,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
		});
		expect(mocks.stopDurableRun).toHaveBeenLastCalledWith(
			{ kind: "session", id: "session-1" },
			{ mode: "purge", reason: "Dev environment torn down by user" },
		);
	});

	it("replays a final 200 from the tombstone after the prior response is lost", async () => {
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(null);
		mocks.workflowData.getDevEnvironmentTeardownTarget.mockResolvedValue({
			...mocks.environment,
			runStatus: "success",
		});
		mocks.previewEnvironmentProvisioner.teardown.mockResolvedValue({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		});
		mocks.stopDurableRun.mockResolvedValue({ state: "notFound" });

		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			complete: true,
			pending: false,
			sessionStopped: "notFound",
			runStopped: null,
		});
	});

	it("returns 404 when neither an active environment nor scoped tombstone exists", async () => {
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(null);
		mocks.workflowData.getDevEnvironmentTeardownTarget.mockResolvedValue(
			null,
		);

		await expect(DELETE(event() as never)).rejects.toMatchObject({
			status: 404,
		});
		expect(
			mocks.previewEnvironmentProvisioner.teardown,
		).not.toHaveBeenCalled();
	});
});
