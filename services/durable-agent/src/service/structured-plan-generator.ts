import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import {
	CanonicalPlanSchema,
	type CanonicalPlan,
	type PlanValidationIssue,
	normalizeAndValidateCanonicalPlan,
} from "./plan-schema.js";
import {
	normalizeModelSpecForEnvironment,
	normalizeOpenAiChatModel,
} from "./model-normalization.js";

const AVAILABLE_TOOLS = `Available workspace tools:
- read_file: Read a file from the workspace
- write_file: Create or overwrite a file
- edit_file: Find and replace text in a file
- list_files: List directory contents
- execute_command: Run a shell command
- delete_file: Delete a file or directory
- mkdir: Create a directory
- file_stat: Get file metadata`;

const SYSTEM_PROMPT = `You are a planning agent. Given a task, create a structured execution plan.

${AVAILABLE_TOOLS}

Rules:
- Return artifactType=task_graph_v1
- Use concrete task titles and explicit instructions
- Keep tool names accurate and path-specific
- Use repository-relative paths only
- Include both task graph (tasks) and ordered compatibility steps (steps)
- Ensure every task has a stable id and valid blockedBy dependencies
- Keep the plan concise and execution-ready`;

const MAX_ATTEMPTS = Math.max(
	1,
	Number.parseInt(process.env.PLAN_STRUCTURED_MAX_ATTEMPTS || "3", 10) || 3,
);
const RETRY_BASE_MS = Math.max(
	50,
	Number.parseInt(process.env.PLAN_STRUCTURED_RETRY_BASE_MS || "250", 10) ||
		250,
);

type StructuredProvider = "ai-sdk" | "mastra" | "auto";
type EffectiveProvider = "ai-sdk" | "mastra";

export type PlanGenerationMeta = {
	attempts: number;
	strategy: EffectiveProvider;
	usedStructuringPass: boolean;
	validationErrors: string[];
};

export class PlanGenerationError extends Error {
	readonly code = "PLAN_SCHEMA_VALIDATION_FAILED";
	readonly attempts: number;
	readonly strategy: EffectiveProvider;
	readonly details: PlanValidationIssue[];

	constructor(input: {
		message: string;
		attempts: number;
		strategy: EffectiveProvider;
		details: PlanValidationIssue[];
	}) {
		super(input.message);
		this.name = "PlanGenerationError";
		this.attempts = input.attempts;
		this.strategy = input.strategy;
		this.details = input.details;
	}
}

function resolveProviderPreference(): StructuredProvider {
	const raw = (process.env.PLAN_STRUCTURED_PROVIDER || "auto")
		.trim()
		.toLowerCase();
	if (raw === "ai-sdk" || raw === "mastra" || raw === "auto") {
		return raw;
	}
	return "auto";
}

function buildPlanningPrompt(prompt: string, errors: string[]): string {
	const correctionBlock =
		errors.length > 0
			? `\n\nPrevious schema validation errors to correct:\n${errors
					.map((issue, index) => `${index + 1}. ${issue}`)
					.join("\n")}\n\nFix every issue above while preserving task intent.`
			: "";
	return `Create an execution plan for this task:\n\n${prompt}${correctionBlock}`;
}

function toErrorMessages(issues: PlanValidationIssue[]): string[] {
	return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function generateWithAiSdk(
	prompt: string,
	validationErrors: string[],
): Promise<unknown> {
	const model = openai.chat(
		normalizeOpenAiChatModel(process.env.AI_MODEL || "", "AI_MODEL", {
			logPrefix: "[planner]",
		}),
	);
	const result = await generateObject({
		model,
		schema: CanonicalPlanSchema,
		system: SYSTEM_PROMPT,
		prompt: buildPlanningPrompt(prompt, validationErrors),
	});
	return result.object;
}

async function generateWithMastra(
	prompt: string,
	validationErrors: string[],
): Promise<unknown> {
	// Optional peer dependency. Fallback is handled by caller.
	const { Agent } = await import("@mastra/core/agent");
	const modelSpec = normalizeModelSpecForEnvironment(
		process.env.PLAN_STRUCTURED_MODEL_SPEC ||
			process.env.MASTRA_MODEL_SPEC ||
			"",
		{
			logPrefix: "[planner]",
		},
	);

	const planner = new Agent({
		id: "durable-structured-planner",
		name: "durable-structured-planner",
		model: modelSpec,
		instructions: SYSTEM_PROMPT,
	});

	const result = await planner.generate(
		buildPlanningPrompt(prompt, validationErrors),
		{
			structuredOutput: {
				schema: CanonicalPlanSchema,
				...(process.env.PLAN_STRUCTURED_JSON_PROMPT_INJECTION === "true"
					? { jsonPromptInjection: true }
					: {}),
			},
		},
	);

	const output = (result as { object?: unknown }).object;
	if (!output) {
		throw new Error("Mastra structured output did not return an object");
	}
	return output;
}

async function generateCandidateForAttempt(
	provider: StructuredProvider,
	prompt: string,
	validationErrors: string[],
): Promise<{ providerUsed: EffectiveProvider; candidate: unknown }> {
	if (provider === "ai-sdk") {
		return {
			providerUsed: "ai-sdk",
			candidate: await generateWithAiSdk(prompt, validationErrors),
		};
	}
	if (provider === "mastra") {
		return {
			providerUsed: "mastra",
			candidate: await generateWithMastra(prompt, validationErrors),
		};
	}

	try {
		return {
			providerUsed: "mastra",
			candidate: await generateWithMastra(prompt, validationErrors),
		};
	} catch (error) {
		console.warn(
			`[planner] Mastra structured output unavailable, falling back to AI SDK: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return {
			providerUsed: "ai-sdk",
			candidate: await generateWithAiSdk(prompt, validationErrors),
		};
	}
}

export async function generateCanonicalPlan(input: {
	prompt: string;
}): Promise<{ plan: CanonicalPlan; meta: PlanGenerationMeta }> {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new PlanGenerationError({
			message: "prompt is required",
			attempts: 0,
			strategy: "ai-sdk",
			details: [
				{ path: "$", message: "prompt is required", code: "invalid_prompt" },
			],
		});
	}

	const providerPreference = resolveProviderPreference();
	const collectedErrors: string[] = [];
	let lastIssues: PlanValidationIssue[] = [];
	let strategyUsed: EffectiveProvider = "ai-sdk";

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		try {
			const generated = await generateCandidateForAttempt(
				providerPreference,
				prompt,
				collectedErrors,
			);
			strategyUsed = generated.providerUsed;
			const normalized = normalizeAndValidateCanonicalPlan(generated.candidate);
			if (normalized.success) {
				return {
					plan: normalized.plan,
					meta: {
						attempts: attempt,
						strategy: strategyUsed,
						usedStructuringPass: strategyUsed === "mastra",
						validationErrors: collectedErrors,
					},
				};
			}

			lastIssues = normalized.issues;
			collectedErrors.push(...toErrorMessages(normalized.issues));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastIssues = [{ path: "$", message, code: "generation_error" }];
			collectedErrors.push(message);
		}

		if (attempt < MAX_ATTEMPTS) {
			await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
		}
	}

	throw new PlanGenerationError({
		message: `Failed to produce canonical structured output after ${MAX_ATTEMPTS} attempts`,
		attempts: MAX_ATTEMPTS,
		strategy: strategyUsed,
		details: lastIssues,
	});
}
