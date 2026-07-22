import type {
	WorkflowExecutionRecord,
	WorkflowApprovalEventPort,
	WorkflowDefinition,
	WorkflowDataService,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionLifecycleStopMode,
	WorkflowExecutionReadModelPort,
	WorkflowRunStarterPort,
	WorkflowSpecValidatorPort,
} from "$lib/server/application/ports";

export type WorkflowExecutionControlInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowExecutionStartInput = {
	workflowId: string;
	userId: string;
	projectId?: string | null;
	body?: Record<string, unknown>;
};

export type DevWorkflowExecutionStartInput = WorkflowExecutionStartInput & {
	requestOrigin: string | null;
};

export type WorkflowWebhookStartInput = {
	workflowId: string;
	authorizationHeader: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowExecutionDetailInput = {
	executionId: string;
	userId?: string | null;
	projectId?: string | null;
};

export type WorkflowExecutionStatusInput = WorkflowExecutionDetailInput & {
	includeAgentEvents: boolean;
};

export type WorkflowExecutionApprovalStateInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

const STOP_MODES = new Set<WorkflowExecutionLifecycleStopMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

export type WorkflowExecutionControlResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
			httpStatus?: number;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

export class ApplicationWorkflowExecutionControlService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getExecutionById"
				| "getScopedExecutionById"
				| "getWorkflowByRef"
				| "getRunningWorkflowExecution"
				| "isPlatformAdmin"
				| "validateApiKeyForUser"
			>;
			approvalEvents: WorkflowApprovalEventPort;
			coordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
			executionLifecycle: WorkflowExecutionLifecycleControllerPort;
			executionReadModels: WorkflowExecutionReadModelPort;
			runStarter: WorkflowRunStarterPort;
			workflowSpecs: WorkflowSpecValidatorPort;
			/** Dynamic-script gate lookups (cutover P1d): approve()/waitForEvent()
			 * gates live in the call journal, not the spec. Optional so lite/test
			 * wiring without a journal store keeps working (scripts then report
			 * no gates). */
			scriptCalls?: {
				listInternal(executionId: string): Promise<
					Array<{
						callId: string;
						status: string;
						label?: string | null;
						result?: unknown;
					}>
				>;
			};
		},
	) {}

	/** Waiting approve()/waitForEvent() gates for a dynamic-script run: RUNNING
	 * journal rows carrying the wait_event child's pause marker. */
	private async listScriptGates(executionId: string): Promise<
		Array<{
			callId: string;
			label: string | null;
			logicalName: string;
			message: string | null;
			eventName: string;
			waiterInstanceId: string;
		}>
	> {
		if (!this.deps.scriptCalls) return [];
		try {
			const rows = await this.deps.scriptCalls.listInternal(executionId);
			return rows.flatMap((row) => {
				if (row.status !== "running") return [];
        const pause = (row.result as { pause?: Record<string, unknown> } | null)
          ?.pause;
				if (!pause || pause.type !== "EVENT") return [];
        const eventName =
          typeof pause.eventName === "string" ? pause.eventName : "";
				const waiterInstanceId =
          typeof pause.waiterInstanceId === "string"
            ? pause.waiterInstanceId
            : "";
				if (!eventName || !waiterInstanceId) return [];
				return [
					{
						callId: row.callId,
						label: row.label ?? null,
						logicalName:
              typeof pause.logicalName === "string"
                ? pause.logicalName
                : "event",
						message: typeof pause.message === "string" ? pause.message : null,
						eventName,
						waiterInstanceId,
					},
				];
			});
		} catch (err) {
			console.warn(
				`[approval] script gate lookup failed for ${executionId}:`,
				err instanceof Error ? err.message : String(err),
			);
			return [];
		}
	}

	async executeWorkflow(
		input: WorkflowExecutionStartInput,
	): Promise<WorkflowExecutionControlResult> {
		return this.startWorkflow(input);
	}

	async executeDevWorkflow(
		input: DevWorkflowExecutionStartInput,
	): Promise<WorkflowExecutionControlResult> {
		if (!(await this.deps.workflowData.isPlatformAdmin(input.userId))) {
			return workflowControlError(403, "Admin access required");
		}
		return this.startWorkflow(input, {
			surface: "dev-environment",
			origin: input.requestOrigin,
		});
	}

	private async startWorkflow(
		input: WorkflowExecutionStartInput,
		launch?: { surface: "dev-environment"; origin: string | null },
	): Promise<WorkflowExecutionControlResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isScopedResourceInScope(workflow, input)) {
			return workflowControlError(404, "Workflow not found");
		}

		const budgetTotalRaw = input.body?.budgetTotal;
		const budgetTotal =
			typeof budgetTotalRaw === "number" && Number.isFinite(budgetTotalRaw)
				? budgetTotalRaw
				: undefined;
		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: input.workflowId,
			// Pass verbatim: dynamic-script accepts ANY JSON value (and undefined =
			// "no args"); the SW path coerces non-objects to {} itself.
			triggerData: input.body?.input,
			userId: input.userId,
			...(budgetTotal !== undefined ? { budgetTotal } : {}),
			...(launch
				? { launchSurface: launch.surface, launchOrigin: launch.origin }
				: {}),
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				executionId: result.executionId,
				instanceId: result.instanceId,
				workflowId: input.workflowId,
				status: "running",
			},
		};
	}

	async startWebhookExecution(
		input: WorkflowWebhookStartInput,
	): Promise<WorkflowExecutionControlResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!workflow) {
			return workflowControlError(404, "Workflow not found");
		}

    const apiKeyValidation = await this.deps.workflowData.validateApiKeyForUser(
      {
			authorizationHeader: input.authorizationHeader,
			userId: workflow.userId,
        projectId: workflow.projectId ?? null,
      },
    );
		if (!apiKeyValidation.valid) {
			return workflowControlError(
				apiKeyValidation.statusCode || 401,
				apiKeyValidation.error,
			);
		}

		if (!hasWebhookTrigger(workflow)) {
			return workflowControlError(
				400,
				"This workflow is not configured for webhook triggers",
			);
		}

		if (!this.deps.workflowSpecs.isServerlessWorkflow(workflow.spec)) {
			return workflowControlError(
				400,
				"Workflow does not have a valid CNCF Serverless Workflow 1.0 spec",
			);
		}

		const runningExecution =
      await this.deps.workflowData.getRunningWorkflowExecution(
        input.workflowId,
      );
		if (runningExecution) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					error: "A workflow execution is already running",
					existingExecutionId: runningExecution.id,
				},
			};
		}

		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: input.workflowId,
			triggerData: asRecord(input.body),
			userId: workflow.userId,
			triggerSource: "webhook",
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				executionId: result.executionId,
				status: "running",
			},
		};
	}

	async getExecutionStatus(
		input: WorkflowExecutionStatusInput,
	): Promise<WorkflowExecutionControlResult> {
		if (input.userId) {
			const execution = await this.deps.workflowData.getExecutionById(
				input.executionId,
			);
			if (
				!isExecutionInScope(execution, {
					userId: input.userId,
					projectId: input.projectId ?? null,
				})
			) {
				return workflowControlError(404, "Execution not found");
			}
		}

		try {
			const model = await this.deps.executionReadModels.loadExecutionReadModel({
				executionId: input.executionId,
				refreshRuntime: true,
				includeAgentEvents: input.includeAgentEvents,
			});
			if (!model) return workflowControlError(404, "Execution not found");

			return {
				status: "ok",
				body: this.deps.executionReadModels.serializeExecutionReadModel(model, {
					compact: false,
					includeAgentEvents: input.includeAgentEvents,
				}),
			};
		} catch (readModelError) {
			console.error(
				"[ExecutionStatus] execution read-model load failed:",
				readModelError,
			);
			return workflowControlError(
				503,
				readModelError instanceof Error
					? readModelError.message
					: "Execution read-model migration is required",
			);
		}
	}

	async stopExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const access = await this.deps.executionLifecycle.checkExecutionAccess({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (access.status !== "ok") {
			return workflowControlError(404, "Execution not found");
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		if (owner) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "coordinator_owned",
					ownedBy: owner.kind,
					runId: owner.runId,
					message:
						owner.kind === "benchmarkRun"
							? "This is a benchmark instance — cancel the benchmark run instead."
							: "This is an evaluation instance — cancel the evaluation run instead.",
				},
			};
		}

		const result = await this.deps.executionLifecycle.stopExecution(
			input.executionId,
			{
				mode: parseStopMode(input.body?.mode),
				reason:
					typeof input.body?.reason === "string"
						? input.body.reason
						: undefined,
				graceMs:
					typeof input.body?.graceMs === "number"
						? input.body.graceMs
						: undefined,
			},
		);
    if (result.notFound)
      return workflowControlError(404, "Execution not found");
    if (result.retryable && !result.requested) {
      return workflowControlError(
        503,
        "Stop intent could not be persisted - please retry.",
      );
    }

		const httpStatus =
      result.state === "confirmed"
        ? 200
        : result.state === "stopping"
          ? 202
          : 409;
		return {
			status: "ok",
			httpStatus,
			body: { ok: result.confirmed, ...result },
		};
	}

	async getStopStatus(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const access = await this.deps.executionLifecycle.checkExecutionAccess({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (access.status !== "ok") {
			return workflowControlError(404, "Execution not found");
		}

		const result = await this.deps.executionLifecycle.confirmExecutionStop(
			input.executionId,
		);
		return { status: "ok", body: { state: result.state } };
	}

	async getExecutionDetail(
		input: WorkflowExecutionDetailInput,
	): Promise<WorkflowExecutionControlResult> {
		const execution = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!execution) {
			return workflowControlError(404, "Execution not found");
		}
		if (
			input.userId &&
			!isExecutionInScope(execution, {
				userId: input.userId,
				projectId: input.projectId ?? null,
			})
		) {
			return workflowControlError(404, "Execution not found");
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		return {
			status: "ok",
			body: { ...execution, owner },
		};
	}

	async approveExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const eventType = approvalEventType(input.body);
		const execution = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!isExecutionInScope(execution, input)) {
			return workflowControlError(404, "Execution not found");
		}

		if (!execution.daprInstanceId) {
			return workflowControlError(409, "Run has no Dapr instance to signal");
		}

		// Dynamic-script runs (cutover P1d): the waiter is a wait_event child on
		// a per-callId event name — resolve the gate from the journal's pause
		// markers instead of the spec, and raise at the child.
		if (execution.executionIrVersion?.startsWith("dynamic-script")) {
			const gates = await this.listScriptGates(input.executionId);
			if (gates.length === 0) {
        return workflowControlError(
          409,
          "No approval gate is waiting on this run",
        );
			}
			const requestedCallId =
				typeof input.body?.callId === "string" ? input.body.callId : undefined;
			const gate = requestedCallId
				? gates.find((g) => g.callId === requestedCallId)
				: gates.length === 1
					? gates[0]
					: undefined;
			if (!gate) {
				return workflowControlError(
					409,
					requestedCallId
						? `No waiting gate matches callId ${requestedCallId}`
						: "Multiple gates are waiting — pass body.callId to disambiguate",
				);
			}
			const approved = input.body?.approved !== false;
			const raisedGate = await this.deps.approvalEvents.raiseWorkflowEvent({
				instanceId: gate.waiterInstanceId,
				eventName: gate.eventName,
				eventData: {
					approved,
					approvedBy: input.userId,
          ...(typeof input.body?.note === "string"
            ? { note: input.body.note }
            : {}),
					source: "run-ui",
				},
			});
			if (!raisedGate.ok) {
				console.error(
					`[approve] gate raise ${raisedGate.status}:`,
					raisedGate.detail.slice(0, 300),
				);
				return workflowControlError(
					raisedGate.status === 404 ? 409 : 502,
					"Failed to raise approval event",
				);
			}
			return {
				status: "ok",
				body: {
					ok: true,
					callId: gate.callId,
					approved,
					instanceId: gate.waiterInstanceId,
				},
			};
		}

		const raised = await this.deps.approvalEvents.raiseApprovalEvent({
			instanceId: execution.daprInstanceId,
			eventType,
			approvedBy: input.userId,
		});
		if (!raised.ok) {
			console.error(
				`[approve] orchestrator ${raised.status}:`,
				raised.detail.slice(0, 300),
			);
			return workflowControlError(
				raised.status === 404 ? 409 : 502,
				"Failed to raise approval event",
			);
		}

		return {
			status: "ok",
			body: { ok: true, eventType, instanceId: execution.daprInstanceId },
		};
	}

	async getApprovalState(
		input: WorkflowExecutionApprovalStateInput,
	): Promise<WorkflowExecutionControlResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return workflowControlError(404, "Execution not found");
		}

		if (
			!ACTIVE_APPROVAL_STATUSES.has(
				String(execution.status ?? "").toLowerCase(),
			)
		) {
			return { status: "ok", body: { awaiting: false } };
		}

		// Dynamic-script runs (cutover P1d): gates are journal rows with pause
		// markers, plural (scripts can hold parallel approve()/waitForEvent()).
		if (execution.executionIrVersion?.startsWith("dynamic-script")) {
			const gates = await this.listScriptGates(input.executionId);
      if (gates.length === 0)
        return { status: "ok", body: { awaiting: false } };
			return {
				status: "ok",
				body: {
					awaiting: true,
					gates: gates.map((g) => ({
						callId: g.callId,
						name: g.logicalName,
						label: g.label,
						message: g.message,
					})),
				},
			};
		}

		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: execution.workflowId,
			lookup: "id",
		});
		const gate = findListenGate(workflow?.spec, execution.currentNodeId);
		if (!gate) return { status: "ok", body: { awaiting: false } };

		return {
			status: "ok",
			body: {
				awaiting: true,
				nodeId: execution.currentNodeId,
				eventType: gate.eventType,
			},
		};
	}

	async resumeExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		let fromNodeId = resumeNodeId(input.body);
		const source = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!isExecutionInScope(source, input)) {
			return workflowControlError(404, "Execution not found");
		}
		if (!source.daprInstanceId) {
			return workflowControlError(
				409,
				"Run has no Dapr instance id to resume from",
			);
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		if (owner) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "coordinator_owned",
					ownedBy: owner.kind,
					runId: owner.runId,
					message:
						"This is a benchmark/eval instance — resume via the owning run instead.",
				},
			};
		}

		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: source.workflowId,
			lookup: "id",
		});
		if (!workflow) return workflowControlError(404, "Workflow not found");

		// Dynamic-script resume-after-edit: there are no nodes to skip — resume
		// starts a FRESH run of the CURRENT (possibly edited) script and imports the
		// source run's `done` journal rows so unchanged calls resolve without new
		// sessions. Only the changed calls re-dispatch. The source must have reached
		// a terminal projection so its journal is stable. stopRequestedAt is only a
		// persisted intent and is not evidence that the source has stopped.
		if (workflow.engineType === "dynamic-script") {
			if (!isTerminalExecution(source)) {
				return workflowControlError(
					409,
					"Source run is still active; stop it before resuming a dynamic-script run",
				);
			}
			const result = await this.deps.runStarter.startWorkflowRun({
				workflowId: source.workflowId,
				// Verbatim: any JSON value. A null stored input (run started without
				// args) resumes as undefined so the script's `args` global matches
				// the original run.
				triggerData: source.input ?? undefined,
				journalImportFromExecutionId: source.id,
				rerunOfExecutionId: source.id,
				rerunSourceInstanceId: source.daprInstanceId,
				triggerSource: "resume",
			});
			if (!result.ok) {
				return workflowControlError(result.status, result.error);
			}
			return {
				status: "ok",
				body: {
					ok: true,
					executionId: result.executionId,
					sourceExecutionId: source.id,
					newInstanceId: result.instanceId,
					journalImportFromExecutionId: source.id,
				},
			};
		}

		const nodeIds = topLevelNodeIds(workflow.spec);

		if (!fromNodeId) fromNodeId = source.currentNodeId ?? undefined;
		if (!fromNodeId) {
			return workflowControlError(
				400,
				"Could not determine a resume node; pass fromNodeId",
			);
		}
		if (nodeIds.length && !nodeIds.includes(fromNodeId)) {
			return workflowControlError(
				404,
				`Node '${fromNodeId}' is not a top-level node in the current workflow`,
			);
		}

		const seedWorkspaceFrom = await this.resolveWorkspaceExecutionId(source);
		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: source.workflowId,
			triggerData: (source.input ?? {}) as Record<string, unknown>,
			resumeFromNode: fromNodeId,
			seedWorkspaceFrom: seedWorkspaceFrom ?? undefined,
			rerunOfExecutionId: source.id,
			rerunSourceInstanceId: source.daprInstanceId,
			triggerSource: "resume",
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				ok: true,
				executionId: result.executionId,
				sourceExecutionId: source.id,
				newInstanceId: result.instanceId,
				fromNodeId,
				seedWorkspaceFrom,
			},
		};
	}

	/**
	 * Skip a pending dynamic-script `agent()`/`workflow()` call. Raises the
	 * `script.call.control` external event ({callId, action:'skip', requestedBy})
	 * into the running workflow instance; the evaluator then resolves that call's
	 * promise to null and the run proceeds. Scope + coordinator-owner guarded like
	 * the stop route. Returns 202 (accepted — the effect is asynchronous).
	 */
	async skipScriptCall(
		input: WorkflowExecutionControlInput & { callId: string },
	): Promise<WorkflowExecutionControlResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return workflowControlError(404, "Execution not found");
		}
		if (!input.callId) {
			return workflowControlError(400, "callId required");
		}
		if (!execution.daprInstanceId) {
			return workflowControlError(409, "Run has no Dapr instance id");
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		if (owner) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "coordinator_owned",
					ownedBy: owner.kind,
					runId: owner.runId,
					message:
						"This is a benchmark/eval instance — control it via the owning run instead.",
				},
			};
		}

		const raised = await this.deps.approvalEvents.raiseWorkflowEvent({
			instanceId: execution.daprInstanceId,
			eventName: "script.call.control",
			eventData: {
				callId: input.callId,
				action: "skip",
				requestedBy: input.userId,
			},
		});
		if (!raised.ok) {
      return workflowControlError(
        raised.status,
        raised.detail || "Failed to raise skip event",
      );
		}
		return { status: "ok", httpStatus: 202, body: { ok: true } };
	}

	private async resolveWorkspaceExecutionId(
		source: WorkflowExecutionRecord,
	): Promise<string | null> {
		let current = source;
		for (let hops = 0; hops < 20 && current.rerunOfExecutionId; hops++) {
			const parent = await this.deps.workflowData.getExecutionById(
				current.rerunOfExecutionId,
			);
			if (!parent) break;
			current = parent;
		}
		return current.daprInstanceId;
	}
}

