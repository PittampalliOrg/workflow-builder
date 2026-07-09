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
		Check,
		Terminal,
		MessageSquare,
		Wrench,
		Monitor,
		CircleAlert,
		ImageIcon,
		Video,
		FileArchive,
		Brain,
		Zap,
		FileDiff,
		RefreshCw,
		AlertTriangle,
		Gauge,
		ListTree,
		ChevronRight,
		ChevronLeft,
		ChevronDown,
		GitFork,
		Play,
		PencilLine,
		Ellipsis,
		Waypoints
	} from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ForkDialog from '$lib/components/workflow/execution/fork-dialog.svelte';
	import RunLineageTree from '$lib/components/workflow/execution/run-lineage-tree.svelte';
	import ForkSpecDiff from '$lib/components/workflow/execution/fork-spec-diff.svelte';
	import { forkRun } from '$lib/workflows/fork';
	import WorkflowQuickSwitcher from '$lib/components/workflow/workflow-quick-switcher.svelte';
	import RunQuickSwitcher from '$lib/components/workflow/run-quick-switcher.svelte';
	import RunProgressBand from '$lib/components/workflow/execution/run-progress-band.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import RunConsole from '$lib/components/workflow/execution/run-console.svelte';
	import ServiceGraphRunView from '$lib/components/observability/service-graph-run-view.svelte';
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
	import JsonViewer from '$lib/components/workflow/execution/json-viewer.svelte';
	import ArtifactList from '$lib/components/workflow/execution/artifact-list.svelte';
	import RunChanges from '$lib/components/workflow/execution/run-changes.svelte';
	import RunFilesTree from '$lib/components/workflow/execution/run-files-tree.svelte';
	import ExecutionPreview from '$lib/components/workflow/execution/execution-preview.svelte';
	import TimelineAutoScroll from '$lib/components/workflow/execution/timeline-auto-scroll.svelte';
	import AgentRunExplorer from '$lib/components/workflow/execution/agent-run-explorer.svelte';
	import InvestigationStudio from '$lib/components/observability/investigation-studio.svelte';
	import PlanReview from '$lib/components/workflow/execution/plan-review.svelte';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import { EventRenderer, ToolEventRenderer } from '$lib/components/events';
	import { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor } from '$lib/components/ui/prompt-kit/chat-container';
	import { ScrollButton } from '$lib/components/ui/prompt-kit/scroll-button';
	import { ThinkingBar } from '$lib/components/ui/prompt-kit/thinking-bar';
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
	import {
		Sources,
		SourcesTrigger,
		SourcesContent,
		Source
	} from '$lib/components/ai-elements/sources';
	import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import type { ExecutionWorkspaceSession } from '$lib/types/execution-stream';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';
	import { withAgentNodeMetrics } from '$lib/utils/agent-node-metrics';
	import { fmtTokens, modelContextWindow } from '$lib/utils/format-tokens';
	import { specToGraph } from '$lib/utils/spec-graph-adapter';
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
	import ScriptRunPanel from '$lib/components/workflow/execution/script-run-panel.svelte';

	let workflowId = $derived(page.params.workflowId ?? '');
	let executionId = $derived(page.params.executionId ?? '');
	let slug = $derived((page.params.slug ?? '') as string);

	// Sibling-run navigation. The old "Other runs" sidebar is gone (run switching
	// now lives in the breadcrumb RunQuickSwitcher); we keep lightweight prev/next
	// affordances (toolbar buttons + `[` / `]`) by loading the workflow's run list
	// here. Newest-first, matching the executions endpoint order.
	let siblingRuns = $state<Array<{ id: string }>>([]);
	$effect(() => {
		const wf = workflowId;
		if (!wf) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/workflows/${encodeURIComponent(wf)}/executions?limit=200`);
				if (!res.ok || cancelled) return;
				const body = (await res.json()) as Array<{ id: string }>;
				if (!cancelled) siblingRuns = body ?? [];
			} catch {
				// best-effort; prev/next simply stay disabled
			}
		})();
		return () => {
			cancelled = true;
		};
	});
	const runIndex = $derived(siblingRuns.findIndex((r) => r.id === executionId));
	const canPrevRun = $derived(runIndex >= 0 && runIndex < siblingRuns.length - 1);
	const canNextRun = $derived(runIndex > 0);
	function gotoSiblingRun(id: string) {
		goto(`/workspaces/${slug}/workflows/${workflowId}/runs/${id}`, { replaceState: true });
	}
	function prevRun() {
		if (canPrevRun) gotoSiblingRun(siblingRuns[runIndex + 1].id);
	}
	function nextRun() {
		if (canNextRun) gotoSiblingRun(siblingRuns[runIndex - 1].id);
	}

	function handleCockpitKey(e: KeyboardEvent) {
		// Skip when the user is typing in an input or textarea.
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
		if (e.key === '[') {
			e.preventDefault();
			prevRun();
		} else if (e.key === ']') {
			e.preventDefault();
			nextRun();
		}
	}

	// Workflow canvas data
	let workflowNodes = $state<Node[]>([]);
	let workflowEdges = $state<Edge[]>([]);
	let workflowName = $state<string>('');
	// Dynamic-script engine: when true, the Canvas tab renders the script-run
	// panel (meta/phases/journal/budget) instead of the SW graph.
	let isDynamicScript = $state(false);
	let scriptExecutionIr = $state<Record<string, unknown> | null>(null);

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
	let investigationExecutionId = $state(page.params.executionId ?? '');


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

	// Active tab — the unified Live console (run-console) is the default landing.
	let activeTab = $state('overview');
	// Deep-link from the canvas launchpad: `?node=<name>` focuses that node's activity
	// in the run console (review mode lands on the node you clicked).
	const deepLinkNode = $derived(page.url.searchParams.get('node'));

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
	const ENVIRONMENT_BUILD_ACTIVITY_POLL_MS = 2_000;
	const TERMINAL_ENVIRONMENT_BUILD_STATUSES = new Set(['validated', 'failed', 'cancelled']);

	type ExecutionEnvironmentBuildActivity = {
		build: Record<string, unknown>;
		events: Record<string, unknown>[];
		latestEvent: Record<string, unknown> | null;
	};
	type EnvironmentBuildLookup = {
		key: string;
		kind: 'build' | 'run';
		url: string;
		instanceId: string | null;
	};
	let environmentBuildActivity = $state<ExecutionEnvironmentBuildActivity | null>(null);
	let environmentBuildActivityKey = $state<string | null>(null);

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
				'agent.context_usage', 'agent.llm_usage',
				'hook.decision', 'mcp.tool_call',
				'agent.circuit_breaker_tripped', 'session.turn_timeout',
				'agent.thread_images_compacted', 'session.error'
			].includes(t)) {
				return true;
			}
			return false;
		})
	);

	// Aggregate provider spend from every agent.llm_usage event. Context-window
	// usage is tracked separately from the latest active request; summing spend
	// across calls is not the same as current model context.
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
	const latestContextEvent = $derived.by<Record<string, unknown> | null>(() => {
		for (let i = timelineEvents.length - 1; i >= 0; i -= 1) {
			const event = timelineEvents[i];
			if (event.type !== 'agent.context_usage' && event.type !== 'agent.llm_usage') continue;
			const data = event.data as Record<string, unknown>;
			if (Number(data.context_input_tokens ?? 0) > 0) return data;
		}
		return null;
	});
	const usedTokens = $derived(Number(latestContextEvent?.context_input_tokens ?? 0));
	const maxTokens = $derived(
		Number(latestContextEvent?.context_window_size ?? 0) ||
			modelContextWindow(
				(typeof latestContextEvent?.model === 'string' ? latestContextEvent.model : null) ??
					aggregatedUsage.model
			)
	);
	const contextModel = $derived(
		(typeof latestContextEvent?.model === 'string' ? latestContextEvent.model : null) ??
			aggregatedUsage.model ??
			'unknown'
	);
	const usage = $derived({
		inputTokens: usedTokens,
		outputTokens: latestContextEvent?.input_tokens ? Number(latestContextEvent.input_tokens) : 0,
		cachedInputTokens: latestContextEvent?.cache_read_input_tokens
			? Number(latestContextEvent.cache_read_input_tokens)
			: 0,
		reasoningTokens: aggregatedUsage.reasoningTokens
	});

	const snapshot = $derived(executionState.snapshot);
	// Live token rate (tokens/sec over the last-30s window) for the progress band.
	const pageTokensPerSec = $derived.by(() => {
		const win = executionState.tokenRateWindow;
		if (win.length > 1) {
			const span = (win[win.length - 1].ts - win[0].ts) / 1000;
			const sum = win.reduce((a, b) => a + b.totalDelta, 0);
			return span > 0 ? sum / span : null;
		}
		return null;
	});
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
	const primaryInvestigationTraceId = $derived(traceId ?? allTraceIds[0] ?? null);
	const logs = $derived((snapshot?.steps as StepLog[] | undefined) ?? []);
	const browserArtifacts = $derived(
		(snapshot?.browserArtifacts as BrowserArtifact[] | undefined) ?? []
	);
	// Generic per-execution artifacts (workflow_artifacts table). Populated by
	// SW 1.0 task `artifacts:` blocks via the orchestrator's persist activity.
	const workflowArtifacts = $derived(
		(snapshot?.artifacts as Array<{
			id: string;
			nodeId: string | null;
			slot: 'primary' | 'secondary' | 'aux' | null;
			kind: string;
			title: string;
			description: string | null;
			inlinePayload: unknown;
			fileId: string | null;
			contentType: string | null;
			metadata: Record<string, unknown> | null;
			createdAt: string;
		}> | undefined) ?? []
	);
	// Per-node workspace diffs render in the dedicated Changes tab; keep them out
	// of Outputs to avoid duplication.
	const diffArtifacts = $derived(workflowArtifacts.filter((a) => a.kind === 'diff'));
	const outputArtifacts = $derived(workflowArtifacts.filter((a) => a.kind !== 'diff'));
	const hasChangesTab = $derived(diffArtifacts.length > 0);
	const primaryArtifacts = $derived(outputArtifacts.filter((a) => a.slot === 'primary'));
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

	function optionalString(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function executionEnvironmentBuildSourceData(): Record<string, unknown> | null {
		const outputRecord = isRecord(output) ? output : null;
		const inputRecord = isRecord(input) ? input : null;
		const prepare = outputRecord && isRecord(outputRecord.prepare_environment)
			? outputRecord.prepare_environment
			: null;
		const environment = prepare && isRecord(prepare.environment)
			? prepare.environment
			: inputRecord && isRecord(inputRecord.inferenceEnvironment)
				? inputRecord.inferenceEnvironment
				: prepare;
		if (!environment || !isRecord(environment)) return null;
		const status =
			optionalString(environment.environmentStatus) ??
			optionalString(prepare?.environmentStatus) ??
			optionalString(prepare?.status) ??
			'building';
		return {
			...environment,
			buildId: optionalString(prepare?.buildId) ?? optionalString(environment.buildId),
			pipelineRunName:
				optionalString(prepare?.pipelineRunName) ?? optionalString(environment.pipelineRunName),
			environmentStatus: status,
			status,
		};
	}

	function environmentStatusFromBuildSnapshot(build: Record<string, unknown>): string {
		const status = optionalString(build.status);
		if (status === 'validated') return 'validated';
		if (status === 'failed' || status === 'cancelled') return 'failed';
		return status ?? 'building';
	}

	function executionEnvironmentBuildData(): Record<string, unknown> | null {
		const source = executionEnvironmentBuildSourceData();
		if (!source) return null;
		const activity = environmentBuildActivity;
		const build = activity?.build;
		if (!build) return source;
		const status = environmentStatusFromBuildSnapshot(build);
		return {
			...source,
			buildId: optionalString(build.id) ?? optionalString(source.buildId),
			environmentKey: optionalString(build.environmentKey) ?? optionalString(source.environmentKey),
			envSpecHash: optionalString(build.envSpecHash) ?? optionalString(source.envSpecHash),
			pipelineRunName:
				optionalString(build.pipelineRunName) ?? optionalString(source.pipelineRunName),
			pipelineRunNamespace:
				optionalString(build.pipelineRunNamespace) ?? optionalString(source.pipelineRunNamespace),
			environmentStatus: status,
			status: optionalString(build.status) ?? status,
			latestActivityEvent: activity.latestEvent,
		};
	}

	function environmentBuildLookup(): EnvironmentBuildLookup | null {
		const source = executionEnvironmentBuildSourceData();
		const inputRecord = isRecord(input) ? input : null;
		const buildId = optionalString(source?.buildId);
		if (buildId) {
			return {
				key: `build:${buildId}`,
				kind: 'build',
				url: `/api/environment-builds/${encodeURIComponent(buildId)}/activity?sync=1`,
				instanceId: optionalString(inputRecord?.instanceId),
			};
		}
		const runId = optionalString(inputRecord?.runId);
		if (!runId) return null;
		const instanceId = optionalString(inputRecord?.instanceId);
		return {
			key: `run:${runId}:${instanceId ?? ''}`,
			kind: 'run',
			url: `/api/benchmarks/runs/${encodeURIComponent(runId)}/activity?sync=1`,
			instanceId,
		};
	}

	function normalizeEnvironmentBuildActivityPayload(
		payload: unknown,
		lookup: EnvironmentBuildLookup,
	): ExecutionEnvironmentBuildActivity | null {
		if (!isRecord(payload)) return null;
		if (lookup.kind === 'build') {
			if (!isRecord(payload.build)) return null;
			return {
				build: payload.build,
				events: Array.isArray(payload.events) ? payload.events.filter(isRecord) : [],
				latestEvent: isRecord(payload.latestEvent) ? payload.latestEvent : null,
			};
		}

		const instances = Array.isArray(payload.instances) ? payload.instances.filter(isRecord) : [];
		const group =
			instances.find((item) =>
				lookup.instanceId
					? optionalString(item.instanceId) === lookup.instanceId
					: isRecord(item.build),
			) ?? null;
		if (!group || !isRecord(group.build)) return null;
		return {
			build: group.build,
			events: Array.isArray(group.events) ? group.events.filter(isRecord) : [],
			latestEvent: isRecord(group.latestEvent) ? group.latestEvent : null,
		};
	}

	function withEnvironmentBuildNodeData(nodes: Node[]): Node[] {
		const build = executionEnvironmentBuildData();
		if (!build) return nodes;
		return nodes.map((node) => {
			const data = (node.data ?? {}) as Record<string, unknown>;
			const taskConfig = data.taskConfig as Record<string, unknown> | undefined;
			const isPrepareEnvironment =
				node.id === 'prepare_environment' ||
				node.id.endsWith('/prepare_environment') ||
				taskConfig?.call === 'environment/ensure';
			if (!isPrepareEnvironment) return node;
			return {
				...node,
				data: {
					...data,
					environmentBuild: build,
				},
			};
		});
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

	// Eagerly probe plan + code-checkpoint presence (cheap) once the run snapshot
	// loads, so the conditional Plan/Code tabs can show/hide without waiting for
	// the user to open them. Works for every run shape (SWE-bench/CLI runs don't
	// always populate `agentRuns`, but can still have code checkpoints / a plan).
	$effect(() => {
		if (!snapshot) return;
		if (!planTextLoaded) void loadPlanText();
		if (!planArtifactsLoaded) void loadPlanArtifacts();
		if (!codeCheckpointsLoaded) void loadCodeCheckpoints();
	});

	// Conditional run-tab visibility — hide tabs whose data this run lacks, so
	// simple runs aren't cluttered with empty Code/Plan/Browser/Agents tabs.
	const hasAgentsTab = $derived(agentRuns.length > 0);
	const hasBrowserTab = $derived(browserArtifacts.length > 0);
	const hasCodeTab = $derived(codeCheckpoints.length > 0);
	const hasPlanTab = $derived(displayPlanText != null || planArtifacts.length > 0);

	// Files tab gate: a lightweight summary fetch decides whether the run has
	// persisted output files or a live sandbox worth browsing. RunFilesTree
	// re-fetches its own data when the tab is opened.
	let filesSummary = $state<{ count: number; live: boolean; cli: boolean }>({
		count: 0,
		live: false,
		cli: false
	});
	$effect(() => {
		const id = executionId;
		if (!id) return;
		let cancelled = false;
		const load = async () => {
			try {
				const r = await fetch(`/api/workflows/executions/${id}/files`);
				if (!r.ok || cancelled) return;
				const d = await r.json();
				filesSummary = {
					count: Array.isArray(d.files) ? d.files.length : 0,
					live: !!d.liveSandbox,
					cli: !!d.cliWorkspace
				};
			} catch {
				/* transient */
			}
		};
		load();
		// While the run is active, re-poll so the Files tab appears as soon as a
		// workspace exists (a run that's still cloning has none yet). Stop once a
		// source is found or the run goes idle/terminal.
		const active = executionStatus === 'running' || executionStatus === 'pending';
		if (!active) return;
		const t = setInterval(() => {
			if (filesSummary.cli || filesSummary.live || filesSummary.count > 0) {
				clearInterval(t);
				return;
			}
			load();
		}, 15000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	});
	const hasFilesTab = $derived(filesSummary.count > 0 || filesSummary.live || filesSummary.cli);
	// Unified post-run live preview: which backend (if any) is previewable —
	// `cli` (JuiceFS execution-keyed pod) or `openshell` (retained dapr sandbox).
	// Resolved once from /preview-info so one Preview tab serves every runtime.
	let previewBackend = $state<string | null>(null);
	let previewBackendChecked = $state(false);
	$effect(() => {
		if (previewBackendChecked) return;
		previewBackendChecked = true;
		fetch(`/api/workflows/executions/${executionId}/preview-info`)
			.then((r) => (r.ok ? r.json() : null))
			.then((b) => {
				previewBackend = b?.backend ?? null;
			})
			.catch(() => {});
	});
	const hasPreviewTab = $derived(
		filesSummary.cli || previewBackend === 'cli' || previewBackend === 'openshell'
	);

	// Approval gate: while the run is active, poll whether it's parked at an
	// approval listen-gate (e.g. planGoal `goal_spec_approval`) and surface an
	// Approve button so it can advance from the UI (no manual API call needed).
	let approvalState = $state<{ awaiting: boolean; eventType?: string; nodeId?: string }>({
		awaiting: false
	});
	let approving = $state(false);
	$effect(() => {
		const id = executionId;
		const active = executionStatus === 'running' || executionStatus === 'pending';
		if (!id || !active) {
			approvalState = { awaiting: false };
			return;
		}
		let cancelled = false;
		const poll = async () => {
			try {
				const r = await fetch(`/api/workflows/executions/${id}/approval-state`);
				if (r.ok && !cancelled) approvalState = await r.json();
			} catch {
				/* transient */
			}
		};
		poll();
		const t = setInterval(poll, 10000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	});
	async function approveGoalSpec(): Promise<void> {
		if (approving) return;
		approving = true;
		try {
			const r = await fetch(`/api/workflows/executions/${executionId}/approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ eventType: approvalState.eventType })
			});
			if (r.ok) approvalState = { awaiting: false };
		} finally {
			approving = false;
		}
	}

	// If the active tab becomes hidden (or was a removed tab like the old
	// "steps"), fall back to the Live console so content never goes blank.
	$effect(() => {
		const hidden =
			activeTab === 'steps' ||
			(activeTab === 'agents' && !hasAgentsTab) ||
			(activeTab === 'browser' && !hasBrowserTab) ||
			(activeTab === 'code' && !hasCodeTab) ||
			(activeTab === 'plan' && !hasPlanTab) ||
			(activeTab === 'changes' && !hasChangesTab) ||
			(activeTab === 'preview' && !hasPreviewTab) ||
			(activeTab === 'files' && !hasFilesTab);
		if (hidden) activeTab = 'overview';
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
	const canvasNodes = $derived.by(() =>
		withEnvironmentBuildNodeData(withAgentNodeMetrics(workflowNodes, agentRuns, timelineEvents))
	);
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

	// Compact cockpit-header helpers (status badge variant + copy-id), inlined so
	// the header is one clean row instead of the old nested ExecutionHeader block.
	function runStatusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		const u = s.toUpperCase();
		if (u === 'RUNNING' || u === 'PENDING') return 'default';
		if (u === 'COMPLETED' || u === 'SUCCESS') return 'secondary';
		if (u === 'FAILED' || u === 'ERROR') return 'destructive';
		return 'outline';
	}
	let execIdCopied = $state(false);
	async function copyExecId() {
		try {
			await navigator.clipboard.writeText(executionId);
			execIdCopied = true;
			setTimeout(() => (execIdCopied = false), 1500);
		} catch {
			// clipboard unavailable
		}
	}

	let stopBusy = $state(false);
	// "stopping" = the stop was accepted (202) but the durable terminate is still
	// converging (e.g. a long activity applies terminate late). Poll until confirmed.
	let stopConverging = $state(false);
	// Set when this execution is actually a benchmark/eval instance driven by a
	// coordinator — hides the futile generic Stop and links to the owning run.
	let coordinatorOwner = $state<{ kind: 'benchmarkRun' | 'evalRun'; runId: string } | null>(
		null
	);
	async function pollStopStatus() {
		// Up to ~5 min, every 3s; the reaper is the backstop if the tab closes.
		for (let i = 0; i < 100 && stopConverging; i++) {
			await new Promise((r) => setTimeout(r, 3000));
			try {
				const res = await fetch(`/api/workflows/executions/${executionId}/stop/status`);
				if (!res.ok) break;
				const b = (await res.json().catch(() => ({}))) as { state?: string };
				if (b?.state === 'confirmed' || b?.state === 'notFound') break;
			} catch {
				/* transient — keep polling */
			}
		}
		stopConverging = false;
	}
	async function stopRun(mode: 'terminate' | 'purge') {
		if (stopBusy || stopConverging) return;
		if (
			!confirm(
				mode === 'purge'
					? 'Stop & purge this run? Terminates it, purges durable state, and reaps per-session sandboxes.'
					: 'Stop this run? Terminates the durable run and its per-session children.'
			)
		)
			return;
		stopBusy = true;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/stop`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode })
			});
			const b = (await res.json().catch(() => ({}))) as {
				error?: string;
				state?: string;
				ownedBy?: 'benchmarkRun' | 'evalRun';
				runId?: string;
				message?: string;
			};
			if (res.status === 409 && b?.error === 'coordinator_owned' && b.ownedBy && b.runId) {
				// Reactive fallback if the proactive hide didn't catch it.
				coordinatorOwner = { kind: b.ownedBy, runId: b.runId };
				alert(b.message ?? 'Stop this run from its benchmark/evaluation run.');
			} else if (res.status === 202 || b?.state === 'stopping') {
				// Accepted + converging — show "Stopping…" and poll to confirmation.
				stopConverging = true;
				void pollStopStatus();
			} else if (!res.ok) {
				alert(`Stop did not confirm (HTTP ${res.status}) — retry or check the run.`);
			}
		} finally {
			stopBusy = false;
		}
	}
	// --- Resume from a failed/terminal node (node-aware Dapr rerun-from-event) ---
	let resumeBusy = $state(false);
	// The run this one was forked/resumed from (rerun lineage) — drives the
	// "Forked from" context banner. Set from the execution row on load.
	let forkedFromExecutionId = $state<string | null>(null);
	const isTerminalFailed = $derived(
		['error', 'failed', 'cancelled', 'canceled'].includes(executionStatus.toLowerCase())
	);
	const isTerminalSuccess = $derived(
		['success', 'completed'].includes(executionStatus.toLowerCase())
	);
	// Resume (recover) framing for failed runs, fork (iterate) framing for successful
	// ones — same mechanism, surfaced on ANY terminal run.
	const isTerminal = $derived(isTerminalFailed || isTerminalSuccess);
	const resumeVerb = $derived(isTerminalFailed ? 'Resume' : 'Fork');
	// Top-level node NAMES in canvas order, for the "Resume/Fork from: <node>" picker.
	// Canvas ids are "/do/<i>/<name>"; the orchestrator + resume API key on the bare
	// node name (the spec `do` key / update_execution_node nodeId), so strip the prefix.
	const resumableNodeIds = $derived(
		workflowNodeIds
			.filter((id) => id && id !== '__start__' && id !== '__end__')
			.map((id) => id.split('/').filter(Boolean).pop() ?? id)
			.filter((name, i, arr) => name && arr.indexOf(name) === i)
	);
	// Resume/fork preview dialog (replaces a blocking native confirm). `null` node = auto
	// (the failed step). The dialog previews which steps are skipped vs re-run.
	let resumeDialogOpen = $state(false);
	let resumeDialogNode = $state<string | null>(null);
	let resumeError = $state<string | null>(null);
	// Fork-lineage tree (ancestors + every fork), revealed from the lineage bar.
	let lineageOpen = $state(false);
	// Per-branch spec diff (this fork vs its parent), revealed from the lineage bar.
	let diffOpen = $state(false);
	// Effective node being resumed from: explicit pick, else the in-flight (failed) node.
	const resumeEffectiveNode = $derived(
		resumeDialogNode ?? snapshot?.currentNodeId ?? resumableNodeIds[0] ?? null
	);
	const resumeSplit = $derived.by(() => {
		const idx = resumeEffectiveNode ? resumableNodeIds.indexOf(resumeEffectiveNode) : -1;
		if (idx < 0) return { skipped: [] as string[], rerun: resumableNodeIds };
		return { skipped: resumableNodeIds.slice(0, idx), rerun: resumableNodeIds.slice(idx) };
	});
	function openResume(fromNodeId?: string) {
		resumeDialogNode = fromNodeId ?? null;
		resumeError = null;
		resumeDialogOpen = true;
	}
	async function confirmResume() {
		if (resumeBusy) return;
		resumeBusy = true;
		resumeError = null;
		try {
			const r = await forkRun(executionId, resumeDialogNode);
			if (!r.ok || !r.executionId) {
				resumeError = r.error ?? 'Request failed';
				return;
			}
			resumeDialogOpen = false;
			await goto(`/workspaces/${slug}/workflows/${workflowId}/runs/${r.executionId}`);
		} finally {
			resumeBusy = false;
		}
	}

	let allTimelineItems = $derived(buildTimelineItems(significantTimelineEvents, { isRunning }));

	// Collect unique URLs the agent visited (from browser-use tool_result events)
	// so the Overview tab can render a consolidated "sources" list.
	let browserSources = $derived.by(() => {
		const seen = new Map<string, { url: string; stepNumber?: number; title: string }>();
		for (const item of allTimelineItems) {
			if (item.kind !== 'tool' || !item.url) continue;
			if (seen.has(item.url)) continue;
			try {
				const u = new URL(item.url);
				const title = `${u.hostname}${u.pathname !== '/' ? u.pathname : ''}${u.hash || ''}`;
				seen.set(item.url, { url: item.url, stepNumber: item.stepNumber, title });
			} catch {
				seen.set(item.url, { url: item.url, stepNumber: item.stepNumber, title: item.url });
			}
		}
		return Array.from(seen.values());
	});

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
			const [workflowRes, executionRes] = await Promise.all([
				fetch(`/api/workflows/${workflowId}`),
				fetch(`/api/workflows/executions/${encodeURIComponent(executionId)}`)
			]);
			if (!workflowRes.ok) throw new Error('Failed to load workflow');
			const workflowData = await workflowRes.json();
			workflowName = workflowData.name ?? '';

			let renderedFromExecutionSpec = false;
			if (executionRes.ok) {
				const executionData = await executionRes.json();
				coordinatorOwner = executionData?.owner ?? null;
				forkedFromExecutionId =
					typeof executionData?.rerunOfExecutionId === 'string'
						? executionData.rerunOfExecutionId
						: null;
				const ir = executionData?.executionIr;
				if (
					executionData?.executionIrVersion === 'dynamic-script-1' ||
					(ir && typeof ir === 'object' && (ir as Record<string, unknown>).engine === 'dynamic-script')
				) {
					isDynamicScript = true;
					scriptExecutionIr = (ir ?? null) as Record<string, unknown> | null;
					renderedFromExecutionSpec = true;
				}
				const spec = executionData?.executionIr?.spec;
				if (!isDynamicScript && spec && typeof spec === 'object' && !Array.isArray(spec)) {
					const graph = specToGraph(spec as Record<string, unknown>, {});
					if (graph) {
						workflowNodes = graph.nodes;
						workflowEdges = graph.edges;
						renderedFromExecutionSpec = true;
					}
				}
			}

			if (!renderedFromExecutionSpec) {
				workflowNodes = workflowData.nodes ?? [];
				workflowEdges = workflowData.edges ?? [];
			}
		} catch {
			// Leave canvas empty on error
		} finally {
			isLoadingWorkflow = false;
		}
	}

	async function fetchInvestigation() {
		if (investigationFetched || !executionId) return;
		investigationFetched = true;
		isLoadingInvestigation = true;
		investigationError = null;
		try {
			let res = await fetch(`/api/observability/executions/${encodeURIComponent(executionId)}/investigation`);
			if (!res.ok && res.status === 404 && investigationSessionId) {
				res = await fetch(`/api/observability/sessions/${encodeURIComponent(investigationSessionId)}/investigation`);
			}
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
		if (activeTab === 'trace' && executionId && !investigationFetched) {
			fetchInvestigation();
		}
	});

	$effect(() => {
		if (executionId === investigationExecutionId) return;
		investigationExecutionId = executionId;
		investigationFetched = false;
		investigationPayload = null;
		investigationError = null;
	});

	// (Spawned-session listing now lives in the RunConsole component on the Live
	// tab, which owns its own sessions fetch + per-session preview streams.)

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

	$effect(() => {
		const lookup = environmentBuildLookup();
		if (!lookup) {
			environmentBuildActivity = null;
			environmentBuildActivityKey = null;
			return;
		}
		if (untrack(() => environmentBuildActivityKey) !== lookup.key) {
			environmentBuildActivity = null;
			environmentBuildActivityKey = lookup.key;
		}
		const activeLookup = lookup;

		let cancelled = false;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		let controller: AbortController | null = null;

		async function pollBuildActivity() {
			controller?.abort();
			controller = new AbortController();
			try {
				const response = await fetch(activeLookup.url, { signal: controller.signal });
				if (response.ok) {
					const activity = normalizeEnvironmentBuildActivityPayload(
						await response.json(),
						activeLookup,
					);
					if (!cancelled && activity) {
						environmentBuildActivity = activity;
						const status = optionalString(activity.build.status);
						if (status && TERMINAL_ENVIRONMENT_BUILD_STATUSES.has(status)) return;
					}
				}
			} catch {
				/* Benchmark execution streams should stay usable if activity polling fails. */
			}
			if (!cancelled) {
				timeout = setTimeout(pollBuildActivity, ENVIRONMENT_BUILD_ACTIVITY_POLL_MS);
			}
		}

		pollBuildActivity();
		return () => {
			cancelled = true;
			if (timeout) clearTimeout(timeout);
			controller?.abort();
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
			case 'agent.context_usage':
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

	function runtimePreviewPath(targetExecutionId: string, queryString = ''): string {
		const base = slug
			? `/workspaces/${encodeURIComponent(slug)}/workflows/runtime-preview/${encodeURIComponent(targetExecutionId)}`
			: `/workflows/runtime-preview/${encodeURIComponent(targetExecutionId)}`;
		return queryString ? `${base}?${queryString}` : base;
	}

	function browserAppPreviewUrl(artifact: BrowserArtifact): string {
		// The runtime-preview proxy resolves a retained workspace sandbox
		// (workflow_workspace_sessions row). Browser-use runs navigate the
		// live internet via Browserstation — they have no sandbox to proxy,
		// so the link would 404. Surface only the inline video/screenshots
		// for those artifacts.
		const agentRuntime = metadataText(artifact, 'agentRuntime');
		if (agentRuntime === 'browser-use-agent') return '';

		const repoPath = metadataText(artifact, 'requestedRepoPath');
		const baseUrl = metadataText(artifact, 'requestedBaseUrl') || artifact.manifestJson.baseUrl;
		if (!repoPath && !baseUrl) return '';

		const params = new URLSearchParams();
		params.set('previewId', artifact.id);
		if (repoPath) params.set('repoPath', repoPath);
		if (baseUrl) {
			params.set('baseUrl', baseUrl);
			// Only forward an explicit devServerCommand if the artifact captured
			// one. Otherwise let the runtime auto-detect via _local_devserver_runner
			// (next.config -> next dev, package.json -> npm/pnpm/yarn run dev,
			// index.html -> python3 -m http.server). Forcing `npm run dev` here
			// breaks static sites (no package.json -> npm ENOENT).
			const command =
				metadataText(artifact, 'requestedDevServerCommand') ||
				metadataText(artifact, 'devServerCommand');
			if (command) params.set('devServerCommand', command);
		}
		params.set('timeoutSeconds', '7200');
		return runtimePreviewPath(executionId, params.toString());
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

		return runtimePreviewPath(executionId, params.toString());
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
		return sandboxKept ? runtimePreviewPath(executionId) : '';
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
		if (nodeData?.environmentBuild && isRecord(input)) {
			const runId = optionalString(input.runId);
			const benchmarkInstanceId = optionalString(input.instanceId);
			if (runId) {
				const instanceQuery = benchmarkInstanceId
					? `&instance=${encodeURIComponent(benchmarkInstanceId)}`
					: '';
				goto(`/workspaces/${slug}/benchmarks?run=${encodeURIComponent(runId)}${instanceQuery}`);
				return;
			}
		}
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

<svelte:window onkeydown={handleCockpitKey} />

<div class="flex h-full flex-col">
	<!-- Header -->
	<header class="flex h-12 items-center gap-3 border-b border-border px-4">
		<Breadcrumb.Root>
			<Breadcrumb.List class="gap-1 text-xs">
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/workspaces/{slug}/workflows" class="text-xs">Workflows</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<!-- Switch WORKFLOW (Running / Recent) without leaving the pane -->
					<WorkflowQuickSwitcher
						{slug}
						currentWorkflowId={workflowId}
						currentWorkflowName={workflowName}
						variant="run"
					/>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<!-- Switch RUN of the current workflow -->
					<RunQuickSwitcher {slug} {workflowId} currentExecutionId={executionId} />
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>

		<Separator orientation="vertical" class="h-5" />

		<!-- Compact status cluster: badge + duration + started + live dot. -->
		<div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
			<Badge variant={runStatusVariant(executionStatus)} class="flex shrink-0 items-center gap-1">
				{#if isRunning}
					<Loader2 size={11} class="animate-spin" />
				{:else if executionStatus.toLowerCase() === 'success' || executionStatus.toLowerCase() === 'completed'}
					<CheckCircle2 size={11} />
				{:else if executionStatus.toLowerCase() === 'error' || executionStatus.toLowerCase() === 'failed'}
					<XCircle size={11} />
				{:else}
					<Clock size={11} />
				{/if}
				{executionStatus}
			</Badge>
			{#if duration}
				<span class="whitespace-nowrap"><Clock size={11} class="mr-0.5 inline" />{duration}</span>
			{/if}
			{#if relativeStart}
				<span class="hidden whitespace-nowrap md:inline">· {relativeStart}</span>
			{/if}
			{#if executionState.isConnected}
				<span class="flex items-center gap-1">
					<span class="size-1.5 animate-pulse rounded-full bg-green-500"></span>Live
				</span>
			{/if}
		</div>

		<div class="ml-auto flex items-center gap-1 text-xs">
			<!-- Prev / Next sibling runs. The full run list lives in the breadcrumb
			     RunQuickSwitcher; these are quick step affordances. Keyboard `[` / `]`
			     also wired via handleCockpitKey. -->
			<Button
				variant="ghost"
				size="icon"
				class="size-7"
				disabled={!canPrevRun}
				onclick={prevRun}
				title="Previous run (older) — [">
				<ChevronLeft class="size-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				class="size-7"
				disabled={!canNextRun}
				onclick={nextRun}
				title="Next run (newer) — ]">
				<ChevronRight class="size-3.5" />
			</Button>
			{#if isRunning && coordinatorOwner}
				<!-- Coordinator-owned (benchmark/eval instance): the generic per-execution
				     Stop is futile — its run coordinator re-drives it. Point at the run. -->
				<Button
					variant="outline"
					size="sm"
					class="h-7 gap-1"
					href={coordinatorOwner.kind === 'benchmarkRun'
						? `/workspaces/${slug}/benchmarks?run=${encodeURIComponent(coordinatorOwner.runId)}`
						: `/workspaces/${slug}/evaluations`}
					title={`This run is driven by its ${coordinatorOwner.kind === 'benchmarkRun' ? 'benchmark' : 'evaluation'} run — stop it there`}
				>
					Managed by {coordinatorOwner.kind === 'benchmarkRun' ? 'benchmark' : 'evaluation'} run →
				</Button>
			{:else if isRunning}
				<Button
					variant="destructive"
					size="sm"
					class="h-7 gap-1"
					onclick={() => stopRun('terminate')}
					disabled={stopBusy || stopConverging}
					title="Terminate this run and its per-session children"
				>
					{stopBusy || stopConverging ? 'Stopping…' : 'Stop run'}
				</Button>
			{:else if isTerminal}
				<!-- Resume/fork from a step: earlier steps are skipped + their workspace is
				     reused; only the chosen step onward re-runs with the CURRENT workflow.
				     Failed runs get a recover-framed split button (resume from the failed
				     step + node picker); successful runs get an iterate-framed picker. -->
				{#snippet resumePicker()}
					<DropdownMenu.Content align="end" class="max-h-96 w-72 overflow-auto">
						<DropdownMenu.Label class="text-xs font-semibold">
							{resumeVerb} from a step
						</DropdownMenu.Label>
						<p class="px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground">
							Earlier steps are skipped and an isolated copy of this run's workspace is
							used — only the chosen step onward re-runs with the current workflow.
						</p>
						<DropdownMenu.Separator />
						{#each resumableNodeIds as nodeId, i (nodeId)}
							<DropdownMenu.Item onSelect={() => openResume(nodeId)} class="gap-2">
								<span
									class="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground"
									>{i + 1}</span
								>
								<code class="min-w-0 flex-1 truncate text-xs">{nodeId}</code>
								{#if isTerminalFailed && nodeId === snapshot?.currentNodeId}
									<span class="shrink-0 text-[9px] font-medium text-red-500">failed here</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				{/snippet}
				{#if isTerminalFailed}
					<div class="flex items-center">
						<Button
							variant="outline"
							size="sm"
							class="h-7 gap-1 rounded-r-none border-r-0"
							onclick={() => openResume()}
							disabled={resumeBusy}
							title="Resume from the failed step — earlier steps are skipped and the workspace reused; the failed node onward re-runs with the current workflow"
						>
							<RefreshCw class="size-3.5 {resumeBusy ? 'animate-spin' : ''}" />
							{resumeBusy ? 'Resuming…' : 'Resume from failed step'}
						</Button>
						{#if resumableNodeIds.length}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="outline"
											size="sm"
											class="h-7 rounded-l-none px-1"
											disabled={resumeBusy}
											title="Resume from a specific step"
										>
											<ChevronDown class="size-3.5" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								{@render resumePicker()}
							</DropdownMenu.Root>
						{/if}
					</div>
				{:else if resumableNodeIds.length}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="outline"
									size="sm"
									class="h-7 gap-1"
									disabled={resumeBusy}
									title="Fork this run from a step to iterate — earlier steps are reused, only the chosen step onward re-runs with your current edits"
								>
									<GitFork class="size-3.5 {resumeBusy ? 'animate-pulse' : ''}" />
									{resumeBusy ? 'Forking…' : 'Fork from step'}
									<ChevronDown class="size-3.5 opacity-70" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						{@render resumePicker()}
					</DropdownMenu.Root>
				{/if}
			{/if}
			<Separator orientation="vertical" class="mx-1 h-5" />
			<a
				href={`/workspaces/${slug}/workflows/${workflowId}`}
				class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
				title="Open the workflow editor"
			>
				<PencilLine class="size-3.5" /> Editor
			</a>
			<Button
				variant="default"
				size="sm"
				class="h-7 gap-1"
				onclick={() => goto(`/workspaces/${slug}/workflows/${workflowId}?execute=1`)}
				title="Submit a new run of this workflow (opens the Execute dialog in the editor)"
			>
				<Play class="size-3.5" /> Submit new run
			</Button>

			<!-- Overflow: secondary / niche actions tucked away to de-noise the bar. -->
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon" class="size-7" title="More actions">
							<Ellipsis class="size-4" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-60">
					<DropdownMenu.Item onSelect={copyExecId}>
						{#if execIdCopied}
							<Check class="size-3.5 text-green-500" />
						{:else}
							<Copy class="size-3.5" />
						{/if}
						Copy execution ID
					</DropdownMenu.Item>
					{#if traceId}
						<DropdownMenu.Item onSelect={() => goto(`/observability/${traceId}`)}>
							<ExternalLink class="size-3.5" /> View full trace
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item
						onSelect={() =>
							goto(
								`/workspaces/${slug}/service-graph?mode=${isDynamicScript ? 'step' : 'service'}&scope=execution&executionId=${executionId}`
							)}
					>
						<Waypoints class="size-3.5" /> Service graph for this run
					</DropdownMenu.Item>
					{#if instanceId}
						<DropdownMenu.Separator />
						<DropdownMenu.Label class="text-[10px] font-normal text-muted-foreground">
							Dapr instance: <code class="text-[10px]">{instanceId.slice(0, 16)}</code>
						</DropdownMenu.Label>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</header>

	{#if forkedFromExecutionId || isTerminal}
		<!-- Fork lineage bar: this run's place in the fork family. Forks are
		     first-class — the bar names the source run (if forked) and expands the
		     full lineage tree (ancestors + every fork) for navigation + re-forking. -->
		<div class="border-b border-border bg-muted/40 text-xs text-muted-foreground">
			<div class="flex items-center gap-2 px-4 py-1.5">
				<GitFork class="size-3.5 shrink-0 text-primary" />
				<span class="min-w-0 flex-1 truncate">
					{#if forkedFromExecutionId}
						Forked from an earlier run — skipped steps were reused from its workspace and show as
						<span class="font-medium">inherited</span> activity.
					{:else}
						This run can be forked from any completed step — branches reuse its workspace.
					{/if}
				</span>
				{#if forkedFromExecutionId}
					<a
						class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
						href={`/workspaces/${slug}/workflows/${workflowId}/runs/${forkedFromExecutionId}`}
					>
						View source run <ChevronRight class="size-3" />
					</a>
				{/if}
				{#if forkedFromExecutionId}
					<button
						class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
						onclick={() => (diffOpen = !diffOpen)}
					>
						Diff vs parent
						<ChevronDown class="size-3 transition-transform {diffOpen ? 'rotate-180' : ''}" />
					</button>
				{/if}
				<button
					class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
					onclick={() => (lineageOpen = !lineageOpen)}
				>
					Fork lineage
					<ChevronDown class="size-3 transition-transform {lineageOpen ? 'rotate-180' : ''}" />
				</button>
			</div>
			{#if diffOpen}
				<div class="max-h-96 overflow-y-auto border-t border-border bg-background">
					<ForkSpecDiff {executionId} />
				</div>
			{/if}
			{#if lineageOpen}
				<div class="max-h-72 overflow-y-auto border-t border-border bg-background">
					<RunLineageTree {executionId} {slug} {workflowId} onFork={() => openResume()} />
				</div>
			{/if}
		</div>
	{/if}

	<!-- Run-level flow progress as a PERSISTENT header on every tab — constant
	     position so switching tabs never shifts the tab bar or content (the Live
	     console no longer renders its own band; it keeps only the metrics cards). -->
	<RunProgressBand
		nodes={workflowNodes}
		edges={workflowEdges}
		{snapshot}
		activeToolName={executionState.activeToolName}
		isStreaming={executionState.isLlmStreaming}
		tokensPerSec={pageTokensPerSec}
		runActive={isRunning}
	/>

	<!-- Approval banner: full-width, ABOVE the body row (must not be a flex-row
	     child of the body, or items-stretch blows it up to full height). -->
	{#if approvalState.awaiting}
		<div class="shrink-0 border-b border-amber-300/70 bg-amber-50 px-4 py-2.5 dark:border-amber-800/70 dark:bg-amber-950/30">
			<div class="mx-auto flex max-w-5xl items-center gap-3">
				<Clock class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
				<div class="min-w-0 flex-1 text-sm">
					<span class="font-medium text-amber-900 dark:text-amber-200">Approval required</span>
					<span class="text-amber-800/80 dark:text-amber-200/70">
						— paused at
						<code class="rounded bg-amber-100 px-1 text-xs dark:bg-amber-900/40">{approvalState.nodeId}</code>
						for you to approve the drafted goal spec.
					</span>
				</div>
				<Button
					size="sm"
					class="h-8 shrink-0 bg-amber-600 text-white hover:bg-amber-700"
					onclick={approveGoalSpec}
					disabled={approving}
				>
					{#if approving}<Loader2 class="size-3.5 animate-spin" />{:else}<Check class="size-3.5" />{/if}
					{approving ? 'Approving…' : 'Approve'}
				</Button>
			</div>
		</div>
	{/if}

	<!-- Body: Other Runs panel on the left (collapsible), tabbed content on the right. -->
	<div class="flex flex-1 overflow-hidden">
		<Tabs bind:value={activeTab} class="flex flex-1 flex-col overflow-hidden">
		<div class="border-b border-border px-4">
			<TabsList class="h-10">
				<TabsTrigger value="overview">Live</TabsTrigger>
				<TabsTrigger value="outputs">Outputs{#if outputArtifacts.length > 0}<span class="ml-1.5 text-xs text-muted-foreground">{outputArtifacts.length}</span>{/if}</TabsTrigger>
				{#if hasChangesTab}<TabsTrigger value="changes">Changes<span class="ml-1.5 text-xs text-muted-foreground">{diffArtifacts.length}</span></TabsTrigger>{/if}
				<TabsTrigger value="timeline">Timeline</TabsTrigger>
				<TabsTrigger value="canvas">Canvas</TabsTrigger>
				{#if hasCodeTab}<TabsTrigger value="code">Code</TabsTrigger>{/if}
				{#if hasPlanTab}<TabsTrigger value="plan">Plan</TabsTrigger>{/if}
				{#if hasAgentsTab}<TabsTrigger value="agents">Agents</TabsTrigger>{/if}
				{#if hasBrowserTab}<TabsTrigger value="browser">Browser</TabsTrigger>{/if}
				{#if hasFilesTab}<TabsTrigger value="files">Files{#if filesSummary.count > 0}<span class="ml-1.5 text-xs text-muted-foreground">{filesSummary.count}</span>{/if}</TabsTrigger>{/if}
				{#if hasPreviewTab}<TabsTrigger value="preview">Preview</TabsTrigger>{/if}
				<TabsTrigger value="graph">Graph</TabsTrigger>
				<TabsTrigger value="trace">Trace</TabsTrigger>
			</TabsList>
		</div>

		<!-- Tab 1: Overview -->
		<TabsContent value="overview" class="flex-1 overflow-hidden p-0">
			<RunConsole {executionId} {slug} {workflowId} nodes={workflowNodes} edges={workflowEdges} focusNode={deepLinkNode} scriptIr={isDynamicScript ? scriptExecutionIr : null}>
				{#snippet details()}
				{#if primaryAppPreviewUrl}
					<Card>
						<CardContent class="flex flex-wrap items-center justify-between gap-3 p-4">
							<div>
								<p class="text-sm font-medium">Live preview available</p>
								<p class="text-sm text-muted-foreground">
									This run kept its workspace alive — open the <strong>Preview</strong> tab to interact with the built app.
								</p>
							</div>
							<button
								type="button"
								class="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
								onclick={() => (activeTab = 'preview')}
							>
								<ExternalLink size={14} />
								Open Preview tab
							</button>
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

				{#if browserSources.length > 0}
					<Card>
						<CardContent class="space-y-3 p-4">
							<Sources>
								<SourcesTrigger count={browserSources.length} />
								<SourcesContent>
									{#each browserSources as src (src.url)}
										<Source href={src.url} title={src.stepNumber !== undefined ? `Step ${src.stepNumber} · ${src.title}` : src.title} />
									{/each}
								</SourcesContent>
							</Sources>
						</CardContent>
					</Card>
				{/if}

				{#if primaryArtifacts.length > 0}
					<ArtifactList artifacts={primaryArtifacts} mode="primary" {executionId} />
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
							<JsonViewer data={output} label="Output" collapsed={primaryArtifacts.length > 0} />
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

				{/snippet}
			</RunConsole>
		</TabsContent>

		<!-- Tab: Outputs (generic workflow_artifacts) -->
		<TabsContent value="outputs" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-5xl space-y-4">
				<ArtifactList artifacts={outputArtifacts} mode="all" {executionId} />
			</div>
		</TabsContent>

		<!-- Tab: Changes (per-node workspace diffs — the agent's impact) -->
		{#if hasChangesTab}
			<TabsContent value="changes" class="flex-1 overflow-y-auto p-4">
				<div class="mx-auto max-w-5xl">
					<RunChanges artifacts={diffArtifacts} {executionId} />
				</div>
			</TabsContent>
		{/if}

		<!-- Tab: Files (live workspace tree + persisted output files) -->
		<TabsContent value="files" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-5xl">
				{#if activeTab === 'files'}
					<RunFilesTree {executionId} />
				{/if}
			</div>
		</TabsContent>

		<!-- Tab: Preview (unified post-run live preview — CLI/juicefs + dapr/openshell) -->
		<TabsContent value="preview" class="flex-1 overflow-hidden p-0">
			{#if activeTab === 'preview'}
				<ExecutionPreview {executionId} />
			{/if}
		</TabsContent>

		<!-- Tab 2: Steps -->
		<!-- Tab: Timeline -->
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
							<!-- Current context-window usage. Prefer active Dapr-state
							     context, then fall back to latest provider usage. -->
							{#if usedTokens > 0}
								<div class="h-3 w-px bg-border"></div>
								<Context {usedTokens} {maxTokens} {usage} modelId={contextModel}>
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
												{contextModel}
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
						<div class="sticky top-0 z-10 mb-2 flex w-full max-w-none items-center gap-1 rounded-md border bg-background/95 px-2 py-1.5 backdrop-blur">
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
						<ChatContainerContent class="w-full max-w-none divide-y divide-border/60 rounded-lg border bg-card/40 shadow-sm">
							{#each timelineItems as item, i (item.key)}
								{@const turnAnchor = turnNav.byKey.get(item.key)}
								<div
									class="px-4 py-3 md:px-5"
									data-turn-anchor={turnAnchor ?? undefined}
								>
								{#if item.kind === 'tool'}
									<div class="flex flex-col gap-2">
										<ToolEventRenderer
											pair={{ start: item.startEvent, end: item.endEvent }}
											toolNameOverride={item.toolName}
											argsOverride={item.args}
											stateOverride={item.status === 'unknown' ? 'error' : item.status}
											variant="card"
										/>
										{#if item.imageUrl}
											<figure class="flex flex-col gap-1 rounded-md border border-border/40 bg-muted/20 p-2">
												<img
													src={item.imageUrl}
													alt={`Browser state after step ${item.stepNumber ?? ''}`}
													loading="lazy"
													class="max-h-[360px] w-full max-w-[720px] rounded border border-border/30 object-contain"
												/>
												{#if item.stepNumber !== undefined || item.url}
													<figcaption class="text-[11px] text-muted-foreground">
														{#if item.stepNumber !== undefined}Step {item.stepNumber}{/if}
														{#if item.stepNumber !== undefined && item.url} · {/if}
														{#if item.url}<span class="truncate">{item.url}</span>{/if}
													</figcaption>
												{/if}
											</figure>
										{/if}
									</div>
								{:else}
									<EventRenderer event={item.event} variant="card" {agentModel} />
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
			{:else if isDynamicScript}
				<ScriptRunPanel
					{executionId}
					{slug}
					executionIr={scriptExecutionIr}
					currentPhase={executionState.currentPhase ?? null}
					{isRunning}
				/>
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
											<!-- Video assets are rendered ONCE by the dedicated player
											     below (which owns caption tracks + Download); the loop
											     only surfaces non-video assets (trace/caption links). -->
											{#if asset.kind === 'trace' || asset.kind === 'caption'}
												<a
													class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
													href={browserBlobUrl(asset.storageRef)}
													target="_blank"
													rel="noreferrer"
												>
													{#if asset.kind === 'trace'}
														<FileArchive size={12} />
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
											<!-- R1 persisted recording: the single inline player for the
											     captured browser session (Playwright-native .webm). Owns
											     caption tracks + the Download affordance. -->
											<figure class="flex w-full flex-col gap-1">
												<!-- svelte-ignore a11y_media_has_caption -->
												<video
													class="w-full overflow-hidden rounded-lg border border-border bg-black"
													src={browserBlobUrl(primaryVideoAsset(artifact)?.storageRef ?? '')}
													controls
													preload="metadata"
													playsinline
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
												<figcaption class="flex items-center gap-1 text-xs text-muted-foreground">
													<Video size={12} />
													{primaryVideoAsset(artifact)?.label ?? 'Browser session recording'}
													<a
														class="ml-auto hover:text-foreground hover:underline"
														href={browserBlobUrl(primaryVideoAsset(artifact)?.storageRef ?? '')}
														target="_blank"
														rel="noreferrer">Download</a
													>
												</figcaption>
											</figure>
											{#if primaryVideoAsset(artifact)?.kind === 'video-annotated' && rawVideoAsset(artifact)?.storageRef}
												<a
													class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
													href={browserBlobUrl(rawVideoAsset(artifact)?.storageRef ?? '')}
													target="_blank"
													rel="noreferrer"
												>
													<Video size={12} />
													Download raw (unannotated) recording
												</a>
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
		<!-- Tab: Graph — the run's service graph (flow lens auto-detects
		     dynamic-script journals vs SW steps; live-polls while running). -->
		<TabsContent value="graph" class="flex-1 overflow-hidden">
			<ServiceGraphRunView {executionId} active={isRunning} />
		</TabsContent>

		<TabsContent value="trace" class="flex-1 overflow-y-auto px-4 py-4 xl:px-5 2xl:px-6">
			<div class="w-full">
				<InvestigationStudio
					payload={investigationPayload}
					isLoading={isLoadingInvestigation}
					error={investigationError}
					fullTraceHref={primaryInvestigationTraceId ? `/observability/${primaryInvestigationTraceId}` : null}
					onRefresh={() => {
						investigationFetched = false;
						fetchInvestigation();
					}}
				/>
			</div>
	</TabsContent>
</Tabs>
	</div>
</div>

<!-- Resume/fork preview — replaces a blocking native confirm() with an in-app modal
     that previews which steps are skipped (reused) vs re-run before forking. -->
<ForkDialog
	bind:open={resumeDialogOpen}
	verb={resumeVerb}
	effectiveNode={resumeEffectiveNode}
	skipped={resumeSplit.skipped}
	rerun={resumeSplit.rerun}
	busy={resumeBusy}
	error={resumeError}
	onConfirm={confirmResume}
/>
