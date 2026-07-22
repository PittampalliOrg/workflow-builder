import { randomUUID } from "node:crypto";
import type {
	PublishWorkflowExecutionRuntimeHostResult,
	ReserveWorkflowExecutionRuntimeHostResult,
	WorkflowExecutionRuntimeHostCleanupResult,
	WorkflowExecutionRuntimeHostIdentity,
	WorkflowExecutionRuntimeHostIdentityFactory,
	WorkflowExecutionRuntimeHostLifecyclePort,
	WorkflowExecutionRuntimeHostOperation,
	WorkflowExecutionRuntimeHostCleanupProvider,
	WorkflowExecutionRuntimeHostRepository,
} from "$lib/server/application/ports";

const MAX_CLEANUPS_PER_PASS = 8;
const MAX_CANDIDATES_PER_PASS = 32;
const CLEANUP_CONCURRENCY = 4;
const CLEANUP_CLAIM_LEASE_MS = 60_000;
// Provision + SEA readiness is bounded below six minutes today. Keep a wider
// crash lease so a slow but live create cannot be acknowledged absent first.
const OPERATION_LEASE_MS = 15 * 60_000;

type CleanupPass = () => Promise<void>;

export class CoalescingWorkflowExecutionRuntimeHostCleanupRunner {
	private requested = false;
	private running = false;
	private nextPass: CleanupPass | null = null;

	request(pass: CleanupPass): void {
		this.requested = true;
		this.nextPass = pass;
		if (!this.running) void this.drain();
	}

	private async drain(): Promise<void> {
		this.running = true;
		try {
			while (this.requested) {
				this.requested = false;
				const pass = this.nextPass;
				if (!pass) continue;
				try {
					await pass();
				} catch (error) {
					console.warn(
						"[workflow-executions] eager runtime-host cleanup failed:",
						error instanceof Error ? error.message : error,
					);
				}
			}
		} finally {
			this.running = false;
			if (this.requested) void this.drain();
		}
	}
}

const processCleanupRunner =
	new CoalescingWorkflowExecutionRuntimeHostCleanupRunner();

function targetKey(input: {
	executionId: string;
	purpose: string;
}): string {
	return `${input.executionId}:${input.purpose}`;
}

function assertExactTarget(target: WorkflowExecutionRuntimeHostIdentity): void {
	if (!target.executionId.trim()) throw new Error("executionId is required");
	if (!target.helperSessionId.trim()) {
		throw new Error("helperSessionId is required");
	}
	if (!target.runtimeAppId.trim()) throw new Error("runtimeAppId is required");
	if (!Number.isFinite(target.generationStartedAt.getTime())) {
		throw new Error("workflow helper generation timestamp is invalid");
	}
	if (target.runtimeInstanceId !== target.executionId) {
		throw new Error("workflow helper runtime instance must equal executionId");
	}
	if (target.runtimeSandboxName !== `agent-host-${target.runtimeAppId}`) {
		throw new Error("workflow helper runtime Sandbox identity is inconsistent");
	}
	if (!target.owned) throw new Error("workflow helper runtime host must be owned");
}

