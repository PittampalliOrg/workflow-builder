import type { ScorerLike } from "../mastra/eval-scorer.js";

export type ToolCallRecord = { name: string; args: any; result: any };

export type FileChange = {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
};

export type ChangeSummaryOutput = {
	changed: boolean;
	files: Array<{ path: string; op: string }>;
	stats: {
		files: number;
		additions: number;
		deletions: number;
	};
	patchRef?: string;
	patchSha256?: string;
	patchBytes?: number;
	truncatedInlinePatch?: boolean;
	inlinePatchPreview?: string;
	truncatedArtifact?: boolean;
	artifactOriginalBytes?: number;
	baseRevision?: string;
	headRevision?: string;
};

export type WorkflowCompletion = {
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
};

type BuildOpenShellRunCompletionInput = {
	completion: WorkflowCompletion;
	runPrompt: string;
	instanceId: string;
	executionId?: string;
	workspaceRef?: string;
	requireFileChanges: boolean;
	traceContext?: Record<string, unknown>;
};

type BuildOpenShellRunCompletionDeps = {
	scorers: ScorerLike[];
	runScorers: (
		scorers: ScorerLike[],
		prompt: string,
		text: string,
		instanceId: string,
	) => Promise<unknown[] | undefined>;
	buildAgentChangeSummary: (
		executionId: string,
		durableInstanceId: string,
	) => Promise<ChangeSummaryOutput>;
};

function traceIdFromTraceparent(traceparent: unknown): string | undefined {
	if (typeof traceparent !== "string") return undefined;
	const parts = traceparent.trim().split("-");
	if (parts.length < 4) return undefined;
	const traceId = parts[1]?.trim().toLowerCase();
	if (!traceId || traceId.length !== 32) return undefined;
	return /^[0-9a-f]+$/.test(traceId) ? traceId : undefined;
}

function buildTraceSurface(
	traceContext: Record<string, unknown> | undefined,
	completionResult: Record<string, unknown> | undefined,
): {
	traceId?: string;
	traceparent?: string;
	tracestate?: string;
	traceContext?: Record<string, unknown>;
} {
	const traceId =
		typeof completionResult?.traceId === "string" &&
		completionResult.traceId.trim().length > 0
			? completionResult.traceId.trim()
			: typeof traceContext?.traceId === "string" &&
				  traceContext.traceId.trim().length > 0
				? traceContext.traceId.trim()
				: typeof traceContext?.trace_id === "string" &&
					  traceContext.trace_id.trim().length > 0
					? traceContext.trace_id.trim()
					: traceIdFromTraceparent(traceContext?.traceparent);
	const traceparent =
		typeof traceContext?.traceparent === "string" &&
		traceContext.traceparent.trim().length > 0
			? traceContext.traceparent.trim()
			: undefined;
	const tracestate =
		typeof traceContext?.tracestate === "string" &&
		traceContext.tracestate.trim().length > 0
			? traceContext.tracestate.trim()
			: undefined;
	return {
		...(traceId ? { traceId } : {}),
		...(traceparent ? { traceparent } : {}),
		...(tracestate ? { tracestate } : {}),
		...(traceContext ? { traceContext } : {}),
	};
}

export function stopConditionImpliesFileChanges(stopCondition: string): boolean {
	const normalized = stopCondition.toLowerCase();
	const requiresChangeTerms = [
		"file changes",
		"files are updated",
		"code changes",
		"files updated",
		"changes are complete",
		"edited files",
		"modified files",
		"apply changes",
		"write files",
		"edit files",
	];
	return requiresChangeTerms.some((term) => normalized.includes(term));
}

