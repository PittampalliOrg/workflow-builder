"use client";

import type {
	WorkflowGenerationComplexity,
	WorkflowGenerationDraftSettings,
} from "@/lib/ai/workflow-authoring/types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export const WORKFLOW_AI_CREATE_SEED_KEY = "workflow-ai-create-seed";

export type WorkflowAiCreateSeed = {
	workflowId: string;
	prompt: string;
	settings?: Partial<WorkflowGenerationDraftSettings>;
};

function inferWorkflowGenerationComplexity(
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

export function buildDefaultWorkflowGenerationDraftSettings(
	prompt: string,
	overrides?: Partial<WorkflowGenerationDraftSettings>,
): WorkflowGenerationDraftSettings {
	return {
		complexity:
			overrides?.complexity ?? inferWorkflowGenerationComplexity(prompt),
		requiresPullRequest: overrides?.requiresPullRequest ?? true,
		preferAvailableMcp: overrides?.preferAvailableMcp ?? true,
		repoOwner: overrides?.repoOwner ?? "",
		repoName: overrides?.repoName ?? "",
		issueNumber: overrides?.issueNumber ?? "",
	};
}

export function readWorkflowAiCreateSeed(): WorkflowAiCreateSeed | null {
	if (typeof window === "undefined") {
		return null;
	}

	const raw = window.sessionStorage.getItem(WORKFLOW_AI_CREATE_SEED_KEY);
	if (!raw) {
		return null;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<WorkflowAiCreateSeed>;
		if (
			typeof parsed.workflowId !== "string" ||
			typeof parsed.prompt !== "string"
		) {
			return null;
		}
		return {
			workflowId: parsed.workflowId,
			prompt: parsed.prompt,
			settings: parsed.settings,
		};
	} catch {
		return null;
	}
}

export function writeWorkflowAiCreateSeed(seed: WorkflowAiCreateSeed): void {
	if (typeof window === "undefined") {
		return;
	}
	window.sessionStorage.setItem(
		WORKFLOW_AI_CREATE_SEED_KEY,
		JSON.stringify(seed),
	);
}

export function clearWorkflowAiCreateSeed(): void {
	if (typeof window === "undefined") {
		return;
	}
	window.sessionStorage.removeItem(WORKFLOW_AI_CREATE_SEED_KEY);
}

export function buildWorkflowAiRefinedPrompt(
	basePrompt: string,
	refinement: string,
): string {
	const trimmedBase = basePrompt.trim();
	const trimmedRefinement = refinement.trim();

	if (!trimmedBase) {
		return trimmedRefinement;
	}

	if (!trimmedRefinement) {
		return trimmedBase;
	}

	return `${trimmedBase}\n\nAdditional user refinement:\n${trimmedRefinement}`;
}

export function normalizeGeneratedWorkflowNodes(
	nodes: WorkflowNode[],
): WorkflowNode[] {
	return nodes.map((node) => ({
		...node,
		selected: false,
		data: {
			...node.data,
			type: node.data.type || node.type,
			status: "idle",
		},
	}));
}

export function cloneWorkflowNodes(nodes: WorkflowNode[]): WorkflowNode[] {
	return nodes.map((node) => ({
		...node,
		position: { ...node.position },
		data: {
			...node.data,
			config: node.data.config ? structuredClone(node.data.config) : undefined,
		},
	}));
}

export function cloneWorkflowEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
	return edges.map((edge) => ({
		...edge,
		data: edge.data ? structuredClone(edge.data) : undefined,
	}));
}