export class ApplicationWorkflowExecutionRuntimeHostService
	implements WorkflowExecutionRuntimeHostLifecyclePort
{
	constructor(
		private readonly deps: {
			repository: WorkflowExecutionRuntimeHostRepository;
			provider: WorkflowExecutionRuntimeHostCleanupProvider;
			identities: WorkflowExecutionRuntimeHostIdentityFactory;
			now?: () => Date;
			createOperationId?: () => string;
			eagerRunner?: CoalescingWorkflowExecutionRuntimeHostCleanupRunner;
		},
	) {}

	async reserve(input: {
		executionId: string;
		purpose: "cli-workspace-command";
		helperSessionId: string;
	}): Promise<ReserveWorkflowExecutionRuntimeHostResult> {
		const startedAt = this.deps.now?.() ?? new Date();
		const operationId = this.deps.createOperationId?.() ?? randomUUID();
		const proposedTarget = this.deps.identities.create({
			...input,
			generationStartedAt: startedAt,
		});
		assertExactTarget(proposedTarget);
		const result = await this.deps.repository.reserve({
			proposedTarget,
			operationId,
			startedAt,
			staleBefore: new Date(startedAt.getTime() - OPERATION_LEASE_MS),
		});
		if (result.status === "execution_not_active") this.requestReap();
		return result.status === "reserved"
			? {
					status: "reserved",
					operation: { ...result.target, operationId },
				}
			: result;
	}

	async publish(
		input: WorkflowExecutionRuntimeHostOperation,
	): Promise<PublishWorkflowExecutionRuntimeHostResult> {
		assertExactTarget(input);
		const result = await this.deps.repository.publish({
			...input,
			publishedAt: this.deps.now?.() ?? new Date(),
		});
		if (result.status === "execution_not_active") this.requestReap();
		return result;
	}

	async completeActivation(input: WorkflowExecutionRuntimeHostOperation) {
		assertExactTarget(input);
		const result = await this.deps.repository.completeActivation({
			...input,
			activatedAt: this.deps.now?.() ?? new Date(),
		});
		if (result.status === "execution_not_active") this.requestReap();
		return result;
	}

	async abort(
		input: WorkflowExecutionRuntimeHostOperation & { error: string },
	): Promise<boolean> {
		assertExactTarget(input);
		const aborted = await this.deps.repository.abort({
			...input,
			abortedAt: this.deps.now?.() ?? new Date(),
		});
		// If stop won the race, releasing the create lease makes the exact target
		// immediately eligible. An unscoped coalesced sweep keeps ordering fair.
		this.requestReap();
		return aborted;
	}

	async retireUnpublished(
		input: WorkflowExecutionRuntimeHostOperation & { error: string },
	) {
		assertExactTarget(input);
		const rollbackStartedAt = this.deps.now?.() ?? new Date();
		const authority = await this.deps.repository.beginRollback({
			...input,
			startedAt: rollbackStartedAt,
		});
		if (authority.status === "lost") {
			// A successor owns this immutable generation. Deleting the provider
			// target here would tear down work that this request no longer owns.
			return { status: "fenced" } as const;
		}

		try {
			// cleanup_complete is intentionally reaped again: a create that began
			// before acknowledgement may materialize afterward. The target can no
			// longer be reserved, so this exact idempotent delete has no successor.
			const target: WorkflowExecutionRuntimeHostIdentity = {
				executionId: input.executionId,
				purpose: input.purpose,
				helperSessionId: input.helperSessionId,
				generationStartedAt: input.generationStartedAt,
				runtimeAppId: input.runtimeAppId,
				runtimeInstanceId: input.runtimeInstanceId,
				runtimeSandboxName: input.runtimeSandboxName,
				owned: input.owned,
			};
			const cleanup = await this.deps.provider.cleanup(target);
			return { status: "retired", cleanup } as const;
		} finally {
			if (authority.status === "claimed") {
				await this.deps.repository.abort({
					...input,
					abortedAt: this.deps.now?.() ?? new Date(),
				});
			}
			this.requestReap();
		}
	}

	requestReap(): void {
		(this.deps.eagerRunner ?? processCleanupRunner).request(async () => {
			await this.reapPending({ limit: MAX_CLEANUPS_PER_PASS });
		});
	}

	async reapPending(input: {
		limit?: number;
		executionId?: string;
		dryRun?: boolean;
	}): Promise<WorkflowExecutionRuntimeHostCleanupResult> {
		const requestedLimit =
			typeof input.limit === "number" && Number.isFinite(input.limit)
				? Math.trunc(input.limit)
				: MAX_CLEANUPS_PER_PASS;
		const actionLimit = Math.max(
			1,
			Math.min(requestedLimit, MAX_CLEANUPS_PER_PASS),
		);
		const attemptedAt = this.deps.now?.() ?? new Date();
		const availableBefore = new Date(
			attemptedAt.getTime() - CLEANUP_CLAIM_LEASE_MS,
		);
		const operationStaleBefore = new Date(
			attemptedAt.getTime() - OPERATION_LEASE_MS,
		);
		const candidates = await this.deps.repository.listPendingCleanup({
			limit: MAX_CANDIDATES_PER_PASS,
			availableBefore,
			operationStaleBefore,
			executionId: input.executionId,
		});
		if (input.dryRun) {
			return {
				scanned: candidates.length,
				acknowledged: [],
				failed: [],
				dryRun: true,
			};
		}

		const acknowledged: string[] = [];
		const failed: Array<{ target: string; error: string }> = [];
		const claimed: typeof candidates = [];
		for (const candidate of candidates) {
			if (claimed.length >= actionLimit) break;
			try {
				const didClaim = await this.deps.repository.claimCleanup({
					...candidate,
					attemptedAt,
					availableBefore,
					operationStaleBefore,
				});
				if (didClaim) claimed.push(candidate);
			} catch (error) {
				failed.push({
					target: targetKey(candidate),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (let offset = 0; offset < claimed.length; offset += CLEANUP_CONCURRENCY) {
			const batch = claimed.slice(offset, offset + CLEANUP_CONCURRENCY);
			const outcomes = await Promise.all(
				batch.map(async (candidate) => {
					const key = targetKey(candidate);
					try {
						assertExactTarget(candidate);
						const cleanup = await this.deps.provider.cleanup(candidate);
						if (cleanup.status === "error") {
							return { failure: { target: key, error: cleanup.error } };
						}
						const didAcknowledge =
							await this.deps.repository.acknowledgeCleanup({
								...candidate,
								completedAt: this.deps.now?.() ?? new Date(),
							});
						return didAcknowledge ? { acknowledged: key } : {};
					} catch (error) {
						return {
							failure: {
								target: key,
								error: error instanceof Error ? error.message : String(error),
							},
						};
					}
				}),
			);
			for (const outcome of outcomes) {
				if (outcome.acknowledged) acknowledged.push(outcome.acknowledged);
				if (outcome.failure) failed.push(outcome.failure);
			}
		}

		return {
			scanned: candidates.length,
			acknowledged,
			failed,
			dryRun: false,
		};
	}
}
