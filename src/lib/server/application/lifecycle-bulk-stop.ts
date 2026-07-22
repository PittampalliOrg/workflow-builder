import type {
	BenchmarkRunCancellationPort,
	EvaluationRunCancellationPort,
	LifecycleCoordinatorCancelNotifier,
	SessionLifecycleController,
	SessionLifecycleStopMode,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionLifecycleStopMode,
} from "$lib/server/application/ports";

export type BulkLifecycleTargetKind =
	| "session"
	| "workflowExecution"
	| "benchmarkRun"
	| "evalRun";

export type BulkLifecycleTarget =
	| { kind: "session"; id: string }
	| { kind: "workflowExecution"; id: string }
	| { kind: "benchmarkRun"; id: string }
	| { kind: "evalRun"; id: string };

export type BulkLifecycleResult = BulkLifecycleTarget & {
	state:
		| "confirmed"
		| "stopping"
		| "cancelled"
		| "coordinator_owned"
		| "notFound"
		| "error";
	status: number;
	ok: boolean;
	ownedBy?: "benchmarkRun" | "evalRun";
	runId?: string;
	error?: string;
};

export type BulkLifecycleStopSummary = {
	total: number;
	confirmed: number;
	stopping: number;
	cancelled: number;
	coordinatorOwned: number;
	notFound: number;
	failed: number;
};

export type BulkLifecycleStopResponse = {
	mode: SessionLifecycleStopMode;
	results: BulkLifecycleResult[];
	summary: BulkLifecycleStopSummary;
};

export type BulkLifecycleStopServiceResult =
	| { status: "ok"; body: BulkLifecycleStopResponse }
	| { status: "error"; httpStatus: number; message: string };

export type BulkLifecycleStopInput = {
	userId: string;
	projectId?: string | null;
	body: unknown;
};

const MODES = new Set<SessionLifecycleStopMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

const TARGET_KINDS = new Set<BulkLifecycleTargetKind>([
	"session",
	"workflowExecution",
	"benchmarkRun",
	"evalRun",
]);

const MAX_TARGETS = 200;
const CONCURRENCY = 8;

export class ApplicationBulkLifecycleStopService {
	constructor(
		private readonly deps: {
			sessionLifecycle: SessionLifecycleController;
			workflowLifecycle: WorkflowExecutionLifecycleControllerPort;
			workflowCoordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
			benchmarkRuns: BenchmarkRunCancellationPort;
			evaluationRuns: EvaluationRunCancellationPort;
			coordinatorCancels: LifecycleCoordinatorCancelNotifier;
		},
	) {}

	async stopMany(
		input: BulkLifecycleStopInput,
	): Promise<BulkLifecycleStopServiceResult> {
		const body = asRecord(input.body);
		const mode = parseStopMode(body.mode);
		const reason = typeof body.reason === "string" ? body.reason : undefined;
		const graceMs = typeof body.graceMs === "number" ? body.graceMs : undefined;
		const targets = parseTargets(body.targets);

		if (targets.length === 0) {
      return {
        status: "error",
        httpStatus: 400,
        message: "No valid targets provided",
      };
		}
		if (targets.length > MAX_TARGETS) {
			return {
				status: "error",
				httpStatus: 400,
				message: `Too many targets (max ${MAX_TARGETS})`,
			};
		}

		const results = await mapPool(
			targets,
			CONCURRENCY,
			(target): Promise<BulkLifecycleResult> =>
				this.stopTarget(target, {
					userId: input.userId,
					projectId: input.projectId ?? null,
					mode,
					reason,
					graceMs,
				}),
		);

		return {
			status: "ok",
			body: {
				mode,
				results,
				summary: summarizeResults(results),
			},
		};
	}

