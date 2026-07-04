export type BenchmarkCapacityDiagnostics = {
	requestedConcurrency: number;
	deterministicConcurrency: number;
	pressureAdjustedConcurrency: number;
	storedEffectiveConcurrency: number;
	selectedInstanceCount: number;
	blockedBy: string[];
	resources: Array<{
		resourceType: string;
		capacityKey?: string;
		active: number;
		limit: number;
		headroom?: number;
		staleActive: number;
		[key: string]: unknown;
	}>;
	runtime: {
		class?: string | null;
		appId?: string | null;
		replicas: number | null;
		slotsPerReplica: number | null;
		slots: number | null;
		maxActiveSessions?: number | null;
		[key: string]: unknown;
	};
	daprWorkflow: {
		perSidecarLimit?: number | null;
		effectiveCapacity: number | null;
		agentWorkflowMaxActiveTurns?: number | null;
		[key: string]: unknown;
	};
	parentWorkflow: {
		appId?: string | null;
		replicas: number | null;
		readyReplicas?: number | null;
		connectedWorkers: number | null;
		connectedWorkerPods?: number | null;
		podWorkers?: unknown[];
		workflowLimitPerSidecar?: number | null;
		activityLimitPerSidecar?: number | null;
		configurationWorkflowLimitPerSidecar?: number | null;
		configurationActivityLimitPerSidecar: number | null;
		workerWorkflowLimitPerSidecar?: number | null;
		workerActivityLimitPerSidecar: number | null;
		effectiveWorkflowCapacity: number | null;
		effectiveActivityCapacity: number | null;
		daprRuntimeVersion?: string | null;
		schedulerPods: number | null;
		schedulerReadyPods: number | null;
		recentActorErrorCount: number | null;
		recentReminderErrorCount: number | null;
		recentStaleWorkflowEventCount?: number | null;
		recentStartPendingTimeoutCount?: number | null;
		daprRuntimePressure: boolean;
		error?: string | null;
		[key: string]: unknown;
	};
	agentHostRuntime: {
		activePods: number | null;
		unhealthyPods: string[];
		oomKilledPods: string[];
		recentActorErrorCount: number | null;
		recentReminderErrorCount: number | null;
		daprRuntimePressure: boolean;
		pressureReasons: string[];
		error: string | null;
		[key: string]: unknown;
	};
	sandbox: {
		configuredMaxActiveSandboxes?: number | null;
		maxActiveSandboxes?: number | null;
		schedulableSandboxCapacity: number | null;
		availableSandboxSlots?: number | null;
		activeSwebenchPods?: number | null;
		pendingSwebenchPods?: number | null;
		ephemeralStorageLimitedCapacity: number | null;
		nodeFsLimitedCapacity: number | null;
		nodeFsAvailableBytes?: number | null;
		nodeFsEvictionReserveBytes?: number | null;
		kueueClusterQueueName?: string | null;
		kueueClusterQueueActive?: boolean | null;
		kueueClusterQueueReason?: string | null;
		kueueClusterQueueMessage?: string | null;
		kueueAvailableSandboxSlots?: number | null;
		kueueBorrowAvailableSandboxSlots?: number | null;
		kueueCpuLimitedCapacity?: number | null;
		kueueMemoryLimitedCapacity?: number | null;
		kueueEphemeralStorageLimitedCapacity?: number | null;
		kueuePodLimitedCapacity?: number | null;
		kueueInstanceRequestCpuMilli?: number | null;
		kueueInstanceRequestMemoryBytes?: number | null;
		kueueInstanceRequestEphemeralStorageBytes?: number | null;
		kueueInstancePodCount?: number | null;
		kueueInstancePodCountScope?: string | null;
		kueueInstanceRequestMode?: string | null;
		kueueAvailableInstanceSlots?: number | null;
		kueueBorrowAvailableInstanceSlots?: number | null;
		kueueInstanceCpuLimitedCapacity?: number | null;
		kueueInstanceMemoryLimitedCapacity?: number | null;
		kueueInstanceEphemeralStorageLimitedCapacity?: number | null;
		kueueInstancePodLimitedCapacity?: number | null;
		schedulableKueueInstanceCapacity?: number | null;
		diskPressureNodeCount: number | null;
		error?: string | null;
		[key: string]: unknown;
	};
	modelCaps: {
		modelMaxActiveRequests: number | null;
		[key: string]: unknown;
	};
	evaluator?: {
		requestedEvaluationConcurrency: number | null;
		effectiveEvaluationConcurrency: number | null;
		reason?: string | null;
		capacity?: unknown;
		[key: string]: unknown;
	};
	clusterPressure: {
		hardBlock?: boolean;
		[key: string]: unknown;
	} | null;
	sharedCapacity?: {
		available?: boolean;
		fitsAdditionalSessions?: number | null;
		[key: string]: unknown;
	};
	coverage?: unknown;
	workflowLifecycle?: {
		parentAppId?: string;
		childAppId?: string | null;
		sharedActorStateStore?: boolean | null;
		parentActorStateStore?: {
			componentName: string;
			componentType?: string | null;
			tablePrefix: string | null;
			connectionSecretRef?: string | null;
			maxConns?: number | null;
			scoped?: boolean;
			[key: string]: unknown;
		} | null;
		childActorStateStore?: {
			componentName: string;
			componentType?: string | null;
			tablePrefix: string | null;
			connectionSecretRef?: string | null;
			maxConns?: number | null;
			scoped?: boolean;
			[key: string]: unknown;
		} | null;
		issue: string | null;
		error?: string | null;
		[key: string]: unknown;
	};
	capReason?: string | null;
	computedAt?: string;
	[key: string]: unknown;
};

