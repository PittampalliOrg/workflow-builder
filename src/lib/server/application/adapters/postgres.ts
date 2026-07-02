import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	mlflowLineageLinks,
	sessions,
	workflowArtifacts,
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowPlanArtifacts,
	workflowWorkspaceSessions,
	workflows,
	type Workflow,
	type WorkflowArtifactRow,
	type WorkflowExecution,
	type WorkflowExecutionLog,
	type WorkflowPlanArtifact,
} from "$lib/server/db/schema";
import type {
	AppendWorkflowExecutionLogInput,
	ArtifactStore,
	CreateWorkflowExecutionInput,
	TraceLinkTarget,
	TraceLineageStore,
	UpsertTraceLineageLinksInput,
	UpdateWorkflowAgentRunLifecycleInput,
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowArtifactRecord,
	WorkflowArtifactInput,
	WorkflowAgentRunStore,
	WorkflowDefinition,
	WorkflowDefinitionRepository,
	WorkflowExecutionRecord,
	WorkflowExecutionLogPatch,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRepository,
	WorkflowExecutionLogRecord,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStore,
	UpsertWorkspaceSessionInput,
	WorkspaceSessionStore,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

const SLOT_RANK = sql<number>`CASE ${workflowArtifacts.slot}
	WHEN 'primary' THEN 0
	WHEN 'secondary' THEN 1
	WHEN 'aux' THEN 2
	ELSE 3
END`;

export function requirePostgresDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

function mapWorkflow(row: Workflow): WorkflowDefinition {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		userId: row.userId,
		projectId: row.projectId,
		nodes: Array.isArray(row.nodes) ? row.nodes : [],
		edges: Array.isArray(row.edges) ? row.edges : [],
		specVersion: row.specVersion,
		spec: row.spec,
		visibility: row.visibility,
		engineType: row.engineType,
		daprWorkflowName: row.daprWorkflowName,
		daprOrchestratorUrl: row.daprOrchestratorUrl,
		mlflowExperimentId: row.mlflowExperimentId,
		mlflowExperimentName: row.mlflowExperimentName,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapExecution(row: WorkflowExecution): WorkflowExecutionRecord {
	return {
		id: row.id,
		workflowId: row.workflowId,
		userId: row.userId,
		projectId: row.projectId,
		status: row.status,
		input: row.input ?? null,
		output: row.output,
		executionIrVersion: row.executionIrVersion,
		executionIr: row.executionIr,
		error: row.error,
		daprInstanceId: row.daprInstanceId,
		phase: row.phase,
		progress: row.progress,
		currentNodeId: row.currentNodeId,
		currentNodeName: row.currentNodeName,
		primaryTraceId: row.primaryTraceId,
		workflowSessionId: row.workflowSessionId,
		mlflowExperimentId: row.mlflowExperimentId,
		mlflowRunId: row.mlflowRunId,
		summaryOutput: row.summaryOutput,
		errorStackTrace: row.errorStackTrace,
		rerunOfExecutionId: row.rerunOfExecutionId,
		rerunSourceInstanceId: row.rerunSourceInstanceId,
		resumeFromNode: row.resumeFromNode,
		triggerSource: row.triggerSource,
		rerunFromEventId: row.rerunFromEventId,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		duration: row.duration,
		stopRequestedAt: row.stopRequestedAt,
		stopReason: row.stopReason,
	};
}

function mapExecutionLog(row: WorkflowExecutionLog): WorkflowExecutionLogRecord {
	return {
		id: row.id,
		executionId: row.executionId,
		nodeId: row.nodeId,
		nodeName: row.nodeName,
		nodeType: row.nodeType,
		activityName: row.activityName,
		status: row.status,
		input: row.input,
		output: row.output,
		error: row.error,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		duration: row.duration,
		timestamp: row.timestamp,
		credentialFetchMs: row.credentialFetchMs,
		routingMs: row.routingMs,
		coldStartMs: row.coldStartMs,
		executionMs: row.executionMs,
		routedTo: row.routedTo,
		wasColdStart: row.wasColdStart,
	};
}

function mapArtifact(row: WorkflowArtifactRow): WorkflowArtifactRecord {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		nodeId: row.nodeId,
		slot: row.slot ?? null,
		kind: row.kind,
		title: row.title,
		description: row.description,
		inlinePayload: row.inlinePayload,
		fileId: row.fileId,
		contentType: row.contentType,
		sizeBytes: row.sizeBytes,
		metadata: row.metadata,
		createdAt: row.createdAt,
	};
}

function mapPlanArtifact(row: WorkflowPlanArtifact): WorkflowPlanArtifactRecord {
	return {
		artifactRef: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		userId: row.userId,
		nodeId: row.nodeId,
		workspaceRef: row.workspaceRef,
		clonePath: row.clonePath,
		artifactType: row.artifactType,
		artifactVersion: row.artifactVersion,
		status: row.status,
		goal: row.goal,
		planJson:
			row.planJson && typeof row.planJson === "object"
				? (row.planJson as Record<string, unknown>)
				: {},
		planMarkdown: row.planMarkdown,
		sourcePrompt: row.sourcePrompt,
		metadata: row.metadata,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export class PostgresWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getById(id: string): Promise<WorkflowDefinition | null> {
		const [row] = await this.database
			.select()
			.from(workflows)
			.where(eq(workflows.id, id))
			.limit(1);
		return row ? mapWorkflow(row) : null;
	}

	async getLatestByName(name: string): Promise<WorkflowDefinition | null> {
		const candidates = await this.database
			.select()
			.from(workflows)
			.where(eq(workflows.name, name))
			.orderBy(desc(workflows.updatedAt))
			.limit(20);
		if (candidates.length === 0) return null;
		const row = candidates.find((workflow) => workflow.visibility === "public") ?? candidates[0] ?? null;
		return row ? mapWorkflow(row) : null;
	}

	async getByRef(ref: { workflowId?: string | null; workflowName?: string | null }): Promise<WorkflowDefinition | null> {
		const workflowId = ref.workflowId?.trim();
		if (workflowId) return this.getById(workflowId);
		const workflowName = ref.workflowName?.trim();
		if (!workflowName) return null;
		return this.getLatestByName(workflowName);
	}
}

export class PostgresWorkflowExecutionRepository implements WorkflowExecutionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getById(id: string): Promise<WorkflowExecutionRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, id))
			.limit(1);
		return row ? mapExecution(row) : null;
	}

	async create(input: CreateWorkflowExecutionInput): Promise<{ id: string }> {
		const [row] = await this.database
			.insert(workflowExecutions)
			.values({
				...(input.id ? { id: input.id } : {}),
				workflowId: input.workflowId,
				userId: input.userId,
				projectId: input.projectId ?? null,
				status: input.status,
				phase: input.phase ?? null,
				progress: input.progress ?? null,
				input: input.input,
				output: input.output,
				executionIr: input.executionIr,
				executionIrVersion: input.executionIrVersion ?? null,
				...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
				...(input.rerunOfExecutionId ? { rerunOfExecutionId: input.rerunOfExecutionId } : {}),
				...(input.rerunSourceInstanceId
					? { rerunSourceInstanceId: input.rerunSourceInstanceId }
					: {}),
				...(input.resumeFromNode ? { resumeFromNode: input.resumeFromNode } : {}),
			})
			.returning({ id: workflowExecutions.id });
		if (!row) throw new Error("Failed to create workflow execution");
		return row;
	}

	async attachSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
	}): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set({
				daprInstanceId: input.instanceId,
				phase: "running",
				progress: 0,
				workflowSessionId: input.workflowSessionId ?? input.executionId,
			})
			.where(eq(workflowExecutions.id, input.executionId));
	}

	async markStartFailed(input: { executionId: string; error: string }): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set({
				status: "error",
				phase: "failed",
				error: input.error,
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, input.executionId));
	}

	async updateReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set(patch)
			.where(eq(workflowExecutions.id, executionId));
	}

	async appendLog(input: AppendWorkflowExecutionLogInput): Promise<WorkflowExecutionLogRecord> {
		const [row] = await this.database
			.insert(workflowExecutionLogs)
			.values({
				...(input.id ? { id: input.id } : {}),
				executionId: input.executionId,
				nodeId: input.nodeId,
				nodeName: input.nodeName,
				nodeType: input.nodeType,
				activityName: input.activityName ?? null,
				status: input.status,
				input: input.input,
				output: input.output,
				error: input.error ?? null,
				...(input.startedAt ? { startedAt: input.startedAt } : {}),
				...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
				duration: input.duration ?? null,
				credentialFetchMs: input.credentialFetchMs ?? null,
				routingMs: input.routingMs ?? null,
				coldStartMs: input.coldStartMs ?? null,
				executionMs: input.executionMs ?? null,
				routedTo: input.routedTo ?? null,
				wasColdStart: input.wasColdStart ?? null,
			})
			.returning();
		if (!row) throw new Error("Failed to append workflow execution log");
		return mapExecutionLog(row);
	}

	async updateLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null> {
		const [row] = await this.database
			.update(workflowExecutionLogs)
			.set(patch)
			.where(and(
				eq(workflowExecutionLogs.id, id),
				eq(workflowExecutionLogs.executionId, executionId),
			))
			.returning();
		return row ? mapExecutionLog(row) : null;
	}
}

