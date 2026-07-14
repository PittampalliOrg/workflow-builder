import { env } from "$env/dynamic/private";
import type {
	CreateWorkflowDefinitionInput,
	UpdateWorkflowDefinitionInput,
	WorkflowConnectionRefSyncPort,
	WorkflowDefinition,
	WorkflowEngineType,
} from "$lib/server/application/ports";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import { validateWithEvaluator } from "$lib/server/workflows/dynamic-script-validation";
import { nanoid } from "nanoid";

type WorkflowDefinitionCommandDataPort = {
	createWorkflowDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition>;
	updateWorkflowDefinition(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null>;
	getWorkflowByRef(input: {
		workflowId: string;
		lookup: "id";
	}): Promise<WorkflowDefinition | null>;
	hasActiveWorkflowExecutions(id: string): Promise<boolean>;
	deleteWorkflowDefinition(id: string): Promise<void>;
};

export type WorkflowDefinitionCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: unknown;
	  }
	| {
			status: "error";
			httpStatus: number;
			body: string | Record<string, unknown>;
	  };

export class ApplicationWorkflowDefinitionCommandService {
	constructor(
		private readonly deps: {
			workflowData: WorkflowDefinitionCommandDataPort;
			connectionRefs: WorkflowConnectionRefSyncPort;
		},
	) {}

	/** P4 freeze (cutover item 18): new SW 1.0 workflows are rejected once
	 * SW_AUTHORING_FROZEN is on. `internalOverride` (the internal-token routes)
	 * bypasses it so system producers can still seed SW rows during the
	 * migration window. Legacy rows stay readable/runnable — freeze blocks
	 * CREATION, not execution. */
	private swAuthoringFrozen(): boolean {
		const raw = (env.SW_AUTHORING_FROZEN ?? "").trim().toLowerCase();
		return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
	}

	/** Live-editor validation (code⇄canvas split view): the same evaluator-truth
	 * check the save path runs, WITHOUT saving. */
	async validateScript(script: string): Promise<
		| { ok: true; meta: Record<string, unknown> | null; estimatedAgentCalls: number | null }
		| { ok: false; error: string }
	> {
		const result = await validateWithEvaluator(script);
		if (!result.ok) return { ok: false, error: result.error };
		return {
			ok: true,
			meta: (result.meta as Record<string, unknown> | undefined) ?? null,
			estimatedAgentCalls:
				typeof result.estimatedAgentCalls === "number" ? result.estimatedAgentCalls : null,
		};
	}

	async createWorkflow(input: {
		body: unknown;
		userId: string;
		projectId: string;
		/** Internal callers (system producers) bypass the SW authoring freeze. */
		internalOverride?: boolean;
	}): Promise<WorkflowDefinitionCommandResult> {
		const body = asRecord(input.body);
		// P4 freeze: default new workflows to the script engine and reject
		// explicit SW ('dapr'/'vercel') creation.
		const requestedEngine = stringValue(body.engineType);
		const engineType = (requestedEngine ||
			(this.swAuthoringFrozen() ? "dynamic-script" : "dapr")) as WorkflowEngineType;
		if (
			this.swAuthoringFrozen() &&
			!input.internalOverride &&
			engineType !== "dynamic-script"
		) {
			return {
				status: "error",
				httpStatus: 400,
				body:
					"SW 1.0 authoring is frozen — new workflows are dynamic-script " +
					"(docs/code-first-cutover.md). Existing SW workflows still run.",
			};
		}
		let spec = body.spec;
		if (engineType === "dynamic-script" && spec !== undefined) {
			const validated = await this.validateAndStampDynamicScript(spec);
			if (!validated.ok) {
				return { status: "error", httpStatus: validated.httpStatus, body: validated.error };
			}
			spec = validated.spec;
		}
		const createInput: CreateWorkflowDefinitionInput = {
			name: stringValue(body.name) || "Untitled Workflow",
			nodes: (body.nodes as unknown[] | undefined) || [],
			edges: (body.edges as unknown[] | undefined) || [],
			engineType,
			userId: input.userId,
			projectId: input.projectId,
			spec,
		};

		const workflow = await this.deps.workflowData.createWorkflowDefinition(createInput);
		await this.deps.connectionRefs.syncWorkflowConnectionRefs({
			workflowId: workflow.id,
			nodes: createInput.nodes,
			spec,
		});

		return { status: "ok", httpStatus: 201, body: workflow };
	}