const ACTIVE_APPROVAL_STATUSES = new Set(["running", "pending", "paused"]);

function findListenGate(
	spec: unknown,
	nodeId: string | null,
): { eventType: string } | null {
	if (!nodeId || typeof spec !== "object" || spec === null) return null;
	const doList = (spec as Record<string, unknown>).do;
	if (!Array.isArray(doList)) return null;
	for (const entry of doList) {
		if (typeof entry !== "object" || entry === null) continue;
		const key = Object.keys(entry as Record<string, unknown>)[0];
		if (key !== nodeId) continue;
		const node = (entry as Record<string, unknown>)[key] as Record<
			string,
			unknown
		>;
		const listen = node.listen as Record<string, unknown> | undefined;
		if (!listen) return null;
		const withType = (
			((listen.to as Record<string, unknown>)?.one as Record<string, unknown>)
				?.with as Record<string, unknown>
		)?.type;
		return {
			eventType: typeof withType === "string" && withType ? withType : nodeId,
		};
	}
	return null;
}

function resumeNodeId(
  body: Record<string, unknown> | undefined,
): string | undefined {
	const raw =
		typeof body?.fromNodeId === "string" && body.fromNodeId.trim()
			? body.fromNodeId.trim()
			: undefined;
	if (!raw?.includes("/")) return raw;
	return raw.split("/").filter(Boolean).pop() ?? raw;
}