export class PostgresArtifactStore implements ArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }> {
		const [execution] = await this.database
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, input.workflowExecutionId))
			.limit(1);
		if (!execution) throw new Error(`execution ${input.workflowExecutionId} not found`);

		await this.database
			.insert(workflowArtifacts)
			.values({
				id: input.id,
				workflowExecutionId: input.workflowExecutionId,
				nodeId: input.nodeId ?? null,
				slot: input.slot ?? null,
				kind: input.kind,
				title: input.title,
				description: input.description ?? null,
				inlinePayload: input.inlinePayload ?? null,
				fileId: input.fileId ?? null,
				contentType: input.contentType ?? null,
				sizeBytes: input.sizeBytes ?? null,
				metadata: input.metadata ?? null,
			})
			.onConflictDoUpdate({
				target: workflowArtifacts.id,
				set: {
					nodeId: input.nodeId ?? null,
					slot: input.slot ?? null,
					kind: input.kind,
					title: input.title,
					description: input.description ?? null,
					inlinePayload: input.inlinePayload ?? null,
					fileId: input.fileId ?? null,
					contentType: input.contentType ?? null,
					sizeBytes: input.sizeBytes ?? null,
					metadata: input.metadata ?? null,
				},
			});
		return { id: input.id };
	}

	async listWorkflowArtifactsByExecutionId(executionId: string): Promise<WorkflowArtifactRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowArtifacts)
			.where(eq(workflowArtifacts.workflowExecutionId, executionId))
			.orderBy(SLOT_RANK, asc(workflowArtifacts.createdAt));
		return rows.map(mapArtifact);
	}
}

