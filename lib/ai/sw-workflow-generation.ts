import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { resolveCatalogModelKey } from "@/lib/ai/openai-model-selection";
import { getSecretValueAsync } from "@/lib/dapr/config-provider";
import { FUNCTION_CATALOG } from "@/lib/serverless-workflow/function-catalog";
import {
	parseWorkflowDefinition,
	validateWorkflowDefinition,
	type SWWorkflow,
} from "@/lib/serverless-workflow/sdk";

const WorkflowTextEnvelopeSchema = z.object({
	workflowText: z.string().min(1),
});

const MULTI_AGENT_REFERENCE = `Example multi-agent pattern:
- initialize input and working context with a set task
- call specialized agents in sequence
- evaluate or review outputs with a call task
- use switch to branch on approval/refinement
- use for or do for repeated refinement or step execution
- emit events or shape output at the end`;

function buildFunctionCatalogPrompt(): string {
	return FUNCTION_CATALOG.map(
		(fn) => `- ${fn.name}: ${fn.description} [${fn.category}]`,
	).join("\n");
}

async function getAi(): Promise<{
	model: Parameters<typeof generateObject>[0]["model"];
	provider: "anthropic" | "openai";
}> {
	const anthropicKey = await getSecretValueAsync("ANTHROPIC_API_KEY");
	if (anthropicKey) {
		const provider = createAnthropic({ apiKey: anthropicKey });
		const configuredModelId =
			process.env.ANTHROPIC_MODEL ||
			(process.env.AI_MODEL?.startsWith("claude-") ? process.env.AI_MODEL : "");
		const modelKey = await resolveCatalogModelKey({
			providerId: "anthropic",
			configuredModelId: configuredModelId || undefined,
			fallbackModelKey: "claude-opus-4-6",
		});
		return { model: provider.chat(modelKey), provider: "anthropic" };
	}

	const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL;
	const openaiKey = await getSecretValueAsync("OPENAI_API_KEY");
	const gatewayKey = await getSecretValueAsync("AI_GATEWAY_API_KEY");
	const apiKey = gatewayBaseURL
		? gatewayKey || openaiKey
		: openaiKey || gatewayKey;
	if (!apiKey) {
		throw new Error(
			"Missing AI API key (set ANTHROPIC_API_KEY or OPENAI_API_KEY or AI_GATEWAY_API_KEY).",
		);
	}

	const configuredModelId =
		process.env.OPENAI_MODEL ||
		(!process.env.AI_MODEL?.startsWith("claude-") ? process.env.AI_MODEL : "");
	const modelKey = await resolveCatalogModelKey({
		providerId: "openai",
		configuredModelId: configuredModelId || undefined,
		fallbackModelKey: "gpt-5.4",
	});
	const modelId = gatewayBaseURL ? `openai/${modelKey}` : modelKey;
	const provider = createOpenAI({
		apiKey,
		...(gatewayBaseURL ? { baseURL: gatewayBaseURL } : {}),
	});
	return { model: provider.chat(modelId), provider: "openai" };
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) {
		return trimmed;
	}
	return trimmed
		.replace(/^```(?:yaml|json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
}

function buildSystemPrompt(): string {
	return `You generate CNCF Serverless Workflow 1.0 workflow definitions for a Dapr-based multi-agent automation platform.

Rules:
- Output only a complete workflow definition as YAML or JSON text, with no markdown commentary.
- Use document.dsl: "1.0.0".
- Prefer YAML unless JSON is significantly clearer.
- The workflow must be valid CNCF Serverless Workflow 1.0.
- Use only supported task types: call, set, switch, wait, emit, for, do, fork, try, run, listen, raise.
- Favor call, set, switch, for, do, and emit for AI-agent workflows.
- Reference platform functions by name in call tasks. Do not invent raw URLs.
- Use workflow context expressions consistently, for example \${ .plan }, \${ .review }, or \${ .input.issue_number }.
- Give tasks stable names like initialize, plan, implementStep, review, commitPR.
- Include output.as when it helps surface key results like PR URLs or review status.
- Keep the workflow practical for graph visualization: avoid deeply nested branches unless needed.

Available platform functions:
${buildFunctionCatalogPrompt()}

${MULTI_AGENT_REFERENCE}
`;
}

export async function generateSwWorkflowWithRepairs(input: {
	prompt: string;
	maxAttempts?: number;
}): Promise<{ spec: SWWorkflow; warnings: Array<{ message: string }> }> {
	const maxAttempts = input.maxAttempts ?? 3;
	const ai = await getAi();
	const system = buildSystemPrompt();

	let lastWorkflowText = "";
	let lastErrors = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const prompt =
			attempt === 1
				? input.prompt
				: `Fix the Serverless Workflow definition.

Validation errors:
${lastErrors}

Previous workflow:
${lastWorkflowText}`;

		const { object } = await generateObject({
			model: ai.model,
			system,
			prompt,
			schema: WorkflowTextEnvelopeSchema,
		});

		const workflowText = stripCodeFences(object.workflowText);
		lastWorkflowText = workflowText;

		try {
			const spec = parseWorkflowDefinition(workflowText);
			const issues = validateWorkflowDefinition(spec);
			if (issues.length === 0) {
				return { spec, warnings: [] };
			}
			lastErrors = issues
				.map((issue) => `- ${issue.path}: ${issue.message}`)
				.join("\n");
		} catch (error) {
			lastErrors =
				error instanceof Error
					? `- /: ${error.message}`
					: "- /: Failed to parse workflow";
		}
	}

	throw new Error(
		`Failed to generate a valid SW 1.0 workflow after ${maxAttempts} attempts.\n${lastErrors}`,
	);
}
