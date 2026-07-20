import type { ModelCompletionPort } from '$lib/server/application/ports';
import { getPromptExpansionConfig } from '$lib/utils/workflow-input-config';

type PromptExpansionResult = Record<string, string> & {
	repo?: string;
};

type ModelCompletionClient = Pick<ModelCompletionPort, 'isAvailable' | 'complete'>;

function isPresentString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function extractJson(text: string): Record<string, unknown> {
	const candidates = [
		text.trim(),
		text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim(),
		text.match(/\{[\s\S]*\}/)?.[0]?.trim()
	].filter((candidate): candidate is string => isPresentString(candidate));

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next extraction candidate.
		}
	}

	throw new Error('Could not extract valid JSON from LLM response');
}

async function callKimi(
	prompt: string,
	modelCompletion: ModelCompletionClient
): Promise<string> {
	return modelCompletion.complete({
		maxOutputTokens: 800,
		responseFormat: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content:
					'You turn a single product idea into concise structured fields for a greenfield SvelteKit demo app. Respond with JSON only.'
			},
			{ role: 'user', content: prompt }
		]
	});
}

function buildDerivationPrompt(userPrompt: string, existingRepo?: string): string {
	return [
		'Expand this single user prompt into fields for a greenfield SvelteKit workflow.',
		'Return valid JSON with exactly these keys: app_name, headline, description, ui_brief, implementation_brief, capture_steps_json, annotation_plan_json, repo.',
		'Rules:',
		'- app_name: short product/app display name',
		'- headline: bold landing-page headline, 4 to 10 words',
		'- description: one-sentence repository/app description',
		'- ui_brief: a detailed UI/design brief suitable for code generation, 1 to 3 sentences',
		'- implementation_brief: a concrete implementation brief that names the core surfaces, interactions, and realtime behaviors the app must actually implement',
		'- capture_steps_json: an array of 4 to 6 browser demo steps grounded in the requested app, not generic dashboard steps. Each step should include id, label, action, path, goal, and whichever of selector, waitForSelector, waitForText, value, pauseMs, or fullPage are needed',
		'- annotation_plan_json: an object with title, summary, style, and captions aligned to those capture steps',
		'- If the prompt asks for a map, the implementation_brief must require a real interactive map in-browser and the capture steps must interact with it',
		'- Prefer Leaflet + OpenStreetMap or another no-key map option when a map is needed',
		'- Avoid stock labels like Launch, Stealth, Broadcast, Signal Uptime, or Live Scenes unless the user explicitly asked for them',
		'- repo: lowercase kebab-case slug suitable as a repository name',
		existingRepo ? `- Preserve this existing repo slug exactly: ${existingRepo}` : '',
		`User prompt: ${userPrompt}`
	]
		.filter(Boolean)
		.join('\n');
}

function normalizeExpansion(
	raw: Record<string, unknown>,
	derivedFields: string[],
	existingRepo?: string
): PromptExpansionResult {
	const repo = existingRepo || (isPresentString(raw.repo) ? raw.repo.trim() : '');
	const normalized: Record<string, string> = {};

	for (const field of derivedFields) {
		const value = raw[field];
		if (isPresentString(value)) {
			normalized[field] = value.trim();
			continue;
		}
		if (value !== null && value !== undefined) {
			try {
				normalized[field] = JSON.stringify(value);
				continue;
			} catch {
				// fall through to validation below
			}
		}
		normalized[field] = '';
	}

	if (!repo || derivedFields.some((field) => !isPresentString(normalized[field]))) {
		throw new Error('Greenfield prompt expansion returned incomplete fields');
	}

	return {
		...normalized,
		repo
	};
}

async function deriveFromPrompt(
	userPrompt: string,
	derivedFields: string[],
	existingRepo?: string,
	modelCompletion?: ModelCompletionClient
): Promise<PromptExpansionResult> {
	if (!modelCompletion?.isAvailable()) {
		throw new Error('KIMI_API_KEY is not configured for greenfield prompt expansion');
	}

	const prompt = buildDerivationPrompt(userPrompt, existingRepo);
	const responseText = await callKimi(prompt, modelCompletion);

	return normalizeExpansion(extractJson(responseText), derivedFields, existingRepo);
}

export async function expandGreenfieldPromptInput(
	spec: Record<string, unknown> | null,
	triggerData: Record<string, unknown>,
	modelCompletion?: ModelCompletionClient
): Promise<Record<string, unknown>> {
	const config = getPromptExpansionConfig(spec);
	if (!config || !config.requiresExpansion) return triggerData;

	const prompt = isPresentString(triggerData[config.promptField])
		? String(triggerData[config.promptField]).trim()
		: '';
	if (!prompt) return triggerData;

	const hasAllDerivedFields = config.derivedFields.every((field) =>
		isPresentString(triggerData[field])
	);
	if (hasAllDerivedFields && isPresentString(triggerData.repo)) {
		return triggerData;
	}

	const derived = await deriveFromPrompt(
		prompt,
		config.derivedFields,
		isPresentString(triggerData.repo) ? triggerData.repo : undefined,
		modelCompletion
	);
	return {
		...triggerData,
		...derived
	};
}