export class PostgresWorkspaceSessionStore implements WorkspaceSessionStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }> {
		await this.database
			.insert(workflowWorkspaceSessions)
			.values({
				workspaceRef: input.workspaceRef,
				workflowExecutionId: input.workflowExecutionId ?? null,
				durableInstanceId: input.durableInstanceId ?? null,
				name: input.name,
				rootPath: input.rootPath,
				clonePath: input.clonePath ?? null,
				backend: input.backend,
				enabledTools: input.enabledTools ?? [],
				status: input.status ?? "active",
				sandboxState: input.sandboxState ?? null,
			})
			.onConflictDoUpdate({
				target: workflowWorkspaceSessions.workspaceRef,
				set: {
					workflowExecutionId: input.workflowExecutionId ?? null,
					durableInstanceId: input.durableInstanceId ?? null,
					name: input.name,
					rootPath: input.rootPath,
					clonePath: input.clonePath ?? null,
					backend: input.backend,
					enabledTools: input.enabledTools ?? [],
					status: input.status ?? "active",
					sandboxState: input.sandboxState ?? null,
					updatedAt: new Date(),
					lastAccessedAt: new Date(),
				},
			});
		return { workspaceRef: input.workspaceRef };
	}
}

export class PostgresWorkflowAgentRunStore implements WorkflowAgentRunStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertScheduledAgentRun(
		input: UpsertWorkflowAgentRunScheduledInput,
	): Promise<{ id: string }> {
		await this.database
			.insert(workflowAgentRuns)
			.values({
				id: input.id,
				workflowExecutionId: input.workflowExecutionId,
				workflowId: input.workflowId,
				nodeId: input.nodeId,
				mode: input.mode,
				agentWorkflowId: input.agentWorkflowId,
				daprInstanceId: input.daprInstanceId,
				parentExecutionId: input.parentExecutionId,
				workspaceRef: input.workspaceRef ?? null,
				artifactRef: input.artifactRef ?? null,
				status: "scheduled",
			})
			.onConflictDoUpdate({
				target: workflowAgentRuns.id,
				set: {
					workflowExecutionId: input.workflowExecutionId,
					workflowId: input.workflowId,
					nodeId: input.nodeId,
					mode: input.mode,
					agentWorkflowId: input.agentWorkflowId,
					daprInstanceId: input.daprInstanceId,
					parentExecutionId: input.parentExecutionId,
					workspaceRef: input.workspaceRef ?? null,
					artifactRef: input.artifactRef ?? null,
					status: "scheduled",
					updatedAt: new Date(),
				},
			});

		if (input.workspaceRef) {
			await this.database
				.update(workflowWorkspaceSessions)
				.set({
					durableInstanceId: input.daprInstanceId,
					updatedAt: new Date(),
					lastAccessedAt: new Date(),
				})
				.where(eq(workflowWorkspaceSessions.workspaceRef, input.workspaceRef));
		}

		return { id: input.id };
	}

	async updateAgentRunLifecycle(
		input: UpdateWorkflowAgentRunLifecycleInput,
	): Promise<{ id: string; status: "scheduled" | "running" | "completed" | "failed" | "event_published" }> {
		if (input.status === "running") {
			await this.database
				.update(workflowAgentRuns)
				.set({
					status: "running",
					...(input.result != null ? { result: input.result } : {}),
					updatedAt: new Date(),
				})
				.where(eq(workflowAgentRuns.id, input.id));
		} else {
			await this.database
				.update(workflowAgentRuns)
				.set({
					status: input.status,
					result: input.result ?? null,
					error: input.error ?? null,
					...(input.workspaceRef ? { workspaceRef: input.workspaceRef } : {}),
					completedAt: sql`COALESCE(${workflowAgentRuns.completedAt}, now())`,
					...(input.eventPublished ? { eventPublishedAt: new Date() } : {}),
					updatedAt: new Date(),
				})
				.where(eq(workflowAgentRuns.id, input.id));
		}

		return { id: input.id, status: input.status };
	}
}

