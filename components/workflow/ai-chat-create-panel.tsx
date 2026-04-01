"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	RefreshCw,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AiChatComposer } from "@/components/workflow/ai-chat-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type {
	WorkflowAuthoringContextPayload,
	WorkflowGenerationDraftSettings,
} from "@/lib/ai/workflow-authoring/types";
import {
	buildDefaultWorkflowGenerationDraftSettings,
	buildWorkflowAiRefinedPrompt,
	clearWorkflowAiCreateSeed,
	cloneWorkflowEdges,
	cloneWorkflowNodes,
	normalizeGeneratedWorkflowNodes,
	readWorkflowAiCreateSeed,
} from "@/lib/workflow-ai-authoring";
import type { SWWorkflow } from "@/lib/serverless-workflow/sdk";
import {
	currentWorkflowNameAtom,
	edgesAtom,
	hasUnsavedChangesAtom,
	isGeneratingAtom,
	nodesAtom,
	type WorkflowAiCreateDraftState,
	type WorkflowEdge,
	type WorkflowNode,
	workflowAiCreateDraftAtom,
} from "@/lib/workflow-store";

function summarizeGeneratedWorkflow(nodes: WorkflowNode[]) {
	const executable = nodes.filter(
		(node) => !["add", "start", "end"].includes(node.type ?? ""),
	);
	const hasBranching = executable.some(
		(node) => node.type === "switch" || node.type === "if-else",
	);
	const hasLoop = executable.some((node) =>
		["for", "do", "loop-until", "while"].includes(node.type ?? ""),
	);
	const taskCount = executable.length;
	const startNode = nodes.find((node) => node.type === "start");
	const startConfig =
		(startNode?.data.config as Record<string, unknown> | undefined) ||
		((startNode?.data as Record<string, unknown> | undefined)?.taskConfig as
			| Record<string, unknown>
			| undefined);
	const authoringMode =
		startConfig?.document && typeof startConfig.document === "object"
			? "SW 1.0"
			: "Graph";

	return {
		authoringMode,
		taskCount,
		hasBranching,
		hasLoop,
	};
}

function formatIssueMessage(issue: unknown): string {
	if (typeof issue === "string") {
		return issue;
	}
	if (issue && typeof issue === "object") {
		const record = issue as Record<string, unknown>;
		const message =
			typeof record.message === "string" ? record.message : String(issue);
		const path = typeof record.path === "string" ? record.path : "";
		return path ? `${path}: ${message}` : message;
	}
	return String(issue);
}

