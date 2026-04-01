import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { resolveCatalogModelKey } from "@/lib/ai/openai-model-selection";
import {
	buildWorkflowGenerationBrief,
	getWorkflowAuthoringContext,
} from "@/lib/ai/workflow-authoring/context";
import type {
	WorkflowAuthoringCapability,
	WorkflowGenerationInput,
} from "@/lib/ai/workflow-authoring/types";
import { getSecretValueAsync } from "@/lib/dapr/config-provider";
import { normalizeWorkflowToSwCutover } from "@/lib/serverless-workflow/cutover";
import {
	parseWorkflowDefinition,
	repairWorkflowDefinitionShape,
	validateWorkflowDefinition,
	type SWWorkflow,
} from "@/lib/serverless-workflow/sdk";

const WorkflowTextEnvelopeSchema = z.object({
	workflowText: z.string().min(1),
});

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

function renderFunctionsPrompt(
	functions: Awaited<
		ReturnType<typeof getWorkflowAuthoringContext>
	>["functions"],
): string {
	return functions
		.map((fn) => {
			const inputs =
				fn.requiredInputs.length > 0 ? fn.requiredInputs.join(", ") : "none";
			const outputs = fn.outputs.length > 0 ? fn.outputs.join(", ") : "none";
			const example =
				fn.examplePayload && Object.keys(fn.examplePayload).length > 0
					? ` Example payload: ${JSON.stringify(fn.examplePayload)}`
					: "";
			return `- ${fn.name} [${fn.category}]: ${fn.description}
  Use when: ${fn.whenToUse}
  Avoid when: ${fn.avoidWhen}
  Required inputs: ${inputs}
  Typical outputs: ${outputs}
  Long running: ${fn.longRunning ? "yes" : "no"}
  Idempotent: ${fn.idempotent ? "yes" : "no"}${example}`;
		})
		.join("\n");
}

function renderCapabilitiesPrompt(
	capabilities: WorkflowAuthoringCapability[],
	preferAvailableMcp: boolean,
): string {
	if (!preferAvailableMcp) {
		return "Project MCP capabilities are intentionally ignored for this generation request.";
	}
	if (capabilities.length === 0) {
		return "No enabled project MCP capabilities are available. Do not invent external MCP tool calls.";
	}
	return `Enabled project MCP capabilities:
${capabilities
	.map(
		(capability) =>
			`- ${capability.displayName} [${capability.sourceType}]${
				capability.description ? `: ${capability.description}` : ""
			}`,
	)
	.join("\n")}

These capabilities may inform downstream agent behavior, but they are not direct SW call targets unless a catalog function exposes them.`;
}

function renderExamplesPrompt(
	examples: Awaited<ReturnType<typeof getWorkflowAuthoringContext>>["examples"],
): string {
	return examples
		.map(
			(example) =>
				`## ${example.name}
Intent: ${example.intent}
${example.workflow}`,
		)
		.join("\n\n");
}

function buildSystemPrompt(
	context: Awaited<ReturnType<typeof getWorkflowAuthoringContext>>,
	preferAvailableMcp: boolean,
): string {
	return `You generate CNCF Serverless Workflow 1.0 definitions for workflow-builder.

Follow this authoring guide exactly:
${context.guide}

Available platform functions:
${renderFunctionsPrompt(context.functions)}

Project capability context:
${renderCapabilitiesPrompt(context.capabilities, preferAvailableMcp)}

Canonical valid examples:
${renderExamplesPrompt(context.examples)}

Return only workflow YAML or JSON with no markdown commentary.`;
}

function collectUnsupportedRequirements(
	input: WorkflowGenerationInput,
	context: Awaited<ReturnType<typeof getWorkflowAuthoringContext>>,
): string[] {
	const unsupported: string[] = [];
	const normalizedPrompt = input.prompt.toLowerCase();
	if (
		input.preferAvailableMcp !== false &&
		normalizedPrompt.includes("mcp") &&
		context.capabilities.length === 0
	) {
		unsupported.push(
			"The prompt references MCP capabilities, but this project has no enabled MCP connections.",
		);
	}
	if (
		input.requiresPullRequest === false &&
		/(\bpr\b|pull request)/.test(normalizedPrompt)
	) {
		unsupported.push(
			"The prompt requests a pull request, but the structured settings say PR creation is not required.",
		);
	}
	return unsupported;
}

export async function generateSwWorkflowWithRepairs(
	input: WorkflowGenerationInput & {
		projectId: string;
		maxAttempts?: number;
	},
): Promise<{
	spec: SWWorkflow;
	warnings: Array<{ message: string; code?: string }>;
	repairActions: string[];
	unsupportedRequirements: string[];
}> {
	const maxAttempts = input.maxAttempts ?? 3;
	const ai = await getAi();
	const context = await getWorkflowAuthoringContext({
		projectId: input.projectId,
		generation: input,
	});
	const unsupportedRequirements = collectUnsupportedRequirements(
		input,
		context,
	);
	const system = buildSystemPrompt(context, input.preferAvailableMcp !== false);
	const brief = buildWorkflowGenerationBrief(input);

	let lastWorkflowText = "";
	let lastErrors = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const prompt =
			attempt === 1
				? `Workflow request:
${brief}

User prompt:
${input.prompt}`
				: `Fix the Serverless Workflow definition.

Workflow request:
${brief}

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
			const parsed = parseWorkflowDefinition(workflowText);
			const repaired = repairWorkflowDefinitionShape(parsed);
			const normalized = normalizeWorkflowToSwCutover({
				name:
					input.name?.trim() ||
					parsed.document.title?.trim() ||
					parsed.document.name?.trim() ||
					"Generated Workflow",
				description:
					input.description?.trim() || parsed.document.summary?.trim() || null,
				nodes: [],
				edges: [],
				spec: repaired.workflow,
				specVersion: null,
			});
			const spec = normalized.spec as unknown as SWWorkflow;
			const issues = validateWorkflowDefinition(spec);
			if (issues.length === 0) {
				return {
					spec,
					warnings: [
						...(normalized.needsMigration
							? [
									{
										message:
											"Normalized generated workflow for platform compatibility.",
										code: "NORMALIZED_WORKFLOW",
									},
								]
							: []),
						...unsupportedRequirements.map((message) => ({
							message,
							code: "UNSUPPORTED_REQUIREMENT",
						})),
					],
					repairActions: repaired.actions,
					unsupportedRequirements,
				};
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
