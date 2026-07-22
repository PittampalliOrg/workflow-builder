import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CompleteWorkflowExecutionRuntimeHostActivationResult,
	PublishWorkflowExecutionRuntimeHostResult,
	ReserveWorkflowExecutionRuntimeHostResult,
	WorkflowExecutionRuntimeHostRetirementResult,
} from "$lib/server/application/ports";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		daprInstanceId: "sw-example-exec-exec-1" as string | null,
		executionIrVersion: null as string | null,
	};
	const candidate = {
		sessionId: "session-1",
		userId: "user-1" as string | null,
		projectId: "project-1" as string | null,
		appId: "agent-session-1",
		invokeTarget: "agent-session-1",
		runtimeSandboxName: "agent-host-agent-session-1" as string | null,
		source: "persisted",
		agentSlug: "codex",
		agentRuntime: "codex-cli" as string | null,
	};
	const workflowData = {
		listCliWorkspaceCommandCandidates: vi.fn(async () => [candidate]),
		getExecutionById: vi.fn(async () => execution),
		createWorkflowFile: vi.fn(async () => ({ file: { id: "file-1" } })),
		saveWorkflowBrowserArtifact: vi.fn(async () => ({ id: "bwf_1" })),
	};
	const helperOperation = {
		executionId: "exec-1",
		purpose: "cli-workspace-command" as const,
		helperSessionId: "exec-1__cliws",
		generationStartedAt: new Date("2026-07-22T12:00:00.123Z"),
		runtimeAppId: "helper-exec-1__cliws",
		runtimeInstanceId: "exec-1",
		runtimeSandboxName: "agent-host-helper-exec-1__cliws",
		owned: true,
		operationId: "operation-1",
	};
	const workflowExecutionRuntimeHosts = {
		reserve: vi.fn(async (): Promise<ReserveWorkflowExecutionRuntimeHostResult> => ({
			status: "reserved" as const,
			operation: helperOperation,
		})),
		publish: vi.fn(
			async (): Promise<PublishWorkflowExecutionRuntimeHostResult> => ({
				status: "published",
			}),
		),
		completeActivation: vi.fn(
			async (): Promise<CompleteWorkflowExecutionRuntimeHostActivationResult> => ({
				status: "activated",
			}),
		),
		abort: vi.fn(async () => true),
		retireUnpublished: vi.fn(
			async (): Promise<WorkflowExecutionRuntimeHostRetirementResult> => ({
				status: "retired",
				cleanup: {
					status: "cleaned",
					sandbox: "deleted",
				},
			}),
		),
		requestReap: vi.fn(),
	};
	const requireInternal = vi.fn(() => undefined);
	const waitForAgentWorkflowHostAppReady = vi.fn(async () => ({
		baseUrl: "http://127.0.0.1:1",
	}));
	const probeAgentWorkflowHostAppReady = vi.fn(
		async (): Promise<{ baseUrl: string } | null> => ({
			baseUrl: "http://127.0.0.1:1",
		}),
	);
	const maybeProvisionAgentWorkflowHost = vi.fn(async () => ({
		agentAppId: "helper-exec-1__cliws",
		sandboxName: "agent-host-helper-exec-1__cliws",
	}));
	const activateAgentWorkflowHostGeneration = vi.fn(async () => undefined);
	return {
		activateAgentWorkflowHostGeneration,
		candidate,
		execution,
		helperOperation,
		maybeProvisionAgentWorkflowHost,
		probeAgentWorkflowHostAppReady,
		requireInternal,
		waitForAgentWorkflowHostAppReady,
		workflowData,
		workflowExecutionRuntimeHosts,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		workflowExecutionRuntimeHosts: mocks.workflowExecutionRuntimeHosts,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	waitForAgentWorkflowHostAppReady: mocks.waitForAgentWorkflowHostAppReady,
	probeAgentWorkflowHostAppReady: mocks.probeAgentWorkflowHostAppReady,
	maybeProvisionAgentWorkflowHost: mocks.maybeProvisionAgentWorkflowHost,
	activateAgentWorkflowHostGeneration: mocks.activateAgentWorkflowHostGeneration,
}));

vi.mock("$lib/server/workflows/github-token", () => ({
	resolveWorkflowGithubToken: vi.fn(async () => "gh-token"),
}));

import { POST } from "./+server";

type CommandReply = {
	exit_code?: number;
	stdout_tail?: string;
	stderr_tail?: string;
};

let server: http.Server | null = null;

async function startCommandServer(
	handler: (payload: { command?: string }) => CommandReply,
): Promise<string> {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			let payload: { command?: string } = {};
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				/* ignore */
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(handler(payload)));
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	return `http://127.0.0.1:${address.port}`;
}