export type BenchmarkRunCapacityDiagnostics = BenchmarkCapacityDiagnostics;

export type BenchmarkLaunchCapacityInput = {
	projectId: string;
	agentId: string;
	agentVersion?: number;
	instanceIds?: unknown;
	instanceCount?: unknown;
	requestedConcurrency?: unknown;
	evaluationConcurrency?: unknown;
	modelNameOrPath?: string | null;
	modelConfigLabel?: string | null;
	executionBackend?: string | null;
};

export type BenchmarkCapacityDiagnosticsPort = {
	inspectLaunchCapacity(
		input: BenchmarkLaunchCapacityInput,
	): Promise<
		| { status: "ok"; diagnostics: BenchmarkCapacityDiagnostics }
		| { status: "validation_error"; message: string }
	>;
	getRunCapacity(
		projectId: string,
		runId: string,
	): Promise<BenchmarkRunCapacityDiagnostics | null>;
};

export type BenchmarkCapacityRouteResult =
	| { status: "ok"; body: { diagnostics: BenchmarkCapacityDiagnostics } }
	| { status: "error"; httpStatus: 400 | 404; message?: string; body?: Record<string, unknown> };

export class ApplicationBenchmarkCapacityDiagnosticsService {
	constructor(private readonly capacity: BenchmarkCapacityDiagnosticsPort) {}

	async inspectLaunchCapacity(input: {
		projectId?: string | null;
		body: unknown;
	}): Promise<BenchmarkCapacityRouteResult> {
		if (!input.projectId) {
			return {
				status: "error",
				httpStatus: 400,
				message: "No active workspace — cannot inspect benchmark capacity",
			};
		}

		const body = asRecord(input.body);
		const result = await this.capacity.inspectLaunchCapacity({
			projectId: input.projectId,
			agentId: String(body.agentId ?? ""),
			agentVersion: parseOptionalInteger(body.agentVersion),
			instanceIds: body.instanceIds,
			instanceCount: body.instanceCount,
			requestedConcurrency:
				parseOptionalInteger(body.requestedConcurrency) ?? body.concurrency,
			evaluationConcurrency: parseOptionalInteger(body.evaluationConcurrency),
			modelNameOrPath:
				typeof body.modelNameOrPath === "string" ? body.modelNameOrPath : null,
			modelConfigLabel:
				typeof body.modelConfigLabel === "string" ? body.modelConfigLabel : null,
			executionBackend:
				typeof body.executionBackend === "string" ? body.executionBackend : null,
		});

		if (result.status === "validation_error") {
			return {
				status: "error",
				httpStatus: 400,
				body: { message: result.message },
			};
		}

		return { status: "ok", body: { diagnostics: result.diagnostics } };
	}

	async getRunCapacity(input: {
		projectId?: string | null;
		runId: string;
	}): Promise<BenchmarkCapacityRouteResult> {
		if (!input.projectId) return benchmarkRunNotFound();

		const diagnostics = await this.capacity.getRunCapacity(
			input.projectId,
			input.runId,
		);
		if (!diagnostics) return benchmarkRunNotFound();

		return { status: "ok", body: { diagnostics } };
	}
}

function benchmarkRunNotFound(): BenchmarkCapacityRouteResult {
	return {
		status: "error",
		httpStatus: 404,
		message: "Benchmark run not found",
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function parseOptionalInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : undefined;
}
