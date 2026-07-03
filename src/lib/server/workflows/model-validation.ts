import { getApplicationAdapters } from '$lib/server/application';

export type TriggerModelCatalogReader = {
	listEnabledModelIds(): Promise<string[]>;
};

export type ValidateTriggerModelOptions = {
	modelCatalog?: TriggerModelCatalogReader;
};

/**
 * Validate that trigger input's `model` field matches a known value.
 *
 * Strategy:
 *   1. If the spec's x-workflow-builder.input.fields.model declares `options`,
 *      the allowed set is those option values (authoritative — same list the UI shows).
 *   2. Otherwise, fall back to `model_catalog.id` (enabled rows only).
 *
 * Returns an error message when the provided model is rejected. Returns
 * `null` when validation passes (including the case where the workflow does
 * not take a model input).
 *
 * Context: a 2026-04-17 prod run failed with
 *   Unknown modelSpec 'anthropic/claude-sonnet-4-7'
 * because a typo reached the orchestrator unvalidated. This helper stops
 * such typos at the SvelteKit trigger API with a readable 400 instead of
 * a downstream "Sub-orchestration task #4 failed" error.
 */
export async function validateTriggerModel(
	spec: Record<string, unknown>,
	triggerData: Record<string, unknown>,
	options: ValidateTriggerModelOptions = {}
): Promise<string | null> {
	const declared = collectDeclaredModelOptions(spec);
	const submitted = triggerData.model;
	if (typeof submitted !== 'string' || !submitted) {
		// No `model` in trigger payload → nothing to validate.
		return null;
	}

	if (declared !== null) {
		if (declared.includes(submitted)) return null;
		return `Invalid model '${submitted}' for this workflow. Allowed: ${declared.join(', ')}`;
	}

	// No inline options — fall back to model_catalog.
	let allowed: string[];
	try {
		const catalog = options.modelCatalog ?? getApplicationAdapters().workflowData;
		allowed = await catalog.listEnabledModelIds();
	} catch (err) {
		if (err instanceof Error && err.message === 'Database not configured') {
			return null;
		}
		throw err;
	}
	if (allowed.includes(submitted)) return null;
	return `Invalid model '${submitted}'. Allowed: ${allowed.sort().join(', ')}`;
}

function collectDeclaredModelOptions(spec: Record<string, unknown>): string[] | null {
	const doc = spec.document as Record<string, unknown> | undefined;
	if (!doc) return null;
	const xwb = doc['x-workflow-builder'] as Record<string, unknown> | undefined;
	const input = xwb?.input as Record<string, unknown> | undefined;
	const fields = input?.fields as Record<string, unknown> | undefined;
	const modelField = fields?.model as Record<string, unknown> | undefined;
	const options = modelField?.options;
	if (!Array.isArray(options)) return null;
	const values: string[] = [];
	for (const opt of options) {
		if (opt && typeof opt === 'object' && typeof (opt as Record<string, unknown>).value === 'string') {
			values.push((opt as Record<string, unknown>).value as string);
		}
	}
	return values.length > 0 ? values : null;
}
