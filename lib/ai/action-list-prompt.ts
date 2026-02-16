import { flattenConfigFields } from "@/lib/actions/utils";
import type { WorkflowSpecCatalog } from "@/lib/workflow-spec/catalog";

function uniq<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function tokenizePrompt(prompt: string): string[] {
	const raw = prompt
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3);

	// Keep the prompt tokens bounded to avoid adversarially long prompts.
	return uniq(raw).slice(0, 60);
}

function scoreAction(input: {
	needleTokens: string[];
	haystack: string;
}): number {
	let score = 0;
	for (const t of input.needleTokens) {
		if (!t) continue;
		// Strong signal if action id contains token; weaker if just description/label.
		if (input.haystack.includes(t)) {
			score += t.length >= 6 ? 3 : 2;
		}
	}
	return score;
}

function buildExampleConfig(action: {
	id: string;
	configFields: unknown;
}): Record<string, string | number> {
	const example: Record<string, string | number> = { actionType: action.id };
	const fields = flattenConfigFields(action.configFields as any);

	for (const field of fields) {
		if ((field as any).showWhen) continue;

		if ((field as any).example !== undefined) {
			example[(field as any).key] = (field as any).example;
		} else if ((field as any).defaultValue !== undefined) {
			example[(field as any).key] = (field as any).defaultValue;
		} else if ((field as any).type === "number") {
			example[(field as any).key] = 10;
		} else if (
			(field as any).type === "select" &&
			(field as any).options?.[0]
		) {
			example[(field as any).key] = (field as any).options[0].value;
		} else if ((field as any).type === "schema-builder") {
			example[(field as any).key] = "[]";
		} else if ((field as any).type === "template-textarea") {
			example[(field as any).key] =
				`Your ${String((field as any).label || "value")}`;
		} else {
			example[(field as any).key] =
				`Your ${String((field as any).label || "value")}`;
		}
	}

	return example;
}

const ALWAYS_INCLUDE_ACTIONS = new Set([
	"system/http-request",
	"system/database-query",
	"system/condition",
]);

/**
 * Build a bounded action list prompt so structured-output generation doesn't
 * balloon with the full catalog.
 */
export function buildRelevantActionListPrompt(input: {
	catalog: WorkflowSpecCatalog;
	prompt: string;
	limit?: number;
}): string {
	const limit = input.limit ?? 60;
	const tokens = tokenizePrompt(input.prompt);

	const actions = Array.from(input.catalog.actionsById.values());
	const scored = actions
		.map((a) => {
			const haystack = `${a.id} ${a.label} ${a.description}`.toLowerCase();
			const score =
				(ALWAYS_INCLUDE_ACTIONS.has(a.id) ? 1000 : 0) +
				scoreAction({ needleTokens: tokens, haystack });
			return { action: a, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id))
		.slice(0, limit);

	// Ensure essentials are always present, even if they scored 0.
	for (const id of ALWAYS_INCLUDE_ACTIONS) {
		if (scored.some((s) => s.action.id === id)) continue;
		const a = input.catalog.actionsById.get(id);
		if (a) {
			scored.unshift({ action: a, score: 1000 });
		}
	}

	// Deduplicate while preserving order.
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const { action } of scored) {
		if (seen.has(action.id)) continue;
		seen.add(action.id);
		lines.push(
			`- ${action.label} (${action.id}): ${JSON.stringify(buildExampleConfig(action))}`,
		);
	}

	return lines.join("\n");
}
