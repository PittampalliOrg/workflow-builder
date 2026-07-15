import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	dateValue,
	jsonParam,
	jsonValue,
	numberOrNull,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import type {
	ArtifactStore,
	WorkflowArtifactInput,
	WorkflowArtifactRecord,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStatus,
	WorkflowPlanArtifactStore,
} from "$lib/server/application/ports";

type BindingClient = Pick<DaprPostgresBindingClient, "query" | "exec">;

const WORKFLOW_ARTIFACT_COLUMNS = `
	id,
	workflow_execution_id,
	node_id,
	slot,
	kind,
	title,
	description,
	inline_payload,
	file_id,
	content_type,
	size_bytes,
	metadata,
	created_at
`;

const WORKFLOW_ARTIFACT_COLUMNS_QUALIFIED = `
	wa.id,
	wa.workflow_execution_id,
	wa.node_id,
	wa.slot,
	wa.kind,
	wa.title,
	wa.description,
	wa.inline_payload,
	wa.file_id,
	wa.content_type,
	wa.size_bytes,
	wa.metadata,
	wa.created_at
`;

const WORKFLOW_PLAN_ARTIFACT_COLUMNS = `
	id,
	workflow_execution_id,
	workflow_id,
	user_id,
	node_id,
	workspace_ref,
	clone_path,
	artifact_type,
	artifact_version,
	status,
	goal,
	plan_json,
	plan_markdown,
	source_prompt,
	metadata,
	created_at,
	updated_at
`;

function rowToArtifact(row: readonly unknown[]): WorkflowArtifactRecord {
	return {
		id: stringValue(row[0]),
		workflowExecutionId: stringValue(row[1]),
		nodeId: stringOrNull(row[2]),
		slot: stringOrNull(row[3]) as WorkflowArtifactRecord["slot"],
		kind: stringValue(row[4]),
		title: stringValue(row[5]),
		description: stringOrNull(row[6]),
		inlinePayload: jsonValue(row[7], null),
		fileId: stringOrNull(row[8]),
		contentType: stringOrNull(row[9]),
		sizeBytes: numberOrNull(row[10]),
		metadata: jsonValue<Record<string, unknown> | null>(row[11], null),
		createdAt: dateValue(row[12]),
	};
}

function rowToPlanArtifact(
	row: readonly unknown[],
): WorkflowPlanArtifactRecord {
	return {
		artifactRef: stringValue(row[0]),
		workflowExecutionId: stringValue(row[1]),
		workflowId: stringValue(row[2]),
		userId: stringOrNull(row[3]),
		nodeId: stringValue(row[4]),
		workspaceRef: stringOrNull(row[5]),
		clonePath: stringOrNull(row[6]),
		artifactType: stringValue(row[7], "claude_task_graph_v1"),
		artifactVersion: numberValue(row[8], 1),
		status: stringValue(row[9], "draft") as WorkflowPlanArtifactStatus,
		goal: stringValue(row[10]),
		planJson: jsonValue<Record<string, unknown>>(row[11], {}),
		planMarkdown: stringOrNull(row[12]),
		sourcePrompt: stringOrNull(row[13]),
		metadata: jsonValue<Record<string, unknown> | null>(row[14], null),
		createdAt: dateValue(row[15]),
		updatedAt: dateValue(row[16]),
	};
}

export class DaprPostgresArtifactStore implements ArtifactStore {
	constructor(
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
	) {}

	async upsertWorkflowArtifact(
		input: WorkflowArtifactInput,
	): Promise<{ id: string }> {
		const params = [
			input.id,
			input.workflowExecutionId,
			input.nodeId ?? null,
			input.slot ?? null,
			input.kind,
			input.title,
			input.description ?? null,
			jsonParam(input.inlinePayload ?? null),
			input.fileId ?? null,
			input.contentType ?? null,
			input.sizeBytes ?? null,
			jsonParam(input.metadata ?? null),
		];
		await this.client.exec({
			summary: "workflow_artifacts.upsert",
			collection: "workflow_artifacts",
			sql: `
				INSERT INTO workflow_artifacts (
					id,
					workflow_execution_id,
					node_id,
					slot,
					kind,
					title,
					description,
					inline_payload,
					file_id,
					content_type,
					size_bytes,
					metadata
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7,
					CAST($8 AS jsonb),
					$9, $10, $11,
					CAST($12 AS jsonb)
				)
				ON CONFLICT (id)
				DO UPDATE SET
					node_id = EXCLUDED.node_id,
					slot = EXCLUDED.slot,
					kind = EXCLUDED.kind,
					title = EXCLUDED.title,
					description = EXCLUDED.description,
					inline_payload = EXCLUDED.inline_payload,
					file_id = EXCLUDED.file_id,
					content_type = EXCLUDED.content_type,
					size_bytes = EXCLUDED.size_bytes,
					metadata = EXCLUDED.metadata
			`,
			params,
			spanParams: [
				...params.slice(0, 7),
				input.inlinePayload ?? null,
				...params.slice(8, 11),
				input.metadata ?? null,
			],
			paramNames: [
				"id",
				"workflow_execution_id",
				"node_id",
				"slot",
				"kind",
				"title",
				"description",
				"inline_payload",
				"file_id",
				"content_type",
				"size_bytes",
				"metadata",
			],
		});
		return { id: input.id };
	}