	async updateWorkflow(input: {
		workflowId: string;
		body: unknown;
		/** Internal callers (system producers) bypass the SW authoring freeze. */
		internalOverride?: boolean;
	}): Promise<WorkflowDefinitionCommandResult> {
		const body = asRecord(input.body);
		const updateData: UpdateWorkflowDefinitionInput = {
			name: stringValue(body.name),
			nodes: body.nodes as unknown[] | undefined,
			edges: body.edges as unknown[] | undefined,
		};
		if (body.spec !== undefined) {
			updateData.spec = body.spec;
			// Re-validate + re-stamp the spec when the workflow is (or is becoming) a
			// dynamic-script — the meta persisted into spec.meta is evaluator-truth.
			const existing = await this.deps.workflowData.getWorkflowByRef({
				workflowId: input.workflowId,
				lookup: "id",
			});
			const isDynamicScript =
				stringValue(body.engineType) === "dynamic-script" ||
				existing?.engineType === "dynamic-script" ||
				asRecord(body.spec).engine === "dynamic-script";
			// P4 freeze: reject SW spec WRITES (a legacy row stays runnable and
			// metadata-editable; only its `document` spec is frozen).
			if (
				this.swAuthoringFrozen() &&
				!input.internalOverride &&
				!isDynamicScript &&
				asRecord(body.spec).document !== undefined
			) {
				return {
					status: "error",
					httpStatus: 400,
					body:
						"SW 1.0 spec editing is frozen — convert this workflow to a " +
						"dynamic-script (docs/code-first-cutover.md).",
				};
			}
			if (isDynamicScript) {
				const validated = await this.validateAndStampDynamicScript(body.spec);
				if (!validated.ok) {
					return { status: "error", httpStatus: validated.httpStatus, body: validated.error };
				}
				updateData.spec = validated.spec;
			}
		}

		const updated = await this.deps.workflowData.updateWorkflowDefinition(
			input.workflowId,
			updateData,
		);
		if (!updated) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		await this.deps.connectionRefs.syncWorkflowConnectionRefs({
			workflowId: input.workflowId,
			nodes: body.nodes,
			spec: updateData.spec,
		});

		return { status: "ok", body: updated };
	}

	/**
	 * Validate a dynamic-script spec (static + authoritative evaluator) and stamp
	 * the evaluator-truth meta + estimatedAgentCalls back into spec.meta. Returns
	 * the spec to persist, or a 400 on validation failure.
	 */
	private async validateAndStampDynamicScript(
		spec: unknown,
	): Promise<
		| { ok: true; spec: Record<string, unknown> }
		| { ok: false; httpStatus: number; error: string }
	> {
		const record = asRecord(spec);
		const script = stringValue(record.script);
		if (!script) {
			return { ok: false, httpStatus: 400, error: "spec.script must be a non-empty string" };
		}
		const result = await validateWithEvaluator(script);
		if (!result.ok) {
			return { ok: false, httpStatus: result.status, error: result.error };
		}
		return {
			ok: true,
			spec: {
				...record,
				engine: "dynamic-script",
				script,
				meta: { ...asRecord(record.meta), ...result.meta },
			},
		};
	}

