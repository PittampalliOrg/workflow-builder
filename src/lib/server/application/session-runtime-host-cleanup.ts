import type {
	SessionRepository,
	SessionRuntimeInspectionPort,
	SessionRuntimeInstanceState,
	SessionSandboxDestroyer,
	TerminalRuntimeHostCleanupPort,
	TerminalRuntimeHostCleanupResult,
} from "$lib/server/application/ports";

type TerminalCleanupRepository = Pick<
	SessionRepository,
	| "listPendingTerminalRuntimeHostCleanups"
	| "claimTerminalRuntimeHostCleanup"
	| "acknowledgeTerminalRuntimeHostCleanup"
>;

const MAX_CLEANUPS_PER_PASS = 8;
const MAX_CLEANUP_CANDIDATES_PER_PASS = 32;
const CLEANUP_CONCURRENCY = 4;
const CLEANUP_CLAIM_LEASE_MS = 60_000;
const DEFAULT_RUNTIME_INSPECTION_TIMEOUT_MS = 8_000;

function canonicalRuntimeSandboxName(runtimeAppId: string): string {
	return `agent-host-${runtimeAppId}`;
}

type CleanupPass = () => Promise<void>;

/** One process-wide runner: burst signals collapse into at most one follow-up pass. */
export class CoalescingTerminalRuntimeHostCleanupRunner {
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
						"[sessions] eager terminal runtime-host cleanup failed:",
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

const processEagerCleanupRunner =
	new CoalescingTerminalRuntimeHostCleanupRunner();

/**
 * Reaps terminal, session-owned runtime hosts after the repository proves the
 * parent-consumption fence is closed. The nullable DB acknowledgement is the
 * retry queue: failures deliberately leave it untouched for the next eager or
 * scheduled pass.
 */
export class ApplicationSessionRuntimeHostCleanupService
	implements TerminalRuntimeHostCleanupPort
{
	constructor(
		private readonly deps: {
			sessions: TerminalCleanupRepository;
			runtimeInspector: SessionRuntimeInspectionPort;
			sandboxes: Pick<SessionSandboxDestroyer, "deleteRuntimeSandbox">;
			now?: () => Date;
			eagerRunner?: CoalescingTerminalRuntimeHostCleanupRunner;
			runtimeInspectionTimeoutMs?: number;
		},
	) {}

	requestReap(): void {
		(this.deps.eagerRunner ?? processEagerCleanupRunner).request(async () => {
			await this.reapPending({ limit: MAX_CLEANUPS_PER_PASS });
		});
	}

	private async inspectRuntimeInstance(input: {
		runtimeAppId: string;
		instanceId: string;
		runtimeSandboxName: string;
	}): Promise<SessionRuntimeInstanceState> {
		const timeoutMs = Math.max(
			1,
			Math.trunc(
				this.deps.runtimeInspectionTimeoutMs ??
					DEFAULT_RUNTIME_INSPECTION_TIMEOUT_MS,
			),
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.deps.runtimeInspector
					.inspectRuntimeInstance(input)
					.catch(() => "unknown" as const),
				new Promise<"unknown">((resolve) => {
					timeout = setTimeout(() => resolve("unknown"), timeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async reapPending(input: {
		limit?: number;
		sessionId?: string;
		workflowExecutionId?: string;
		exceptSessionId?: string;
		dryRun?: boolean;
	}): Promise<TerminalRuntimeHostCleanupResult> {
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
		const candidates = await this.deps.sessions.listPendingTerminalRuntimeHostCleanups({
			limit: MAX_CLEANUP_CANDIDATES_PER_PASS,
			availableBefore,
			sessionId: input.sessionId,
			workflowExecutionId: input.workflowExecutionId,
		});
		const eligible = candidates.filter(
			(candidate) => candidate.sessionId !== input.exceptSessionId,
		);
		if (input.dryRun) {
			return {
				scanned: eligible.length,
				acknowledged: [],
				failed: [],
				dryRun: true,
			};
		}

		const acknowledged: string[] = [];
		const failed: Array<{ sessionId: string; error: string }> = [];
		const claimed: typeof eligible = [];
		for (const candidate of eligible) {
			if (claimed.length >= actionLimit) break;
			try {
					const didClaim = await this.deps.sessions.claimTerminalRuntimeHostCleanup({
						sessionId: candidate.sessionId,
						runtimeAppId: candidate.runtimeAppId,
						instanceId: candidate.instanceId,
						runtimeSandboxName: candidate.runtimeSandboxName,
						attemptedAt,
					availableBefore,
				});
				if (didClaim) claimed.push(candidate);
			} catch (error) {
				failed.push({
					sessionId: candidate.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (let offset = 0; offset < claimed.length; offset += CLEANUP_CONCURRENCY) {
			const batch = claimed.slice(offset, offset + CLEANUP_CONCURRENCY);
			const outcomes = await Promise.all(
					batch.map(async (candidate) => {
						try {
							const canonicalSandboxName = canonicalRuntimeSandboxName(
								candidate.runtimeAppId,
							);
							const persistedSandboxName = candidate.runtimeSandboxName?.trim();
							if (
								persistedSandboxName &&
								persistedSandboxName !== canonicalSandboxName
							) {
								return {
									failure: {
										sessionId: candidate.sessionId,
										error: `runtime target mismatch: ${candidate.runtimeAppId} does not own ${persistedSandboxName}`,
									},
								};
							}
							const runtimeState = await this.inspectRuntimeInstance({
								runtimeAppId: candidate.runtimeAppId,
								instanceId: candidate.instanceId,
								runtimeSandboxName: canonicalSandboxName,
						});
						if (runtimeState !== "terminal" && runtimeState !== "not_found") {
							return {
								failure: {
									sessionId: candidate.sessionId,
									error:
										runtimeState === "active"
											? "runtime instance is still active"
											: "runtime closure could not be confirmed",
								},
							};
						}
							const deletion = await this.deps.sandboxes.deleteRuntimeSandbox(
								canonicalSandboxName,
						);
						if (deletion.status === "error") {
							return {
								failure: {
									sessionId: candidate.sessionId,
									error:
										deletion.error ||
										`failed to delete runtime Sandbox ${canonicalSandboxName}`,
								},
							};
						}
						const didAcknowledge =
							await this.deps.sessions.acknowledgeTerminalRuntimeHostCleanup({
									sessionId: candidate.sessionId,
									runtimeAppId: candidate.runtimeAppId,
									instanceId: candidate.instanceId,
									runtimeSandboxName: candidate.runtimeSandboxName,
									completedAt: this.deps.now?.() ?? new Date(),
							});
						return didAcknowledge
							? { acknowledged: candidate.sessionId }
							: {};
					} catch (error) {
						return {
							failure: {
								sessionId: candidate.sessionId,
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
			scanned: eligible.length,
			acknowledged,
			failed,
			dryRun: false,
		};
	}
}
