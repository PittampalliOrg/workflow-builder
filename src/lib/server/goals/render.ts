import continuationTemplate from "./templates/continuation.md?raw";
import budgetLimitTemplate from "./templates/budget_limit.md?raw";

/**
 * Renders the Codex `/goal` prompt templates (ported verbatim under
 * ./templates) for the autonomous continuation loop. The templates use
 * Handlebars-style `{{ var }}` placeholders; we render with a tiny replacer
 * (no extra dependency). The objective stays wrapped in
 * `<untrusted_objective>` so the agent treats it as data, not instructions.
 */
export interface GoalBudgetView {
	objective: string;
	tokensUsed: number;
	tokenBudget: number | null;
	timeUsedSeconds: number;
}

function render(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) =>
		Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{ ${key} }}`,
	);
}

function budgetVars(goal: GoalBudgetView): Record<string, string> {
	const noBudget = goal.tokenBudget === null || goal.tokenBudget === undefined;
	return {
		objective: goal.objective,
		time_used_seconds: String(goal.timeUsedSeconds),
		tokens_used: String(goal.tokensUsed),
		token_budget: noBudget ? "(no budget)" : String(goal.tokenBudget),
		remaining_tokens: noBudget
			? "(no budget)"
			: String(Math.max(0, (goal.tokenBudget as number) - goal.tokensUsed)),
	};
}

export function renderContinuationPrompt(goal: GoalBudgetView): string {
	return render(continuationTemplate, budgetVars(goal));
}

export function renderBudgetLimitPrompt(goal: GoalBudgetView): string {
	return render(budgetLimitTemplate, budgetVars(goal));
}