	async listWorkflowArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowArtifactRecord[]> {
		const result = await this.client.query({
			summary: "workflow_artifacts.select_by_execution",
			collection: "workflow_artifacts",
			sql: `
				SELECT ${WORKFLOW_ARTIFACT_COLUMNS}
				FROM workflow_artifacts
				WHERE workflow_execution_id = $1
				ORDER BY
					CASE slot
						WHEN 'primary' THEN 0
						WHEN 'secondary' THEN 1
						WHEN 'aux' THEN 2
						ELSE 3
					END ASC,
					created_at ASC
			`,
			params: [executionId],
			paramNames: ["workflow_execution_id"],
		});
		return result.rows.map(rowToArtifact);
	}

	async listSourceBundleArtifactsByWorkflowId(
		workflowId: string,
	): Promise<WorkflowArtifactRecord[]> {
		const result = await this.client.query({
			summary: "workflow_artifacts.select_source_bundles_by_workflow",
			collection: "workflow_artifacts",
			sql: `
				SELECT ${WORKFLOW_ARTIFACT_COLUMNS_QUALIFIED}
				FROM workflow_artifacts wa
				INNER JOIN workflow_executions we ON we.id = wa.workflow_execution_id
				WHERE we.workflow_id = $1 AND wa.kind = 'source-bundle'
				ORDER BY wa.created_at DESC
			`,
			params: [workflowId],
			paramNames: ["workflow_id"],
		});
		return result.rows.map(rowToArtifact);
	}

	async getWorkflowArtifactForExecution(input: {
		executionId: string;
		artifactId: string;
	}): Promise<WorkflowArtifactRecord | null> {
		const result = await this.client.query({
			summary: "workflow_artifacts.select_by_execution_and_id",
			collection: "workflow_artifacts",
			sql: `
				SELECT ${WORKFLOW_ARTIFACT_COLUMNS}
				FROM workflow_artifacts
				WHERE workflow_execution_id = $1 AND id = $2
				LIMIT 1
			`,
			params: [input.executionId, input.artifactId],
			paramNames: ["workflow_execution_id", "id"],
		});
		return result.rows[0] ? rowToArtifact(result.rows[0]) : null;
	}

	async updateWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		metadata: Record<string, unknown> | null;
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null> {
		const conditional = Boolean(input.ifAbsentMetadataKey);
		const result = await this.client.exec({
			summary: conditional
				? "workflow_artifacts.update_metadata_if_absent"
				: "workflow_artifacts.update_metadata",
			collection: "workflow_artifacts",
			sql: `
				UPDATE workflow_artifacts
				SET metadata = CAST($3 AS jsonb)
				WHERE workflow_execution_id = $1 AND id = $2
				${conditional ? "AND NOT (COALESCE(metadata, '{}'::jsonb) ? $4)" : ""}
			`,
			params: [
				input.executionId,
				input.artifactId,
				jsonParam(input.metadata ?? null),
				...(conditional ? [input.ifAbsentMetadataKey] : []),
			],
			spanParams: [
				input.executionId,
				input.artifactId,
				input.metadata ?? null,
				...(conditional ? [input.ifAbsentMetadataKey] : []),
			],
			paramNames: [
				"workflow_execution_id",
				"id",
				"metadata",
				...(conditional ? ["if_absent_metadata_key"] : []),
			],
		});
		if (conditional && result.rowsAffected !== 1) return null;
		return this.getWorkflowArtifactForExecution(input);
	}

	async mergeWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		patch: Record<string, unknown>;
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null> {
		const conditional = Boolean(input.ifAbsentMetadataKey);
		const result = await this.client.exec({
			summary: conditional
				? "workflow_artifacts.merge_metadata_if_absent"
				: "workflow_artifacts.merge_metadata",
			collection: "workflow_artifacts",
			sql: `
				UPDATE workflow_artifacts
				SET metadata = COALESCE(metadata, '{}'::jsonb) || CAST($3 AS jsonb)
				WHERE workflow_execution_id = $1 AND id = $2
				${conditional ? "AND NOT (COALESCE(metadata, '{}'::jsonb) ? $4)" : ""}
			`,
			params: [
				input.executionId,
				input.artifactId,
				jsonParam(input.patch),
				...(conditional ? [input.ifAbsentMetadataKey] : []),
			],
			spanParams: [
				input.executionId,
				input.artifactId,
				input.patch,
				...(conditional ? [input.ifAbsentMetadataKey] : []),
			],
			paramNames: [
				"workflow_execution_id",
				"id",
				"metadata_patch",
				...(conditional ? ["if_absent_metadata_key"] : []),
			],
		});
		if (conditional && result.rowsAffected !== 1) return null;
		return this.getWorkflowArtifactForExecution(input);
	}
}

