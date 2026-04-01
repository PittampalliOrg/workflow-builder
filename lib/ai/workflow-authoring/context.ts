import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMcpConnectionCatalog } from "@/lib/mcp-connections/catalog";
import {
	FUNCTION_CATALOG,
	getCatalogFunctionAuthoringDetails,
} from "@/lib/serverless-workflow/function-catalog";
import { WORKFLOW_AUTHORING_EXAMPLES } from "./examples";
import { WORKFLOW_AUTHORING_GUIDE_FALLBACK } from "./guide";
import type {
	WorkflowAuthoringCapability,
	WorkflowAuthoringContextPayload,
	WorkflowGenerationComplexity,
	WorkflowGenerationInput,
} from "./types";

let cachedGuide: string | null = null;

async function loadWorkflowAuthoringGuide(): Promise<string> {
	if (cachedGuide) {
		return cachedGuide;
	}

	const guidePath = path.join(
		process.cwd(),
		"lib/ai/workflow-authoring/AGENTS.md",
	);
	cachedGuide = await readFile(guidePath, "utf8").catch(() => {
		return WORKFLOW_AUTHORING_GUIDE_FALLBACK;
	});
	return cachedGuide;
}

export function inferWorkflowGenerationComplexity(
	prompt: string,
): WorkflowGenerationComplexity {
	const normalized = prompt.toLowerCase();
	if (
		normalized.includes("multi-agent") ||
		normalized.includes("multi agent") ||
		normalized.includes("review loop") ||
		normalized.includes("parallel") ||
		normalized.includes("fork")
	) {
		return "multi_agent";
	}
	if (
		normalized.includes("simple") ||
		normalized.includes("minimal") ||
		normalized.includes("basic")
	) {
		return "simple";
	}
	return "standard";
}

export function buildWorkflowGenerationBrief(
	input: WorkflowGenerationInput,
): string {
	const complexity =
		input.complexity ?? inferWorkflowGenerationComplexity(input.prompt);
	const repoSummary =
		input.repoOwner || input.repoName
			? `${input.repoOwner || "<repo-owner>"}/${input.repoName || "<repo-name>"}`
			: "not specified";
	const issueSummary =
		typeof input.issueNumber === "number"
			? String(input.issueNumber)
			: "not specified";

	return [
		`Goal: ${input.prompt.trim()}`,
		`Complexity target: ${complexity}`,
		`Repository: ${repoSummary}`,
		`Issue number: ${issueSummary}`,
		`Pull request required: ${input.requiresPullRequest === false ? "no" : "yes"}`,
		`Prefer available project MCP capabilities: ${input.preferAvailableMcp === false ? "no" : "yes"}`,
	].join("\n");
}

async function getProjectCapabilities(
	projectId: string,
	preferAvailableMcp: boolean,
): Promise<WorkflowAuthoringCapability[]> {
	if (!preferAvailableMcp) {
		return [];
	}

	const catalog = await getMcpConnectionCatalog(projectId);
	return catalog
		.filter((item) => item.enabled)
		.map((item) => ({
			sourceType: item.sourceType,
			key: item.catalogKey,
			displayName: item.displayName,
			description: item.description,
		}));
}

export async function getWorkflowAuthoringContext(input: {
	projectId: string;
	generation: WorkflowGenerationInput;
}): Promise<WorkflowAuthoringContextPayload> {
	const guide = await loadWorkflowAuthoringGuide();
	const capabilities = await getProjectCapabilities(
		input.projectId,
		input.generation.preferAvailableMcp !== false,
	);

	return {
		guide,
		examples: WORKFLOW_AUTHORING_EXAMPLES,
		functions: FUNCTION_CATALOG.map((fn) => ({
			name: fn.name,
			label: fn.label,
			category: fn.category,
			description: fn.description,
			...getCatalogFunctionAuthoringDetails(fn),
		})),
		capabilities,
	};
}
