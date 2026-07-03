import { PostgresCodeFunctionStore } from "$lib/server/application/adapters/code-functions";
import type { SaveCodeFunctionInput } from "$lib/server/code-functions/model";
import {
	emitWorkflow,
	type EmitterLanguage,
} from "$lib/server/workflows/code-emitter";
import type {
	WorkflowCodeFunctionPort,
	WorkflowCodeFunctionSaveInput,
	WorkflowEmitterPort,
	WorkflowExportLanguage,
} from "$lib/server/application/workflow-export";

export class LegacyWorkflowEmitterAdapter implements WorkflowEmitterPort {
	constructor(private readonly store = new PostgresCodeFunctionStore()) {}

	emitWorkflow(
		spec: Record<string, unknown>,
		options: {
			language: WorkflowExportLanguage;
			userId?: string | null;
			inlineFunctions: boolean;
		},
	) {
		return emitWorkflow(spec, {
			...options,
			language: options.language as EmitterLanguage,
			codeFunctions: this.store,
		});
	}
}

export class PostgresWorkflowCodeFunctionAdapter
	implements WorkflowCodeFunctionPort
{
	constructor(private readonly store = new PostgresCodeFunctionStore()) {}

	async createWorkflowCodeFunction(
		input: WorkflowCodeFunctionSaveInput,
		userId: string,
	) {
		const saved = await this.store.createCodeFunction(
			input as SaveCodeFunctionInput,
			userId,
		);
		return {
			id: saved.id,
			slug: saved.slug,
			name: saved.name,
		};
	}
}
