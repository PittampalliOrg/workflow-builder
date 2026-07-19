export type BenchmarkLaunchCommand = {
	projectId?: string | null;
	userId: string;
	body: unknown;
};

export type EvaluationLaunchCommand = {
	projectId?: string | null;
	userId: string;
	body: unknown;
};

export type BenchmarkRunSummaryList = {
	runs: unknown[];
};

export type EvaluationRunSummaryList = {
	runs: unknown[];
};

export type RunLaunchResult =
	| { status: "ok"; httpStatus: number; body: Record<string, unknown> }
	| {
			status: "error";
			httpStatus: number;
			message?: string;
			body?: Record<string, unknown>;
	  };

export type CreatedRun = {
	id: string;
	[key: string]: unknown;
};

export type BenchmarkRunLaunchCreateInput = {
	projectId: string;
	userId: string;
	suiteSlug: string;
	agentId: string;
	agentVersion?: number;
	instanceIds: unknown;
	modelNameOrPath?: string;
	modelConfigLabel: string | null;
	concurrency?: number;
	evaluationConcurrency?: number;
	timeoutSeconds?: number;
	maxTurns: number | null;
	evaluatorResourceClass: string | null;
	tags: string[] | null;
	requirePrevalidatedEnvironments: boolean;
	executionBackend: string | null;
	executionClass: string | null;
};

export type BenchmarkCreateRunResult =
	| { status: "ok"; run: CreatedRun }
	| { status: "validation_error"; message: string };

export type BenchmarkRunLaunchPort = {
	listRuns(input: {
		projectId: string;
		limit: number;
		tag?: string | null;
	}): Promise<unknown[]>;
	createRun(input: BenchmarkRunLaunchCreateInput): Promise<BenchmarkCreateRunResult>;
	startCoordinator(runId: string): Promise<Record<string, unknown>>;
	markStatus(
		runId: string,
		status: "queued" | "failed",
		extra: Record<string, unknown>,
	): Promise<unknown>;
	getRun(projectId: string, runId: string): Promise<unknown>;
};

export type EvaluationSubjectTypeInput =
	| "agent"
	| "workflow"
	| "imported_outputs"
	| "model";

export type EvaluationRunLaunchCreateInput = {
	projectId: string;
	userId: string;
	evaluationId: string;
	datasetId: string | null;
	rowIds?: string[];
	subjectType: EvaluationSubjectTypeInput;
	subjectId: string | null;
	subjectVersion: string | null;
	executionConfig?: Record<string, unknown>;
	importedOutputs: unknown;
	autoGrade: boolean;
};

export type EvaluationRunLaunchPort = {
	listRuns(projectId: string, limit: number): Promise<unknown[]>;
	createRun(input: EvaluationRunLaunchCreateInput): Promise<CreatedRun>;
	startCoordinator(runId: string): Promise<Record<string, unknown>>;
	markStatus(
		runId: string,
		status: "running" | "failed",
		extra: Record<string, unknown>,
	): Promise<unknown>;
};

export type CoordinatedRunCapabilityReader = {
	coordinatedWorkloadAvailability(workload: "benchmark" | "evaluation"): {
		available: boolean;
		code: string;
		message: string | null;
	};
};

const EVALUATION_SUBJECT_TYPES = new Set<EvaluationSubjectTypeInput>([
	"agent",
	"workflow",
	"imported_outputs",
	"model",
]);

export class ApplicationBenchmarkRunLaunchService {
	constructor(
		private readonly runs: BenchmarkRunLaunchPort,
		private readonly capabilities?: CoordinatedRunCapabilityReader,
	) {}

	async listRuns(input: {
		projectId?: string | null;
		limit: number;
		tag?: string | null;
	}): Promise<BenchmarkRunSummaryList> {
		if (!input.projectId) return { runs: [] };
		return {
			runs: await this.runs.listRuns({
				projectId: input.projectId,
				limit: input.limit,
				tag: input.tag ?? null,
			}),
		};
	}

