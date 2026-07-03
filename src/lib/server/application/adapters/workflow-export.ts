import {
	createCodeFunction,
	type SaveCodeFunctionInput,
} from "$lib/server/code-functions";
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
		});
	}
}

export class LegacyWorkflowCodeFunctionAdapter
	implements WorkflowCodeFunctionPort
{
	async createWorkflowCodeFunction(
		input: WorkflowCodeFunctionSaveInput,
		userId: string,
	) {
		const saved = await createCodeFunction(input as SaveCodeFunctionInput, userId);
		return {
			id: saved.id,
			slug: saved.slug,
			name: saved.name,
		};
	}
}
