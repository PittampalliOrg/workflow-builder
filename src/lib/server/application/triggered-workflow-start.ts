import type {
	WorkflowRunStarterPort,
	WorkflowRunStartResult,
} from "$lib/server/application/ports";

export type TriggeredRunAdmissionDecision = {
	admit: boolean;
	active: number;
	cap: number;
};

export type TriggeredRunAdmissionPort = {
	admitTriggeredRun(): Promise<TriggeredRunAdmissionDecision>;
};

export type TriggeredWorkflowExecutionIdPort = {
	executionIdForDedupKey(dedupKey: string): string;
};

export type TriggeredWorkflowStartLogger = {
	info(message: string, details?: Record<string, unknown>): void;
	warn(message: string, details?: Record<string, unknown>): void;
	error(message: string, details?: unknown): void;
};

export type TriggeredWorkflowStartResult = {
	daprStatus: "SUCCESS" | "RETRY";
};

export class ApplicationTriggeredWorkflowStartService {
	constructor(
		private readonly deps: {
			admission: TriggeredRunAdmissionPort;
			executionIds: TriggeredWorkflowExecutionIdPort;
			runStarter: WorkflowRunStarterPort;
			logger?: TriggeredWorkflowStartLogger;
		},
	) {}

	async handleTriggerMessage(
		body: unknown,
	): Promise<TriggeredWorkflowStartResult> {
		const message = normalizeTriggerMessage(body);
		if (!message) {
			return success();
		}

		const { dedupKey, workflowId, workflowName, triggerData, triggerId } =
			message;

		if (!dedupKey || (!workflowId && !workflowName)) {
			this.logWarn("[workflow-triggers/start] missing dedupKey or workflow ref; dropping", {
				hasDedup: !!dedupKey,
				workflowId,
				workflowName,
			});
			return success();
		}

		const gate = await this.deps.admission.admitTriggeredRun();
		if (!gate.admit) {
			this.logInfo("[workflow-triggers/start] deferred (over cap); will redeliver", {
				active: gate.active,
				cap: gate.cap,
				workflowId,
				workflowName,
			});
			return retry();
		}

		try {
			const result = await this.deps.runStarter.startWorkflowRun({
				workflowId,
				workflowName,
				triggerData,
				executionId: this.deps.executionIds.executionIdForDedupKey(dedupKey),
				idempotent: true,
				triggerSource: triggerId || `event:${workflowId ?? workflowName}`,
			});
			return this.logStartResult(result, workflowId, workflowName);
		} catch (err) {
			this.logError(
				"[workflow-triggers/start] unexpected error; ACK to avoid wedge",
				err,
			);
		}

		return success();
	}

	private logStartResult(
		result: WorkflowRunStartResult,
		workflowId: string | undefined,
		workflowName: string | undefined,
	): TriggeredWorkflowStartResult {
		if (!result.ok) {
			if ([404, 429, 503].includes(result.status)) {
				this.logWarn(
					"[workflow-triggers/start] start deferred; will redeliver",
					{
						status: result.status,
						error: result.error,
						workflowId,
						workflowName,
					},
				);
				return retry();
			}
			this.logWarn("[workflow-triggers/start] start failed; dropping message", {
				status: result.status,
				error: result.error,
				workflowId,
				workflowName,
			});
			return success();
		}

		this.logInfo("[workflow-triggers/start] started", {
			executionId: result.executionId,
			reused: result.reused ?? false,
			workflowId: result.workflowId ?? workflowId,
		});
		return success();
	}

	private logInfo(message: string, details?: Record<string, unknown>) {
		(this.deps.logger ?? console).info(message, details);
	}

	private logWarn(message: string, details?: Record<string, unknown>) {
		(this.deps.logger ?? console).warn(message, details);
	}

	private logError(message: string, details?: unknown) {
		(this.deps.logger ?? console).error(message, details);
	}
}

function normalizeTriggerMessage(body: unknown):
	| {
			dedupKey: string;
			workflowId?: string;
			workflowName?: string;
			triggerData: Record<string, unknown>;
			triggerId: string;
	  }
	| null {
	if (!isRecord(body)) return null;

	const data = isRecord(body.data) ? body.data : body;
	const cloudEventId = typeof body.id === "string" ? body.id : undefined;
	const dedupKey =
		(typeof data.dedupKey === "string" && data.dedupKey.trim()) ||
		cloudEventId ||
		"";
	const workflowId =
		typeof data.workflowId === "string" ? data.workflowId.trim() : undefined;
	const workflowName =
		typeof data.workflowName === "string" ? data.workflowName.trim() : undefined;
	const triggerId =
		typeof data.triggerId === "string" ? data.triggerId.trim() : "";
	const triggerData = isRecord(data.triggerData) ? { ...data.triggerData } : {};
	if (cloudEventId && triggerData.eventId === undefined) {
		triggerData.eventId = cloudEventId;
	}

	return {
		dedupKey,
		workflowId,
		workflowName,
		triggerData,
		triggerId,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(): TriggeredWorkflowStartResult {
	return { daprStatus: "SUCCESS" };
}

function retry(): TriggeredWorkflowStartResult {
	return { daprStatus: "RETRY" };
}