function parseIssueNumber(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function buildInitialCreateDraft(input: {
	workflowId: string;
	prompt: string;
	currentName: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	settings?: Partial<WorkflowGenerationDraftSettings>;
}): WorkflowAiCreateDraftState {
	return {
		workflowId: input.workflowId,
		prompt: input.prompt,
		settings: buildDefaultWorkflowGenerationDraftSettings(
			input.prompt,
			input.settings,
		),
		status: "generating",
		originalName: input.currentName,
		originalNodes: cloneWorkflowNodes(input.nodes),
		originalEdges: cloneWorkflowEdges(input.edges),
		issues: {
			errors: [],
			warnings: [],
			repairActions: [],
			unsupportedRequirements: [],
		},
	};
}

export function AiChatCreatePanel({ workflowId }: { workflowId: string }) {
	const [createDraft, setCreateDraft] = useAtom(workflowAiCreateDraftAtom);
	const nodes = useAtomValue(nodesAtom);
	const edges = useAtomValue(edgesAtom);
	const [workflowName, setWorkflowName] = useAtom(currentWorkflowNameAtom);
	const setNodes = useSetAtom(nodesAtom);
	const setEdges = useSetAtom(edgesAtom);
	const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
	const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
	const [authoringContext, setAuthoringContext] = useState<Pick<
		WorkflowAuthoringContextPayload,
		"functions" | "capabilities"
	> | null>(null);
	const [authoringContextError, setAuthoringContextError] = useState<
		string | null
	>(null);

	const currentDraft =
		createDraft?.workflowId === workflowId ? createDraft : null;

	useEffect(() => {
		if (currentDraft) {
			return;
		}
		const seed = readWorkflowAiCreateSeed();
		if (!seed || seed.workflowId !== workflowId) {
			return;
		}
		clearWorkflowAiCreateSeed();
		setCreateDraft(
			buildInitialCreateDraft({
				workflowId,
				prompt: seed.prompt,
				currentName: workflowName,
				nodes,
				edges,
				settings: seed.settings,
			}),
		);
	}, [currentDraft, workflowId, workflowName, nodes, edges, setCreateDraft]);

	useEffect(() => {
		if (!currentDraft || currentDraft.status !== "generating") {
			return;
		}

		let canceled = false;
		setIsGenerating(true);
		const issueNumber = parseIssueNumber(currentDraft.settings.issueNumber);

		void api.workflow
			.generateFromPrompt({
				prompt: currentDraft.prompt,
				complexity: currentDraft.settings.complexity,
				requiresPullRequest: currentDraft.settings.requiresPullRequest,
				preferAvailableMcp: currentDraft.settings.preferAvailableMcp,
				repoOwner: currentDraft.settings.repoOwner.trim() || undefined,
				repoName: currentDraft.settings.repoName.trim() || undefined,
				issueNumber,
			})
			.then((generated) => {
				if (canceled) {
					return;
				}

				const stagedNodes = normalizeGeneratedWorkflowNodes(
					generated.nodes as WorkflowNode[],
				);
				const stagedEdges = cloneWorkflowEdges(
					generated.edges as WorkflowEdge[],
				);
				setNodes(stagedNodes);
				setEdges(stagedEdges);
				setWorkflowName(generated.name ?? "Untitled Workflow");
				setHasUnsavedChanges(false);
				setCreateDraft((previous) => {
					if (!previous || previous.workflowId !== workflowId) {
						return previous;
					}
					return {
						...previous,
						status: "staged",
						name: generated.name,
						description: generated.description,
						spec: (generated.spec ?? null) as SWWorkflow | null,
						nodes: stagedNodes,
						edges: stagedEdges,
						issues: generated.issues,
						error: null,
					};
				});
			})
			.catch((error) => {
				if (canceled) {
					return;
				}
				console.error("Failed to generate workflow draft:", error);
				setCreateDraft((previous) => {
					if (!previous || previous.workflowId !== workflowId) {
						return previous;
					}
					return {
						...previous,
						status: "error",
						error:
							error instanceof Error
								? error.message
								: "Failed to generate workflow draft",
					};
				});
			})
			.finally(() => {
				if (!canceled) {
					setIsGenerating(false);
				}
			});

		return () => {
			canceled = true;
		};
	}, [
		currentDraft,
		workflowId,
		setCreateDraft,
		setEdges,
		setHasUnsavedChanges,
		setIsGenerating,
		setNodes,
		setWorkflowName,
	]);

	useEffect(() => {
		if (!currentDraft) {
			setAuthoringContext(null);
			setAuthoringContextError(null);
			return;
		}

		let canceled = false;
		const issueNumber = parseIssueNumber(currentDraft.settings.issueNumber);

		void api.workflowAuthoring
			.getContext({
				prompt: currentDraft.prompt,
				complexity: currentDraft.settings.complexity,
				requiresPullRequest: currentDraft.settings.requiresPullRequest,
				preferAvailableMcp: currentDraft.settings.preferAvailableMcp,
				repoOwner: currentDraft.settings.repoOwner.trim() || undefined,
				repoName: currentDraft.settings.repoName.trim() || undefined,
				issueNumber,
			})
			.then((context) => {
				if (canceled) {
					return;
				}
				setAuthoringContext({
					functions: context.functions,
					capabilities: context.capabilities,
				});
				setAuthoringContextError(null);
			})
			.catch((error) => {
				if (canceled) {
					return;
				}
				setAuthoringContext(null);
				setAuthoringContextError(
					error instanceof Error
						? error.message
						: "Failed to load workflow authoring context",
				);
			});

		return () => {
			canceled = true;
		};
	}, [currentDraft]);

	const handleDiscard = useCallback(async () => {
		if (!currentDraft) {
			return;
		}
		setNodes(cloneWorkflowNodes(currentDraft.originalNodes));
		setEdges(cloneWorkflowEdges(currentDraft.originalEdges));
		setWorkflowName(currentDraft.originalName);
		setHasUnsavedChanges(false);
		setCreateDraft(null);
		setIsGenerating(false);
		toast.success("Discarded AI draft");
	}, [
		currentDraft,
		setCreateDraft,
		setEdges,
		setHasUnsavedChanges,
		setIsGenerating,
		setNodes,
		setWorkflowName,
	]);

	const handleApply = useCallback(async () => {
		if (
			!currentDraft ||
			currentDraft.status !== "staged" ||
			!currentDraft.nodes ||
			!currentDraft.edges ||
			!currentDraft.spec
		) {
			return;
		}

		setIsGenerating(true);
		setCreateDraft((previous) =>
			previous && previous.workflowId === workflowId
				? { ...previous, status: "applying", error: null }
				: previous,
		);

		try {
			const updated = await api.workflow.update(workflowId, {
				name: currentDraft.name,
				description: currentDraft.description,
				nodes: currentDraft.nodes,
				edges: currentDraft.edges,
				spec: currentDraft.spec,
			});

			const persistedNodes = normalizeGeneratedWorkflowNodes(
				updated.nodes as WorkflowNode[],
			);
			setNodes(persistedNodes);
			setEdges(cloneWorkflowEdges(updated.edges as WorkflowEdge[]));
			setWorkflowName(updated.name);
			setHasUnsavedChanges(false);
			setCreateDraft(null);
			toast.success("Applied AI draft to the supported workflow");
		} catch (error) {
			console.error("Failed to apply AI draft:", error);
			setCreateDraft((previous) =>
				previous && previous.workflowId === workflowId
					? {
							...previous,
							status: "error",
							error:
								error instanceof Error
									? error.message
									: "Failed to apply AI draft",
						}
					: previous,
			);
			toast.error("Failed to apply AI draft");
		} finally {
			setIsGenerating(false);
		}
	}, [
		currentDraft,
		setCreateDraft,
		setEdges,
		setHasUnsavedChanges,
		setIsGenerating,
		setNodes,
		setWorkflowName,
		workflowId,
	]);

	const handlePromptSubmit = useCallback(
		async ({ text }: { text: string }) => {
			const trimmed = text.trim();
			if (!trimmed || isGenerating) {
				return;
			}

			setCreateDraft((previous) => {
				if (!previous || previous.workflowId !== workflowId) {
					return previous;
				}

				return {
					...previous,
					prompt: buildWorkflowAiRefinedPrompt(previous.prompt, trimmed),
					status: "generating",
					issues: {
						errors: [],
						warnings: [],
						repairActions: [],
						unsupportedRequirements: [],
					},
					error: null,
				};
			});
		},
		[isGenerating, setCreateDraft, workflowId],
	);

	const handleRegenerate = useCallback(async () => {
		setCreateDraft((previous) => {
			if (!previous || previous.workflowId !== workflowId) {
				return previous;
			}
			return {
				...previous,
				status: "generating",
				issues: {
					errors: [],
					warnings: [],
					repairActions: [],
					unsupportedRequirements: [],
				},
				error: null,
			};
		});
	}, [setCreateDraft, workflowId]);

	const updateDraftSettings = useCallback(
		(next: Partial<WorkflowGenerationDraftSettings>) => {
			setCreateDraft((previous) => {
				if (!previous || previous.workflowId !== workflowId) {
					return previous;
				}
				return {
					...previous,
					settings: {
						...previous.settings,
						...next,
					},
				};
			});
		},
		[setCreateDraft, workflowId],
	);

	const summary = useMemo(() => {
		if (!currentDraft?.nodes) {
			return null;
		}
		return summarizeGeneratedWorkflow(currentDraft.nodes);
	}, [currentDraft?.nodes]);

	const warningCount = currentDraft?.issues.warnings.length ?? 0;
	const errorCount = currentDraft?.issues.errors.length ?? 0;
	const repairActionCount = currentDraft?.issues.repairActions?.length ?? 0;
	const unsupportedRequirementCount =
		currentDraft?.issues.unsupportedRequirements?.length ?? 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex-1 space-y-4 overflow-y-auto p-4">
				<div className="rounded-lg border bg-background p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Sparkles className="h-4 w-4 text-primary" />
								<h3 className="font-medium text-sm">Create With AI</h3>
								<Badge variant="secondary">
									{currentDraft?.status === "applying"
										? "Applying"
										: currentDraft?.status === "staged"
											? "Ready to apply"
											: currentDraft?.status === "error"
												? "Needs attention"
												: "Generating"}
								</Badge>
							</div>
							<p className="text-muted-foreground text-sm">
								The canvas is showing a staged AI draft. Nothing is persisted
								until you apply it.
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								disabled={!currentDraft || isGenerating}
								onClick={() => {
									void handleRegenerate();
								}}
								size="sm"
								variant="outline"
							>
								<RefreshCw className="mr-2 h-4 w-4" />
								Regenerate
							</Button>
							<Button
								disabled={!currentDraft || isGenerating}
								onClick={() => {
									void handleDiscard();
								}}
								size="sm"
								variant="ghost"
							>
								<Trash2 className="mr-2 h-4 w-4" />
								Discard
							</Button>
							<Button
								disabled={currentDraft?.status !== "staged" || isGenerating}
								onClick={() => {
									void handleApply();
								}}
								size="sm"
							>
								{currentDraft?.status === "applying" ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<CheckCircle2 className="mr-2 h-4 w-4" />
								)}
								Apply
							</Button>
						</div>
					</div>
				</div>

				<div className="rounded-lg border bg-muted/30 p-4 text-sm">
					<div className="mb-1 font-medium">Prompt</div>
					<p className="whitespace-pre-wrap text-muted-foreground">
						{currentDraft?.prompt ?? "Preparing AI prompt..."}
					</p>
				</div>

				<div className="rounded-lg border bg-background p-4 space-y-4">
					<div>
						<div className="font-medium text-sm">Generation settings</div>
						<p className="text-muted-foreground text-sm">
							These constraints are sent to the workflow authoring model.
						</p>
					</div>
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="workflow-ai-complexity">Complexity</Label>
							<Select
								disabled={!currentDraft || isGenerating}
								onValueChange={(value) => {
									updateDraftSettings({
										complexity:
											value as WorkflowGenerationDraftSettings["complexity"],
									});
								}}
								value={currentDraft?.settings.complexity ?? "standard"}
							>
								<SelectTrigger className="w-full" id="workflow-ai-complexity">
									<SelectValue placeholder="Select complexity" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="simple">Simple</SelectItem>
									<SelectItem value="standard">Standard</SelectItem>
									<SelectItem value="multi_agent">Multi-agent</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="workflow-ai-issue">Issue number</Label>
							<Input
								disabled={!currentDraft || isGenerating}
								id="workflow-ai-issue"
								inputMode="numeric"
								onChange={(event) => {
									updateDraftSettings({ issueNumber: event.target.value });
								}}
								placeholder="1"
								value={currentDraft?.settings.issueNumber ?? ""}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="workflow-ai-owner">Repository owner</Label>
							<Input
								disabled={!currentDraft || isGenerating}
								id="workflow-ai-owner"
								onChange={(event) => {
									updateDraftSettings({ repoOwner: event.target.value });
								}}
								placeholder="PittampalliOrg"
								value={currentDraft?.settings.repoOwner ?? ""}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="workflow-ai-repo">Repository name</Label>
							<Input
								disabled={!currentDraft || isGenerating}
								id="workflow-ai-repo"
								onChange={(event) => {
									updateDraftSettings({ repoName: event.target.value });
								}}
								placeholder="open-swe"
								value={currentDraft?.settings.repoName ?? ""}
							/>
						</div>
					</div>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="flex items-center justify-between rounded-lg border px-3 py-3">
							<div className="space-y-1">
								<Label className="text-sm">Require pull request</Label>
								<p className="text-muted-foreground text-xs">
									Prefer workflows that end with commit and PR publication.
								</p>
							</div>
							<Switch
								checked={currentDraft?.settings.requiresPullRequest ?? true}
								disabled={!currentDraft || isGenerating}
								onCheckedChange={(checked) => {
									updateDraftSettings({ requiresPullRequest: checked });
								}}
							/>
						</div>
						<div className="flex items-center justify-between rounded-lg border px-3 py-3">
							<div className="space-y-1">
								<Label className="text-sm">Use available MCP context</Label>
								<p className="text-muted-foreground text-xs">
									Pass enabled project MCP capabilities into generation.
								</p>
							</div>
							<Switch
								checked={currentDraft?.settings.preferAvailableMcp ?? true}
								disabled={!currentDraft || isGenerating}
								onCheckedChange={(checked) => {
									updateDraftSettings({ preferAvailableMcp: checked });
								}}
							/>
						</div>
					</div>

					{authoringContext ? (
						<div className="rounded-lg border bg-muted/30 p-3 space-y-3">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="outline">
									{authoringContext.functions.length} supported functions
								</Badge>
								<Badge variant="outline">
									{authoringContext.capabilities.length} enabled MCP{" "}
									{authoringContext.capabilities.length === 1
										? "capability"
										: "capabilities"}
								</Badge>
							</div>
							{authoringContext.capabilities.length > 0 ? (
								<div className="flex flex-wrap gap-2">
									{authoringContext.capabilities
										.slice(0, 8)
										.map((capability) => (
											<Badge key={capability.key} variant="secondary">
												{capability.displayName}
											</Badge>
										))}
								</div>
							) : (
								<p className="text-muted-foreground text-sm">
									No enabled project MCP capabilities are available for this
									draft.
								</p>
							)}
						</div>
					) : authoringContextError ? (
						<div className="rounded-lg border border-amber-300/40 bg-amber-50/40 p-3 text-amber-900 text-sm dark:bg-amber-950/20 dark:text-amber-200">
							Failed to load workflow authoring context: {authoringContextError}
						</div>
					) : null}
				</div>

				{currentDraft?.status === "generating" && (
					<div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-3 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Generating a workflow draft...
					</div>
				)}

				{currentDraft?.error && (
					<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
						<div className="mb-1 flex items-center gap-2 font-medium text-destructive">
							<AlertTriangle className="h-4 w-4" />
							Generation failed
						</div>
						<p className="text-destructive/90">{currentDraft.error}</p>
					</div>
				)}

				{currentDraft?.status !== "generating" && currentDraft?.name && (
					<div className="rounded-lg border bg-background p-4 space-y-3">
						<div>
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Proposed workflow
							</div>
							<div className="mt-1 font-medium">{currentDraft.name}</div>
							{currentDraft.description ? (
								<p className="mt-1 text-muted-foreground text-sm">
									{currentDraft.description}
								</p>
							) : null}
						</div>

						{summary && (
							<div className="flex flex-wrap gap-2">
								<Badge variant="outline">{summary.authoringMode}</Badge>
								<Badge variant="outline">
									{summary.taskCount} task
									{summary.taskCount === 1 ? "" : "s"}
								</Badge>
								{summary.hasBranching && (
									<Badge variant="outline">Branching</Badge>
								)}
								{summary.hasLoop && <Badge variant="outline">Looping</Badge>}
							</div>
						)}
					</div>
				)}

				{(warningCount > 0 ||
					errorCount > 0 ||
					repairActionCount > 0 ||
					unsupportedRequirementCount > 0) && (
					<div className="rounded-lg border bg-background p-4 space-y-3">
						<div className="font-medium text-sm">Generation review</div>
						{errorCount > 0 && (
							<div className="space-y-2">
								<div className="flex items-center gap-2 text-destructive text-sm">
									<AlertTriangle className="h-4 w-4" />
									{errorCount} error{errorCount === 1 ? "" : "s"}
								</div>
								<ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
									{currentDraft?.issues.errors.map((issue, index) => (
										<li key={`error-${index}`}>{formatIssueMessage(issue)}</li>
									))}
								</ul>
							</div>
						)}
						{warningCount > 0 && (
							<div className="space-y-2">
								<div className="flex items-center gap-2 text-amber-600 text-sm">
									<AlertTriangle className="h-4 w-4" />
									{warningCount} warning{warningCount === 1 ? "" : "s"}
								</div>
								<ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
									{currentDraft?.issues.warnings.map((issue, index) => (
										<li key={`warning-${index}`}>
											{formatIssueMessage(issue)}
										</li>
									))}
								</ul>
							</div>
						)}
						{repairActionCount > 0 && (
							<div className="space-y-2">
								<div className="flex items-center gap-2 text-emerald-700 text-sm">
									<CheckCircle2 className="h-4 w-4" />
									Applied {repairActionCount} deterministic repair
									{repairActionCount === 1 ? "" : "s"}
								</div>
								<ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
									{currentDraft?.issues.repairActions?.map((action, index) => (
										<li key={`repair-${index}`}>{action}</li>
									))}
								</ul>
							</div>
						)}
						{unsupportedRequirementCount > 0 && (
							<div className="space-y-2">
								<div className="flex items-center gap-2 text-amber-600 text-sm">
									<AlertTriangle className="h-4 w-4" />
									{unsupportedRequirementCount} unsupported requirement
									{unsupportedRequirementCount === 1 ? "" : "s"}
								</div>
								<ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
									{currentDraft?.issues.unsupportedRequirements?.map(
										(requirement, index) => (
											<li key={`unsupported-${index}`}>{requirement}</li>
										),
									)}
								</ul>
							</div>
						)}
					</div>
				)}
			</div>

			<div className="border-t p-4">
				<AiChatComposer
					isDisabled={isGenerating}
					nodes={nodes}
					onClear={handleDiscard}
					onSubmit={handlePromptSubmit}
					workflowId={workflowId}
				/>
				<p className="mt-2 text-muted-foreground text-xs">
					Send a follow-up instruction to refine this draft before applying it.
				</p>
			</div>
		</div>
	);
}