export function buildAgentGraphPromptContext(agentGraph: unknown): string {
	if (
		!agentGraph ||
		typeof agentGraph !== "object" ||
		Array.isArray(agentGraph)
	) {
		return "";
	}
	const graph = agentGraph as {
		version?: unknown;
		nodes?: unknown;
		edges?: unknown;
	};
	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	if (nodes.length === 0) return "";
	const steps = nodes
		.slice(0, 12)
		.map((node, index) => {
			if (!node || typeof node !== "object" || Array.isArray(node)) {
				return `- Step ${index + 1}`;
			}
			const data =
				typeof (node as { data?: unknown }).data === "object" &&
				(node as { data?: unknown }).data &&
				!Array.isArray((node as { data?: unknown }).data)
					? ((node as { data?: Record<string, unknown> }).data as Record<
							string,
							unknown
						>)
					: {};
			const stepType =
				typeof data.stepType === "string"
					? data.stepType
					: typeof data.kind === "string"
						? data.kind
						: "step";
			const label =
				typeof data.label === "string" && data.label.trim().length > 0
					? data.label.trim()
					: `Step ${index + 1}`;
			return `- ${label} [${stepType}]`;
		})
		.join("\n");
	const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;
	const version =
		typeof graph.version === "string" && graph.version.trim().length > 0
			? graph.version.trim()
			: "v1";
	return `## Durable Agent Graph
Use this graph as the durable control loop for planning, tools, memory, approvals, and completion.
Graph version: ${version}
Graph topology: ${nodes.length} steps, ${edgeCount} edges
${steps}

`;
}

export function buildRunPrompt(
	basePrompt: string,
	stopCondition: string | undefined,
	requireFileChanges: boolean,
	cwd?: string,
	agentGraph?: unknown,
): string {
	const normalizedCwd = cwd?.trim();
	const normalizedStopCondition = stopCondition?.trim();
	const graphContext = buildAgentGraphPromptContext(agentGraph);
	const cwdContext = normalizedCwd
		? `Repository root: ${normalizedCwd}\nAlways operate relative to this repository root for file and directory paths.\n\n`
		: "";
	if (!normalizedStopCondition) {
		return `${cwdContext}${graphContext}${basePrompt}`;
	}

	const fileChangeGuard = requireFileChanges
		? "\n\nCRITICAL: You must make real file mutations (write/edit/delete/mkdir) before finalizing. Do not stop at analysis or directory listing."
		: "";

	return `${cwdContext}${graphContext}${basePrompt}

## Stop Condition
${normalizedStopCondition}

Execute autonomously until the stop condition is satisfied. Do not ask for confirmation before proceeding.${fileChangeGuard}`;
}

export function didRunMutateFiles(
	fileChanges: FileChange[],
	changeSummary?: ChangeSummaryOutput,
): boolean {
	if (fileChanges.length > 0) return true;
	return Boolean(changeSummary?.changed || changeSummary?.files.length);
}

export function buildSnapshotRefs(
	fileChanges: FileChange[],
	changeSummary?: ChangeSummaryOutput,
): string[] {
	const refs = new Set<string>();
	for (const file of changeSummary?.files ?? []) {
		const path = file.path?.trim();
		if (path) refs.add(path);
	}
	for (const file of fileChanges) {
		const path = file.path?.trim();
		if (path) refs.add(path);
	}
	return Array.from(refs).sort((a, b) => a.localeCompare(b));
}

export function extractToolCalls(
	result: Record<string, unknown> | undefined,
): ToolCallRecord[] {
	if (!result) return [];

	const toolCalls: ToolCallRecord[] = [];
	const allTc = result.all_tool_calls;
	if (Array.isArray(allTc) && allTc.length > 0) {
		for (const tc of allTc) {
			toolCalls.push({
				name: (tc as any).tool_name || (tc as any).name || "",
				args: (tc as any).tool_args || (tc as any).args || {},
				result: (tc as any).execution_result || (tc as any).result || null,
			});
		}
		return toolCalls;
	}

	const legacyTc = result.tool_calls;
	if (Array.isArray(legacyTc)) {
		for (const tc of legacyTc) {
			toolCalls.push({
				name: (tc as any).tool_name || (tc as any).name || "",
				args: (tc as any).tool_args || (tc as any).args || {},
				result: (tc as any).execution_result || (tc as any).result || null,
			});
		}
	}

	return toolCalls;
}

