import type {
	LegacyAgentPlanReaderPort,
	WorkflowDataService,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStatus,
} from "$lib/server/application/ports";
import { generateId } from "$lib/server/utils/id";

export type WorkflowExecutionPlanReadModel = {
	plan: string | null;
};

export type WorkflowPlanArtifactResult =
	| { status: "ok"; artifact: WorkflowPlanArtifactRecord }
	| { status: "not_found"; message: string }
	| { status: "bad_request"; message: string }
	| { status: "error"; message: string };

export type WorkflowPlanArtifactListResult =
	| { status: "ok"; artifacts: WorkflowPlanArtifactRecord[] }
	| { status: "not_found"; message: string };

const VALID_PLAN_ARTIFACT_STATUSES: WorkflowPlanArtifactStatus[] = [
	"draft",
	"approved",
	"superseded",
	"executed",
	"failed",
];

export class ApplicationWorkflowPlanService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getScopedExecutionById"
				| "listPlanArtifactsByExecutionId"
				| "upsertPlanArtifact"
				| "getPlanArtifact"
				| "updatePlanArtifactStatus"
			>;
			legacyAgentPlans: LegacyAgentPlanReaderPort;
		},
	) {}

	async getExecutionPlan(input: {
		executionId: string;
	}): Promise<WorkflowExecutionPlanReadModel> {
		let artifacts;
		try {
			artifacts = await this.deps.workflowData.listPlanArtifactsByExecutionId(
				input.executionId,
			);
		} catch {
			return { plan: null };
		}

		const [artifact] = artifacts;
		if (artifact?.planMarkdown) {
			return { plan: artifact.planMarkdown };
		}

		try {
			return { plan: await this.deps.legacyAgentPlans.getPlan(input.executionId) };
		} catch {
			return { plan: null };
		}
	}

	async listExecutionPlanArtifacts(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkflowPlanArtifactListResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById(input);
		if (!execution) return { status: "not_found", message: "Execution not found" };
		return {
			status: "ok",
			artifacts: await this.deps.workflowData.listPlanArtifactsByExecutionId(
				input.executionId,
			),
		};
	}

	async createExecutionPlanArtifact(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
		goal?: unknown;
		planMarkdown?: unknown;
		planJson?: unknown;
		nodeId?: unknown;
		workflowId?: unknown;
		metadata?: unknown;
	}): Promise<WorkflowPlanArtifactResult> {
		const goal = typeof input.goal === "string" ? input.goal.trim() : "";
		const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
		const workflowId = typeof input.workflowId === "string" ? input.workflowId.trim() : "";
		if (!goal || !nodeId || !workflowId) {
			return {
				status: "bad_request",
				message: "Missing required fields: goal, nodeId, workflowId",
			};
		}

		const execution = await this.deps.workflowData.getScopedExecutionById(input);
		if (!execution) return { status: "not_found", message: "Execution not found" };
		if (workflowId !== execution.workflowId) {
			return {
				status: "bad_request",
				message: "workflowId does not match execution",
			};
		}

		const artifactRef = generateId();
		await this.deps.workflowData.upsertPlanArtifact({
			artifactRef,
			workflowExecutionId: input.executionId,
			workflowId: execution.workflowId,
			nodeId,
			goal,
			planMarkdown:
				typeof input.planMarkdown === "string" && input.planMarkdown.trim()
					? input.planMarkdown
					: null,
			planJson: isRecord(input.planJson) ? input.planJson : { steps: [] },
			status: "draft",
			metadata: isRecord(input.metadata) ? input.metadata : null,
		});
		const artifact = await this.deps.workflowData.getPlanArtifact(artifactRef);
		if (!artifact) return { status: "error", message: "Plan artifact was not created" };
		return { status: "ok", artifact };
	}

	async updateExecutionPlanArtifactStatus(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
		artifactId?: unknown;
		status?: unknown;
		metadata?: unknown;
	}): Promise<WorkflowPlanArtifactResult> {
		const artifactId = typeof input.artifactId === "string" ? input.artifactId.trim() : "";
		const status = typeof input.status === "string" ? input.status.trim() : "";
		if (!artifactId || !status) {
			return {
				status: "bad_request",
				message: "Missing required fields: artifactId, status",
			};
		}
		if (!VALID_PLAN_ARTIFACT_STATUSES.includes(status as WorkflowPlanArtifactStatus)) {
			return {
				status: "bad_request",
				message: `Invalid status. Must be one of: ${VALID_PLAN_ARTIFACT_STATUSES.join(", ")}`,
			};
		}

		const execution = await this.deps.workflowData.getScopedExecutionById(input);
		if (!execution) return { status: "not_found", message: "Execution not found" };

		const existing = await this.deps.workflowData.getPlanArtifact(artifactId);
		if (!existing || existing.workflowExecutionId !== input.executionId) {
			return { status: "not_found", message: "Plan artifact not found" };
		}

		await this.deps.workflowData.updatePlanArtifactStatus({
			artifactRef: artifactId,
			status: status as WorkflowPlanArtifactStatus,
			metadata: isRecord(input.metadata) ? input.metadata : undefined,
		});
		const artifact = await this.deps.workflowData.getPlanArtifact(artifactId);
		if (!artifact || artifact.workflowExecutionId !== input.executionId) {
			return { status: "not_found", message: "Plan artifact not found" };
		}
		return { status: "ok", artifact };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
