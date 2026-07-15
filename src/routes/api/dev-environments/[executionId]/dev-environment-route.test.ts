import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const environment = {
		executionId: "exec-1",
		workspaceRef: "workspace-1",
		service: "workflow-builder",
		browseUrl: "https://workflow-builder.example.test",
		podIP: "10.0.0.10",
		port: 3000,
		syncUrl: "http://10.0.0.10:3001",
		ready: true,
		needsDapr: false,
		daprAppId: null,
		sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
		sessionId: "session-1",
		sessionUrl: "/sessions/session-1",
		runStatus: "running",
		createdAt: "2026-07-14T00:00:00.000Z",
	};
	const sibling = {
		...environment,
		service: "workflow-orchestrator",
		browseUrl: "https://workflow-orchestrator.example.test",
	};
	const workflowData = {
		getDevEnvironmentOrPending: vi.fn(async () => environment),
		listDevEnvironmentGroups: vi.fn(async () => [
			{
				executionId: "exec-1",
				services: [environment, sibling],
				primary: environment,
				ready: true,
				sessionId: "session-1",
				sessionUrl: "/sessions/session-1",
				runStatus: "running",
				createdAt: "2026-07-14T00:00:00.000Z",
			},
		]),
	};
	const devEnvironmentTeardown = {
		teardown: vi.fn(async (): Promise<any> => ({
			status: "ok" as const,
			httpStatus: 202 as const,
			body: {
				ok: true,
				complete: false,
				pending: true,
				executionId: "exec-1",
				sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
			},
		})),
	};
	const getApplicationAdapters = vi.fn(() => ({
		workflowData,
		devEnvironmentTeardown,
	}));
	return {
		environment,
		sibling,
		workflowData,
		devEnvironmentTeardown,
		getApplicationAdapters,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: mocks.getApplicationAdapters,
}));

import { DELETE, GET } from "./+server";

function event(options: {
	query?: string;
	session?: { userId: string; projectId: string | null } | null;
} = {}) {
	return {
		params: { executionId: "exec-1" },
		locals: {
			session:
				options.session === undefined
					? { userId: "user-1", projectId: "project-1" }
					: options.session,
		},
		url: new URL(
			`http://localhost/api/dev-environments/exec-1${options.query ?? ""}`,
		),
	};
}

describe("dev environment detail transport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(
			mocks.environment,
		);
		mocks.workflowData.listDevEnvironmentGroups.mockResolvedValue([
			{
				executionId: "exec-1",
				services: [mocks.environment, mocks.sibling],
				primary: mocks.environment,
				ready: true,
				sessionId: "session-1",
				sessionUrl: "/sessions/session-1",
				runStatus: "running",
				createdAt: "2026-07-14T00:00:00.000Z",
			},
		]);
		mocks.devEnvironmentTeardown.teardown.mockResolvedValue({
			status: "ok",
			httpStatus: 202,
			body: {
				ok: true,
				complete: false,
				pending: true,
				executionId: "exec-1",
				sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
			},
		});
	});

	it("rejects unauthenticated GET and DELETE requests before composition", async () => {
		await expect(GET(event({ session: null }) as never)).rejects.toMatchObject({
			status: 401,
		});
		await expect(
			DELETE(event({ session: null }) as never),
		).rejects.toMatchObject({ status: 401 });
		expect(mocks.getApplicationAdapters).not.toHaveBeenCalled();
	});

	it("reads the environment and grouped services in the caller project scope", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			environment: mocks.environment,
			services: [mocks.environment, mocks.sibling],
		});
		expect(
			mocks.workflowData.getDevEnvironmentOrPending,
		).toHaveBeenCalledExactlyOnceWith({
			executionId: "exec-1",
			projectId: "project-1",
		});
		expect(mocks.workflowData.listDevEnvironmentGroups).toHaveBeenCalledExactlyOnceWith(
			{ projectId: "project-1" },
		);
	});

	it.each([
		["", false],
		["?discardUncaptured=true", true],
		["?discardUncaptured=TRUE", false],
	])("delegates DELETE with the exact command for %s", async (query, discardUncaptured) => {
		await DELETE(event({ query }) as never);

		expect(mocks.devEnvironmentTeardown.teardown).toHaveBeenCalledExactlyOnceWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			discardUncaptured,
		});
	});

	it("passes the application status and body through unchanged", async () => {
		const body = {
			ok: false,
			complete: false,
			pending: false,
			executionId: "exec-1",
			error: "The frozen checkpoint could not be promoted",
		};
		mocks.devEnvironmentTeardown.teardown.mockResolvedValueOnce({
			status: "error",
			httpStatus: 409,
			body,
		});

		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual(body);
	});

	it("keeps teardown policy behind the application port", () => {
		const source = readFileSync(new URL("./+server.ts", import.meta.url), "utf8");
		const deleteSource = source.slice(source.indexOf("export const DELETE"));

		expect(deleteSource).toContain("devEnvironmentTeardown.teardown");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/workflows/dev-preview");
		expect(deleteSource).not.toContain("stopDurableRun");
		expect(deleteSource).not.toContain("previewSessionContinuation");
		expect(deleteSource).not.toContain("previewEnvironmentProvisioner");
		expect(deleteSource).not.toContain('action: "capture"');
		expect(deleteSource).not.toContain('action: "promote"');
		expect(deleteSource).not.toContain("freezeSourcesForTeardown");
		expect(deleteSource).not.toContain("mergeWorkflowArtifactMetadata");
	});
});
