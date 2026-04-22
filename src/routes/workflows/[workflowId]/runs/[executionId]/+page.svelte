<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import {
		SvelteFlow,
		MiniMap,
		Controls,
		Background,
		BackgroundVariant,
		type NodeTypes,
		type EdgeTypes,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import { formatDistanceToNow } from 'date-fns';
	import {
		ArrowLeft,
		CheckCircle2,
		XCircle,
		Loader2,
		Clock,
		ExternalLink,
		Copy,
		Terminal,
		MessageSquare,
		Wrench,
		Monitor,
		CircleAlert,
		Inbox,
		ImageIcon,
		Video,
		FileArchive,
		Brain,
		Bot,
		Zap,
		FileDiff,
		RefreshCw,
		MessagesSquare,
		AlertTriangle,
		Cable,
		Gauge,
		ShieldCheck,
		ListTree,
		ChevronRight,
		ChevronLeft
	} from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Separator } from '$lib/components/ui/separator';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Card, CardContent } from '$lib/components/ui/card';
	import {
		createExecutionStream,
		createInitialExecutionStreamState,
		type ExecutionStreamStore,
		type ExecutionStreamState
	} from '$lib/stores/execution-stream.svelte';
	import ExecutionHeader from '$lib/components/workflow/execution/execution-header.svelte';
	import JsonViewer from '$lib/components/workflow/execution/json-viewer.svelte';
	import StepDetail from '$lib/components/workflow/execution/step-detail.svelte';
	import TimelineAutoScroll from '$lib/components/workflow/execution/timeline-auto-scroll.svelte';
	import AgentRunExplorer from '$lib/components/workflow/execution/agent-run-explorer.svelte';
	import InvestigationStudio from '$lib/components/observability/investigation-studio.svelte';
	import PlanReview from '$lib/components/workflow/execution/plan-review.svelte';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import { getToolComponent } from '$lib/components/workflow/execution/tool-views';
	import { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor } from '$lib/components/ui/prompt-kit/chat-container';
	import { ScrollButton } from '$lib/components/ui/prompt-kit/scroll-button';
	import { ThinkingBar } from '$lib/components/ui/prompt-kit/thinking-bar';
	import { Reasoning, ReasoningTrigger, ReasoningContent } from '$lib/components/ui/prompt-kit/reasoning';
	import { Message, MessageAvatar, MessageContent } from '$lib/components/ui/prompt-kit/message';
	import ProviderIcon from '$lib/components/ui/ai-elements/provider-icon.svelte';
	import { Response as MarkdownResponse } from '$lib/components/ui/ai-elements/response/index.js';
	import {
		ChainOfThought,
		ChainOfThoughtHeader,
		ChainOfThoughtContent,
		ChainOfThoughtStep
	} from '$lib/components/ui/ai-elements/chain-of-thought/index.js';
	import {
		Task,
		TaskTrigger,
		TaskContent,
		TaskItem
	} from '$lib/components/ui/ai-elements/task/index.js';
	import {
		Context,
		ContextTrigger,
		ContextContent,
		ContextContentHeader,
		ContextContentBody,
		ContextContentFooter,
		ContextInputUsage,
		ContextOutputUsage,
		ContextCacheUsage,
		ContextReasoningUsage
	} from '$lib/components/ui/ai-elements/context';
	import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import type { ExecutionWorkspaceSession } from '$lib/types/execution-stream';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';
	import { withAgentNodeMetrics } from '$lib/utils/agent-node-metrics';
	import { fmtTokens, modelContextWindow } from '$lib/utils/format-tokens';
	import {
		buildTimelineItems,
		eventType,
		mergeTimelineEvents
	} from '$lib/utils/execution-timeline';

	import StartNode from '$lib/components/workflow/nodes/sw/start-node.svelte';
	import EndNode from '$lib/components/workflow/nodes/sw/end-node.svelte';
	import CallNode from '$lib/components/workflow/nodes/sw/call-node.svelte';
	import SetNode from '$lib/components/workflow/nodes/sw/set-node.svelte';
	import SwitchNode from '$lib/components/workflow/nodes/sw/switch-node.svelte';
	import WaitNode from '$lib/components/workflow/nodes/sw/wait-node.svelte';
	import EmitNode from '$lib/components/workflow/nodes/sw/emit-node.svelte';
	import ListenNode from '$lib/components/workflow/nodes/sw/listen-node.svelte';
	import ForNode from '$lib/components/workflow/nodes/sw/for-node.svelte';
	import ForkNode from '$lib/components/workflow/nodes/sw/fork-node.svelte';
	import TryNode from '$lib/components/workflow/nodes/sw/try-node.svelte';
	import RunNode from '$lib/components/workflow/nodes/sw/run-node.svelte';
	import RaiseNode from '$lib/components/workflow/nodes/sw/raise-node.svelte';
	import DoNode from '$lib/components/workflow/nodes/sw/do-node.svelte';
	import AgentNode from '$lib/components/workflow/nodes/sw/agent-node.svelte';
	import DefaultNode from '$lib/components/workflow/nodes/default-node.svelte';
	import AnimatedEdge from '$lib/components/workflow/edges/animated-edge.svelte';
	import LabeledEdge from '$lib/components/workflow/edges/labeled-edge.svelte';
	import ExecutionCanvasSync from '$lib/components/workflow/execution-canvas-sync.svelte';

	let workflowId = $derived(page.params.workflowId ?? '');
	let executionId = $derived(page.params.executionId ?? '');

	// Workflow canvas data
	let workflowNodes = $state<Node[]>([]);
	let workflowEdges = $state<Edge[]>([]);
	let workflowName = $state<string>('');

	// Logs
	interface StepLog {
		stepName: string;
		label: string;
		actionType: string;
		status: string;
		input: unknown;
		output: unknown;
		error: string | null;
		durationMs: number | null;
	}

	// Investigation / observability studio
	let investigationPayload = $state<ObservabilityInvestigationPayload | null>(null);
	let isLoadingInvestigation = $state(false);
	let investigationError = $state<string | null>(null);
	let investigationFetched = $state(false);

	// Sessions spawned by this run's durable/run nodes. Fetched once per
	// execution; re-fetched when an agent run completes so new sessions appear.
	type SpawnedSessionRow = {
		id: string;
		title: string | null;
		status: string;
		agentId: string;
		createdAt: string | null;
		completedAt: string | null;
	};
	let spawnedSessions = $state<SpawnedSessionRow[]>([]);
	let spawnedSessionsFetched = $state(false);

	// Browser artifacts
	type BrowserArtifactStep = {
		id: string;
		label: string;
		url: string;
		action?: string;
		goal?: string;
		title?: string;
		status: string;
		pauseMs?: number;
		successCriteria?: string;
		screenshotStorageRef?: string;
		error?: string;
	};
	type BrowserAsset = {
		kind: 'screenshot' | 'trace' | 'video' | 'video-annotated' | 'caption';
		label: string;
		storageRef: string;
		contentType: string;
		fileName?: string;
		stepId?: string;
	};
	type BrowserAnnotationCue = {
		id: string;
		stepId?: string;
		kind?: string;
		title?: string;
		body?: string;
		startMs?: number;
		endMs?: number;
		durationMs?: number;
	};
	type BrowserArtifact = {
		id: string;
		status: string;
		createdAt: string;
		manifestJson: {
			baseUrl: string;
			steps: BrowserArtifactStep[];
			assets?: BrowserAsset[];
			metadata?: Record<string, unknown> | null;
		};
	};
	type PreviewActionResult = {
		previewId: string;
		url: string;
		workspaceRef: string;
		sandboxName: string;
		workingDir: string;
		provider: string;
	};
	let previewActionPending = $state(false);
	let previewActionMessage = $state<string | null>(null);
	let previewActionError = $state<string | null>(null);

	// Active tab
	let activeTab = $state('overview');

	// Plan artifacts
	let planArtifacts = $state<Array<{ id: string; status: string; goal: string; planMarkdown: string | null; planJson: unknown; nodeId: string; createdAt: string; updatedAt: string }>>([]);
	let planArtifactsLoaded = $state(false);

	type CodeCheckpointFile = {
		path?: string;
		status?: string;
		previousPath?: string | null;
		additions?: number | null;
		deletions?: number | null;
		binary?: boolean;
	};

	type CodeCheckpoint = {
		id: string;
		seq: number | null;
		toolName: string;
		status: 'created' | 'no_changes' | 'skipped' | 'error';
		beforeSha: string | null;
		afterSha: string | null;
		remoteUrl: string | null;
		remoteRef: string | null;
		remoteStatus: string | null;
		remoteError: string | null;
		remotePushedAt: string | null;
		changedFiles: CodeCheckpointFile[];
		fileCount: number;
		sourceEventId: string;
		sandboxName: string | null;
		repoPath: string;
		error: string | null;
		createdAt: string;
	};

	let codeCheckpoints = $state<CodeCheckpoint[]>([]);
	let codeCheckpointsLoaded = $state(false);
	let codeCheckpointsLoading = $state(false);
	let codeCheckpointError = $state<string | null>(null);
	let selectedCodeCheckpointId = $state<string | null>(null);
	let selectedCodePath = $state<string | null>(null);
	let codeDiff = $state('');
	let codeDiffLoading = $state(false);
	let codeDiffError = $state<string | null>(null);
	let restoreCheckpointPending = $state(false);
	let restoreCheckpointMessage = $state<string | null>(null);
	let restoreCheckpointError = $state<string | null>(null);

	// Loading
	let isLoadingWorkflow = $state(true);

	// Execution stream
	let executionStream: ExecutionStreamStore | null = null;
	let executionState = $state<ExecutionStreamState>(createInitialExecutionStreamState());
	let timelineRef = $state<HTMLDivElement | null>(null);
	let persistedAgentEvents = $state<ExecutionTimelineEvent[]>([]);
	let persistedEventsLoaded = $state(false);

	// Fetch persisted agent events from DB when stream events are empty
	async function loadPersistedAgentEvents() {
		if (persistedEventsLoaded) return;
		persistedEventsLoaded = true;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/logs`);
			if (res.ok) {
				const data = await res.json();
				if (data.agentEvents?.length) {
					persistedAgentEvents = data.agentEvents;
				}
			}
		} catch { /* ignore */ }
	}

	// Combined events: live updates should extend persisted history, never replace it.
	let timelineEvents = $derived(
		mergeTimelineEvents(persistedAgentEvents, executionState.events)
	);

	// Derived stats from timeline events. Counts both legacy (llm_complete /
	// tool_call_start) and CMA (agent.message / agent.tool_use, etc.)
	// vocabularies; dedupe by taking max so we don't double-count.
	const CMA_TOOL_START_RUN = new Set(['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use']);
	let turnCount = $derived(Math.max(
		timelineEvents.filter(e => {
			const t = e.type ?? (e.data?.type as string) ?? '';
			return t === 'llm_complete';
		}).length,
		timelineEvents.filter(e => {
			const t = e.type ?? (e.data?.type as string) ?? '';
			return t === 'agent.message';
		}).length
	));
	let toolCallCount = $derived(Math.max(
		timelineEvents.filter(e => {
			const t = e.type ?? (e.data?.type as string) ?? '';
			return t === 'tool_call_start';
		}).length,
		timelineEvents.filter(e => {
			const t = e.type ?? (e.data?.type as string) ?? '';
			return CMA_TOOL_START_RUN.has(t);
		}).length
	));
	let significantTimelineEvents = $derived(
		timelineEvents.filter(e => {
			const t = e.type ?? (e.data?.type as string) ?? '';
			// Legacy vocabulary
			if (['llm_start', 'llm_complete', 'tool_call_start', 'tool_call_end', 'tool_call_error', 'run_started', 'run_complete', 'run_error'].includes(t)) {
				return true;
			}
			// CMA vocabulary — include the same types the step-timeline surfaces.
			if ([
				'agent.message', 'agent.thinking',
				'agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use',
				'agent.tool_result', 'agent.mcp_tool_result', 'agent.custom_tool_result',
				'agent.llm_usage',
				'hook.decision', 'mcp.tool_call',
				'agent.circuit_breaker_tripped', 'session.turn_timeout',
				'agent.thread_images_compacted', 'session.error'
			].includes(t)) {
				return true;
			}
			return false;
		})
	);

	// Aggregate tokens from every agent.llm_usage event so the Context
	// compound in the stats banner can show the total context-window
	// consumption for the whole run, not just per-call. Updates reactively
	// via $derived as new events stream in via SSE (no polling, no refresh).
	type AggregatedUsage = {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		reasoningTokens: number;
		model: string | null;
	};
	const aggregatedUsage = $derived.by<AggregatedUsage>(() => {
		const acc: AggregatedUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			reasoningTokens: 0,
			model: null
		};
		for (const e of timelineEvents) {
			if (e.type !== 'agent.llm_usage') continue;
			const d = e.data as Record<string, unknown>;
			acc.inputTokens += Number(d.input_tokens ?? 0);
			acc.outputTokens += Number(d.output_tokens ?? 0);
			acc.cacheReadTokens += Number(d.cache_read_input_tokens ?? 0);
			acc.cacheCreationTokens += Number(d.cache_creation_input_tokens ?? 0);
			if (typeof d.model === 'string') acc.model = d.model;
		}
		return acc;
	});
	const usedTokens = $derived(
		aggregatedUsage.inputTokens +
		aggregatedUsage.outputTokens +
		aggregatedUsage.cacheCreationTokens
	);
	const maxTokens = $derived(modelContextWindow(aggregatedUsage.model));
	const usage = $derived({
		inputTokens: aggregatedUsage.inputTokens,
		outputTokens: aggregatedUsage.outputTokens,
		cachedInputTokens: aggregatedUsage.cacheReadTokens,
		reasoningTokens: aggregatedUsage.reasoningTokens
	});

	const snapshot = $derived(executionState.snapshot);
	const executionStatus = $derived(snapshot?.status ?? 'unknown');
	const startTime = $derived(snapshot?.startedAt ?? null);
	const endTime = $derived(snapshot?.completedAt ?? null);
	const nodeStatuses = $derived(snapshot?.nodeStatuses ?? {});
	const output = $derived(
		(snapshot?.output as Record<string, unknown> | null) ??
			(snapshot?.summaryOutput as Record<string, unknown> | null) ??
			null
	);
	const input = $derived((snapshot?.input as Record<string, unknown> | null) ?? null);
	const errorMessage = $derived(snapshot?.error ?? null);
	const instanceId = $derived(snapshot?.instanceId ?? null);
	const traceId = $derived(snapshot?.traceId ?? null);
	const allTraceIds = $derived(Array.isArray(snapshot?.traceIds) ? snapshot.traceIds : []);
	const logs = $derived((snapshot?.steps as StepLog[] | undefined) ?? []);
	const browserArtifacts = $derived(
		(snapshot?.browserArtifacts as BrowserArtifact[] | undefined) ?? []
	);
	const agentRuns = $derived(
		(snapshot?.agentRuns as ExecutionAgentRun[] | undefined) ?? []
	);
	const workspaces = $derived(
		(snapshot?.workspaces as ExecutionWorkspaceSession[] | undefined) ?? []
	);
	const primaryWorkspace = $derived.by(
		() => workspaces.find((workspace) => workspace.status === 'active') ?? workspaces[0] ?? null
	);
	const primaryWorkspaceSandboxPolicy = $derived.by(() => {
		const state = primaryWorkspace?.sandboxState;
		if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
		const policy = (state as Record<string, unknown>).sandboxPolicy;
		return policy && typeof policy === 'object' && !Array.isArray(policy)
			? (policy as Record<string, unknown>)
			: null;
	});
	const investigationSessionId = $derived(snapshot?.sessionId ?? null);
	const browserArtifactError = $derived(executionState.error);
	const isLoadingStatus = $derived(!snapshot && !executionState.error);
	const isLoadingLogs = $derived(isLoadingStatus);
	const isLoadingBrowserArtifacts = $derived(isLoadingStatus);
	const activeNodeLabel = $derived(
		snapshot?.currentNodeName?.trim() || snapshot?.currentNodeId?.trim() || null
	);
	// Plan text fetched from Dapr state store (full content, never truncated)
	let planText = $state<string | null>(null);
	let planTextLoaded = $state(false);

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function stringValue(value: unknown): string | null {
		return typeof value === 'string' && value.trim().length > 10 ? value.trim() : null;
	}

	function extractTextValue(value: unknown, depth = 0): string | null {
		if (depth > 5) return null;
		const direct = stringValue(value);
		if (direct) return direct;
		if (!isRecord(value)) return null;

		for (const key of ['planMarkdown', 'plan', 'markdown', 'content']) {
			const text = stringValue(value[key]);
			if (text) return text;
		}

		for (const key of ['result', 'data', 'output']) {
			const nested = extractTextValue(value[key], depth + 1);
			if (nested) return nested;
		}

		return null;
	}

	function looksLikePlanText(text: string): boolean {
		return /\b(plan|implementation|approach|architecture|phase|steps?|tasks?)\b/i.test(text);
	}

	function stepLooksLikePlan(step: StepLog): boolean {
		return [step.stepName, step.label]
			.filter((value): value is string => typeof value === 'string')
			.some((value) => value.toLowerCase().includes('plan'));
	}

	function extractPlanTextFromExecution(): string | null {
		const planStep = logs.find(stepLooksLikePlan);
		const planStepText = planStep ? extractTextValue(planStep.output) : null;
		if (planStepText) return planStepText;

		const planRun = agentRuns.find((run) => run.nodeId.toLowerCase().includes('plan'));
		const planRunText = planRun ? extractTextValue(planRun.result) : null;
		if (planRunText) return planRunText;

		for (const step of logs) {
			const text = extractTextValue(step.output);
			if (text && looksLikePlanText(text)) return text;
		}

		for (const run of agentRuns) {
			const text = extractTextValue(run.result);
			if (text && looksLikePlanText(text)) return text;
		}

		return null;
	}

	const executionPlanText = $derived(extractPlanTextFromExecution());
	const displayPlanText = $derived(planText ?? executionPlanText);
	const selectedCodeCheckpoint = $derived.by(
		() => codeCheckpoints.find((checkpoint) => checkpoint.id === selectedCodeCheckpointId) ?? null
	);
	const checkpointChangeCount = $derived(
		codeCheckpoints.filter((checkpoint) => checkpoint.status === 'created').length
	);
	const durableCheckpointCount = $derived(
		codeCheckpoints.filter(checkpointIsDurable).length
	);

	async function loadPlanText(): Promise<void> {
		if (planTextLoaded) return;
		try {
			// Priority 1: Fetch from Dapr state store (persisted by agent after writing PLAN.md)
			const res = await fetch(`/api/workflows/executions/${executionId}/plan`);
			if (res.ok) {
				const data = await res.json();
				if (data.plan && typeof data.plan === 'string' && data.plan.length > 10) {
					planText = data.plan;
					planTextLoaded = true;
					return;
				}
			}
		} catch {
			// Non-critical
		}

		// Priority 2: Check plan_artifact agent event (published by agent after reading PLAN.md)
		const allEvents = [
			...(snapshot?.agentEvents ?? []),
			...persistedAgentEvents
		] as Array<{ type: string; data: Record<string, unknown> }>;

		const planArtifactEvent = allEvents.find(
			(e) => e.type === 'plan_artifact' && typeof e.data?.content === 'string'
		);
		if (planArtifactEvent) {
			planText = planArtifactEvent.data.content as string;
		}

		planTextLoaded = true;
	}

	async function loadPlanArtifacts(): Promise<void> {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/plan-artifacts`);
			if (res.ok) {
				const data = await res.json();
				planArtifacts = data.artifacts ?? [];
			}
		} catch {
			// Non-critical
		}
		planArtifactsLoaded = true;
	}

	$effect(() => {
		if (activeTab === 'plan') {
			if (!planArtifactsLoaded) loadPlanArtifacts();
			if (!planTextLoaded) loadPlanText();
		}
	});

	async function loadCodeCheckpoints(force = false): Promise<void> {
		if (codeCheckpointsLoaded && !force) return;
		codeCheckpointsLoading = true;
		codeCheckpointError = null;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/code-checkpoints`);
			if (!res.ok) throw new Error(await readApiError(res, `HTTP ${res.status}`));
			const data = await res.json();
			codeCheckpoints = data.checkpoints ?? [];
			codeCheckpointsLoaded = true;
			const firstChanged =
				codeCheckpoints.find((checkpoint) => checkpoint.status === 'created') ??
				codeCheckpoints[0] ??
				null;
			if (firstChanged && !selectedCodeCheckpointId) {
				await selectCodeCheckpoint(firstChanged.id);
			}
		} catch (err) {
			codeCheckpointError = err instanceof Error ? err.message : 'Failed to load code checkpoints';
		} finally {
			codeCheckpointsLoading = false;
		}
	}

	async function selectCodeCheckpoint(checkpointId: string, filePath: string | null = null): Promise<void> {
		selectedCodeCheckpointId = checkpointId;
		selectedCodePath = filePath;
		codeDiff = '';
		codeDiffError = null;
		restoreCheckpointMessage = null;
		restoreCheckpointError = null;
		codeDiffLoading = true;
		const pathQuery = filePath ? `?path=${encodeURIComponent(filePath)}` : '';
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/code-checkpoints/${checkpointId}/diff${pathQuery}`
			);
			if (!res.ok) throw new Error(await readApiError(res, 'Failed to load checkpoint diff'));
			const data = await res.json();
			codeDiff = typeof data.diff === 'string' ? data.diff : '';
			if (data.error) codeDiffError = String(data.error);
		} catch (err) {
			codeDiffError = err instanceof Error ? err.message : 'Failed to load checkpoint diff';
		} finally {
			codeDiffLoading = false;
		}
	}

	$effect(() => {
		if (activeTab === 'code') {
			loadCodeCheckpoints();
		}
	});

	async function restoreSelectedCodeCheckpoint(): Promise<void> {
		if (!selectedCodeCheckpoint) return;
		const sandboxName = selectedCodeCheckpoint.sandboxName || activeWorkspaceSandboxName;
		if (!sandboxName) {
			restoreCheckpointError = 'No active sandbox is available for restore.';
			return;
		}
		restoreCheckpointPending = true;
		restoreCheckpointMessage = null;
		restoreCheckpointError = null;
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/code-checkpoints/${selectedCodeCheckpoint.id}/restore`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sandboxName,
						repoPath: selectedCodeCheckpoint.repoPath
					})
				}
			);
			if (!res.ok) throw new Error(await readApiError(res, 'Failed to restore checkpoint'));
			const data = await res.json();
			restoreCheckpointMessage = `Restored ${shortSha(data.afterSha)} into ${data.sandboxName}.`;
		} catch (err) {
			restoreCheckpointError = err instanceof Error ? err.message : 'Failed to restore checkpoint';
		} finally {
			restoreCheckpointPending = false;
		}
	}

	let selectedAgentRunId = $state<string | null>(null);
	const selectedAgentRun = $derived.by(
		() =>
			agentRuns.find((run) => run.id === selectedAgentRunId) ??
			agentRuns.find((run) => run.status === 'running') ??
			agentRuns[0] ??
			null
	);
	const runningAgentRun = $derived.by(() => agentRuns.find((run) => run.status === 'running') ?? null);
	const canvasNodes = $derived.by(() => withAgentNodeMetrics(workflowNodes, agentRuns, timelineEvents));
	const canvasEdges = $derived.by(() => workflowEdges);
	const workflowNodeIds = $derived.by(() => workflowNodes.map((node) => node.id));

	const nodeTypes: NodeTypes = {
		start: StartNode,
		end: EndNode,
		call: CallNode,
		set: SetNode,
		switch: SwitchNode,
		wait: WaitNode,
		emit: EmitNode,
		listen: ListenNode,
		for: ForNode,
		fork: ForkNode,
		try: TryNode,
		run: RunNode,
		raise: RaiseNode,
		do: DoNode,
		agent: AgentNode,
		default: DefaultNode
	} satisfies NodeTypes;

	const isRunning = $derived(['running', 'pending'].includes(executionStatus.toLowerCase()));
	let allTimelineItems = $derived(buildTimelineItems(significantTimelineEvents, { isRunning }));

	// Filter state — lets users narrow the feed to a category in long threads.
	type TimelineFilter = 'all' | 'messages' | 'tools' | 'errors';
	let timelineFilter = $state<TimelineFilter>('all');

	function itemMatchesFilter(item: typeof allTimelineItems[number], f: TimelineFilter): boolean {
		if (f === 'all') return true;
		if (item.kind === 'tool') {
			if (f === 'tools') return true;
			if (f === 'errors') return item.status === 'error' || !!item.error;
			return false;
		}
		const t = eventType(item.event);
		if (f === 'messages') return t === 'llm_complete' || t === 'agent.message' || t === 'agent.thinking';
		if (f === 'errors') return ['run_error', 'agent.circuit_breaker_tripped', 'session.turn_timeout', 'session.error'].includes(t);
		if (f === 'tools') return t === 'mcp.tool_call' || t === 'hook.decision';
		return false;
	}
	let timelineItems = $derived(allTimelineItems.filter((item) => itemMatchesFilter(item, timelineFilter)));

	// Turn outline — each `llm_complete` / `agent.message` marks a turn
	// boundary. We collect per-turn context (assistant preview + tools used in
	// that turn) so the outline panel can show something meaningful rather
	// than just T1/T2/Tn. Walks allTimelineItems (not filtered) so the outline
	// always reflects the full thread structure.
	type TurnOutlineEntry = {
		turnIndex: number;
		itemKey: string;
		preview: string;
		tools: string[];
		hasError: boolean;
	};
	let turnNav = $derived.by(() => {
		const byKey = new Map<string, number>();
		const entries: TurnOutlineEntry[] = [];
		let pendingTools: string[] = [];
		let pendingError = false;
		for (const item of allTimelineItems) {
			if (item.kind === 'tool') {
				pendingTools.push(item.toolName);
				if (item.status === 'error' || item.error) pendingError = true;
				continue;
			}
			const t = eventType(item.event);
			if (t === 'llm_complete' || t === 'agent.message') {
				const turnIndex = entries.length + 1;
				const data = (item.event.data ?? {}) as { content?: unknown; preview?: unknown };
				let preview = '';
				if (typeof data.content === 'string') preview = data.content;
				else if (Array.isArray(data.content)) {
					preview = (data.content as Array<{ text?: unknown }>)
						.map((b) => (typeof b?.text === 'string' ? b.text : ''))
						.filter(Boolean)
						.join(' ');
				}
				if (!preview && typeof data.preview === 'string') preview = data.preview;
				preview = preview.replace(/\s+/g, ' ').trim().slice(0, 90);
				// Fallback for tool-only turns: synthesize a preview from the
				// tool chain so the outline entry actually tells the user what
				// happened, not just "(no text response)".
				if (!preview && pendingTools.length > 0) {
					const uniqueTools = Array.from(new Set(pendingTools));
					preview = `Ran ${uniqueTools.slice(0, 3).join(', ')}${uniqueTools.length > 3 ? `, +${uniqueTools.length - 3} more` : ''}`;
				}
				entries.push({
					turnIndex,
					itemKey: item.key,
					preview: preview || 'Silent turn',
					tools: pendingTools,
					hasError: pendingError,
				});
				byKey.set(item.key, turnIndex);
				pendingTools = [];
				pendingError = false;
			}
			if (['run_error', 'agent.circuit_breaker_tripped', 'session.turn_timeout', 'session.error'].includes(t)) {
				pendingError = true;
			}
		}
		return { byKey, entries };
	});

	// Active turn tracking — the outline panel highlights whichever turn's
	// anchor is closest to the top of the scrolling feed. IntersectionObserver
	// is set up once the timeline tab mounts.
	let activeTurn = $state<number | null>(null);
	let outlineOpen = $state(false);

	function scrollToTurn(turnIndex: number) {
		if (typeof document === 'undefined') return;
		const el = document.querySelector(`[data-turn-anchor="${turnIndex}"]`);
		if (el && 'scrollIntoView' in el) {
			(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	function scrollToAdjacentTurn(delta: 1 | -1) {
		const total = turnNav.entries.length;
		if (total === 0) return;
		const cur = activeTurn ?? (delta > 0 ? 0 : total + 1);
		const next = Math.min(Math.max(cur + delta, 1), total);
		if (next !== cur) scrollToTurn(next);
	}

	// Wire an IntersectionObserver + keyboard shortcuts once the run page mounts.
	$effect(() => {
		if (typeof window === 'undefined') return;

		const observer = new IntersectionObserver(
			(entries) => {
				// Track the topmost anchor that's currently intersecting.
				const visible = entries
					.filter((e) => e.isIntersecting)
					.map((e) => ({
						turn: Number((e.target as HTMLElement).dataset.turnAnchor),
						top: e.boundingClientRect.top,
					}))
					.filter((e) => Number.isFinite(e.turn) && e.turn > 0);
				if (visible.length === 0) return;
				visible.sort((a, b) => a.top - b.top);
				activeTurn = visible[0].turn;
			},
			{ rootMargin: '-80px 0px -60% 0px', threshold: 0 }
		);

		let raf = 0;
		function observeAllAnchors() {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				document.querySelectorAll('[data-turn-anchor]').forEach((el) => observer.observe(el));
			});
		}
		observeAllAnchors();
		const mo = new MutationObserver(observeAllAnchors);
		mo.observe(document.body, { childList: true, subtree: true });

		function onKey(e: KeyboardEvent) {
			// Don't trap keys inside editable surfaces.
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === '[') { e.preventDefault(); scrollToAdjacentTurn(-1); }
			else if (e.key === ']') { e.preventDefault(); scrollToAdjacentTurn(1); }
			else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); outlineOpen = !outlineOpen; }
		}
		window.addEventListener('keydown', onKey);

		return () => {
			observer.disconnect();
			mo.disconnect();
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
		};
	});

	/** Extract model name from run_started or llm_start events for provider icon display. */
	let agentModel = $derived.by(() => {
		for (const ev of timelineEvents) {
			const model = ev.data?.model;
			if (model && typeof model === 'string') return model;
		}
		return '';
	});

	const duration = $derived.by(() => {
		if (!startTime) return null;
		const start = new Date(startTime);
		const end = endTime ? new Date(endTime) : new Date();
		const ms = end.getTime() - start.getTime();
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	});

	const relativeStart = $derived(
		startTime ? formatDistanceToNow(new Date(startTime), { addSuffix: true }) : null
	);

	// Load workflow definition for the canvas
	async function loadWorkflow() {
		try {
			const res = await fetch(`/api/workflows/${workflowId}`);
			if (!res.ok) throw new Error('Failed to load workflow');
			const data = await res.json();
			workflowNodes = data.nodes ?? [];
			workflowEdges = data.edges ?? [];
			workflowName = data.name ?? '';
		} catch {
			// Leave canvas empty on error
		} finally {
			isLoadingWorkflow = false;
		}
	}

	async function fetchInvestigation() {
		if (investigationFetched || !investigationSessionId) return;
		investigationFetched = true;
		isLoadingInvestigation = true;
		investigationError = null;
		try {
			const res = await fetch(`/api/observability/sessions/${encodeURIComponent(investigationSessionId)}/investigation`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.error) {
				investigationError = data.error;
			} else {
				investigationPayload = data;
			}
		} catch (err) {
			investigationError = err instanceof Error ? err.message : 'Failed to load investigation view';
		} finally {
			isLoadingInvestigation = false;
		}
	}

	$effect(() => {
		if (activeTab === 'trace' && investigationSessionId && !investigationFetched) {
			fetchInvestigation();
		}
	});

	async function fetchSpawnedSessions() {
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/sessions`
			);
			if (!res.ok) return;
			const data = (await res.json()) as { sessions?: SpawnedSessionRow[] };
			spawnedSessions = data.sessions ?? [];
		} catch {
			// Non-fatal — the card just won't render.
		} finally {
			spawnedSessionsFetched = true;
		}
	}

	// Refresh spawned sessions once on load and again whenever an agent run
	// transitions (new durable/run → new session row).
	$effect(() => {
		if (!executionId) return;
		if (!spawnedSessionsFetched) {
			void fetchSpawnedSessions();
			return;
		}
		const running = agentRuns.some((r) => r.status === 'running');
		if (running) {
			const handle = setTimeout(() => {
				void fetchSpawnedSessions();
			}, 5000);
			return () => clearTimeout(handle);
		}
	});

	// Load persisted events when timeline tab is shown and stream is empty
	$effect(() => {
		if (activeTab === 'timeline' && !persistedEventsLoaded) {
			loadPersistedAgentEvents();
		}
	});

	const edgeTypes: EdgeTypes = {
		default: AnimatedEdge,
		animated: AnimatedEdge,
		labeled: LabeledEdge
	} satisfies EdgeTypes;

	// Timeline auto-scroll is handled inside the ChatContainerRoot context.

	$effect(() => {
		if (!selectedAgentRunId && selectedAgentRun) {
			selectedAgentRunId = selectedAgentRun.id;
		}
	});

	$effect(() => {
		if (isRunning && runningAgentRun && selectedAgentRunId !== runningAgentRun.id) {
			selectedAgentRunId = runningAgentRun.id;
		}
	});

	// Initialize
	$effect(() => {
		const nextExecutionId = executionId;
		loadWorkflow();

		const previousStream = untrack(() => executionStream);
		previousStream?.dispose();
		executionState = createInitialExecutionStreamState();

		const stream = createExecutionStream(nextExecutionId);
		executionStream = stream;
		const unsubscribe = stream.subscribe((state) => {
			executionState = state;
		});

		return () => {
			unsubscribe();
			stream.dispose();
			if (executionStream === stream) {
				executionStream = null;
			}
		};
	});

	let prevRunning = $state(true);
	$effect(() => {
		if (prevRunning && !isRunning) {
			investigationFetched = false;
			if (activeTab === 'trace') {
				fetchInvestigation();
			}
		}
		prevRunning = isRunning;
	});

	function eventIcon(type: string) {
		switch (type) {
			// Legacy
			case 'tool_call_start':
			case 'tool_call_end':
			case 'tool_call_error':
				return Wrench;
			case 'llm_start':
			case 'llm_token':
			case 'llm_complete':
				return MessageSquare;
			case 'sandbox_output':
				return Monitor;
			case 'run_complete':
				return CheckCircle2;
			case 'run_error':
				return XCircle;
			// CMA Tier 1/2/3
			case 'agent.tool_use':
			case 'agent.mcp_tool_use':
			case 'agent.custom_tool_use':
			case 'agent.tool_result':
			case 'agent.mcp_tool_result':
			case 'agent.custom_tool_result':
			case 'mcp.tool_call':
				return Wrench;
			case 'agent.message':
			case 'agent.message_delta':
			case 'agent.thinking':
			case 'agent.thinking_delta':
			case 'agent.tool_input_delta':
			case 'agent.llm_usage':
				return MessageSquare;
			case 'hook.decision':
				return CheckCircle2;
			case 'agent.circuit_breaker_tripped':
			case 'session.turn_timeout':
			case 'agent.thread_images_compacted':
			case 'session.error':
				return XCircle;
			default:
				return Terminal;
		}
	}

	function shortSha(value: string | null | undefined): string {
		return value ? value.slice(0, 8) : 'none';
	}

	function checkpointFilePath(file: CodeCheckpointFile): string {
		return String(file.path ?? '');
	}

	function checkpointFileSummary(file: CodeCheckpointFile): string {
		const parts = [];
		if (typeof file.additions === 'number') parts.push(`+${file.additions}`);
		if (typeof file.deletions === 'number') parts.push(`-${file.deletions}`);
		if (file.binary) parts.push('binary');
		return parts.join(' ');
	}

	function checkpointFileStatusLabel(file: CodeCheckpointFile): string {
		const status = String(file.status ?? '').trim().toUpperCase();
		if (!status) return file.binary ? 'BIN' : 'M';
		if (status.startsWith('R')) return status;
		if (status.startsWith('C')) return status;
		return status.slice(0, 1);
	}

	function checkpointHasFileChanges(checkpoint: CodeCheckpoint): boolean {
		return checkpoint.status === 'created' && checkpoint.fileCount > 0;
	}

	function checkpointGitChangeLabel(checkpoint: CodeCheckpoint): string | null {
		if (!checkpointHasFileChanges(checkpoint)) return null;
		const counts = new Map<string, number>();
		for (const file of checkpoint.changedFiles) {
			const status = checkpointFileStatusLabel(file);
			counts.set(status, (counts.get(status) ?? 0) + 1);
		}
		if (counts.size === 0) return `M ${checkpoint.fileCount}`;
		const order = ['A', 'M', 'D', 'R', 'C', 'T', 'U'];
		return [...counts.entries()]
			.sort(([left], [right]) => {
				const leftIndex = order.findIndex((prefix) => left.startsWith(prefix));
				const rightIndex = order.findIndex((prefix) => right.startsWith(prefix));
				return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
			})
			.map(([status, count]) => `${status} ${count}`)
			.join(' ');
	}

	function checkpointShaRange(checkpoint: CodeCheckpoint): string | null {
		if (!checkpointHasFileChanges(checkpoint)) return null;
		if (!checkpoint.beforeSha || !checkpoint.afterSha) return null;
		return `${shortSha(checkpoint.beforeSha)}..${shortSha(checkpoint.afterSha)}`;
	}

	function checkpointGitRemoteLabel(checkpoint: CodeCheckpoint): string | null {
		if (!checkpointHasFileChanges(checkpoint)) return null;
		if (checkpointIsDurable(checkpoint)) return 'pushed';
		if (checkpoint.remoteStatus === 'error') return 'push failed';
		if (checkpoint.remoteRef) return 'local ref';
		return null;
	}

	function checkpointShouldShowRemoteError(checkpoint: CodeCheckpoint): boolean {
		if (!checkpoint.remoteError) return false;
		if (
			!checkpointHasFileChanges(checkpoint) &&
			['no changes', 'no staged changes'].includes(checkpoint.remoteError.trim().toLowerCase())
		) {
			return false;
		}
		return true;
	}

	function checkpointIsDurable(checkpoint: CodeCheckpoint): boolean {
		return checkpoint.remoteStatus === 'pushed' && !!checkpoint.remoteRef;
	}

	function checkpointRemoteLabel(checkpoint: CodeCheckpoint): string {
		if (checkpointIsDurable(checkpoint)) return 'durable';
		if (checkpoint.remoteStatus === 'error') return 'remote error';
		if (checkpoint.remoteRef) return 'not pushed';
		return 'local only';
	}

	async function readApiError(response: Response, fallback: string): Promise<string> {
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			const body = await response.json().catch(() => null);
			if (body && typeof body.message === 'string') return body.message;
			if (body && typeof body.error === 'string') return body.error;
		}
		const text = await response.text().catch(() => '');
		return text.trim() || fallback;
	}

	function eventLabel(event: ExecutionTimelineEvent): string {
		switch (event.type) {
			case 'tool_call_start':
				return `Tool: ${(event.data.toolName as string) ?? (event.data.name as string) ?? 'unknown'}`;
			case 'tool_call_error':
				return `Tool failed: ${(event.data.toolName as string) ?? (event.data.name as string) ?? 'unknown'}`;
			case 'tool_call_end':
				return 'Tool completed';
			case 'llm_start':
				return `Model: ${(event.data.model as string) ?? (event.data.modelName as string) ?? 'started'}`;
			case 'llm_token':
				return `Token: ${((event.data.token as string) ?? '').slice(0, 80)}`;
			case 'llm_complete':
				return 'LLM response complete';
			case 'sandbox_output':
				return `Sandbox: ${((event.data.output as string) ?? (event.data.text as string) ?? '').slice(0, 120)}`;
			case 'run_complete':
				return 'Execution completed';
			case 'run_error':
				return `Error: ${(event.data.error as string) ?? 'unknown'}`;
			case 'status':
				return `Phase: ${(event.data.phase as string) ?? 'unknown'}`;
			case 'heartbeat':
				return 'Heartbeat';
			default:
				return event.type;
		}
	}

	function formatSpanDuration(us: number): string {
		if (us < 1000) return `${us}us`;
		if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
		return `${(us / 1_000_000).toFixed(2)}s`;
	}

	function browserBlobUrl(storageRef: string): string {
		return `/api/workflows/browser-artifacts/blob?storageRef=${encodeURIComponent(storageRef)}`;
	}

	function assetForStep(artifact: BrowserArtifact, stepId: string): BrowserAsset | undefined {
		return artifact.manifestJson.assets?.find(
			(asset) => asset.kind === 'screenshot' && asset.stepId === stepId
		);
	}

	function firstAssetByKind(
		artifact: BrowserArtifact,
		kind: BrowserAsset['kind']
	): BrowserAsset | undefined {
		return artifact.manifestJson.assets?.find((asset) => asset.kind === kind);
	}

	function primaryVideoAsset(artifact: BrowserArtifact): BrowserAsset | undefined {
		return (
			firstAssetByKind(artifact, 'video-annotated') ??
			firstAssetByKind(artifact, 'video')
		);
	}

	function rawVideoAsset(artifact: BrowserArtifact): BrowserAsset | undefined {
		return firstAssetByKind(artifact, 'video');
	}

	function captionAsset(artifact: BrowserArtifact): BrowserAsset | undefined {
		return firstAssetByKind(artifact, 'caption');
	}

	function metadataText(
		artifact: BrowserArtifact,
		key: string
	): string {
		const value = artifact.manifestJson.metadata?.[key];
		return typeof value === 'string' ? value : '';
	}

	function metadataNumber(
		artifact: BrowserArtifact,
		key: string
	): number | null {
		const value = artifact.manifestJson.metadata?.[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}

	function previewPortFromBaseUrl(baseUrl: string): string {
		try {
			const parsed = new URL(baseUrl);
			return parsed.port;
		} catch {
			return '';
		}
	}

	function defaultDevServerCommand(baseUrl: string): string {
		const port = previewPortFromBaseUrl(baseUrl);
		return port ? `npm run dev -- --host 0.0.0.0 --port ${port}` : '';
	}

	function browserAppPreviewUrl(artifact: BrowserArtifact): string {
		const repoPath = metadataText(artifact, 'requestedRepoPath');
		const baseUrl = metadataText(artifact, 'requestedBaseUrl') || artifact.manifestJson.baseUrl;
		if (!repoPath && !baseUrl) return '';

		const params = new URLSearchParams();
		params.set('previewId', artifact.id);
		if (repoPath) params.set('repoPath', repoPath);
		if (baseUrl) {
			params.set('baseUrl', baseUrl);
			const command =
				metadataText(artifact, 'requestedDevServerCommand') ||
				metadataText(artifact, 'devServerCommand') ||
				defaultDevServerCommand(baseUrl);
			if (command) params.set('devServerCommand', command);
		}
		params.set('timeoutSeconds', '7200');
		return `/workflows/runtime-preview/${encodeURIComponent(executionId)}?${params.toString()}`;
	}

	function annotationCues(artifact: BrowserArtifact): BrowserAnnotationCue[] {
		const value = artifact.manifestJson.metadata?.annotationPlan;
		if (!value || typeof value !== 'object') return [];
		const raw = (value as Record<string, unknown>).captions;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
			.map((entry, index) => ({
				id:
					typeof entry.id === 'string' && entry.id.trim()
						? entry.id.trim()
						: `caption-${index + 1}`,
				stepId: typeof entry.stepId === 'string' ? entry.stepId : undefined,
				kind: typeof entry.kind === 'string' ? entry.kind : undefined,
				title: typeof entry.title === 'string' ? entry.title : undefined,
				body: typeof entry.body === 'string' ? entry.body : undefined,
				startMs: typeof entry.startMs === 'number' ? entry.startMs : undefined,
				endMs: typeof entry.endMs === 'number' ? entry.endMs : undefined,
				durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : undefined
			}));
	}

	function asRecord(value: unknown): Record<string, unknown> | null {
		return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
	}

	function asText(value: unknown): string {
		return typeof value === 'string' ? value.trim() : '';
	}

	function firstText(record: Record<string, unknown>, keys: string[]): string {
		for (const key of keys) {
			const value = asText(record[key]);
			if (value) return value;
		}
		return '';
	}

	function previewActionCandidate(value: unknown, depth = 0): Record<string, unknown> | null {
		if (depth > 8) return null;
		const record = asRecord(value);
		if (!record || Array.isArray(value)) return null;

		if (firstText(record, ['previewId', 'proxyPath', 'proxyUrl', 'pageUrl'])) {
			return record;
		}

		for (const key of ['result', 'data', 'output', 'body', 'response']) {
			const nested = previewActionCandidate(record[key], depth + 1);
			if (nested) return nested;
		}
		return null;
	}

	function previewActionUrl(result: Record<string, unknown>, previewId: string): string {
		const pageUrl = firstText(result, ['pageUrl']);
		if (pageUrl) return pageUrl;

		const params = new URLSearchParams();
		params.set('previewId', previewId);

		const repoPath = firstText(result, ['requestedRepoPath', 'repoPath']);
		const baseUrl = firstText(result, ['requestedBaseUrl', 'baseUrl']);
		const devServerCommand = firstText(result, ['requestedDevServerCommand', 'devServerCommand']);
		const installCommand = firstText(result, ['requestedInstallCommand', 'installCommand']);
		if (repoPath) params.set('repoPath', repoPath);
		if (baseUrl) params.set('baseUrl', baseUrl);
		if (devServerCommand) params.set('devServerCommand', devServerCommand);
		if (installCommand) params.set('installCommand', installCommand);
		params.set('timeoutSeconds', '7200');

		return `/workflows/runtime-preview/${encodeURIComponent(executionId)}?${params.toString()}`;
	}

	function findPreviewActionResult(value: unknown, depth = 0): PreviewActionResult | null {
		if (depth > 8 || value == null) return null;

		if (Array.isArray(value)) {
			for (const item of value) {
				const match = findPreviewActionResult(item, depth + 1);
				if (match) return match;
			}
			return null;
		}

		const candidate = previewActionCandidate(value, depth);
		if (candidate) {
			const previewId = firstText(candidate, ['previewId']);
			if (previewId) {
				const sandbox = asRecord(candidate.sandbox);
				return {
					previewId,
					url: previewActionUrl(candidate, previewId),
					workspaceRef: firstText(candidate, ['workspaceRef']),
					sandboxName: firstText(candidate, ['sandboxName']) || (sandbox ? firstText(sandbox, ['sandboxName']) : ''),
					workingDir: firstText(candidate, ['workingDirectory', 'workingDir']),
					provider: firstText(candidate, ['provider'])
				};
			}
		}

		const record = asRecord(value);
		if (!record || Array.isArray(value)) return null;

		const preferredEntries = Object.entries(record).filter(([key]) => {
			const normalized = key.toLowerCase();
			return normalized.includes('preview') || normalized === 'start_preview';
		});
		for (const [, nested] of preferredEntries) {
			const match = findPreviewActionResult(nested, depth + 1);
			if (match) return match;
		}
		for (const [, nested] of Object.entries(record)) {
			const match = findPreviewActionResult(nested, depth + 1);
			if (match) return match;
		}
		return null;
	}

	const previewActionResult = $derived.by(() => findPreviewActionResult(output));

	const sandboxPreviewUrl = $derived.by(() => {
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		if (!workflowOutput) return '';
		const sandboxKeptValue = workflowOutput.sandboxKept;
		const sandboxKept =
			typeof sandboxKeptValue === 'boolean'
				? sandboxKeptValue
				: typeof sandboxKeptValue === 'string'
					? ['true', '1', 'yes'].includes(sandboxKeptValue.trim().toLowerCase())
					: false;
		return sandboxKept ? `/workflows/runtime-preview/${encodeURIComponent(executionId)}` : '';
	});

	const primaryAppPreviewUrl = $derived.by(() => {
		if (previewActionResult?.url) return previewActionResult.url;
		for (const artifact of browserArtifacts) {
			const url = browserAppPreviewUrl(artifact);
			if (url) return url;
		}
		return sandboxPreviewUrl;
	});

	const sandboxWorkspaceRef = $derived.by(() => {
		if (previewActionResult?.workspaceRef) return previewActionResult.workspaceRef;
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxWorkspaceRef;
		return typeof value === 'string' ? value : '';
	});

	const sandboxWorkingDir = $derived.by(() => {
		if (previewActionResult?.workingDir) return previewActionResult.workingDir;
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxWorkingDir;
		return typeof value === 'string' ? value : '';
	});

	const activeWorkspaceSandboxName = $derived.by(() => {
		if (previewActionResult?.sandboxName) return previewActionResult.sandboxName;
		const details = asRecord(primaryWorkspace?.sandboxState?.details);
		const detailName = details?.sandboxName ?? details?.name;
		if (typeof detailName === 'string' && detailName.trim()) return detailName.trim();
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxName;
		return typeof value === 'string' ? value : '';
	});

	const sandboxProvider = $derived.by(() => {
		if (previewActionResult?.provider) return previewActionResult.provider;
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxProvider;
		return typeof value === 'string' ? value : '';
	});

	const previewSandboxName = $derived(previewActionResult?.sandboxName || activeWorkspaceSandboxName);
	const activePreviewId = $derived(previewActionResult?.previewId || executionId);

	async function stopSandboxPreview() {
		previewActionPending = true;
		previewActionMessage = null;
		previewActionError = null;
		try {
			const response = await fetch(
				`/api/workflows/executions/${executionId}/sandbox-preview?previewId=${encodeURIComponent(activePreviewId)}`,
				{ method: 'DELETE' }
			);
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.success === false) {
				throw new Error(
					typeof payload.message === 'string'
						? payload.message
						: typeof payload.error === 'string'
							? payload.error
							: 'Failed to stop sandbox preview'
				);
			}
			previewActionMessage = 'Live preview stopped';
		} catch (error) {
			previewActionError =
				error instanceof Error ? error.message : 'Failed to stop sandbox preview';
		} finally {
			previewActionPending = false;
		}
	}

	function openAgentRunForNode(node: Node | string | null | undefined) {
		const nodeId = typeof node === 'string' ? node : node?.id;
		if (!nodeId) return;
		const nodeData =
			typeof node === 'string' || !node
				? undefined
				: (node.data as Record<string, unknown> | undefined);
		const directRunId = typeof nodeData?.agentRunId === 'string' ? nodeData.agentRunId : null;
		if (directRunId) {
			selectedAgentRunId = directRunId;
			return;
		}
		const match = agentRuns.find((run) => run.nodeId === nodeId);
		if (!match) return;
		selectedAgentRunId = match.id;
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<header class="flex h-12 items-center gap-3 border-b border-border px-4">
		<Breadcrumb.Root>
			<Breadcrumb.List class="gap-1 text-xs">
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/workflows" class="text-xs">Workflows</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Link
						href="/workflows/{workflowId}"
						class="text-xs truncate max-w-[220px]"
						title={workflowName || workflowId}
					>
						{workflowName || workflowId}
					</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/workflows/{workflowId}/runs" class="text-xs">Runs</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Page class="text-xs font-mono" title={executionId}>
						{executionId.slice(0, 8)}
					</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>

		<Separator orientation="vertical" class="h-5" />

		<ExecutionHeader
			status={executionStatus}
			duration={duration ?? undefined}
			startedAt={relativeStart ?? undefined}
			{executionId}
			instanceId={instanceId ?? undefined}
			traceId={traceId ?? undefined}
		/>

		<div class="ml-auto flex items-center gap-2 text-xs">
			<a
				href={`/workspaces/default/sessions?source=workflow&q=${executionId}`}
				class="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent text-muted-foreground hover:text-foreground"
				title="Sessions spawned by this run"
			>
				<MessagesSquare class="size-3.5" /> Sessions
			</a>
			{#if executionState.isConnected}
				<span class="flex items-center gap-1 text-muted-foreground">
					<span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
					Live
				</span>
			{/if}
		</div>
	</header>

	<!-- Tabbed content -->
	<Tabs bind:value={activeTab} class="flex flex-1 flex-col overflow-hidden">
		<div class="border-b border-border px-4">
			<TabsList class="h-10">
				<TabsTrigger value="overview">Overview</TabsTrigger>
				<TabsTrigger value="steps">Steps</TabsTrigger>
				<TabsTrigger value="timeline">Timeline</TabsTrigger>
				<TabsTrigger value="code">Code</TabsTrigger>
				<TabsTrigger value="plan">Plan</TabsTrigger>
				<TabsTrigger value="canvas">Canvas</TabsTrigger>
				<TabsTrigger value="agents">Agents</TabsTrigger>
				<TabsTrigger value="browser">Browser</TabsTrigger>
				<TabsTrigger value="trace">Trace</TabsTrigger>
			</TabsList>
		</div>

		<!-- Tab 1: Overview -->
		<TabsContent value="overview" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-5xl space-y-4">
				{#if primaryAppPreviewUrl}
					<Card>
						<CardContent class="space-y-3 p-4">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<div>
									<p class="text-sm font-medium">Retained Sandbox Available</p>
									<p class="text-sm text-muted-foreground">
										This run kept its OpenShell workspace alive so you can interact with the app after completion.
									</p>
								</div>
								<div class="flex flex-wrap gap-2">
									<a
										class="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
										href={primaryAppPreviewUrl}
										target="_blank"
										rel="noreferrer"
									>
										<ExternalLink size={14} />
										Open Live Preview
									</a>
									<button
										class="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:cursor-progress disabled:opacity-70"
										type="button"
										onclick={stopSandboxPreview}
										disabled={previewActionPending}
									>
										{previewActionPending ? 'Stopping…' : 'Stop Preview'}
									</button>
								</div>
							</div>

								<div class="grid gap-2 text-sm text-muted-foreground">
									{#if sandboxWorkspaceRef}
										<p><span class="font-medium text-foreground">Workspace:</span> <code>{sandboxWorkspaceRef}</code></p>
									{/if}
									{#if previewSandboxName}
										<p><span class="font-medium text-foreground">Sandbox:</span> <code>{previewSandboxName}</code></p>
									{/if}
									{#if previewActionResult?.previewId}
										<p><span class="font-medium text-foreground">Preview:</span> <code>{previewActionResult.previewId}</code></p>
									{/if}
									{#if sandboxWorkingDir}
										<p><span class="font-medium text-foreground">Working Dir:</span> <code>{sandboxWorkingDir}</code></p>
									{/if}
								{#if sandboxProvider}
									<p><span class="font-medium text-foreground">Provider:</span> <code>{sandboxProvider}</code></p>
								{/if}
							</div>

							{#if previewActionMessage}
								<p class="text-sm text-green-700 dark:text-green-400">{previewActionMessage}</p>
							{/if}
							{#if previewActionError}
								<p class="text-sm text-red-600 dark:text-red-400">{previewActionError}</p>
							{/if}
						</CardContent>
					</Card>
				{/if}

				{#if primaryWorkspace}
					<Card>
						<CardContent class="space-y-3 p-4">
							<div>
								<p class="text-sm font-medium">Workspace</p>
								<p class="text-sm text-muted-foreground">
									Canonical execution workspace tracked from <code>workflow_workspace_sessions</code>.
								</p>
							</div>

								<div class="grid gap-2 text-sm sm:grid-cols-2">
									<p><span class="font-medium text-foreground">Workspace Ref:</span> <code>{primaryWorkspace.workspaceRef}</code></p>
									<p><span class="font-medium text-foreground">Backend:</span> <code>{primaryWorkspace.backend}</code></p>
									<p><span class="font-medium text-foreground">Root Path:</span> <code>{primaryWorkspace.rootPath}</code></p>
									<p><span class="font-medium text-foreground">Status:</span> <code>{primaryWorkspace.status}</code></p>
									{#if primaryWorkspaceSandboxPolicy}
										<p><span class="font-medium text-foreground">Sandbox Mode:</span> <code>{String(primaryWorkspaceSandboxPolicy.mode ?? 'unknown')}</code></p>
										<p><span class="font-medium text-foreground">Keep After Run:</span> <code>{String(primaryWorkspaceSandboxPolicy.keepAfterRun ?? false)}</code></p>
									{/if}
									{#if primaryWorkspace.durableInstanceId}
										<p class="sm:col-span-2"><span class="font-medium text-foreground">Durable Instance:</span> <code>{primaryWorkspace.durableInstanceId}</code></p>
								{/if}
								{#if primaryWorkspace.enabledTools.length > 0}
									<p class="sm:col-span-2">
										<span class="font-medium text-foreground">Enabled Tools:</span>
										<code>{primaryWorkspace.enabledTools.join(', ')}</code>
									</p>
								{/if}
								{#if primaryWorkspace.lastError}
									<p class="sm:col-span-2 text-red-600 dark:text-red-400">
										<span class="font-medium">Last Error:</span> {primaryWorkspace.lastError}
									</p>
								{/if}
							</div>
						</CardContent>
					</Card>
				{/if}

				{#if spawnedSessions.length > 0}
					<Card>
						<CardContent class="space-y-3 p-4">
							<div class="flex items-center gap-2">
								<MessageSquare class="size-4 text-muted-foreground" />
								<div>
									<p class="text-sm font-medium">Spawned sessions</p>
									<p class="text-xs text-muted-foreground">
										<code>durable/run</code> nodes in this execution produced {spawnedSessions.length}
										session{spawnedSessions.length === 1 ? '' : 's'}. Click through for the full event trace.
									</p>
								</div>
							</div>
							<ul class="divide-y divide-border rounded-md border border-border">
								{#each spawnedSessions as s (s.id)}
									<li class="flex items-center justify-between gap-3 px-3 py-2 text-xs">
										<a
											href="/sessions/{s.id}"
											class="min-w-0 flex-1 truncate text-primary hover:underline"
											title={s.title ?? s.id}
										>
											{s.title ?? s.id.slice(0, 12)}
										</a>
										<Badge variant="outline" class="text-[10px] uppercase">{s.status}</Badge>
									</li>
								{/each}
							</ul>
						</CardContent>
					</Card>
				{/if}

				{#if input}
					<Card>
						<CardContent class="p-3">
							<JsonViewer data={input} label="Input" collapsed={false} />
						</CardContent>
					</Card>
				{/if}

				{#if output}
					<Card>
						<CardContent class="p-3">
							<JsonViewer data={output} label="Output" collapsed={false} />
						</CardContent>
					</Card>
				{/if}

				{#if errorMessage}
					<Alert variant="destructive">
						<CircleAlert class="size-4" />
						<AlertDescription>
							<pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{errorMessage}</pre>
						</AlertDescription>
					</Alert>
				{/if}

				{#if !input && !output && !errorMessage && !isLoadingStatus}
					<div class="flex flex-col items-center justify-center py-16 text-muted-foreground">
						<div class="rounded-full bg-muted p-3">
							<Inbox size={24} />
						</div>
						<p class="mt-3 text-sm font-medium">No data yet</p>
						<p class="mt-1 text-xs">Input and output will appear here once the execution produces results.</p>
					</div>
				{/if}
			</div>
		</TabsContent>

		<!-- Tab 2: Steps -->
		<TabsContent value="steps" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-5xl space-y-2">
				{#if isLoadingLogs}
					{#each Array(3) as _}
						<Skeleton class="h-14 w-full rounded-md" />
					{/each}
				{:else if logs.length > 0}
					{#each logs as step, i (i)}
						<StepDetail {step} />
					{/each}
				{:else}
					<div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
						<Terminal size={24} />
						<p class="mt-2 text-sm">No step logs available</p>
					</div>
				{/if}
			</div>
		</TabsContent>

		<!-- Tab 3: Timeline -->
		<TabsContent value="timeline" class="flex-1 overflow-hidden">
			<div class="flex h-full flex-col">
				{#if executionState.currentPhase}
					<div class="border-b border-border px-4 py-2 bg-muted/50">
						<span class="text-xs text-muted-foreground">Phase:</span>
						<span class="text-xs font-medium ml-1">{executionState.currentPhase}</span>
					</div>
				{/if}

				{#if executionState.activeToolName}
					<div class="border-b border-border px-4 py-2 bg-yellow-50 dark:bg-yellow-950/20">
						<span class="text-xs text-muted-foreground">Active tool:</span>
						<span class="text-xs font-medium ml-1">{executionState.activeToolName}</span>
					</div>
				{/if}

				<!-- Stats bar -->
				{#if turnCount > 0 || toolCallCount > 0}
					<div class="border-b border-border bg-muted/30 px-4 py-2">
						<div class="flex items-center gap-3 text-xs text-muted-foreground">
							<div class="flex items-center gap-1.5">
								{#if isRunning}
									<span class="relative flex size-1.5">
										<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60"></span>
										<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
									</span>
								{/if}
								<MessageSquare class="size-3 text-muted-foreground/70" />
								<span class="font-medium tabular-nums text-foreground transition-all">{turnCount}</span>
								<span>turn{turnCount !== 1 ? 's' : ''}</span>
							</div>
							<div class="h-3 w-px bg-border"></div>
							<div class="flex items-center gap-1.5">
								<Wrench class="size-3 text-muted-foreground/70" />
								<span class="font-medium tabular-nums text-foreground transition-all">{toolCallCount}</span>
								<span>tool{toolCallCount !== 1 ? 's' : ''}</span>
							</div>
							<div class="h-3 w-px bg-border"></div>
							<div class="flex items-center gap-1.5">
								<Zap class="size-3 text-muted-foreground/70" />
								<span class="font-medium tabular-nums text-foreground transition-all">{timelineEvents.length}</span>
								<span>events</span>
							</div>
							<!-- Aggregated context-window usage. Driven by a $derived
							     that sums every agent.llm_usage event in timelineEvents,
							     so it updates live as the SSE stream appends events. -->
							{#if usedTokens > 0}
								<div class="h-3 w-px bg-border"></div>
								<Context {usedTokens} {maxTokens} {usage} modelId={aggregatedUsage.model ?? 'unknown'}>
									<ContextTrigger variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-xs">
										<Gauge class="size-3 text-muted-foreground/70" />
										<span class="font-medium tabular-nums text-foreground">{fmtTokens(usedTokens)}</span>
										<span class="text-muted-foreground">/ {fmtTokens(maxTokens)}</span>
									</ContextTrigger>
									<ContextContent>
										<ContextContentHeader>
											Context window usage
										</ContextContentHeader>
										<ContextContentBody>
											<ContextInputUsage />
											<ContextOutputUsage />
											<ContextCacheUsage />
											<ContextReasoningUsage />
										</ContextContentBody>
										<ContextContentFooter>
											<span class="text-[10px] text-muted-foreground">
												{aggregatedUsage.model ?? 'model pending'}
											</span>
										</ContextContentFooter>
									</ContextContent>
								</Context>
							{/if}
						</div>
					</div>
				{/if}

				<div class="relative flex-1 overflow-hidden">
					<ChatContainerRoot class="h-full overflow-y-auto px-4 py-4 md:px-6">
						<TimelineAutoScroll
							active={activeTab === 'timeline'}
							itemCount={timelineItems.length}
							{executionId}
						/>
					{#if allTimelineItems.length > 0}
						<!-- Filter pills + Outline trigger. Sticky so they remain accessible while scrolling. -->
						<div class="sticky top-0 z-10 mx-auto mb-2 flex w-full max-w-[1400px] items-center gap-1 rounded-md border bg-background/95 px-2 py-1.5 backdrop-blur">
							{#each [{ v: 'all', label: 'All' }, { v: 'messages', label: 'Messages' }, { v: 'tools', label: 'Tools' }, { v: 'errors', label: 'Errors' }] as const as opt (opt.v)}
								<button
									type="button"
									onclick={() => (timelineFilter = opt.v)}
									class={timelineFilter === opt.v
										? 'rounded-sm bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground transition-colors'
										: 'rounded-sm px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'}
								>
									{opt.label}
								</button>
							{/each}
							<div class="mx-1 h-4 w-px bg-border"></div>
							<div class="flex items-center gap-0.5">
								<Button
									variant="ghost"
									size="sm"
									class="h-7 w-7 p-0"
									title="Previous turn ( [ )"
									onclick={() => scrollToAdjacentTurn(-1)}
									disabled={turnNav.entries.length === 0}
								>
									<ChevronLeft class="size-3.5" />
								</Button>
								<span class="min-w-[52px] text-center text-[11px] font-medium tabular-nums text-muted-foreground">
									{#if turnNav.entries.length > 0}
										{activeTurn ?? '·'} / {turnNav.entries.length}
									{:else}
										—
									{/if}
								</span>
								<Button
									variant="ghost"
									size="sm"
									class="h-7 w-7 p-0"
									title="Next turn ( ] )"
									onclick={() => scrollToAdjacentTurn(1)}
									disabled={turnNav.entries.length === 0}
								>
									<ChevronRight class="size-3.5" />
								</Button>
							</div>
							<div class="ml-auto flex items-center gap-1">
								<span class="hidden text-[10px] text-muted-foreground/70 md:inline">
									{timelineItems.length} of {allTimelineItems.length}
								</span>
								<Sheet bind:open={outlineOpen}>
									<SheetTrigger>
										<Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-[11px]" title="Open outline ( o )">
											<ListTree class="size-3.5" />
											Outline
										</Button>
									</SheetTrigger>
									<SheetContent side="right" class="w-[380px] sm:max-w-[400px]">
										<SheetHeader>
											<SheetTitle>Timeline outline</SheetTitle>
										</SheetHeader>
										<div class="flex h-[calc(100%-4rem)] flex-col overflow-y-auto pr-1">
											{#if turnNav.entries.length === 0}
												<p class="px-2 py-6 text-center text-xs text-muted-foreground">No assistant turns yet.</p>
											{:else}
												<ol class="space-y-1">
													{#each turnNav.entries as entry (entry.itemKey)}
														{@const isActive = activeTurn === entry.turnIndex}
														<li>
															<button
																type="button"
																onclick={() => { scrollToTurn(entry.turnIndex); outlineOpen = false; }}
																class={isActive
																	? 'w-full rounded-md border border-accent bg-accent/40 px-3 py-2 text-left transition-colors'
																	: 'w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/40'}
															>
																<div class="flex items-baseline gap-2">
																	<span class={isActive ? 'text-[10px] font-semibold tabular-nums text-foreground' : 'text-[10px] font-medium tabular-nums text-muted-foreground'}>
																		T{entry.turnIndex}
																	</span>
																	{#if entry.hasError}
																		<AlertTriangle class="size-3 shrink-0 text-red-500/80" />
																	{/if}
																	{#if entry.tools.length > 0}
																		<span class="ml-auto shrink-0 text-[10px] text-muted-foreground">
																			{entry.tools.length} tool{entry.tools.length === 1 ? '' : 's'}
																		</span>
																	{/if}
																</div>
																<p class="mt-0.5 line-clamp-2 text-[12px] leading-snug text-foreground">{entry.preview}</p>
																{#if entry.tools.length > 0}
																	<p class="mt-1 truncate text-[10px] text-muted-foreground">
																		{entry.tools.slice(0, 4).join(' · ')}{entry.tools.length > 4 ? ` · +${entry.tools.length - 4}` : ''}
																	</p>
																{/if}
															</button>
														</li>
													{/each}
												</ol>
											{/if}
										</div>
									</SheetContent>
								</Sheet>
							</div>
						</div>
					{/if}
					{#if timelineItems.length > 0}
						<ChatContainerContent class="mx-auto w-full max-w-[1400px] divide-y divide-border/60 rounded-lg border bg-card/40 shadow-sm">
							{#each timelineItems as item, i (item.key)}
								{@const turnAnchor = turnNav.byKey.get(item.key)}
								<div
									class="px-4 py-3 md:px-5"
									data-turn-anchor={turnAnchor ?? undefined}
								>
								{#if item.kind === 'tool'}
									{@const ToolComponent = getToolComponent(item.toolName)}
									<ToolComponent
										phase={item.phase}
										toolName={item.toolName}
										args={item.args}
										output={item.output}
										success={item.success}
										error={item.error}
										state={item.status === 'unknown' ? 'error' : item.status}
									/>
								{:else}
									{@const event = item.event}
									{@const evtType = eventType(event)}
									{#if evtType === 'run_started'}
										<div class="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-3">
											<Bot size={16} class="text-cyan-400" />
											<span class="text-sm font-medium text-cyan-400">Agent started</span>
											{#if event.data?.model}
												<Badge variant="outline" class="ml-auto text-[10px]">{event.data.model}</Badge>
											{/if}
										</div>

									{:else if evtType === 'llm_start'}
										<!-- Global thinking indicator lives below the {#each} (always visible
										     at the bottom while isRunning). This branch is intentionally empty
										     to avoid a per-turn ThinkingBar above tool calls. -->

									{:else if evtType === 'llm_complete'}
										{@const content = event.data?.content ? String(event.data.content).trim() : ''}
										{#if content}
										<div class="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
											<div class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background">
												<ProviderIcon model={agentModel} size={18} />
											</div>
											<div class="prose prose-sm dark:prose-invert max-w-none flex-1 text-sm leading-relaxed">
												<MarkdownResponse {content} parseIncompleteMarkdown={true} />
											</div>
										</div>
										{/if}
										<!-- When only tool calls and no content, skip — tool_call_start events render them -->

									{:else if evtType === 'run_complete'}
										<div class="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
											<CheckCircle2 size={16} class="text-green-400" />
											<span class="text-sm font-medium text-green-400">Agent completed</span>
										</div>

									{:else if evtType === 'run_error'}
										<Task open={true}>
											<TaskTrigger title="❌ Agent error" />
											<TaskContent>
												<TaskItem>
													<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-500/20 bg-red-500/5 p-3 text-[11px] font-mono text-red-400">{event.data?.error ? String(event.data.error) : 'Unknown error'}</pre>
												</TaskItem>
											</TaskContent>
										</Task>

									{:else if evtType === 'agent.message'}
										{@const data = (event.data ?? {}) as { content?: string | Array<{ text?: string }>; preview?: string }}
										{@const text = typeof data.content === 'string'
											? data.content
											: Array.isArray(data.content)
												? data.content.map(b => b?.text ?? '').filter(Boolean).join('\n\n')
												: (data.preview ?? '')}
										{#if text && text.trim()}
											<div class="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
												<div class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background">
													<ProviderIcon model={agentModel} size={18} />
												</div>
												<div class="prose prose-sm dark:prose-invert max-w-none flex-1 text-sm leading-relaxed">
													<MarkdownResponse content={text} parseIncompleteMarkdown={true} />
												</div>
											</div>
										{/if}

									{:else if evtType === 'agent.thinking'}
										{@const tdata = (event.data ?? {}) as { content?: Array<{ text?: string }> }}
										{@const thinkingText = Array.isArray(tdata.content) ? tdata.content.map(b => b?.text ?? '').filter(Boolean).join('\n\n') : ''}
										{#if thinkingText && thinkingText.trim()}
											<Reasoning defaultOpen={false}>
												<ReasoningTrigger />
												<ReasoningContent>{thinkingText}</ReasoningContent>
											</Reasoning>
										{/if}

									{:else if evtType === 'agent.llm_usage'}
										{@const u = (event.data ?? {}) as { model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; ttft_ms?: number | null }}
										{@const cacheRead = Number(u.cache_read_input_tokens ?? 0)}
										{@const inputTok = Number(u.input_tokens ?? 0)}
										{@const hitPct = cacheRead + inputTok > 0 ? Math.round((cacheRead / (cacheRead + inputTok)) * 100) : null}
										<div class="flex items-center gap-2 rounded-md border border-slate-500/25 bg-slate-500/5 px-3 py-1.5 text-[11px] text-muted-foreground">
											<Gauge size={12} class="text-slate-400" />
											<span class="font-mono text-foreground/90">{u.model ?? '?'}</span>
											<span>·</span>
											<span>in={inputTok}</span>
											<span>out={u.output_tokens ?? 0}</span>
											{#if cacheRead > 0}
												<span>·</span>
												<span>cache {cacheRead}{hitPct != null ? ` (${hitPct}%)` : ''}</span>
											{/if}
											{#if u.ttft_ms != null}
												<span>·</span>
												<span>TTFT {Math.round(Number(u.ttft_ms))}ms</span>
											{/if}
										</div>

									{:else if evtType === 'hook.decision'}
										{@const h = (event.data ?? {}) as { hook_event?: string; matcher?: string; decision?: string; outcome?: string; duration_ms?: number }}
										<div class="flex items-center gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/5 px-3 py-1.5 text-[11px]">
											<ShieldCheck size={12} class="text-indigo-400" />
											<span class="font-mono text-indigo-200">{h.hook_event ?? 'hook'}</span>
											{#if h.matcher}<span class="text-muted-foreground">({h.matcher})</span>{/if}
											<span>·</span>
											<span class="text-foreground/90">{h.decision ?? h.outcome ?? '?'}</span>
											{#if h.duration_ms != null}<span class="ml-auto font-mono text-muted-foreground">{h.duration_ms}ms</span>{/if}
										</div>

									{:else if evtType === 'mcp.tool_call'}
										{@const m = (event.data ?? {}) as { tool_name?: string; server?: string; duration_ms?: number; success?: boolean; error?: string }}
										<div class="flex items-center gap-2 rounded-md border border-cyan-500/25 bg-cyan-500/5 px-3 py-1.5 text-[11px]">
											<Cable size={12} class="text-cyan-400" />
											<span class="font-mono text-cyan-200">{m.tool_name ?? 'tool'}</span>
											{#if m.server}<span class="text-muted-foreground">@{m.server}</span>{/if}
											{#if m.success === false}
												<Badge variant="outline" class="text-[9px] border-red-500/30 text-red-300">failed</Badge>
											{/if}
											{#if m.duration_ms != null}<span class="ml-auto font-mono text-muted-foreground">{m.duration_ms}ms</span>{/if}
										</div>

									{:else if evtType === 'agent.circuit_breaker_tripped' || evtType === 'session.turn_timeout' || evtType === 'agent.thread_images_compacted' || evtType === 'session.error'}
										{@const alertData = (event.data ?? {}) as Record<string, unknown>}
										<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px]">
											<AlertTriangle size={14} class="mt-0.5 shrink-0 text-red-400" />
											<div class="min-w-0 flex-1">
												<div class="font-medium text-red-300">
													{evtType.replace(/^(agent|session)\./, '').replace(/_/g, ' ')}
												</div>
												{#if evtType === 'agent.circuit_breaker_tripped'}
													<div class="text-muted-foreground">Reason: {String(alertData.reason ?? '?')} ({alertData.streak ?? '?'}/{alertData.threshold ?? '?'})</div>
												{:else if evtType === 'session.turn_timeout'}
													<div class="text-muted-foreground">Turn {alertData.turn ?? '?'} exceeded {alertData.timeout_seconds ?? '?'}s</div>
												{:else if evtType === 'agent.thread_images_compacted'}
													<div class="text-muted-foreground">Collapsed {alertData.collapsed ?? '?'} screenshot(s); kept last {alertData.kept ?? '?'}</div>
												{:else if evtType === 'session.error'}
													<div class="whitespace-pre-wrap text-muted-foreground">{String(alertData.error ?? '').slice(0, 400)}</div>
												{/if}
											</div>
										</div>
									{/if}
								{/if}
								</div>
							{/each}
							{#if isRunning}
								<div class="px-4 py-3 md:px-5">
									<ThinkingBar />
								</div>
							{/if}
						</ChatContainerContent>
						<ChatContainerScrollAnchor />
					{:else if executionState.error}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<XCircle size={20} class="text-red-500" />
							<p class="text-sm">{executionState.error}</p>
						</div>
					{:else if isRunning}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<Loader2 size={20} class="animate-spin" />
							<p class="text-sm">Waiting for agent events...</p>
						</div>
					{:else if !persistedEventsLoaded}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<Loader2 size={20} class="animate-spin" />
							<p class="text-sm">Loading agent activity...</p>
						</div>
					{:else}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<Terminal size={20} />
							<p class="text-sm">No agent events recorded for this execution</p>
						</div>
					{/if}
					<ScrollButton />
					</ChatContainerRoot>
				</div>
			</div>
		</TabsContent>

		<!-- Tab 4: Code -->
		<TabsContent value="code" class="flex-1 overflow-hidden p-4">
			<div class="mx-auto flex h-full max-w-7xl flex-col gap-4">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p class="text-sm font-medium">Workspace Checkpoints</p>
						<p class="text-xs text-muted-foreground">
							Git-backed checkpoints created after mutating agent tools. Dapr stores the references; diffs load on demand.
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant="outline">{codeCheckpoints.length} checkpoints</Badge>
						<Badge variant="outline">{checkpointChangeCount} with changes</Badge>
						<Badge variant="outline">{durableCheckpointCount} durable</Badge>
						<button
							class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-progress disabled:opacity-60"
							type="button"
							disabled={codeCheckpointsLoading}
							onclick={() => loadCodeCheckpoints(true)}
						>
							<RefreshCw size={12} class={codeCheckpointsLoading ? 'animate-spin' : ''} />
							Refresh
						</button>
					</div>
				</div>

				{#if codeCheckpointError}
					<Alert variant="destructive">
						<CircleAlert class="size-4" />
						<AlertDescription>{codeCheckpointError}</AlertDescription>
					</Alert>
				{/if}

				{#if codeCheckpointsLoading && codeCheckpoints.length === 0}
					<div class="grid gap-3 lg:grid-cols-[22rem_1fr]">
						<Skeleton class="h-80 w-full rounded-md" />
						<Skeleton class="h-80 w-full rounded-md" />
					</div>
				{:else if codeCheckpoints.length === 0}
					<div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
						<FileDiff size={24} />
						<p class="mt-2 text-sm font-medium">No code checkpoints recorded</p>
						<p class="mt-1 max-w-md text-center text-xs">
							New dapr-agent-py runs will checkpoint write, edit, patch, and shell tools when the workspace is backed by Git.
						</p>
					</div>
				{:else}
					<div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
						<div class="min-h-0 overflow-y-auto rounded-md border border-border">
								{#each codeCheckpoints as checkpoint (checkpoint.id)}
									{@const gitChangeLabel = checkpointGitChangeLabel(checkpoint)}
									{@const gitShaRange = checkpointShaRange(checkpoint)}
									{@const gitRemoteLabel = checkpointGitRemoteLabel(checkpoint)}
									<button
										type="button"
										class="block w-full border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-muted/70 {checkpoint.id === selectedCodeCheckpointId ? 'bg-muted' : ''}"
										onclick={() => selectCodeCheckpoint(checkpoint.id)}
									>
										<div class="flex items-center justify-between gap-2">
											<span class="truncate text-sm font-medium">{checkpoint.toolName}</span>
											{#if checkpoint.status === 'error'}
												<Badge variant="destructive" class="shrink-0 font-mono text-[10px]">!</Badge>
											{:else if gitChangeLabel}
												<Badge variant="outline" class="shrink-0 font-mono text-[10px]">{gitChangeLabel}</Badge>
											{/if}
										</div>
										{#if gitShaRange || gitRemoteLabel || (checkpoint.seq && (gitChangeLabel || checkpoint.status === 'error'))}
											<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
												{#if gitShaRange}
													<span>{gitShaRange}</span>
												{/if}
												{#if gitRemoteLabel}
													<span>{gitRemoteLabel}</span>
												{/if}
												{#if checkpoint.seq && (gitChangeLabel || checkpoint.status === 'error')}
													<span>#{checkpoint.seq}</span>
												{/if}
											</div>
										{/if}
										{#if checkpointShouldShowRemoteError(checkpoint)}
											<p class="mt-1 line-clamp-2 text-xs text-amber-600 dark:text-amber-400">{checkpoint.remoteError}</p>
										{/if}
									{#if checkpoint.error}
										<p class="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">{checkpoint.error}</p>
									{/if}
								</button>
							{/each}
						</div>

						<div class="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
							<div class="border-b border-border px-3 py-2">
								{#if selectedCodeCheckpoint}
									<div class="flex flex-wrap items-center justify-between gap-2">
										<div class="min-w-0">
											<p class="truncate text-sm font-medium">
												{selectedCodePath ?? selectedCodeCheckpoint.toolName}
											</p>
											<p class="truncate text-xs text-muted-foreground">
												{selectedCodeCheckpoint.repoPath}
												{#if selectedCodeCheckpoint.sandboxName}
													<span> · {selectedCodeCheckpoint.sandboxName}</span>
												{/if}
												{#if selectedCodeCheckpoint.remoteRef}
													<span> · {checkpointRemoteLabel(selectedCodeCheckpoint)}</span>
												{/if}
											</p>
										</div>
										<div class="flex flex-wrap items-center gap-1">
											{#if checkpointIsDurable(selectedCodeCheckpoint)}
												<button
													type="button"
													class="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-progress disabled:opacity-60"
													disabled={restoreCheckpointPending}
													onclick={restoreSelectedCodeCheckpoint}
												>
													{restoreCheckpointPending ? 'Restoring...' : 'Restore to sandbox'}
												</button>
											{/if}
												{#each selectedCodeCheckpoint.changedFiles as file (checkpointFilePath(file))}
													{@const path = checkpointFilePath(file)}
													{#if path}
														<button
															type="button"
															class="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted {selectedCodePath === path ? 'bg-muted' : ''}"
															onclick={() => selectCodeCheckpoint(selectedCodeCheckpoint.id, path)}
														>
															<span class="font-mono text-muted-foreground">{checkpointFileStatusLabel(file)}</span>
															<span>{path}</span>
															{#if checkpointFileSummary(file)}
																<span class="ml-1 text-muted-foreground">{checkpointFileSummary(file)}</span>
														{/if}
													</button>
												{/if}
											{/each}
										</div>
									</div>
								{:else}
									<p class="text-sm text-muted-foreground">Select a checkpoint to inspect its diff.</p>
								{/if}
								{#if restoreCheckpointMessage}
									<p class="mt-2 text-xs text-green-700 dark:text-green-400">{restoreCheckpointMessage}</p>
								{/if}
								{#if restoreCheckpointError}
									<p class="mt-2 text-xs text-red-600 dark:text-red-400">{restoreCheckpointError}</p>
								{/if}
							</div>

							<div class="min-h-0 flex-1 overflow-hidden">
								{#if codeDiffLoading}
									<div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
										<Loader2 size={16} class="animate-spin" />
										Loading diff...
									</div>
								{:else if codeDiffError}
									<Alert variant="destructive" class="m-4">
										<CircleAlert class="size-4" />
										<AlertDescription>
											<pre class="whitespace-pre-wrap break-all font-mono text-xs">{codeDiffError}</pre>
										</AlertDescription>
									</Alert>
								{:else if codeDiff}
									<SandboxCodeViewer code={codeDiff} filename={selectedCodePath ?? 'checkpoint.diff'} lang="diff" />
								{:else}
									<div class="flex h-full flex-col items-center justify-center text-muted-foreground">
										<FileDiff size={22} />
										<p class="mt-2 text-sm">No diff for this checkpoint</p>
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		</TabsContent>

		<!-- Tab 5: Plan -->
		<TabsContent value="plan" class="flex-1 overflow-y-auto p-4">
			<PlanReview
				{executionId}
				{workflowId}
				{executionStatus}
				planText={displayPlanText}
				artifacts={planArtifacts}
				onArtifactsChange={loadPlanArtifacts}
			/>
		</TabsContent>

		<!-- Tab 6: Canvas -->
		<TabsContent value="canvas" class="flex-1 overflow-hidden">
			{#if isLoadingWorkflow}
				<div class="flex h-full items-center justify-center">
					<Loader2 size={24} class="animate-spin text-muted-foreground" />
				</div>
			{:else}
				<SvelteFlow
					nodes={canvasNodes}
					edges={canvasEdges}
					{nodeTypes}
					{edgeTypes}
					colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					fitView
					minZoom={0.1}
					maxZoom={4}
					onnodeclick={({ node }) => openAgentRunForNode(node)}
				>
					<ExecutionCanvasSync
						snapshot={snapshot}
						edges={workflowEdges}
						setEdges={(edges) => {
							workflowEdges = edges;
						}}
						managedNodeIds={workflowNodeIds}
					/>
					<Controls />
					<MiniMap zoomable pannable />
					<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				</SvelteFlow>
			{/if}
		</TabsContent>

		<TabsContent value="agents" class="flex-1 overflow-hidden p-4">
			<div class="mx-auto h-full max-w-7xl">
				<AgentRunExplorer
					{agentRuns}
					agentEvents={timelineEvents}
					selectedRunId={selectedAgentRunId}
					onSelectRun={(runId) => {
						selectedAgentRunId = runId;
					}}
				/>
			</div>
		</TabsContent>

		<!-- Tab 8: Browser -->
		<TabsContent value="browser" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-6xl space-y-4">
				{#if isLoadingBrowserArtifacts}
					{#each Array(2) as _}
						<Skeleton class="h-40 w-full rounded-md" />
					{/each}
				{:else if browserArtifactError}
					<Alert variant="destructive">
						<CircleAlert class="size-4" />
						<AlertDescription>{browserArtifactError}</AlertDescription>
					</Alert>
				{:else if browserArtifacts.length === 0}
					<div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
						<ImageIcon size={24} />
						<p class="mt-2 text-sm">No browser artifacts available</p>
					</div>
				{:else}
					{#each browserArtifacts as artifact (artifact.id)}
						<Card>
							<CardContent class="space-y-4 p-4">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{artifact.status}</Badge>
									<span class="text-xs text-muted-foreground">
										{new Date(artifact.createdAt).toLocaleString()}
									</span>
									{#if browserAppPreviewUrl(artifact)}
										<a
											class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
											href={browserAppPreviewUrl(artifact)}
											target="_blank"
											rel="noreferrer"
										>
											<ExternalLink size={12} />
											Open App Preview
										</a>
									{/if}
									{#if artifact.manifestJson.baseUrl}
										<span class="text-xs text-muted-foreground">
											Captured from sandbox URL {artifact.manifestJson.baseUrl}
										</span>
									{/if}
								</div>

									<div class="flex flex-wrap gap-3">
										{#each artifact.manifestJson.assets ?? [] as asset}
											{#if asset.kind === 'trace' || asset.kind === 'video'}
												<a
												class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
												href={browserBlobUrl(asset.storageRef)}
												target="_blank"
												rel="noreferrer"
											>
												{#if asset.kind === 'trace'}
													<FileArchive size={12} />
												{:else}
													<Video size={12} />
												{/if}
													{asset.label}
												</a>
											{:else if asset.kind === 'video-annotated' || asset.kind === 'caption'}
												<a
													class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
													href={browserBlobUrl(asset.storageRef)}
													target="_blank"
													rel="noreferrer"
												>
													{#if asset.kind === 'video-annotated'}
														<Video size={12} />
													{:else}
														<FileArchive size={12} />
													{/if}
													{asset.label}
												</a>
											{/if}
										{/each}
									</div>

								{#if metadataText(artifact, 'captureMode') === 'demo'}
									<div class="rounded-lg border border-border bg-muted/30 p-3 text-sm">
										<p class="font-medium">{metadataText(artifact, 'demoTitle') || 'Functional Demo'}</p>
										{#if metadataText(artifact, 'demoSummary')}
											<p class="mt-1 text-muted-foreground">{metadataText(artifact, 'demoSummary')}</p>
										{/if}
										{#if metadataNumber(artifact, 'stepCount')}
											<p class="mt-2 text-xs text-muted-foreground">
												{metadataNumber(artifact, 'stepCount')} scripted demo steps
											</p>
										{/if}
									</div>
								{/if}

										{#if primaryVideoAsset(artifact)?.storageRef}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video
												class="w-full overflow-hidden rounded-lg border border-border bg-black"
												src={browserBlobUrl(primaryVideoAsset(artifact)?.storageRef ?? '')}
												controls
												preload="metadata"
											>
												{#if captionAsset(artifact)?.storageRef}
													<track
														default
														kind="captions"
														label="Feature walkthrough"
														src={browserBlobUrl(captionAsset(artifact)?.storageRef ?? '')}
														srclang="en"
													/>
												{/if}
											</video>
											{#if primaryVideoAsset(artifact)?.kind === 'video-annotated' && rawVideoAsset(artifact)?.storageRef}
												<p class="text-xs text-muted-foreground">
													Primary player uses the annotated demo. The raw recording is still available in the asset list.
												</p>
											{/if}
										{/if}

										{#if annotationCues(artifact).length > 0}
											<div class="rounded-lg border border-border bg-muted/20 p-3">
												<p class="text-sm font-medium">Feature Walkthrough</p>
												<div class="mt-3 space-y-3">
													{#each annotationCues(artifact) as cue}
														<div class="space-y-1 text-sm">
															<p class="font-medium">{cue.title || 'Annotation'}</p>
															{#if cue.body}
																<p class="text-muted-foreground">{cue.body}</p>
															{/if}
														</div>
													{/each}
												</div>
											</div>
									{/if}

								<div class="grid gap-4 md:grid-cols-2">
									{#each artifact.manifestJson.steps ?? [] as step}
										<div class="overflow-hidden rounded-lg border border-border">
											<div class="flex items-center justify-between border-b border-border px-3 py-2">
												<div class="min-w-0">
													<p class="truncate text-sm font-medium">{step.label}</p>
													<p class="truncate text-xs text-muted-foreground">{step.url}</p>
												</div>
												<Badge variant={step.status === 'failed' ? 'destructive' : 'outline'}>
													{step.status}
												</Badge>
											</div>
											{#if step.screenshotStorageRef || assetForStep(artifact, step.id)?.storageRef}
												<img
													class="w-full bg-muted object-cover"
													src={browserBlobUrl(step.screenshotStorageRef ?? assetForStep(artifact, step.id)?.storageRef ?? '')}
													alt={step.label}
												/>
											{:else}
												<div class="flex h-40 items-center justify-center bg-muted text-xs text-muted-foreground">
													No screenshot stored
												</div>
											{/if}
											{#if step.title || step.error}
												<div class="space-y-1 px-3 py-2 text-xs text-muted-foreground">
													{#if step.action}
														<p class="uppercase tracking-wide">{step.action}</p>
													{/if}
													{#if step.goal}
														<p>{step.goal}</p>
													{/if}
													{#if step.title}
														<p>{step.title}</p>
													{/if}
													{#if step.successCriteria}
														<p>Success: {step.successCriteria}</p>
													{/if}
													{#if step.error}
														<p class="text-red-600 dark:text-red-400">{step.error}</p>
													{/if}
												</div>
											{/if}
										</div>
									{/each}
								</div>
							</CardContent>
						</Card>
					{/each}
				{/if}
			</div>
		</TabsContent>

		<!-- Tab 9: Trace -->
		<TabsContent value="trace" class="flex-1 overflow-y-auto px-4 py-4 xl:px-5 2xl:px-6">
			<div class="w-full">
				<InvestigationStudio
					payload={investigationPayload}
					isLoading={isLoadingInvestigation}
					error={investigationError}
					fullTraceHref={traceId ? `/observability/${traceId}` : null}
					phoenixHref={`/api/observability/phoenix/sessions/${encodeURIComponent(executionId)}`}
					onRefresh={() => {
						investigationFetched = false;
						fetchInvestigation();
					}}
				/>
			</div>
	</TabsContent>
</Tabs>
</div>
