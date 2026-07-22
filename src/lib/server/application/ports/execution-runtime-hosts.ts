export type WorkflowExecutionRuntimeHostPurpose = "cli-workspace-command";

export type WorkflowExecutionRuntimeHostIdentity = {
	executionId: string;
	purpose: WorkflowExecutionRuntimeHostPurpose;
	helperSessionId: string;
	generationStartedAt: Date;
	runtimeAppId: string;
	runtimeInstanceId: string;
	runtimeSandboxName: string;
	owned: boolean;
};

export type WorkflowExecutionRuntimeHostOperation =
	WorkflowExecutionRuntimeHostIdentity & {
		operationId: string;
	};

export type ReserveWorkflowExecutionRuntimeHostResult =
	| { status: "reserved"; operation: WorkflowExecutionRuntimeHostOperation }
	| { status: "not_found" }
	| { status: "execution_not_active" }
	| { status: "busy" }
	| { status: "target_mismatch" };

export type PublishWorkflowExecutionRuntimeHostResult =
	| { status: "published" }
	| { status: "execution_not_active" }
	| { status: "lost" };

export type CompleteWorkflowExecutionRuntimeHostActivationResult =
	| { status: "activated" }
	| { status: "execution_not_active" }
	| { status: "lost" };

export type BeginWorkflowExecutionRuntimeHostRollbackResult =
	| { status: "claimed" }
	| { status: "cleanup_complete" }
	| { status: "lost" };

export type WorkflowExecutionRuntimeHostCleanupCandidate =
	WorkflowExecutionRuntimeHostIdentity;

export interface WorkflowExecutionRuntimeHostIdentityFactory {
	create(input: {
		executionId: string;
		purpose: WorkflowExecutionRuntimeHostPurpose;
		helperSessionId: string;
		generationStartedAt: Date;
	}): WorkflowExecutionRuntimeHostIdentity;
}

export interface WorkflowExecutionRuntimeHostRepository {
	reserve(input: {
		proposedTarget: WorkflowExecutionRuntimeHostIdentity;
		operationId: string;
		startedAt: Date;
		staleBefore: Date;
	}): Promise<
		| { status: "reserved"; target: WorkflowExecutionRuntimeHostIdentity }
		| { status: "not_found" }
		| { status: "execution_not_active" }
		| { status: "busy" }
		| { status: "target_mismatch" }
	>;
	publish(input: WorkflowExecutionRuntimeHostOperation & {
		publishedAt: Date;
	}): Promise<PublishWorkflowExecutionRuntimeHostResult>;
	completeActivation(input: WorkflowExecutionRuntimeHostOperation & {
		activatedAt: Date;
	}): Promise<CompleteWorkflowExecutionRuntimeHostActivationResult>;
	beginRollback(input: WorkflowExecutionRuntimeHostOperation & {
		startedAt: Date;
		error: string;
	}): Promise<BeginWorkflowExecutionRuntimeHostRollbackResult>;
	abort(input: WorkflowExecutionRuntimeHostOperation & {
		abortedAt: Date;
		error: string;
	}): Promise<boolean>;
	listPendingCleanup(input: {
		limit: number;
		availableBefore: Date;
		operationStaleBefore: Date;
		executionId?: string;
	}): Promise<WorkflowExecutionRuntimeHostCleanupCandidate[]>;
	claimCleanup(input: WorkflowExecutionRuntimeHostCleanupCandidate & {
		attemptedAt: Date;
		availableBefore: Date;
		operationStaleBefore: Date;
	}): Promise<boolean>;
	acknowledgeCleanup(input: WorkflowExecutionRuntimeHostCleanupCandidate & {
		completedAt: Date;
	}): Promise<boolean>;
}

export type WorkflowExecutionRuntimeHostProviderCleanupResult =
	| { status: "cleaned"; sandbox: "deleted" | "missing" }
	| { status: "error"; error: string };

export type WorkflowExecutionRuntimeHostRetirementResult =
	| {
			status: "retired";
			cleanup: WorkflowExecutionRuntimeHostProviderCleanupResult;
	  }
	| { status: "fenced" };

export interface WorkflowExecutionRuntimeHostCleanupProvider {
	cleanup(
		target: WorkflowExecutionRuntimeHostCleanupCandidate,
	): Promise<WorkflowExecutionRuntimeHostProviderCleanupResult>;
}

export type WorkflowExecutionRuntimeHostCleanupResult = {
	scanned: number;
	acknowledged: string[];
	failed: Array<{ target: string; error: string }>;
	dryRun: boolean;
};

export interface WorkflowExecutionRuntimeHostLifecyclePort {
	reserve(input: {
		executionId: string;
		purpose: WorkflowExecutionRuntimeHostPurpose;
		helperSessionId: string;
	}): Promise<ReserveWorkflowExecutionRuntimeHostResult>;
	publish(
		input: WorkflowExecutionRuntimeHostOperation,
	): Promise<PublishWorkflowExecutionRuntimeHostResult>;
	completeActivation(
		input: WorkflowExecutionRuntimeHostOperation,
	): Promise<CompleteWorkflowExecutionRuntimeHostActivationResult>;
	abort(
		input: WorkflowExecutionRuntimeHostOperation & { error: string },
	): Promise<boolean>;
	retireUnpublished(
		input: WorkflowExecutionRuntimeHostOperation & { error: string },
	): Promise<WorkflowExecutionRuntimeHostRetirementResult>;
	/** Coalesce an eager hint into a process-wide, fair cleanup sweep. */
	requestReap(): void;
	reapPending(input: {
		limit?: number;
		executionId?: string;
		dryRun?: boolean;
	}): Promise<WorkflowExecutionRuntimeHostCleanupResult>;
}
