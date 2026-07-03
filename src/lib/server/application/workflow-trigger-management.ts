import type {
	CreateWorkflowTriggerInput,
	WorkflowTriggerRecord,
} from "$lib/server/application/ports";
import { getTriggerKind, validateTriggerConfig } from "$lib/server/workflows/trigger-registry";
import { generateId } from "$lib/server/utils/id";

type ScopedWorkflowRecord = {
	id: string;
	userId: string;
	projectId: string | null;
};

type WorkflowTriggerManagementDataPort = {
	getWorkflowByRef(input: {
		workflowId: string;
		lookup: "id";
	}): Promise<ScopedWorkflowRecord | null>;
	listWorkflowTriggers(workflowId: string): Promise<WorkflowTriggerRecord[]>;
	createWorkflowTrigger(input: CreateWorkflowTriggerInput): Promise<WorkflowTriggerRecord>;
};

export type WorkflowTriggerManagementCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			body: string | Record<string, unknown>;
	  };

type WorkflowTriggerManagementErrorResult = Extract<
	WorkflowTriggerManagementCommandResult,
	{ status: "error" }
>;

export type WorkflowTriggerManagementInput = {
	workflowId: string;
	userId: string;
	projectId?: string | null;
};

export class ApplicationWorkflowTriggerManagementService {
	constructor(
		private readonly deps: {
			workflowData: WorkflowTriggerManagementDataPort;
			generateDedupSalt?: () => string;
		},
	) {}

	async listTriggers(
		input: WorkflowTriggerManagementInput,
	): Promise<WorkflowTriggerManagementCommandResult> {
		const workflow = await this.getScopedWorkflow(input);
		if (workflow.status === "error") return workflow;

		const rows = await this.deps.workflowData.listWorkflowTriggers(input.workflowId);
		return {
			status: "ok",
			body: { triggers: rows.map(sanitizeTrigger) },
		};
	}

	async createTrigger(
		input: WorkflowTriggerManagementInput & { body: unknown },
	): Promise<WorkflowTriggerManagementCommandResult> {
		const workflow = await this.getScopedWorkflow(input);
		if (workflow.status === "error") return workflow;

		const body = normalizeBody(input.body);
		const kind = getTriggerKind(body.kind);
		if (!kind) {
			return {
				status: "error",
				httpStatus: 400,
				body: `Unknown trigger kind: ${body.kind}`,
			};
		}

		const validation = validateTriggerConfig(kind.id, body.config);
		if (!validation.ok) {
			return {
				status: "error",
				httpStatus: 400,
				body: `Missing required config: ${validation.missing.join(", ")}`,
			};
		}

		const row = await this.deps.workflowData.createWorkflowTrigger({
			workflowId: workflow.record.id,
			userId: input.userId,
			projectId: workflow.record.projectId ?? null,
			kind: kind.id,
			config: body.config ?? {},
			triggerData: body.triggerData ?? null,
			dedupSalt: (this.deps.generateDedupSalt ?? generateId)(),
			status: "inactive",
		});

		return {
			status: "ok",
			httpStatus: 201,
			body: { trigger: sanitizeTrigger(row) },
		};
	}

	private async getScopedWorkflow(
		input: WorkflowTriggerManagementInput,
	): Promise<
		| { status: "ok"; record: ScopedWorkflowRecord }
		| WorkflowTriggerManagementErrorResult
	> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isResourceInScope(workflow, input)) {
			return {
				status: "error",
				httpStatus: 404,
				body: "Workflow not found",
			};
		}
		return { status: "ok", record: workflow };
	}
}

function normalizeBody(body: unknown): {
	kind?: string;
	config?: Record<string, unknown>;
	triggerData?: Record<string, unknown> | null;
} {
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const record = body as Record<string, unknown>;
	return {
		kind: typeof record.kind === "string" ? record.kind : undefined,
		config: isPlainRecord(record.config) ? record.config : undefined,
		triggerData: isPlainRecord(record.triggerData) ? record.triggerData : null,
	};
}

function sanitizeTrigger(row: WorkflowTriggerRecord): WorkflowTriggerRecord {
	if (!row.config || typeof row.config !== "object") return row;
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row.config)) {
		if (!key.startsWith("__")) clean[key] = value;
	}
	return { ...row, config: clean };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isResourceInScope(
	resource: ScopedWorkflowRecord | null | undefined,
	session: { userId: string; projectId?: string | null },
): resource is ScopedWorkflowRecord {
	if (!resource) return false;
	if (resource.projectId && session.projectId) {
		return resource.projectId === session.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === session.userId;
	}
	return resource.userId === session.userId;
}
