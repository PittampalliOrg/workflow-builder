import {
	type CanonicalPlan as Plan,
	type PlanValidationIssue,
	validateCanonicalPlan,
} from "./plan-schema.js";
import {
	PlanGenerationError,
	type PlanGenerationMeta,
	generateCanonicalPlan,
} from "./structured-plan-generator.js";

export type { Plan, PlanGenerationMeta, PlanValidationIssue };
export { PlanGenerationError };

export function validatePlanForExecution(input: unknown):
	| { success: true; plan: Plan }
	| {
			success: false;
			issues: PlanValidationIssue[];
	  } {
	return validateCanonicalPlan(input);
}

export async function generatePlan(input: {
	prompt: string;
}): Promise<{ plan: Plan; meta: PlanGenerationMeta }> {
	return await generateCanonicalPlan({ prompt: input.prompt });
}

export async function generatePlanFromMarkdown(input: {
	userPrompt: string;
	planMarkdown: string;
}): Promise<{ plan: Plan; meta: PlanGenerationMeta }> {
	const userPrompt = input.userPrompt.trim();
	const planMarkdown = input.planMarkdown.trim();
	const prompt = `Convert this markdown implementation plan into canonical task_graph_v1 JSON.

Original user request:
${userPrompt}

Markdown plan:
${planMarkdown}

Return a concrete, executable task graph with explicit tool-oriented tasks.`;

	return await generateCanonicalPlan({ prompt });
}
