import { env } from '$env/dynamic/private';
import {
	callOpenAICompatibleChatCompletion,
	openAICompatibleTrafficAvailable
} from '$lib/server/ai/openai-gateway';
import { getPromptExpansionConfig } from '$lib/utils/workflow-input-config';

type PromptExpansionResult = Record<string, string> & {
	repo?: string;
};

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

async function callAnthropic(prompt: string, model: string, apiKey: string): Promise<string> {
	const response = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01'
		},
		body: JSON.stringify({
			model,
			max_tokens: 800,
			system:
				'You turn a single product idea into concise structured fields for a greenfield SvelteKit demo app. Respond with JSON only.',
			messages: [{ role: 'user', content: prompt }]
		})
	});

	if (!response.ok) {
		throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
	}

	const data = await response.json();
	const content = data.content?.[0]?.text;
	if (!content) throw new Error('No content in Anthropic response');
	return content;
}

async function callOpenAI(prompt: string, model: string): Promise<string> {
	return callOpenAICompatibleChatCompletion({
		model,
		maxTokens: 800,
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

function normalizeAnthropicModel(model: string | undefined | null): string | null {
	if (!isPresentString(model)) return null;
	const trimmed = model.trim();
	if (trimmed.startsWith('anthropic/')) {
		return trimmed.slice('anthropic/'.length);
	}
	if (trimmed.startsWith('claude-')) {
		return trimmed;
	}
	return null;
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
	selectedModel?: string
): Promise<PromptExpansionResult> {
	const anthropicKey = env.ANTHROPIC_API_KEY;
	const openaiAvailable = openAICompatibleTrafficAvailable();
	if (!anthropicKey && !openaiAvailable) {
		throw new Error('No AI API key configured for greenfield prompt expansion');
	}

	const prompt = buildDerivationPrompt(userPrompt, existingRepo);
	const requestedAnthropicModel = normalizeAnthropicModel(selectedModel);
	const responseText = openaiAvailable
		? await callOpenAI(prompt, env.OPENAI_MODEL || 'gpt-5.5')
		: await callAnthropic(
				prompt,
				requestedAnthropicModel || env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
				anthropicKey!
			);

	return normalizeExpansion(extractJson(responseText), derivedFields, existingRepo);
}

export async function expandGreenfieldPromptInput(
	spec: Record<string, unknown> | null,
	triggerData: Record<string, unknown>
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
		isPresentString(triggerData.model) ? triggerData.model : undefined
	);
	return {
		...triggerData,
		...derived
	};
}
