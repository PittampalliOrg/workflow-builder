<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import {
		X, Check, Loader2, CheckCircle2, XCircle, Clock,
		ChevronDown, ChevronRight, ExternalLink, RefreshCw,
		Wrench, MessageSquare, Monitor, Terminal
	} from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Card } from '$lib/components/ui/card';
	import { formatDistanceToNow } from 'date-fns';
	import ExecutionStatusBadge from '$lib/components/workflow/execution/execution-status-badge.svelte';
	import StepTimeline from '$lib/components/workflow/execution/step-timeline.svelte';
	import { createAgentStream } from '$lib/stores/agent-stream.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	interface Props {
		embedded?: boolean;
	}

	let { embedded = false }: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	interface Execution {
		id: string;
		status: string;
		startedAt: string;
		completedAt?: string;
		duration?: number;
		output?: Record<string, unknown>;
	}

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

	let executions = $state<Execution[]>([]);
	let isLoadingList = $state(false);
	let expandedIds = new SvelteSet<string>();
	let executionLogs = new SvelteMap<string, StepLog[]>();
	let loadingLogs = new SvelteSet<string>();
	let agentStreams = new SvelteMap<string, ReturnType<typeof createAgentStream>>();

	// Fetch executions list
	async function fetchExecutions() {
		if (!store.workflowId) return;
		isLoadingList = true;
		try {
			const res = await fetch(`/api/workflows/${store.workflowId}/executions`);
			if (res.ok) {
				executions = await res.json();
			}
		} catch (err) {
			console.error('Failed to fetch executions:', err);
		} finally {
			isLoadingList = false;
		}
	}

	onMount(() => {
		fetchExecutions();
	});

	// Auto-fetch when workflowId becomes available (may not be set at mount time)
	$effect(() => {
		if (store.workflowId && executions.length === 0 && !isLoadingList) {
			fetchExecutions();
		}
	});

	// Refetch when the runs tab becomes active
	let lastActiveTab = $state('');
	$effect(() => {
		const tab = store.activeConfigTab;
		if (tab === 'runs' && lastActiveTab !== 'runs') {
			fetchExecutions();
		}
		lastActiveTab = tab;
	});

	// Poll for updates when there are running executions
	$effect(() => {
		const hasRunning = executions.some((e) => isRunning(e.status));
		if (!hasRunning && !store.selectedExecutionId) return;
		const interval = setInterval(fetchExecutions, 5000);
		return () => clearInterval(interval);
	});

	// Auto-expand only newly triggered executions (not yet in list = just launched)
	let lastAutoExpandedId = $state('');
	$effect(() => {
		const execId = store.selectedExecutionId;
		if (!execId || execId === lastAutoExpandedId) return;

		const found = executions.find((e) => e.id === execId);
		if (!found) {
			// New execution just triggered — add placeholder and auto-expand
			executions = [{
				id: execId,
				status: 'running',
				startedAt: new Date().toISOString()
			}, ...executions];
			expandedIds.add(execId);
			ensureAgentStream(execId);
			lastAutoExpandedId = execId;
		}
	});

	function ensureAgentStream(execId: string) {
		if (!agentStreams.has(execId)) {
			agentStreams.set(execId, createAgentStream(execId));
		}
	}

	async function fetchLogsForExecution(execId: string) {
		if (executionLogs.has(execId) || loadingLogs.has(execId)) return;
		loadingLogs.add(execId);
		try {
			const res = await fetch(`/api/workflows/executions/${execId}/logs`);
			if (res.ok) {
				const data = await res.json();
				executionLogs.set(execId, data.logs ?? []);
			}
		} catch {
			// ignore
		} finally {
			loadingLogs.delete(execId);
		}
	}

	function selectExecution(exec: Execution) {
		store.selectedExecutionId = exec.id;
	}

	function toggleExpand(exec: Execution) {
		if (expandedIds.has(exec.id)) {
			expandedIds.delete(exec.id);
		} else {
			expandedIds.add(exec.id);
			store.selectedExecutionId = exec.id;
			fetchLogsForExecution(exec.id);
			if (isRunning(exec.status)) {
				ensureAgentStream(exec.id);
			}
		}
	}

	// Re-fetch logs when a running execution completes
	$effect(() => {
		for (const exec of executions) {
			if (!isRunning(exec.status) && expandedIds.has(exec.id) && !executionLogs.has(exec.id)) {
				fetchLogsForExecution(exec.id);
			}
		}
	});

	function formatDuration(ms?: number): string {
		if (ms == null) return '';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}

	function computeDuration(exec: Execution): string {
		if (exec.duration != null) return formatDuration(exec.duration);
		if (!exec.startedAt) return '';
		const start = new Date(exec.startedAt).getTime();
		const end = exec.completedAt ? new Date(exec.completedAt).getTime() : Date.now();
		return formatDuration(end - start);
	}

	function relativeTime(iso: string): string {
		try {
			return formatDistanceToNow(new Date(iso), { addSuffix: true });
		} catch {
			return '';
		}
	}

	function isRunning(status: string): boolean {
		const s = status.toLowerCase();
		return s === 'running' || s === 'pending';
	}

	function statusDotColor(status: string): string {
		const s = status.toLowerCase();
		if (s === 'success' || s === 'completed') return 'bg-green-600';
		if (s === 'error' || s === 'failed') return 'bg-red-600';
		if (s === 'running') return 'bg-blue-600';
		return 'bg-muted-foreground';
	}

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
</script>

