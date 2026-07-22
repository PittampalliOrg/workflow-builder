import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowExecutionRuntimeHostCleanupCandidate,
	WorkflowExecutionRuntimeHostCleanupProvider,
	WorkflowExecutionRuntimeHostIdentityFactory,
	WorkflowExecutionRuntimeHostRepository,
} from "$lib/server/application/ports";
import {
	ApplicationWorkflowExecutionRuntimeHostService,
	CoalescingWorkflowExecutionRuntimeHostCleanupRunner,
} from "./execution-runtime-hosts";

describe("ApplicationWorkflowExecutionRuntimeHostService cleanup", () => {
	const now = new Date("2026-07-22T12:00:00.000Z");
	const candidate: WorkflowExecutionRuntimeHostCleanupCandidate = {
		executionId: "execution-abc",
		purpose: "cli-workspace-command",
		helperSessionId: "execution-abc__cliws",
		generationStartedAt: new Date("2026-07-22T11:45:00.000Z"),
		runtimeAppId: "agent-execution-abc-1234",
		runtimeInstanceId: "execution-abc",
		runtimeSandboxName: "agent-host-agent-execution-abc-1234",
		owned: true,
	};
	let repository: WorkflowExecutionRuntimeHostRepository;
	let provider: WorkflowExecutionRuntimeHostCleanupProvider;
	let service: ApplicationWorkflowExecutionRuntimeHostService;

	beforeEach(() => {
		repository = {
			reserve: vi.fn(),
			publish: vi.fn(),
			completeActivation: vi.fn(),
			beginRollback: vi.fn(async () => ({ status: "claimed" as const })),
			abort: vi.fn(),
			listPendingCleanup: vi.fn(async () => [candidate]),
			claimCleanup: vi.fn(async () => true),
			acknowledgeCleanup: vi.fn(async () => true),
		};
		provider = {
			cleanup: vi.fn(async () => ({
				status: "cleaned" as const,
				sandbox: "missing" as const,
			})),
		};
		const eagerRunner = new CoalescingWorkflowExecutionRuntimeHostCleanupRunner();
		vi.spyOn(eagerRunner, "request").mockImplementation(() => undefined);
		service = new ApplicationWorkflowExecutionRuntimeHostService({
			repository,
			provider,
			identities: {} as WorkflowExecutionRuntimeHostIdentityFactory,
			now: () => now,
			eagerRunner,
		});
	});

	it("does not acknowledge a provider failure and retries the durable obligation", async () => {
		vi.mocked(provider.cleanup)
			.mockResolvedValueOnce({ status: "error", error: "SEA unavailable" })
			.mockResolvedValueOnce({ status: "cleaned", sandbox: "missing" });

		await expect(
			service.reapPending({ executionId: candidate.executionId, limit: 1 }),
		).resolves.toEqual({
			scanned: 1,
			acknowledged: [],
			failed: [
				{
					target: "execution-abc:cli-workspace-command",
					error: "SEA unavailable",
				},
			],
			dryRun: false,
		});
		expect(repository.acknowledgeCleanup).not.toHaveBeenCalled();

		await expect(
			service.reapPending({ executionId: candidate.executionId, limit: 1 }),
		).resolves.toEqual({
			scanned: 1,
			acknowledged: ["execution-abc:cli-workspace-command"],
			failed: [],
			dryRun: false,
		});
		expect(provider.cleanup).toHaveBeenCalledTimes(2);
		expect(repository.acknowledgeCleanup).toHaveBeenCalledOnce();
		expect(repository.acknowledgeCleanup).toHaveBeenCalledWith({
			...candidate,
			completedAt: now,
		});
	});

	it("retries idempotent provider cleanup when the exact acknowledgement loses its CAS", async () => {
		vi.mocked(repository.acknowledgeCleanup)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		const lost = await service.reapPending({ limit: 1 });
		expect(lost).toEqual({
			scanned: 1,
			acknowledged: [],
			failed: [],
			dryRun: false,
		});

		const retried = await service.reapPending({ limit: 1 });
		expect(retried.acknowledged).toEqual([
			"execution-abc:cli-workspace-command",
		]);
		expect(provider.cleanup).toHaveBeenCalledTimes(2);
		expect(repository.acknowledgeCleanup).toHaveBeenCalledTimes(2);
	});

	it("never calls the provider or acknowledgement when a cleanup lease is not claimed", async () => {
		vi.mocked(repository.claimCleanup).mockResolvedValue(false);

		await expect(service.reapPending({ limit: 1 })).resolves.toEqual({
			scanned: 1,
			acknowledged: [],
			failed: [],
			dryRun: false,
		});
		expect(provider.cleanup).not.toHaveBeenCalled();
		expect(repository.acknowledgeCleanup).not.toHaveBeenCalled();
	});

	it("retires an unpublished generation only while its rollback CAS is authoritative", async () => {
		const operation = { ...candidate, operationId: "operation-owned" };

		await expect(
			service.retireUnpublished({
				...operation,
				error: "activation failed",
			}),
		).resolves.toEqual({
			status: "retired",
			cleanup: { status: "cleaned", sandbox: "missing" },
		});
		expect(repository.beginRollback).toHaveBeenCalledWith({
			...operation,
			error: "activation failed",
			startedAt: now,
		});
		expect(provider.cleanup).toHaveBeenCalledWith(candidate);
		expect(repository.abort).toHaveBeenCalledWith({
			...operation,
			error: "activation failed",
			abortedAt: now,
		});
	});

	it("does not delete a generation after rollback authority moves to a successor", async () => {
		vi.mocked(repository.beginRollback).mockResolvedValueOnce({ status: "lost" });
		const operation = { ...candidate, operationId: "operation-stale" };

		await expect(
			service.retireUnpublished({
				...operation,
				error: "publication lease was lost",
			}),
		).resolves.toEqual({ status: "fenced" });
		expect(provider.cleanup).not.toHaveBeenCalled();
		expect(repository.abort).not.toHaveBeenCalled();
	});

	it("repeats exact idempotent cleanup after acknowledgement catches a late create", async () => {
		vi.mocked(repository.beginRollback).mockResolvedValueOnce({
			status: "cleanup_complete",
		});
		const operation = { ...candidate, operationId: "operation-late-create" };

		await expect(
			service.retireUnpublished({
				...operation,
				error: "cleanup completed before create returned",
			}),
		).resolves.toEqual({
			status: "retired",
			cleanup: { status: "cleaned", sandbox: "missing" },
		});
		expect(provider.cleanup).toHaveBeenCalledWith(candidate);
		expect(repository.abort).not.toHaveBeenCalled();
	});
});