function event(body: Record<string, unknown>) {
	return {
		params: { executionId: "exec-1" },
		request: new Request(
			"http://localhost/api/internal/workflows/executions/exec-1/cli-workspace-command",
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
	};
}

describe("CLI workspace command route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.listCliWorkspaceCommandCandidates.mockResolvedValue([
			mocks.candidate,
		]);
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.createWorkflowFile.mockResolvedValue({ file: { id: "file-1" } });
		mocks.workflowData.saveWorkflowBrowserArtifact.mockResolvedValue({ id: "bwf_1" });
		mocks.workflowExecutionRuntimeHosts.reserve.mockResolvedValue({
			status: "reserved",
			operation: mocks.helperOperation,
		});
		mocks.workflowExecutionRuntimeHosts.publish.mockResolvedValue({
			status: "published",
		});
		mocks.workflowExecutionRuntimeHosts.completeActivation.mockResolvedValue({
			status: "activated",
		});
		mocks.workflowExecutionRuntimeHosts.retireUnpublished.mockResolvedValue({
			status: "retired",
			cleanup: { status: "cleaned", sandbox: "deleted" },
		});
		mocks.execution.executionIrVersion = null;
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = null;
		}
	});

	it("keeps persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listCliWorkspaceCommandCandidates");
		expect(source).toContain("workflowData.createWorkflowFile");
		expect(source).toContain("workflowData.saveWorkflowBrowserArtifact");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("createFile");
		expect(source).not.toContain("saveBrowserArtifact");
		expect(source).not.toContain("resolveSessionRuntimeTarget");
	});

	it("runs the command against the first live CLI session candidate", async () => {
		const baseUrl = await startCommandServer(() => ({
			exit_code: 0,
			stdout_tail: "built",
			stderr_tail: "",
		}));
		mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });

		const response = (await POST(event({ command: "npm test" }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			result: { exitCode: 0, stdout: "built", stderr: "" },
		});
		expect(mocks.workflowData.listCliWorkspaceCommandCandidates).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 8,
		});
		expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledWith({
			agentAppId: "agent-session-1",
		});
		expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
		expect(mocks.workflowExecutionRuntimeHosts.reserve).not.toHaveBeenCalled();
	});

	it("uses the execution Dapr instance as helper shared workspace key", async () => {
		const baseUrl = await startCommandServer(() => ({
			exit_code: 0,
			stdout_tail: "ok",
			stderr_tail: "",
		}));
		mocks.workflowData.listCliWorkspaceCommandCandidates.mockResolvedValueOnce([]);
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });

		const response = (await POST(event({ command: "npm run build" }) as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.probeAgentWorkflowHostAppReady).toHaveBeenCalledWith({
			agentAppId: "helper-exec-1__cliws",
		});
		expect(mocks.waitForAgentWorkflowHostAppReady).not.toHaveBeenCalled();
		expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
		expect(mocks.workflowExecutionRuntimeHosts.reserve).toHaveBeenCalledWith({
			executionId: "exec-1",
			purpose: "cli-workspace-command",
			helperSessionId: "exec-1__cliws",
		});
		expect(mocks.workflowExecutionRuntimeHosts.publish).toHaveBeenCalledWith(
			mocks.helperOperation,
		);
		expect(mocks.activateAgentWorkflowHostGeneration).toHaveBeenCalledWith({
			agentAppId: "helper-exec-1__cliws",
			sandboxName: "agent-host-helper-exec-1__cliws",
		});
		expect(
			mocks.workflowExecutionRuntimeHosts.completeActivation,
		).toHaveBeenCalledWith(mocks.helperOperation);
	});

	it("provisions a missing helper before entering the readiness wait", async () => {
		const baseUrl = await startCommandServer(() => ({
			exit_code: 0,
			stdout_tail: "cloned",
			stderr_tail: "",
		}));
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValue(null);
		mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });

		const response = (await POST(
			event({ command: "git clone repo", helperPod: true }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.probeAgentWorkflowHostAppReady).toHaveBeenCalledTimes(1);
		expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "exec-1__cliws",
				workflowExecutionId: "exec-1",
				timeoutMinutes: 30,
				sharedWorkspaceKey: "sw-example-exec-exec-1",
				provisioningStartedAt: mocks.helperOperation.generationStartedAt,
			}),
		);
		expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledTimes(1);
		expect(mocks.waitForAgentWorkflowHostAppReady).toHaveBeenCalledWith({
			agentAppId: "helper-exec-1__cliws",
		});
		expect(mocks.probeAgentWorkflowHostAppReady.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.maybeProvisionAgentWorkflowHost.mock.invocationCallOrder[0],
		);
		expect(mocks.maybeProvisionAgentWorkflowHost.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.waitForAgentWorkflowHostAppReady.mock.invocationCallOrder[0],
		);
	});

	it("rejects a terminal execution before probing or provisioning a helper", async () => {
		mocks.workflowExecutionRuntimeHosts.reserve.mockResolvedValueOnce({
			status: "execution_not_active",
		});

		await expect(
			POST(event({ command: "npm run build", helperPod: true }) as never),
		).rejects.toMatchObject({ status: 409 });
		expect(mocks.probeAgentWorkflowHostAppReady).not.toHaveBeenCalled();
		expect(mocks.maybeProvisionAgentWorkflowHost).not.toHaveBeenCalled();
	});

	it("does not activate when a successor owns publication", async () => {
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValueOnce({
			baseUrl: "http://127.0.0.1:1",
		});
		mocks.workflowExecutionRuntimeHosts.publish.mockResolvedValueOnce({
			status: "lost",
		});
		mocks.workflowExecutionRuntimeHosts.retireUnpublished.mockResolvedValueOnce({
			status: "fenced",
		});

		await expect(
			POST(event({ command: "npm run build", helperPod: true }) as never),
		).rejects.toMatchObject({ status: 409 });
		expect(mocks.workflowExecutionRuntimeHosts.retireUnpublished).toHaveBeenCalledWith({
			...mocks.helperOperation,
			error: "workflow helper publication lease was lost",
		});
		expect(mocks.activateAgentWorkflowHostGeneration).not.toHaveBeenCalled();
	});

	it("retires an owned generation when provider activation fails", async () => {
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValueOnce({
			baseUrl: "http://127.0.0.1:1",
		});
		mocks.activateAgentWorkflowHostGeneration.mockRejectedValueOnce(
			new Error("SEA activation failed"),
		);

		await expect(
			POST(event({ command: "npm run build", helperPod: true }) as never),
		).rejects.toMatchObject({ status: 409 });
		expect(mocks.workflowExecutionRuntimeHosts.retireUnpublished).toHaveBeenCalledWith({
			...mocks.helperOperation,
			error: "SEA activation failed",
		});
		expect(
			mocks.workflowExecutionRuntimeHosts.completeActivation,
		).not.toHaveBeenCalled();
	});

	it("retires the generation when the execution stops during activation", async () => {
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValueOnce({
			baseUrl: "http://127.0.0.1:1",
		});
		mocks.workflowExecutionRuntimeHosts.completeActivation.mockResolvedValueOnce({
			status: "execution_not_active",
		});

		await expect(
			POST(event({ command: "npm run build", helperPod: true }) as never),
		).rejects.toMatchObject({ status: 409 });
		expect(mocks.activateAgentWorkflowHostGeneration).toHaveBeenCalledOnce();
		expect(mocks.workflowExecutionRuntimeHosts.retireUnpublished).toHaveBeenCalledWith({
			...mocks.helperOperation,
			error: "workflow execution stopped during helper activation",
		});
	});

	it("uses the dynamic-script shared workspace key for helper pods", async () => {
		const baseUrl = await startCommandServer(() => ({
			exit_code: 0,
			stdout_tail: "seeded",
			stderr_tail: "",
		}));
		mocks.execution.executionIrVersion = "dynamic-script-2";
		mocks.probeAgentWorkflowHostAppReady.mockResolvedValue(null);
		mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });

		const response = (await POST(
			event({ command: "seed repo", helperPod: true }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.maybeProvisionAgentWorkflowHost).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "exec-1__cliws",
				workflowExecutionId: "exec-1",
				sharedWorkspaceKey: "ws_script_exec-1",
			}),
		);
	});

	it("uploads image readFile output through workflow-data files", async () => {
		const baseUrl = await startCommandServer(({ command }) => {
			if (command?.startsWith("wc -c")) {
				return { exit_code: 0, stdout_tail: "3\n", stderr_tail: "" };
			}
			if (command?.includes("base64 -w0")) {
				return {
					exit_code: 0,
					stdout_tail: Buffer.from("abc").toString("base64"),
					stderr_tail: "",
				};
			}
			return { exit_code: 0, stdout_tail: "shot", stderr_tail: "" };
		});
		mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });

		const response = (await POST(
			event({ command: "make shot", readFile: "/tmp/shot.png" }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			fileId: "file-1",
			fileName: "shot.png",
			contentType: "image/png",
		});
		expect(mocks.workflowData.createWorkflowFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				purpose: "output",
				scopeId: "exec-1",
				name: "shot.png",
				contentType: "image/png",
				bytes: Buffer.from("abc"),
			}),
		);
	});

	it("persists browser video best-effort through workflow-data", async () => {
		const baseUrl = await startCommandServer(({ command }) => {
			if (command?.startsWith("wc -c")) {
				return { exit_code: 0, stdout_tail: "3\n", stderr_tail: "" };
			}
			if (command?.includes("base64 -w0")) {
				return {
					exit_code: 0,
					stdout_tail: Buffer.from("vid").toString("base64"),
					stderr_tail: "",
				};
			}
			return { exit_code: 0, stdout_tail: "recorded", stderr_tail: "" };
		});
		mocks.waitForAgentWorkflowHostAppReady.mockResolvedValue({ baseUrl });
		mocks.workflowData.saveWorkflowBrowserArtifact.mockRejectedValueOnce(
			new Error("artifact write failed"),
		);

		const response = (await POST(
			event({
				command: "record",
				persistBrowserVideo: "/tmp/dashboard.webm",
				nodeId: "video_node",
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			result: { exitCode: 0, stdout: "recorded", stderr: "" },
		});
		expect(mocks.workflowData.saveWorkflowBrowserArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "video_node",
				status: "completed",
				assets: [
					expect.objectContaining({
						kind: "video",
						label: "Dashboard walkthrough",
						contentType: "video/webm",
						fileName: "dashboard.webm",
					}),
				],
			}),
		);
	});
});