function approvalEventType(body: Record<string, unknown> | undefined): string {
	const value = body?.eventType;
	return typeof value === "string" && value.trim()
		? value.trim()
		: "goal_spec_approval";
}

const TERMINAL_EXECUTION_STATUSES = new Set([
	"success",
	"error",
	"cancelled",
	"canceled",
	"failed",
	"completed",
]);

/** A run is safe to resume-from only after its persisted projection is terminal. */
function isTerminalExecution(source: WorkflowExecutionRecord): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(
    String(source.status ?? "").toLowerCase(),
  );
}

function topLevelNodeIds(spec: unknown): string[] {
	const doList = (spec as { do?: unknown })?.do;
	if (!Array.isArray(doList)) return [];
	const ids: string[] = [];
	for (const entry of doList) {
		if (entry && typeof entry === "object") {
			for (const key of Object.keys(entry as Record<string, unknown>)) {
				ids.push(key);
			}
		}
	}
	return ids;
}

type ScopedResource = {
	userId: string;
	projectId: string | null;
};

function isScopedResourceInScope<T extends ScopedResource>(
	resource: T | null,
	input: { userId: string; projectId?: string | null },
): resource is T {
	if (!resource) return false;
	if (resource.projectId && input.projectId) {
		return resource.projectId === input.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === input.userId;
	}
	return resource.userId === input.userId;
}

function isExecutionInScope(
	execution: WorkflowExecutionRecord | null,
	input: { userId: string; projectId?: string | null },
): execution is WorkflowExecutionRecord {
	return isScopedResourceInScope(execution, input);
}

function hasWebhookTrigger(workflow: WorkflowDefinition): boolean {
	const nodes = workflow.nodes as Array<{
		data?: { type?: string; config?: { triggerType?: string } };
	}>;
	return nodes.some(
		(node) =>
			node.data?.type === "trigger" &&
			node.data.config?.triggerType === "Webhook",
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

function parseStopMode(value: unknown): WorkflowExecutionLifecycleStopMode {
	return typeof value === "string" &&
		STOP_MODES.has(value as WorkflowExecutionLifecycleStopMode)
		? (value as WorkflowExecutionLifecycleStopMode)
		: "terminate";
}

function workflowControlError(
	httpStatus: number,
	message: string,
): WorkflowExecutionControlResult {
	return { status: "error", httpStatus, message };
}