export class PostgresWorkflowPlanArtifactStore implements WorkflowPlanArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertPlanArtifact(input: WorkflowPlanArtifactInput): Promise<{
		artifactRef: string;
		storageBackend: "workflow_plan_artifacts";
		artifactType: string;
		status: "draft" | "approved" | "superseded" | "executed" | "failed";
	}> {
		const [execution] = await this.database
			.select({
				userId: workflowExecutions.userId,
				workflowId: workflowExecutions.workflowId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, input.workflowExecutionId))
			.limit(1);
		if (!execution) throw new Error(`execution ${input.workflowExecutionId} not found`);

		const artifactType = input.artifactType?.trim() || "claude_task_graph_v1";
		const status = input.status ?? "draft";
		await this.database
			.insert(workflowPlanArtifacts)
			.values({
				id: input.artifactRef,
				workflowExecutionId: input.workflowExecutionId,
				workflowId: execution.workflowId ?? input.workflowId,
				userId: execution.userId ?? null,
				nodeId: input.nodeId,
				workspaceRef: input.workspaceRef ?? null,
				clonePath: input.clonePath ?? null,
				artifactType: artifactType as "claude_task_graph_v1",
				artifactVersion: 1,
				status,
				goal: input.goal,
				planJson: input.planJson,
				planMarkdown: input.planMarkdown ?? null,
				sourcePrompt: input.sourcePrompt ?? null,
				metadata: input.metadata ?? null,
			})
			.onConflictDoUpdate({
				target: workflowPlanArtifacts.id,
				set: {
					status,
					goal: input.goal,
					planJson: input.planJson,
					planMarkdown: input.planMarkdown ?? null,
					sourcePrompt: input.sourcePrompt ?? null,
					metadata: input.metadata ?? null,
					workspaceRef: input.workspaceRef ?? null,
					clonePath: input.clonePath ?? null,
					updatedAt: new Date(),
				},
			});

		return {
			artifactRef: input.artifactRef,
			storageBackend: "workflow_plan_artifacts",
			artifactType,
			status,
		};
	}

	async updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: "draft" | "approved" | "superseded" | "executed" | "failed";
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: "draft" | "approved" | "superseded" | "executed" | "failed" }> {
		const [row] = await this.database
			.update(workflowPlanArtifacts)
			.set({
				status: input.status,
				...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
				updatedAt: new Date(),
			})
			.where(eq(workflowPlanArtifacts.id, input.artifactRef))
			.returning({ id: workflowPlanArtifacts.id });
		if (!row) throw new Error(`plan artifact ${input.artifactRef} not found`);
		return { artifactRef: input.artifactRef, status: input.status };
	}

	async getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowPlanArtifacts)
			.where(eq(workflowPlanArtifacts.id, artifactRef))
			.limit(1);
		return row ? mapPlanArtifact(row) : null;
	}
}