export function extractFileChanges(toolCalls: ToolCallRecord[]): FileChange[] {
	const changes: FileChange[] = [];
	const seen = new Map<string, number>();

	for (const tc of toolCalls) {
		const name = tc.name;
		const args = tc.args ?? {};

		if (name === "write_file" || name.endsWith("write_file")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			const change: FileChange = {
				path,
				operation: "created",
				content: args.content != null ? String(args.content) : undefined,
			};
			if (seen.has(path)) {
				changes[seen.get(path)!] = change;
			} else {
				seen.set(path, changes.length);
				changes.push(change);
			}
		} else if (name === "edit_file" || name.endsWith("edit_file")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			const change: FileChange = { path, operation: "modified" };
			if (seen.has(path)) {
				changes[seen.get(path)!] = change;
			} else {
				seen.set(path, changes.length);
				changes.push(change);
			}
		} else if (
			name === "delete_file" ||
			name === "delete" ||
			name.endsWith("delete")
		) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			if (seen.has(path)) {
				changes[seen.get(path)!] = { path, operation: "deleted" };
			} else {
				seen.set(path, changes.length);
				changes.push({ path, operation: "deleted" });
			}
		}
	}

	return changes;
}

export async function buildOpenShellRunCompletion(
	input: BuildOpenShellRunCompletionInput,
	deps: BuildOpenShellRunCompletionDeps,
): Promise<{
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}> {
	const toolCalls = extractToolCalls(input.completion.result);
	const fileChanges = extractFileChanges(toolCalls);
	const changeSummary =
		input.workspaceRef && input.executionId
			? await deps.buildAgentChangeSummary(
					input.executionId,
					input.instanceId,
				)
			: undefined;
	const snapshotRefs = buildSnapshotRefs(fileChanges, changeSummary);
	const hasFileMutations = didRunMutateFiles(fileChanges, changeSummary);
	const fileChangeGuardViolation =
		input.requireFileChanges && input.completion.success && !hasFileMutations
			? "Stop condition requires file changes, but this run completed without write/edit/delete operations."
			: undefined;

	const text =
		(input.completion.result?.final_answer as string) ??
		(input.completion.result?.last_message as string) ??
		(input.completion.result?.content as string) ??
		JSON.stringify(input.completion.result ?? {});

	let evalResults: unknown[] | undefined;
	if (
		deps.scorers.length > 0 &&
		input.completion.success &&
		!fileChangeGuardViolation
	) {
		evalResults = await deps.runScorers(
			deps.scorers,
			input.runPrompt,
			text,
			input.instanceId,
		);
	}

	const completionSuccess =
		input.completion.success && !fileChangeGuardViolation;
	const completionResult = {
		text,
		toolCalls,
		staticToolCalls:
			(input.completion.result?.static_tool_calls as unknown[]) ?? undefined,
		loopStopReason:
			(typeof input.completion.result?.stop_reason === "string"
				? input.completion.result.stop_reason
				: undefined) ?? undefined,
		loopStopCondition: input.completion.result?.stop_condition,
		requiresApproval: input.completion.result?.requires_approval,
		usageTotals: input.completion.result?.usage_totals,
		compactionApplied:
			input.completion.result?.compaction_applied === true ||
			((input.completion.result?.compaction_count as number | undefined) ?? 0) >
				0,
		compactionCount:
			typeof input.completion.result?.compaction_count === "number"
				? input.completion.result.compaction_count
				: 0,
		contextOverflowRecovered:
			input.completion.result?.context_overflow_recovered === true,
		lastCompactionReason:
			typeof input.completion.result?.last_compaction_reason === "string"
				? input.completion.result.last_compaction_reason
				: undefined,
		fileChanges,
		snapshotRefs,
		patch: changeSummary?.inlinePatchPreview,
		patchRef: changeSummary?.patchRef,
		changeSummary,
		daprInstanceId: input.instanceId,
		...buildTraceSurface(input.traceContext, input.completion.result),
		...(evalResults ? { evalResults } : {}),
	};

	return {
		success: completionSuccess,
		result: completionResult,
		...(fileChangeGuardViolation || input.completion.error
			? { error: fileChangeGuardViolation || input.completion.error }
			: {}),
	};
}