export class DaprPostgresWorkflowPlanArtifactStore implements WorkflowPlanArtifactStore {
	constructor(
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
	) {}

	async upsertPlanArtifact(input: WorkflowPlanArtifactInput): Promise<{
		artifactRef: string;
		storageBackend: "workflow_plan_artifacts";
		artifactType: string;
		status: WorkflowPlanArtifactStatus;
	}> {
		const artifactType = input.artifactType?.trim() || "claude_task_graph_v1";
		const status = input.status ?? "draft";
		const params = [
			input.artifactRef,
			input.workflowExecutionId,
			input.workflowId,
			input.nodeId,
			input.workspaceRef ?? null,
			input.clonePath ?? null,
			artifactType,
			status,
			input.goal,
			jsonParam(input.planJson),
			input.planMarkdown ?? null,
			input.sourcePrompt ?? null,
			jsonParam(input.metadata ?? null),
		];
		await this.client.exec({
			summary: "workflow_plan_artifacts.upsert",
			collection: "workflow_plan_artifacts",
			sql: `
				INSERT INTO workflow_plan_artifacts (
					id,
					workflow_execution_id,
					workflow_id,
					user_id,
					node_id,
					workspace_ref,
					clone_path,
					artifact_type,
					artifact_version,
					status,
					goal,
					plan_json,
					plan_markdown,
					source_prompt,
					metadata
				)
				SELECT
					$1,
					$2,
					coalesce(we.workflow_id, $3),
					we.user_id,
					$4,
					$5,
					$6,
					$7,
					1,
					$8,
					$9,
					CAST($10 AS jsonb),
					$11,
					$12,
					CAST($13 AS jsonb)
				FROM workflow_executions we
				WHERE we.id = $2
				ON CONFLICT (id)
				DO UPDATE SET
					status = EXCLUDED.status,
					goal = EXCLUDED.goal,
					plan_json = EXCLUDED.plan_json,
					plan_markdown = EXCLUDED.plan_markdown,
					source_prompt = EXCLUDED.source_prompt,
					metadata = EXCLUDED.metadata,
					workspace_ref = EXCLUDED.workspace_ref,
					clone_path = EXCLUDED.clone_path,
					updated_at = now()
			`,
			params,
			spanParams: [
				...params.slice(0, 9),
				input.planJson,
				...params.slice(10, 12),
				input.metadata ?? null,
			],
			paramNames: [
				"id",
				"workflow_execution_id",
				"workflow_id",
				"node_id",
				"workspace_ref",
				"clone_path",
				"artifact_type",
				"status",
				"goal",
				"plan_json",
				"plan_markdown",
				"source_prompt",
				"metadata",
			],
		});
		const selected = await this.getPlanArtifact(input.artifactRef);
		if (!selected) {
			throw new Error(`plan artifact ${input.artifactRef} not found`);
		}
		return {
			artifactRef: input.artifactRef,
			storageBackend: "workflow_plan_artifacts",
			artifactType,
			status,
		};
	}

	async listPlanArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowPlanArtifactRecord[]> {
		const result = await this.client.query({
			summary: "workflow_plan_artifacts.select_by_execution",
			collection: "workflow_plan_artifacts",
			sql: `
				SELECT ${WORKFLOW_PLAN_ARTIFACT_COLUMNS}
				FROM workflow_plan_artifacts
				WHERE workflow_execution_id = $1
				ORDER BY created_at DESC
			`,
			params: [executionId],
			paramNames: ["workflow_execution_id"],
		});
		return result.rows.map(rowToPlanArtifact);
	}

	async updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: WorkflowPlanArtifactStatus }> {
		await this.client.exec({
			summary: "workflow_plan_artifacts.update_status",
			collection: "workflow_plan_artifacts",
			sql: `
				UPDATE workflow_plan_artifacts
				SET
					status = $2,
					metadata = CASE
						WHEN $3::boolean THEN CAST($4 AS jsonb)
						ELSE metadata
					END,
					updated_at = now()
				WHERE id = $1
			`,
			params: [
				input.artifactRef,
				input.status,
				input.metadata !== undefined,
				jsonParam(input.metadata ?? null),
			],
			spanParams: [
				input.artifactRef,
				input.status,
				input.metadata !== undefined,
				input.metadata ?? null,
			],
			paramNames: ["id", "status", "metadata_provided", "metadata"],
		});
		return { artifactRef: input.artifactRef, status: input.status };
	}

	async getPlanArtifact(
		artifactRef: string,
	): Promise<WorkflowPlanArtifactRecord | null> {
		const result = await this.client.query({
			summary: "workflow_plan_artifacts.select_by_id",
			collection: "workflow_plan_artifacts",
			sql: `
				SELECT ${WORKFLOW_PLAN_ARTIFACT_COLUMNS}
				FROM workflow_plan_artifacts
				WHERE id = $1
				LIMIT 1
			`,
			params: [artifactRef],
			paramNames: ["id"],
		});
		return result.rows[0] ? rowToPlanArtifact(result.rows[0]) : null;
	}
}
