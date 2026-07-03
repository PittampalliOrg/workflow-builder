import type { WorkflowDefinition } from "$lib/server/application/ports";

export type WorkflowExportLanguage = "typescript" | "python";

export type WorkflowExportSession = {
	userId?: string | null;
	projectId?: string | null;
};

export type WorkflowExportDataPort = {
	getWorkflowByRef(input: {
		workflowId: string;
		lookup: "id";
	}): Promise<WorkflowDefinition | null>;
};

export type WorkflowEmitResult = {
	source: string;
	supportingFiles: Record<string, string>;
	warnings: string[];
	compositionGraph: unknown;
	workflowName: string;
	filename: string;
};

export type WorkflowEmitterPort = {
	emitWorkflow(
		spec: Record<string, unknown>,
		options: {
			language: WorkflowExportLanguage;
			userId?: string | null;
			inlineFunctions: boolean;
		},
	): Promise<WorkflowEmitResult>;
};

export type WorkflowCodeFunctionSaveInput = {
	name: string;
	description: string;
	language: WorkflowExportLanguage;
	entrypoint: "main";
	source: string;
	supportingFiles: Record<string, string>;
	role: "workflow";
	compositionGraph: unknown;
};

export type WorkflowCodeFunctionPort = {
	createWorkflowCodeFunction(
		input: WorkflowCodeFunctionSaveInput,
		userId: string,
	): Promise<{ id: string; slug: string; name: string }>;
};

export type WorkflowExportGetResult =
	| { status: "json"; body: Record<string, unknown> }
	| { status: "source"; source: string; headers: Record<string, string> }
	| { status: "error"; httpStatus: 400 | 401 | 404; body: string };

export type WorkflowExportSaveResult =
	| { status: "ok"; body: Record<string, unknown> }
	| { status: "error"; httpStatus: 400 | 401 | 404; body: string };

export class ApplicationWorkflowExportService {
	constructor(
		private readonly deps: {
			workflowData: WorkflowExportDataPort;
			emitter: WorkflowEmitterPort;
			codeFunctions: WorkflowCodeFunctionPort;
			now: () => Date;
		},
	) {}

	async getExport(input: {
		workflowId: string;
		session: WorkflowExportSession | null | undefined;
		language: string | null;
		inlineFunctions: string | null;
		format: string | null;
		download: string | null;
	}): Promise<WorkflowExportGetResult> {
		const loaded = await this.loadScopedWorkflow(input.workflowId, input.session);
		if (loaded.status === "error") return loaded;

		const language = parseLanguage(input.language);
		const emitted = await this.deps.emitter.emitWorkflow(loaded.spec, {
			language,
			userId: input.session?.userId ?? null,
			inlineFunctions: parseInlineFlag(input.inlineFunctions),
		});

		if (input.format === "json") {
			return {
				status: "json",
				body: workflowExportBody(emitted, language),
			};
		}

		const headers: Record<string, string> = {
			"content-type":
				language === "typescript" ? "text/typescript" : "text/x-python",
		};
		if (input.download === "true") {
			headers["content-disposition"] = `attachment; filename="${emitted.filename}"`;
		}
		return { status: "source", source: emitted.source, headers };
	}

	async saveExport(input: {
		workflowId: string;
		session: WorkflowExportSession | null | undefined;
		language: string | null;
		inlineFunctions: string | null;
		body: unknown;
	}): Promise<WorkflowExportSaveResult> {
		const loaded = await this.loadScopedWorkflow(input.workflowId, input.session);
		if (loaded.status === "error") return loaded;
		if (!input.session?.userId) return unauthorized();

		const language = parseLanguage(input.language);
		const emitted = await this.deps.emitter.emitWorkflow(loaded.spec, {
			language,
			userId: input.session.userId,
			inlineFunctions: parseInlineFlag(input.inlineFunctions),
		});
		const body = asRecord(input.body);
		const saved = await this.deps.codeFunctions.createWorkflowCodeFunction(
			{
				name: (
					stringValue(body.name)?.trim() ||
					`${loaded.workflow.name ?? emitted.workflowName} (workflow)`
				).slice(0, 120),
				description:
					stringValue(body.description)?.trim() ||
					`Emitted from workflow "${loaded.workflow.name ?? emitted.workflowName}" on ${this.deps.now().toISOString()}. Warnings: ${emitted.warnings.length}.`,
				language,
				entrypoint: "main",
				source: emitted.source,
				supportingFiles: emitted.supportingFiles,
				role: "workflow",
				compositionGraph: emitted.compositionGraph,
			},
			input.session.userId,
		);

		return {
			status: "ok",
			body: {
				codeFunctionId: saved.id,
				slug: saved.slug,
				name: saved.name,
				warnings: emitted.warnings,
				compositionGraph: emitted.compositionGraph,
				language,
			},
		};
	}

	private async loadScopedWorkflow(
		workflowId: string,
		session: WorkflowExportSession | null | undefined,
	): Promise<
		| { status: "ok"; workflow: WorkflowDefinition; spec: Record<string, unknown> }
		| { status: "error"; httpStatus: 400 | 401 | 404; body: string }
	> {
		if (!session?.userId) return unauthorized();

		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId,
			lookup: "id",
		});
		if (!isWorkflowInScope(workflow, session)) return workflowNotFound();

		const spec = workflow.spec;
		if (!isRecord(spec)) {
			return {
				status: "error",
				httpStatus: 400,
				body: "Workflow has no SW 1.0 spec. Save the workflow first before exporting.",
			};
		}

		return { status: "ok", workflow, spec };
	}
}

function workflowExportBody(
	result: WorkflowEmitResult,
	language: WorkflowExportLanguage,
): Record<string, unknown> {
	return {
		source: result.source,
		supportingFiles: result.supportingFiles,
		warnings: result.warnings,
		compositionGraph: result.compositionGraph,
		workflowName: result.workflowName,
		filename: result.filename,
		language,
	};
}

function parseLanguage(value: string | null): WorkflowExportLanguage {
	if (value === "py" || value === "python") return "python";
	return "typescript";
}

function parseInlineFlag(value: string | null): boolean {
	if (value === null) return true;
	return value !== "false" && value !== "0" && value !== "no";
}

function unauthorized(): WorkflowExportGetResult & WorkflowExportSaveResult {
	return { status: "error", httpStatus: 401, body: "Authentication required" };
}

function workflowNotFound(): WorkflowExportGetResult & WorkflowExportSaveResult {
	return { status: "error", httpStatus: 404, body: "Workflow not found" };
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isWorkflowInScope(
	workflow: WorkflowDefinition | null | undefined,
	session: WorkflowExportSession,
): workflow is WorkflowDefinition {
	if (!workflow || !session.userId) return false;
	if (workflow.projectId && session.projectId) {
		return workflow.projectId === session.projectId;
	}
	if (!workflow.projectId) {
		return workflow.userId === session.userId;
	}
	return workflow.userId === session.userId;
}