	async startRun(input: BenchmarkLaunchCommand): Promise<RunLaunchResult> {
		if (!input.projectId) {
			return {
				status: "error",
				httpStatus: 400,
				message: "No active workspace — cannot create benchmark run",
			};
		}
		const availability = this.capabilities?.coordinatedWorkloadAvailability(
			"benchmark",
		);
		if (availability && !availability.available) {
			return unavailableRunResult(availability);
		}
		const body = asRecord(input.body);
		if (typeof body.requirePrevalidatedEnvironments !== "boolean") {
			return {
				status: "error",
				httpStatus: 400,
				message:
					"Benchmark launch requests must declare requirePrevalidatedEnvironments; refresh the Benchmarks page and try again.",
			};
		}

		const created = await this.runs.createRun({
			projectId: input.projectId,
			userId: input.userId,
			suiteSlug: String(body.suiteSlug ?? body.suite ?? ""),
			agentId: String(body.agentId ?? ""),
			agentVersion: parseOptionalInteger(body.agentVersion),
			instanceIds: body.instanceIds ?? body.selectedInstanceIds ?? "",
			modelNameOrPath:
				typeof body.modelNameOrPath === "string"
					? body.modelNameOrPath
					: undefined,
			modelConfigLabel:
				typeof body.modelConfigLabel === "string"
					? body.modelConfigLabel
					: null,
			concurrency: parseOptionalInteger(body.concurrency),
			evaluationConcurrency: parseOptionalInteger(body.evaluationConcurrency),
			timeoutSeconds: parseOptionalInteger(body.timeoutSeconds),
			maxTurns: parseNullableInteger(body.maxTurns),
			evaluatorResourceClass:
				typeof body.evaluatorResourceClass === "string"
					? body.evaluatorResourceClass
					: null,
			tags: parseStringArray(body.tags),
			requirePrevalidatedEnvironments: body.requirePrevalidatedEnvironments,
			executionBackend:
				typeof body.executionBackend === "string" ? body.executionBackend : null,
			executionClass:
				typeof body.executionClass === "string" ? body.executionClass : null,
		});
		if (created.status === "validation_error") {
			return {
				status: "error",
				httpStatus: 400,
				body: { message: created.message },
			};
		}

		let coordinatorStartError: string | null = null;
		try {
			const coordinator = await this.runs.startCoordinator(created.run.id);
			if (typeof coordinator.executionId === "string") {
				await this.runs.markStatus(created.run.id, "queued", {
					coordinatorExecutionId: coordinator.executionId,
				});
			}
		} catch (err) {
			coordinatorStartError = err instanceof Error ? err.message : String(err);
			await this.runs.markStatus(created.run.id, "failed", {
				error: coordinatorStartError,
			});
		}

		return {
			status: "ok",
			httpStatus: 201,
			body: {
				run: await this.runs.getRun(input.projectId, created.run.id),
				coordinatorStartError,
			},
		};
	}
}

export class ApplicationEvaluationRunLaunchService {
	constructor(
		private readonly runs: EvaluationRunLaunchPort,
		private readonly capabilities?: CoordinatedRunCapabilityReader,
	) {}

	async listRuns(input: {
		projectId?: string | null;
		limit: number;
	}): Promise<EvaluationRunSummaryList> {
		if (!input.projectId) return { runs: [] };
		return { runs: await this.runs.listRuns(input.projectId, input.limit) };
	}

	async startRun(input: EvaluationLaunchCommand): Promise<RunLaunchResult> {
		if (!input.projectId) {
			return {
				status: "error",
				httpStatus: 400,
				message: "No active workspace - cannot create evaluation run",
			};
		}
		const body = asRecord(input.body);
		const subjectType = parseEvaluationSubjectType(body.subjectType);
		if (subjectType !== "imported_outputs") {
			const availability = this.capabilities?.coordinatedWorkloadAvailability(
				"evaluation",
			);
			if (availability && !availability.available) {
				return unavailableRunResult(availability);
			}
		}
		const run = await this.runs.createRun({
			projectId: input.projectId,
			userId: input.userId,
			evaluationId: String(body.evaluationId ?? ""),
			datasetId: typeof body.datasetId === "string" ? body.datasetId : null,
			rowIds: Array.isArray(body.rowIds)
				? body.rowIds.map((row) => String(row)).filter(Boolean)
				: undefined,
			subjectType,
			subjectId: typeof body.subjectId === "string" ? body.subjectId : null,
			subjectVersion:
				typeof body.subjectVersion === "string" ? body.subjectVersion : null,
			executionConfig: asOptionalRecord(body.executionConfig),
			importedOutputs: body.importedOutputs,
			autoGrade: body.autoGrade !== false,
		});

		let coordinatorStartError: string | null = null;
		if (subjectType !== "imported_outputs") {
			try {
				const coordinator = await this.runs.startCoordinator(run.id);
				if (typeof coordinator.executionId === "string") {
					await this.runs.markStatus(run.id, "running", {
						coordinatorExecutionId: coordinator.executionId,
					});
					run.coordinatorExecutionId = coordinator.executionId;
					run.status = "running";
				}
			} catch (err) {
				coordinatorStartError = err instanceof Error ? err.message : String(err);
				await this.runs.markStatus(run.id, "failed", {
					error: coordinatorStartError,
				});
				run.status = "failed";
				run.error = coordinatorStartError;
			}
		}

		return {
			status: "ok",
			httpStatus: 201,
			body: { run, coordinatorStartError },
		};
	}
}

function unavailableRunResult(availability: {
	code: string;
	message: string | null;
}): RunLaunchResult {
	return {
		status: "error",
		httpStatus: 409,
		body: {
			code: availability.code,
			message: availability.message ?? "Run type is unavailable in this deployment",
		},
	};
}

function parseEvaluationSubjectType(value: unknown): EvaluationSubjectTypeInput {
	const subjectType = String(value);
	return EVALUATION_SUBJECT_TYPES.has(subjectType as EvaluationSubjectTypeInput)
		? (subjectType as EvaluationSubjectTypeInput)
		: "imported_outputs";
}

function parseOptionalInteger(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (value) return Number.parseInt(String(value), 10);
	return undefined;
}

function parseNullableInteger(value: unknown): number | null {
	return parseOptionalInteger(value) ?? null;
}

function parseStringArray(value: unknown): string[] | null {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
