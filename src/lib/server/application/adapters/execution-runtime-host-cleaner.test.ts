import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SessionSandboxDeleteResult,
	WorkflowExecutionRuntimeHostCleanupCandidate,
} from "$lib/server/application/ports";
import type { DeletedCliStorage } from "$lib/server/kube/client";
import { KubernetesWorkflowExecutionRuntimeHostCleanupProvider } from "./execution-runtime-host-cleaner";

describe("KubernetesWorkflowExecutionRuntimeHostCleanupProvider", () => {
	const target: WorkflowExecutionRuntimeHostCleanupCandidate = {
		executionId: "execution-abc",
		purpose: "cli-workspace-command",
		helperSessionId: "execution-abc__cliws",
		generationStartedAt: new Date("2026-07-22T12:00:00.000Z"),
		runtimeAppId: "agent-execution-abc-1234",
		runtimeInstanceId: "execution-abc",
		runtimeSandboxName: "agent-host-agent-execution-abc-1234",
		owned: true,
	};
	const deleteRuntimeSandbox = vi.fn(async (
		name: string,
	): Promise<SessionSandboxDeleteResult> => ({
		name,
		kind: "runtime",
		status: "deleted",
	}));
	const deleteStorage = vi.fn(
		async (_sessionId: string): Promise<DeletedCliStorage> => ({
			persistentVolumeClaims: [],
			persistentVolumes: [],
		}),
	);
	const listStorage = vi.fn(async (_sessionId: string) => [] as string[]);
	let provider: KubernetesWorkflowExecutionRuntimeHostCleanupProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new KubernetesWorkflowExecutionRuntimeHostCleanupProvider({
			sandboxes: { deleteRuntimeSandbox },
			deleteStorage,
			listStorage,
		});
	});

	it("reports cleanup only after two ordered Sandbox and helper PVC absence passes", async () => {
		await expect(provider.cleanup(target)).resolves.toEqual({
			status: "cleaned",
			sandbox: "deleted",
		});

		expect(deleteRuntimeSandbox).toHaveBeenCalledWith(
			"agent-host-agent-execution-abc-1234",
		);
		expect(deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
		expect(deleteStorage).toHaveBeenCalledWith("execution-abc__cliws");
		expect(deleteStorage).toHaveBeenCalledTimes(2);
		expect(listStorage).toHaveBeenCalledWith("execution-abc__cliws");
		expect(listStorage).toHaveBeenCalledTimes(2);
		expect(deleteRuntimeSandbox.mock.invocationCallOrder[0]).toBeLessThan(
			deleteStorage.mock.invocationCallOrder[0],
		);
		expect(deleteStorage.mock.invocationCallOrder[0]).toBeLessThan(
			listStorage.mock.invocationCallOrder[0],
		);
		expect(listStorage.mock.invocationCallOrder[0]).toBeLessThan(
			deleteRuntimeSandbox.mock.invocationCallOrder[1],
		);
		expect(deleteRuntimeSandbox.mock.invocationCallOrder[1]).toBeLessThan(
			deleteStorage.mock.invocationCallOrder[1],
		);
		expect(deleteStorage.mock.invocationCallOrder[1]).toBeLessThan(
			listStorage.mock.invocationCallOrder[1],
		);
	});

	it("treats SEA not-found as idempotent after confirming helper PVC absence", async () => {
		deleteRuntimeSandbox.mockResolvedValueOnce({
			name: target.runtimeSandboxName,
			kind: "runtime",
			status: "missing",
		}).mockResolvedValueOnce({
			name: target.runtimeSandboxName,
			kind: "runtime",
			status: "missing",
		});

		await expect(provider.cleanup(target)).resolves.toEqual({
			status: "cleaned",
			sandbox: "missing",
		});
		expect(deleteStorage).toHaveBeenCalledWith(target.helperSessionId);
		expect(listStorage).toHaveBeenCalledWith(target.helperSessionId);
	});

	it("deletes a Sandbox recreated between the first absence observations", async () => {
		deleteRuntimeSandbox.mockResolvedValueOnce({
			name: target.runtimeSandboxName,
			kind: "runtime",
			status: "missing",
		});

		await expect(provider.cleanup(target)).resolves.toEqual({
			status: "cleaned",
			sandbox: "deleted",
		});
		expect(deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
		expect(deleteStorage).toHaveBeenCalledTimes(2);
		expect(listStorage).toHaveBeenCalledTimes(2);
	});

	it("keeps cleanup retryable while any helper PVC remains", async () => {
		listStorage
			.mockResolvedValueOnce(["cli-workspace-execution-abc"])
			.mockResolvedValueOnce(["cli-workspace-execution-abc"]);

		await expect(provider.cleanup(target)).resolves.toEqual({
			status: "error",
			error:
				"helper PVC deletion is still converging: cli-workspace-execution-abc",
		});
		expect(deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
		expect(deleteStorage).toHaveBeenCalledTimes(2);
		expect(listStorage).toHaveBeenCalledTimes(2);
	});

	it("rejects a mismatched Sandbox identity without deleting provider resources", async () => {
		await expect(
			provider.cleanup({
				...target,
				runtimeSandboxName: "agent-host-agent-execution-stale",
			}),
		).resolves.toEqual({
			status: "error",
			error:
				"runtime target mismatch: agent-execution-abc-1234 does not own agent-host-agent-execution-stale",
		});
		expect(deleteRuntimeSandbox).not.toHaveBeenCalled();
		expect(deleteStorage).not.toHaveBeenCalled();
		expect(listStorage).not.toHaveBeenCalled();
	});
});