<div class="flex h-full flex-col">
	{#if !embedded}
		<!-- Header (standalone mode only) -->
		<div class="flex h-10 items-center justify-between border-b border-border px-3">
			<span class="text-sm font-medium">Runs</span>
			<button
				onclick={() => (store.showRunsPanel = false)}
				class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
			>
				<X size={14} />
			</button>
		</div>
	{/if}

	<div class="flex-1 overflow-auto">
		{#if isLoadingList && executions.length === 0}
			<div class="flex items-center justify-center p-6">
				<Loader2 size={20} class="animate-spin text-muted-foreground" />
			</div>
		{:else if executions.length === 0}
			<div class="p-6 text-center text-xs text-muted-foreground">
				No executions yet. Click Execute to run this workflow.
			</div>
		{:else}
			<div class="space-y-1.5 p-1.5">
				{#each executions as exec, index (exec.id)}
					{@const execId = exec.id}
					{@const isExpanded = expandedIds.has(execId)}
					{@const logs = executionLogs.get(execId) ?? null}
					{@const stream = agentStreams.get(execId) ?? null}
					{@const isLogsLoading = loadingLogs.has(execId)}

					<Card class="overflow-hidden transition-all {store.selectedExecutionId === exec.id ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''}">
						<!-- Card Header -->
						<div class="flex items-center gap-2 px-3 py-2">
							<!-- Status dot -->
							<span class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full {statusDotColor(exec.status)}">
								{#if isRunning(exec.status)}
									<Loader2 size={9} class="text-white animate-spin" />
								{:else if exec.status.toLowerCase() === 'success' || exec.status.toLowerCase() === 'completed'}
									<Check size={9} class="text-white" strokeWidth={3} />
								{:else if exec.status.toLowerCase() === 'error' || exec.status.toLowerCase() === 'failed'}
									<X size={9} class="text-white" strokeWidth={3} />
								{:else}
									<Clock size={8} class="text-white" />
								{/if}
							</span>

							<!-- Run info — clickable to select -->
							<button
								class="min-w-0 flex-1 text-left hover:opacity-80 transition-opacity"
								onclick={() => selectExecution(exec)}
							>
								<div class="text-[11px] font-semibold text-foreground">Run #{executions.length - index}</div>
								<div class="font-mono text-[10px] text-muted-foreground truncate">
									{relativeTime(exec.startedAt)} · {computeDuration(exec)} · <span class="capitalize">{exec.status.toLowerCase() === 'completed' ? 'Completed' : exec.status.toLowerCase()}</span>
								</div>
							</button>

							<!-- Actions — separate from the expand click area -->
							<div class="flex shrink-0 items-center gap-1">
								<a
									href="/workflows/{store.workflowId}/runs/{exec.id}"
									class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
									title="Open detail page"
								>
									<ExternalLink size={10} />
								</a>
								<button
									class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
									onclick={() => toggleExpand(exec)}
								>
									{#if isExpanded}
										<ChevronDown size={12} />
									{:else}
										<ChevronRight size={12} />
									{/if}
								</button>
							</div>
						</div>

						<!-- Expanded Content -->
						{#if isExpanded}
							<div class="border-t bg-muted/10">
								<!-- Agent stream inline (for running executions) -->
								{#if isRunning(exec.status) && stream}
									<div class="space-y-2 p-3">
										{#if !stream.currentPhase && !stream.activeToolName && stream.events.length === 0 && !stream.error}
											<div class="flex items-center gap-2 py-2 text-xs text-muted-foreground">
												<Loader2 size={12} class="animate-spin" />
												<span>Waiting for events...</span>
											</div>
										{/if}
										{#if stream.currentPhase}
											<div class="flex items-center gap-1.5 text-xs">
												<span class="text-muted-foreground">Phase:</span>
												<span class="font-medium">{stream.currentPhase}</span>
											</div>
										{/if}

										{#if stream.activeToolName}
											<div class="flex items-center gap-1.5 rounded-md bg-accent/50 px-2 py-1.5 text-xs">
												<Wrench size={11} class="text-orange-500" />
												<span class="font-medium truncate">{stream.activeToolName}</span>
												<Loader2 size={11} class="animate-spin text-muted-foreground" />
											</div>
										{/if}

										{#if stream.isLlmStreaming && stream.llmTokenBuffer}
											<div class="max-h-24 overflow-auto rounded-md bg-muted/50 p-2 text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
												{stream.llmTokenBuffer.slice(-500)}
											</div>
										{/if}

										<!-- Compact event feed (last 8) -->
										{#if stream.events.length > 0}
											<div class="space-y-0.5">
												<div class="text-[10px] text-muted-foreground">Events ({stream.events.length})</div>
												{#each stream.events.slice(-8) as event (event.timestamp + event.type)}
													<div class="flex items-center gap-1.5 text-[10px]">
														{#if event.type === 'tool_call_start' || event.type === 'tool_call_end'}
															<Wrench size={9} class="shrink-0 text-orange-500" />
														{:else if event.type === 'llm_complete'}
															<MessageSquare size={9} class="shrink-0 text-blue-500" />
														{:else if event.type === 'sandbox_output'}
															<Monitor size={9} class="shrink-0 text-purple-500" />
														{:else if event.type === 'run_complete'}
															<CheckCircle2 size={9} class="shrink-0 text-green-500" />
														{:else if event.type === 'run_error'}
															<XCircle size={9} class="shrink-0 text-red-500" />
														{:else}
															<Terminal size={9} class="shrink-0 text-muted-foreground" />
														{/if}
														<span class="truncate text-muted-foreground">
															{event.type === 'tool_call_start' ? `Tool: ${event.data.toolName ?? ''}` : event.type}
														</span>
														<span class="ml-auto shrink-0 text-muted-foreground/60">{formatTime(event.timestamp)}</span>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/if}

								<!-- Step timeline (for completed or when logs available) -->
								{#if isLogsLoading}
									<div class="flex items-center justify-center py-6">
										<Loader2 size={16} class="animate-spin text-muted-foreground" />
									</div>
								{:else if logs && logs.length > 0}
									<div class="p-3">
										<StepTimeline steps={logs} />
									</div>
								{:else if !isRunning(exec.status)}
									<div class="py-6 text-center text-[10px] text-muted-foreground">
										No steps recorded
									</div>
								{/if}
							</div>
						{/if}
					</Card>
				{/each}
			</div>
		{/if}

		<!-- Refresh button -->
		<div class="border-t border-border p-2">
			<Button
				variant="ghost"
				size="sm"
				class="w-full text-xs"
				onclick={fetchExecutions}
				disabled={isLoadingList}
			>
				{#if isLoadingList}
					<Loader2 size={12} class="animate-spin" />
					Refreshing...
				{:else}
					<RefreshCw size={12} />
					Refresh
				{/if}
			</Button>
		</div>
	</div>
</div>
