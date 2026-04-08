<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import {
		SvelteFlow,
		MiniMap,
		Background,
		BackgroundVariant,
		type NodeTypes,
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
		FileArchive
	} from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Separator } from '$lib/components/ui/separator';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Card, CardContent } from '$lib/components/ui/card';
	import {
		createExecutionStream,
		type ExecutionStreamStore
	} from '$lib/stores/execution-stream.svelte';
	import ExecutionHeader from '$lib/components/workflow/execution/execution-header.svelte';
	import JsonViewer from '$lib/components/workflow/execution/json-viewer.svelte';
	import StepDetail from '$lib/components/workflow/execution/step-detail.svelte';
	import InvestigationStudio from '$lib/components/observability/investigation-studio.svelte';
	import type { ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';

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
	import DefaultNode from '$lib/components/workflow/nodes/default-node.svelte';

	let workflowId = $derived(page.params.workflowId);
	let executionId = $derived(page.params.executionId ?? '');

	// Workflow canvas data
	let nodes = $state<Node[]>([]);
	let edges = $state<Edge[]>([]);

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
	let previewActionPending = $state(false);
	let previewActionMessage = $state<string | null>(null);
	let previewActionError = $state<string | null>(null);

	// Active tab
	let activeTab = $state('overview');

	// Loading
	let isLoadingWorkflow = $state(true);

	// Execution stream
	let executionStream: ExecutionStreamStore = createExecutionStream('');
	let timelineRef = $state<HTMLDivElement | null>(null);

	const executionState = $derived($executionStream);
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
	const browserArtifactError = $derived(executionState.error);
	const isLoadingStatus = $derived(!snapshot && !executionState.error);
	const isLoadingLogs = $derived(isLoadingStatus);
	const isLoadingBrowserArtifacts = $derived(isLoadingStatus);

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
		default: DefaultNode
	} satisfies NodeTypes;

	const isRunning = $derived(['running', 'pending'].includes(executionStatus.toLowerCase()));

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
			nodes = data.nodes ?? [];
			edges = data.edges ?? [];
		} catch {
			// Leave canvas empty on error
		} finally {
			isLoadingWorkflow = false;
		}
	}

	async function fetchInvestigation() {
		if (investigationFetched) return;
		investigationFetched = true;
		isLoadingInvestigation = true;
		investigationError = null;
		try {
			const res = await fetch(`/api/observability/sessions/${encodeURIComponent(executionId)}/investigation`);
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
		if (activeTab === 'trace' && !investigationFetched) {
			fetchInvestigation();
		}
	});

	// Apply node statuses to canvas nodes
	$effect(() => {
		const statuses = nodeStatuses;
		if (Object.keys(statuses).length === 0) return;
		const currentNodes = untrack(() => nodes);
		nodes = currentNodes.map((n) => {
			const status = statuses[n.id];
			if (status && n.data.status !== status) {
				return { ...n, data: { ...n.data, status } };
			}
			return n;
		});
	});

	// Auto-scroll timeline to bottom
	$effect(() => {
		if (executionState.events.length && timelineRef) {
			timelineRef.scrollTop = timelineRef.scrollHeight;
		}
	});

	// Initialize
	$effect(() => {
		const nextExecutionId = executionId;
		loadWorkflow();

		const previousStream = untrack(() => executionStream);
		previousStream.dispose();

		const stream = createExecutionStream(nextExecutionId);
		executionStream = stream;

		return () => {
			stream.dispose();
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
			default:
				return Terminal;
		}
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

	const sandboxWorkspaceRef = $derived.by(() => {
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxWorkspaceRef;
		return typeof value === 'string' ? value : '';
	});

	const sandboxWorkingDir = $derived.by(() => {
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxWorkingDir;
		return typeof value === 'string' ? value : '';
	});

	const sandboxProvider = $derived.by(() => {
		const root = asRecord(output);
		const workflowOutput = asRecord(root?.workflowOutput);
		const value = workflowOutput?.sandboxProvider;
		return typeof value === 'string' ? value : '';
	});

	async function stopSandboxPreview() {
		previewActionPending = true;
		previewActionMessage = null;
		previewActionError = null;
		try {
			const response = await fetch(
				`/api/workflows/executions/${executionId}/sandbox-preview?previewId=${encodeURIComponent(executionId)}`,
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
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<header class="flex h-12 items-center gap-3 border-b border-border px-4">
		<Breadcrumb.Root>
			<Breadcrumb.List class="gap-1 text-xs">
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/workflows/{workflowId}" class="text-[10px] uppercase tracking-wide">Editor</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/workflows/{workflowId}/runs" class="text-xs">Runs</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Page class="text-xs font-mono">{executionId.slice(0, 8)}</Breadcrumb.Page>
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

		{#if executionState.isConnected}
			<span class="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
				<span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
				Live
			</span>
		{/if}
	</header>

	<!-- Tabbed content -->
	<Tabs bind:value={activeTab} class="flex flex-1 flex-col overflow-hidden">
		<div class="border-b border-border px-4">
			<TabsList class="h-10">
				<TabsTrigger value="overview">Overview</TabsTrigger>
				<TabsTrigger value="steps">Steps</TabsTrigger>
				<TabsTrigger value="timeline">Timeline</TabsTrigger>
				<TabsTrigger value="canvas">Canvas</TabsTrigger>
				<TabsTrigger value="browser">Browser</TabsTrigger>
				<TabsTrigger value="trace">Trace</TabsTrigger>
			</TabsList>
		</div>

		<!-- Tab 1: Overview -->
		<TabsContent value="overview" class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-5xl space-y-4">
				{#if sandboxPreviewUrl}
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
										href={sandboxPreviewUrl}
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

				<div class="flex-1 overflow-y-auto" bind:this={timelineRef}>
					{#if executionState.events.length > 0}
						<div class="divide-y divide-border">
							{#each executionState.events as event, i (i)}
								{@const Icon = eventIcon(event.type)}
								<div class="flex gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors">
									<div class="mt-0.5 shrink-0">
										{#if event.type === 'tool_call_start'}
											<Icon size={14} class="text-yellow-500" />
										{:else if event.type === 'run_complete'}
											<Icon size={14} class="text-green-500" />
										{:else if event.type === 'run_error'}
											<Icon size={14} class="text-red-500" />
										{:else}
											<Icon size={14} class="text-muted-foreground" />
										{/if}
									</div>
									<div class="min-w-0 flex-1">
										<p class="text-xs leading-relaxed break-words">
											{eventLabel(event)}
										</p>
										<p class="text-[10px] text-muted-foreground mt-0.5">
											{new Date(event.timestamp).toLocaleTimeString()}
										</p>
									</div>
								</div>
							{/each}
						</div>
					{:else if executionState.error}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<XCircle size={20} class="text-red-500" />
							<p class="text-sm">{executionState.error}</p>
						</div>
					{:else if isRunning}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<Loader2 size={20} class="animate-spin" />
							<p class="text-sm">Waiting for events...</p>
						</div>
					{:else}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
							<Terminal size={20} />
							<p class="text-sm">No agent events</p>
						</div>
					{/if}
				</div>
			</div>
		</TabsContent>

		<!-- Tab 4: Canvas -->
		<TabsContent value="canvas" class="flex-1 overflow-hidden">
			{#if isLoadingWorkflow}
				<div class="flex h-full items-center justify-center">
					<Loader2 size={24} class="animate-spin text-muted-foreground" />
				</div>
			{:else}
				<SvelteFlow
					bind:nodes
					bind:edges
					{nodeTypes}
					colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					fitView
					minZoom={0.1}
					maxZoom={4}
				>
					<MiniMap zoomable pannable />
					<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				</SvelteFlow>
			{/if}
		</TabsContent>

		<!-- Tab 5: Browser -->
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
									{#if artifact.manifestJson.baseUrl}
										<a
											class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
											href={artifact.manifestJson.baseUrl}
											target="_blank"
											rel="noreferrer"
										>
											<ExternalLink size={12} />
											{artifact.manifestJson.baseUrl}
										</a>
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

		<!-- Tab 6: Trace -->
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