export class PostgresTraceLineageStore implements TraceLineageStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getTraceTargetsForExecution(executionId: string): Promise<TraceLinkTarget[]> {
		const targets: TraceLinkTarget[] = [];
		const [execution] = await this.database
			.select({
				id: workflowExecutions.id,
				projectId: workflowExecutions.projectId,
				externalExperimentId: workflowExecutions.mlflowExperimentId,
				externalRunId: workflowExecutions.mlflowRunId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (execution) {
			targets.push({
				entityType: "workflow_execution",
				entityId: execution.id,
				projectId: execution.projectId,
				externalExperimentId: execution.externalExperimentId,
				externalRunId: execution.externalRunId,
			});
		}

		const sessionRows = await this.database
			.select({
				id: sessions.id,
				projectId: sessions.projectId,
				externalExperimentId: sessions.mlflowExperimentId,
				externalRunId: sessions.mlflowRunId,
			})
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, executionId));
		for (const row of sessionRows) {
			targets.push({
				entityType: "session",
				entityId: row.id,
				projectId: row.projectId,
				externalExperimentId: row.externalExperimentId,
				externalRunId: row.externalRunId,
			});
		}

		const seen = new Set<string>();
		return targets.filter((target) => {
			const key = `${target.entityType}:${target.entityId}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	async upsertTraceLineageLinks(
		input: UpsertTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }> {
		const source = input.source?.trim() || "primary";
		const sourceKeys: string[] = [];
		for (const target of input.targets) {
			if (!target.entityType || !target.entityId) continue;
			const sourceKey = `${target.entityType}:${target.entityId}:otel_trace:${input.traceId}:source:${source}`;
			await this.database
				.insert(mlflowLineageLinks)
				.values({
					sourceKey,
					entityType: target.entityType,
					entityId: target.entityId,
					projectId: target.projectId ?? null,
					mlflowEntityType: "otel_trace",
					mlflowExperimentId: target.externalExperimentId ?? null,
					mlflowRunId: target.externalRunId ?? null,
					mlflowTraceId: input.traceId,
					tags: input.attrs ?? {},
					metadata: { source, telemetrySystem: "opentelemetry" },
				})
				.onConflictDoUpdate({
					target: mlflowLineageLinks.sourceKey,
					set: {
						projectId: target.projectId ?? null,
						mlflowExperimentId: target.externalExperimentId ?? null,
						mlflowRunId: target.externalRunId ?? null,
						mlflowTraceId: input.traceId,
						tags: input.attrs ?? {},
						metadata: { source, telemetrySystem: "opentelemetry" },
						updatedAt: new Date(),
					},
				});
			sourceKeys.push(sourceKey);
		}
		return { recorded: sourceKeys.length, sourceKeys };
	}
}