	private async stopTarget(
		target: BulkLifecycleTarget,
		input: {
			userId: string;
			projectId: string | null;
			mode: SessionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	): Promise<BulkLifecycleResult> {
		try {
			if (target.kind === "benchmarkRun" || target.kind === "evalRun") {
				return await this.cancelRunTarget(target, input.projectId);
			}
			if (target.kind === "session") {
				return await this.stopSessionTarget(target, input);
			}
			return await this.stopWorkflowExecutionTarget(target, input);
		} catch (err) {
			return {
				...target,
				state: "error",
				status: 500,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async cancelRunTarget(
		target: Extract<BulkLifecycleTarget, { kind: "benchmarkRun" | "evalRun" }>,
		projectId: string | null,
	): Promise<BulkLifecycleResult> {
		if (!projectId) return notFound(target);
		if (target.kind === "benchmarkRun") {
			const run = await this.deps.benchmarkRuns.cancelBenchmarkRun(
				projectId,
				target.id,
				{ terminalCleanup: "background" },
			);
			if (!run) return notFound(target);
		} else {
			await this.deps.evaluationRuns.cancelEvaluationRun(projectId, target.id);
		}
    this.deps.coordinatorCancels.scheduleCoordinatorCancel(
      target.kind,
      target.id,
    );
		return { ...target, state: "cancelled", status: 200, ok: true };
	}

	private async stopSessionTarget(
		target: Extract<BulkLifecycleTarget, { kind: "session" }>,
		input: {
			userId: string;
			projectId: string | null;
			mode: SessionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	): Promise<BulkLifecycleResult> {
		const access = await this.deps.sessionLifecycle.checkSessionAccess({
			sessionId: target.id,
			userId: input.userId,
			projectId: input.projectId,
		});
		if (access.status === "not_found") return notFound(target);

    const owner = await this.deps.sessionLifecycle.getCoordinatorOwner(
      target.id,
    );
		if (owner) return coordinatorOwned(target, owner);

		if (input.mode === "interrupt") {
      await this.deps.sessionLifecycle
        .pauseSessionGoal(target.id)
        .catch(() => {});
		}

		const result = await this.deps.sessionLifecycle.stopSession(target.id, {
			mode: input.mode,
			reason: input.reason,
			graceMs: input.graceMs,
		});
		return stopResult(target, result);
	}

	private async stopWorkflowExecutionTarget(
		target: Extract<BulkLifecycleTarget, { kind: "workflowExecution" }>,
		input: {
			userId: string;
			projectId: string | null;
			mode: SessionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	): Promise<BulkLifecycleResult> {
		const access = await this.deps.workflowLifecycle.checkExecutionAccess({
			executionId: target.id,
			userId: input.userId,
			projectId: input.projectId,
		});
		if (access.status === "not_found") return notFound(target);

		const owner = await this.deps.workflowCoordinatorOwners.getCoordinatorOwner(
			target.id,
		);
		if (owner) return coordinatorOwned(target, owner);

		const result = await this.deps.workflowLifecycle.stopExecution(target.id, {
			mode: input.mode as WorkflowExecutionLifecycleStopMode,
			reason: input.reason,
			graceMs: input.graceMs,
		});
		return stopResult(target, result);
	}
}

async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
    },
  );
	await Promise.all(workers);
	return results;
}

function parseStopMode(value: unknown): SessionLifecycleStopMode {
  return typeof value === "string" &&
    MODES.has(value as SessionLifecycleStopMode)
		? (value as SessionLifecycleStopMode)
		: "terminate";
}

function parseTargets(value: unknown): BulkLifecycleTarget[] {
	const rawTargets = Array.isArray(value) ? value : [];
	const seen = new Set<string>();
	const targets: BulkLifecycleTarget[] = [];
	for (const target of rawTargets) {
		if (!target || typeof target !== "object") continue;
		const kind = (target as { kind?: unknown }).kind;
		const id = (target as { id?: unknown }).id;
    if (
      typeof kind !== "string" ||
      !TARGET_KINDS.has(kind as BulkLifecycleTargetKind)
    ) {
			continue;
		}
		if (typeof id !== "string" || !id.trim()) continue;
		const trimmedId = id.trim();
		const key = `${kind}:${trimmedId}`;
		if (seen.has(key)) continue;
		seen.add(key);
    targets.push({
      kind: kind as BulkLifecycleTargetKind,
      id: trimmedId,
    } as BulkLifecycleTarget);
	}
	return targets;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function notFound(target: BulkLifecycleTarget): BulkLifecycleResult {
	return { ...target, state: "notFound", status: 404, ok: false };
}

function coordinatorOwned(
	target: BulkLifecycleTarget,
	owner: { kind: string; runId: string },
): BulkLifecycleResult {
	return {
		...target,
		state: "coordinator_owned",
		status: 409,
		ok: false,
		ownedBy: owner.kind === "evalRun" ? "evalRun" : "benchmarkRun",
		runId: owner.runId,
	};
}

function stopResult(
	target: BulkLifecycleTarget,
  result: {
    notFound?: boolean;
    confirmed: boolean;
    state?: string;
    requested?: boolean;
    retryable?: boolean;
  },
): BulkLifecycleResult {
	if (result.notFound) return notFound(target);
  if (result.retryable && result.requested === false) {
    return {
      ...target,
      state: "error",
      status: 503,
      ok: false,
      error: "Stop intent could not be persisted - retry the request",
    };
  }
	const state =
		result.state === "confirmed"
			? "confirmed"
			: result.state === "stopping"
				? "stopping"
				: result.confirmed
					? "confirmed"
					: "stopping";
	const status = state === "confirmed" ? 200 : 202;
	return { ...target, state, status, ok: result.confirmed };
}

function summarizeResults(
  results: BulkLifecycleResult[],
): BulkLifecycleStopSummary {
	return {
		total: results.length,
		confirmed: results.filter((result) => result.state === "confirmed").length,
		stopping: results.filter((result) => result.state === "stopping").length,
		cancelled: results.filter((result) => result.state === "cancelled").length,
    coordinatorOwned: results.filter(
      (result) => result.state === "coordinator_owned",
    ).length,
		notFound: results.filter((result) => result.state === "notFound").length,
		failed: results.filter((result) => result.state === "error").length,
	};
}