	async deleteWorkflow(input: {
		workflowId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkflowDefinitionCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isResourceInScope(workflow, input)) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		if (await this.deps.workflowData.hasActiveWorkflowExecutions(input.workflowId)) {
			return {
				status: "error",
				httpStatus: 409,
				body: "Stop the running execution before deleting this workflow",
			};
		}

		try {
			await this.deps.workflowData.deleteWorkflowDefinition(input.workflowId);
		} catch (err) {
			if ((err as { code?: string })?.code === "23503") {
				return {
					status: "error",
					httpStatus: 409,
					body:
						"This workflow has execution history and cannot be deleted; archive it instead.",
				};
			}
			throw err;
		}

		return { status: "ok", body: { success: true } };
	}

	async publishWorkflow(input: {
		workflowId: string;
	}): Promise<WorkflowDefinitionCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!workflow) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		const versionId = `pub_${Date.now()}_${nanoid(6).toLowerCase()}`;
		const daprWorkflowName = workflow.daprWorkflowName || `wf_${workflow.id}`;
		const spec = asRecord(workflow.spec);
		const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
		if (removedAgentCallsError) {
			return { status: "error", httpStatus: 400, body: removedAgentCallsError };
		}

		const revision = {
			version: versionId,
			publishedAt: new Date().toISOString(),
			nodes: structuredClone(workflow.nodes),
			edges: structuredClone(workflow.edges),
			name: workflow.name,
			description: workflow.description,
		};

		const metadata = asRecord(spec.metadata);
		const publishedRuntime = asRecord(metadata.publishedRuntime);
		const existingRevisions = Array.isArray(publishedRuntime.revisions)
			? publishedRuntime.revisions
			: [];
		const updated = await this.deps.workflowData.updateWorkflowDefinition(
			input.workflowId,
			{
				spec: {
					...spec,
					metadata: {
						...metadata,
						publishedRuntime: {
							...publishedRuntime,
							latestVersion: versionId,
							revisions: [...existingRevisions, revision],
						},
					},
				},
				daprWorkflowName,
			},
		);

		return { status: "ok", body: updated };
	}

	async getPublishedWorkflowVersion(input: {
		workflowId: string;
		version: string;
	}): Promise<WorkflowDefinitionCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!workflow) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		const revisions = publishedRevisionsFromSpec(workflow.spec);
		if (revisions.length === 0) {
			return {
				status: "error",
				httpStatus: 404,
				body: "No published versions found",
			};
		}

		const revision =
			input.version === "latest"
				? revisions[revisions.length - 1]
				: revisions.find((candidate) => candidate.version === input.version);
		if (!revision) {
			return {
				status: "error",
				httpStatus: 404,
				body: `Version "${input.version}" not found`,
			};
		}

		return {
			status: "ok",
			body: {
				workflowId: workflow.id,
				version: revision.version,
				publishedAt: revision.publishedAt,
				definition: {
					name: revision.name,
					description: revision.description,
					nodes: revision.nodes,
					edges: revision.edges,
				},
				revisions: revisions.map((item) => ({
					version: item.version,
					publishedAt: item.publishedAt,
				})),
			},
		};
	}
}

type PublishedWorkflowRevision = {
	version: string;
	publishedAt: string;
	nodes: unknown[];
	edges: unknown[];
	name: string;
	description?: string;
};

function publishedRevisionsFromSpec(spec: unknown): PublishedWorkflowRevision[] {
	const metadata = asRecord(asRecord(spec).metadata);
	const publishedRuntime = asRecord(metadata.publishedRuntime);
	return Array.isArray(publishedRuntime.revisions)
		? (publishedRuntime.revisions as PublishedWorkflowRevision[])
		: [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isResourceInScope(
	resource: Pick<WorkflowDefinition, "userId" | "projectId"> | null | undefined,
	session: { userId: string; projectId?: string | null },
): resource is Pick<WorkflowDefinition, "userId" | "projectId"> {
	if (!resource) return false;
	if (resource.projectId && session.projectId) {
		return resource.projectId === session.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === session.userId;
	}
	return resource.userId === session.userId;
}
