<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import {
		ArrowLeft,
		CheckCircle2,
		CirclePause,
		Clock,
		Copy,
		ExternalLink,
		Loader2,
		Play,
		Radio,
		RefreshCw,
		RotateCcw,
		StopCircle,
		Trash2,
		XCircle
	} from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import InspectablePayload from '$lib/components/workflow-ops/inspectable-payload.svelte';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import type { PageData } from './$types';

	type AgentRunDetail = {
		instanceId: string;
		agentRun: PageData['detail']['agentRuns'][number] | null;
		status: (PageData['detail']['status'] & { input?: unknown }) | null;
		history: PageData['detail']['history'];
		codeCheckpoints: PageData['detail']['codeCheckpoints'];
		graph: PageData['detail']['graph'];
		replayEvents: PageData['detail']['replayEvents'];
		suggestedReplayEventId: number;
		serviceRuntime: string;
		serviceError: string | null;
	};

	let { data }: { data: PageData } = $props();
	const detail = $derived(data.detail);
	let activeTab = $state('graph');
	let sortNewestFirst = $state(false);
	let failuresOnly = $state(false);
	let expandedEvents = $state<Record<string, boolean>>({});
	let replayOpen = $state(false);
	let actionPending = $state<string | null>(null);
	let actionMessage = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let terminateReason = $state('Terminated from Workflow Ops');
	// svelte-ignore state_referenced_locally
	let fromEventId = $state(data.detail.suggestedReplayEventId);
	let selectedReplayLabel = $state('');
	// svelte-ignore state_referenced_locally
	let newInstanceId = $state(data.suggestedNewInstanceId);
	let overwriteInput = $state(false);
	let inputJson = $state('{\n  \n}');
	let codeCheckpointId = $state('');
	let restoreMode = $state<'live' | 'fresh'>('live');
	let forcePurge = $state(false);
	let recursivePurge = $state(false);
	let eventName = $state('');
	let eventDataJson = $state('{}');
	let selectedAgentRunId = $state('');
	let agentDetail = $state<AgentRunDetail | null>(null);
	let agentLoading = $state(false);
	let agentReplayOpen = $state(false);
	let agentFromEventId = $state(0);
	let selectedAgentReplayLabel = $state('');
	let agentNewInstanceId = $state('');
	let agentOverwriteInput = $state(false);
	let agentInputJson = $state('{}');
	let agentCodeCheckpointId = $state('');
	let agentRestoreMode = $state<'live' | 'fresh'>('live');
	let agentActionPending = $state<string | null>(null);
	let agentActionError = $state<string | null>(null);

	const appId = $derived(detail.status?.appId || 'workflow-orchestrator');
	const workflowName = $derived(detail.workflow?.daprWorkflowName || detail.workflow?.name || detail.status?.workflowName || detail.status?.workflowId || 'Workflow instance');
	const executionInput = $derived(detail.history.find((event) => event.eventType === 'ExecutionStarted')?.input ?? detail.execution?.id);
	const executionOutput = $derived(detail.status?.outputs);
	const selectedReplayEvent = $derived(detail.replayEvents.find((event) => event.eventId === Number(fromEventId)) ?? null);
	const selectedCodeCheckpoint = $derived(detail.codeCheckpoints.find((checkpoint) => checkpoint.id === codeCheckpointId) ?? null);
	const durableCodeCheckpoints = $derived(detail.codeCheckpoints.filter((checkpoint) => checkpoint.remoteStatus === 'pushed'));
	const selectedAgentReplayEvent = $derived(agentDetail?.replayEvents.find((event) => event.eventId === Number(agentFromEventId)) ?? null);
	const selectedAgentCodeCheckpoint = $derived(agentDetail?.codeCheckpoints.find((checkpoint) => checkpoint.id === agentCodeCheckpointId) ?? null);
	const durableAgentCodeCheckpoints = $derived(agentDetail?.codeCheckpoints.filter((checkpoint) => checkpoint.remoteStatus === 'pushed') ?? []);
	const sortedHistory = $derived(
		[...detail.history]
			.filter((event) => !failuresOnly || event.eventType.toLowerCase().includes('failed'))
			.sort((left, right) => {
				const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
				const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0;
				return sortNewestFirst ? rightTime - leftTime : leftTime - rightTime;
			})
	);

	onMount(() => {
		if (location.hash === '#run-new-from') openReplayDialog();
		if (location.pathname.endsWith('/history')) activeTab = 'history';
		if (location.pathname.endsWith('/relationships')) activeTab = 'relationships';
		if (detail.agentRuns.length > 0) {
			selectedAgentRunId = detail.agentRuns[0].id;
		}
	});

	function runtimeStatus(): string {
		return detail.status?.runtimeStatus ?? 'UNKNOWN';
	}

	function statusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
		const normalized = (status ?? 'UNKNOWN').toUpperCase();
		if (['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(normalized)) return 'default';
		if (normalized === 'COMPLETED') return 'secondary';
		if (['FAILED', 'ERROR', 'TERMINATED', 'CANCELLED', 'CANCELED'].includes(normalized)) return 'destructive';
		return 'outline';
	}

	function isActive(status: string | null | undefined): boolean {
		return ['PENDING', 'RUNNING', 'CONTINUED_AS_NEW'].includes((status ?? '').toUpperCase());
	}

	function isSuspended(status: string | null | undefined): boolean {
		return (status ?? '').toUpperCase() === 'SUSPENDED';
	}

	function isTerminal(status: string | null | undefined): boolean {
		return ['COMPLETED', 'FAILED', 'TERMINATED', 'CANCELLED', 'CANCELED'].includes((status ?? '').toUpperCase());
	}

	function formatTime(value: string | null | undefined): string {
		if (!value) return '-';
		return new Date(value).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function formatJson(value: unknown): string {
		if (value === undefined || value === null) return '-';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function eventDisplayName(event: { displayName?: string | null; name?: string | null; eventType: string }): string {
		return event.displayName || event.name || event.eventType;
	}

	function eventRuntimeDetails(event: {
		actionType?: string | null;
		runtimeName?: string | null;
		displayName?: string | null;
		name?: string | null;
		nodeId?: string | null;
	}): string {
		const displayName = event.displayName || event.name;
		return [
			event.nodeId ? `Node: ${event.nodeId}` : null,
			event.actionType,
			event.runtimeName && event.runtimeName !== displayName ? `Dapr: ${event.runtimeName}` : null
		]
			.filter(Boolean)
			.join(' · ');
	}

	function copy(value: string) {
		navigator.clipboard?.writeText(value).catch(() => undefined);
	}

	function toggleAllHistory(expanded: boolean) {
		const next: Record<string, boolean> = {};
		for (const [index, event] of detail.history.entries()) {
			next[`${event.eventId ?? 'x'}-${event.eventType}-${event.timestamp ?? ''}-${index}`] = expanded;
		}
		expandedEvents = next;
	}

	function selectReplayEvent(eventId: number) {
		fromEventId = eventId;
		const event = detail.replayEvents.find((candidate) => candidate.eventId === eventId);
		selectedReplayLabel = event?.label ?? '';
		inputJson = formatJson(event?.input ?? {});
		replayOpen = true;
	}

	function openReplayDialog() {
		if (selectedReplayEvent) {
			selectReplayEvent(selectedReplayEvent.eventId);
			return;
		}
		selectedReplayLabel = '';
		inputJson = formatJson({});
		replayOpen = true;
	}

	function generateInstanceId() {
		const suffix = Math.random().toString(36).slice(2, 10);
		newInstanceId = `${detail.instanceId.slice(0, 48)}-rerun-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '-');
	}

	async function refresh() {
		await invalidateAll();
	}

	async function perform(operation: 'pause' | 'resume' | 'terminate' | 'purge' | 'rerun' | 'event') {
		if (operation === 'terminate' && !confirm(`Terminate workflow instance ${detail.instanceId}?`)) return;
		if (operation === 'purge' && !confirm(`Purge workflow instance ${detail.instanceId}?`)) return;
		actionPending = operation;
		actionError = null;
		actionMessage = null;
		try {
			const payload =
				operation === 'terminate'
					? { reason: terminateReason }
					: operation === 'purge'
						? { force: forcePurge, recursive: recursivePurge }
						: operation === 'rerun'
							? {
									fromEventId,
									newInstanceId,
									overwriteInput,
									inputJson,
									codeCheckpointId,
									restoreMode,
									reason: 'Replay requested from Workflow Ops'
								}
							: operation === 'event'
								? { eventName, eventDataJson }
								: {};
			const response = await fetch(
				`/api/workflow-ops/instances/${encodeURIComponent(detail.instanceId)}/${operation}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				}
			);
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.message ?? `Failed to ${operation} workflow`);
			if (operation === 'rerun' && typeof body.newInstanceId === 'string') {
				actionMessage = `Replay started as ${body.newInstanceId}`;
				replayOpen = false;
				await goto(`/workflow-ops/instances/${encodeURIComponent(body.newInstanceId)}`);
				return;
			}
			actionMessage = `${operation[0].toUpperCase()}${operation.slice(1)} requested`;
			await refresh();
		} catch (err) {
			actionError = err instanceof Error ? err.message : `Failed to ${operation} workflow`;
		} finally {
			actionPending = null;
		}
	}

	async function loadAgentRun(agentRunId = selectedAgentRunId) {
		if (!agentRunId) return;
		agentLoading = true;
		agentActionError = null;
		try {
			const response = await fetch(`/api/workflow-ops/agent-runs/${encodeURIComponent(agentRunId)}`);
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.message ?? 'Failed to load agent run');
			agentDetail = body as AgentRunDetail;
			agentFromEventId = agentDetail.suggestedReplayEventId;
			agentNewInstanceId = `${agentDetail.instanceId.slice(0, 48)}-rerun-${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
			agentCodeCheckpointId = '';
			agentRestoreMode = 'live';
		} catch (err) {
			agentActionError = err instanceof Error ? err.message : 'Failed to load agent run';
		} finally {
			agentLoading = false;
		}
	}

	function selectAgentReplayEvent(eventId: number) {
		if (!agentDetail) return;
		agentFromEventId = eventId;
		const event = agentDetail.replayEvents.find((candidate) => candidate.eventId === eventId);
		selectedAgentReplayLabel = event?.label ?? '';
		agentInputJson = formatJson(event?.input ?? {});
		agentReplayOpen = true;
	}

	function openAgentReplayDialog() {
		if (!agentDetail) return;
		if (selectedAgentReplayEvent) {
			selectAgentReplayEvent(selectedAgentReplayEvent.eventId);
			return;
		}
		selectedAgentReplayLabel = '';
		agentInputJson = '{}';
		agentReplayOpen = true;
	}

	async function performAgent(operation: 'pause' | 'resume' | 'terminate' | 'purge' | 'rerun') {
		if (!agentDetail) return;
		if (operation === 'terminate' && !confirm(`Terminate agent run ${agentDetail.instanceId}?`)) return;
		if (operation === 'purge' && !confirm(`Purge agent run ${agentDetail.instanceId}?`)) return;
		agentActionPending = operation;
		agentActionError = null;
		try {
			const payload =
				operation === 'rerun'
					? {
							fromEventId: agentFromEventId,
							newInstanceId: agentNewInstanceId,
							overwriteInput: agentOverwriteInput,
							inputJson: agentInputJson,
							codeCheckpointId: agentCodeCheckpointId,
							restoreMode: agentRestoreMode,
							reason: 'Agent replay requested from Workflow Ops'
						}
					: operation === 'purge'
						? { force: forcePurge, recursive: recursivePurge }
						: operation === 'terminate'
							? { reason: terminateReason }
							: {};
			const response = await fetch(
				`/api/workflow-ops/agent-runs/${encodeURIComponent(agentDetail.instanceId)}/${operation}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				}
			);
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.message ?? `Failed to ${operation} agent run`);
			if (operation === 'rerun' && typeof body.newInstanceId === 'string') {
				agentReplayOpen = false;
				selectedAgentRunId = body.newInstanceId;
				await loadAgentRun(body.newInstanceId);
				return;
			}
			await loadAgentRun(agentDetail.instanceId);
		} catch (err) {
			agentActionError = err instanceof Error ? err.message : `Failed to ${operation} agent run`;
		} finally {
			agentActionPending = null;
		}
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex min-w-0 items-center gap-3">
			<Button variant="ghost" size="icon" href="/workflow-ops/executions">
				<ArrowLeft size={15} />
			</Button>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<h1 class="truncate text-sm font-semibold tracking-tight">{workflowName}</h1>
					<Badge variant={statusVariant(runtimeStatus())}>{runtimeStatus()}</Badge>
				</div>
				<div class="truncate font-mono text-[11px] text-muted-foreground">Instance ID: {detail.instanceId}</div>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={openReplayDialog}>
				<RotateCcw size={13} class="mr-1.5" />
				Run new from
			</Button>
			<Button variant="outline" size="sm" onclick={refresh}>
				<RefreshCw size={13} class="mr-1.5" />
				Refresh
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
			<a class="hover:text-foreground" href="/workflow-ops/executions">Workflow executions</a>
			<span>/</span>
			<span class="text-foreground">{workflowName}</span>
			<Button variant="ghost" size="icon" onclick={() => copy(detail.instanceId)}>
				<Copy size={13} />
			</Button>
		</div>

		{#if detail.orchestratorError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				Dapr workflow runtime unavailable: {detail.orchestratorError}
			</div>
		{/if}
		{#if actionError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>
		{/if}
		{#if actionMessage}
			<div class="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">{actionMessage}</div>
		{/if}

		<section class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
			<div class="rounded-md border border-border p-4">
				<div class="grid gap-4 md:grid-cols-4">
					<div>
						<div class="text-[11px] uppercase tracking-wide text-muted-foreground">App ID</div>
						<div class="mt-1 truncate text-sm">{appId}</div>
					</div>
					<div>
						<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Start time</div>
						<div class="mt-1 text-sm">{formatTime(detail.status?.startedAt ?? detail.execution?.startedAt)}</div>
					</div>
					<div>
						<div class="text-[11px] uppercase tracking-wide text-muted-foreground">End time</div>
						<div class="mt-1 text-sm">{formatTime(detail.status?.completedAt ?? detail.execution?.completedAt)}</div>
					</div>
					<div>
						<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Current</div>
						<div class="mt-1 truncate text-sm">{detail.status?.currentNodeName ?? detail.execution?.currentNodeName ?? detail.status?.phase ?? detail.execution?.phase ?? '-'}</div>
					</div>
				</div>
				{#if detail.status?.message || detail.status?.error || detail.execution?.error}
					<div class="mt-4 rounded-md bg-muted px-3 py-2 text-sm">{detail.status?.message ?? detail.status?.error ?? detail.execution?.error}</div>
				{/if}
			</div>

			<div class="rounded-md border border-border p-4">
				<h2 class="text-sm font-semibold">Runtime controls</h2>
				<div class="mt-3 flex flex-wrap gap-2">
					{#if isActive(runtimeStatus())}
						<Button variant="outline" size="sm" disabled={actionPending !== null} onclick={() => perform('pause')}>
							<CirclePause size={13} class="mr-1.5" />
							Pause
						</Button>
						<Button variant="destructive" size="sm" disabled={actionPending !== null} onclick={() => perform('terminate')}>
							<StopCircle size={13} class="mr-1.5" />
							Terminate
						</Button>
					{:else if isSuspended(runtimeStatus())}
						<Button variant="outline" size="sm" disabled={actionPending !== null} onclick={() => perform('resume')}>
							<Play size={13} class="mr-1.5" />
							Resume
						</Button>
						<Button variant="destructive" size="sm" disabled={actionPending !== null} onclick={() => perform('terminate')}>
							<StopCircle size={13} class="mr-1.5" />
							Terminate
						</Button>
					{:else}
						<p class="text-sm text-muted-foreground">Pause, resume, and terminate are available for active or suspended instances.</p>
					{/if}
				</div>
				<Input class="mt-3" bind:value={terminateReason} aria-label="Terminate reason" />
			</div>
		</section>

		<section class="mt-4 grid gap-4 lg:grid-cols-2">
			<div class="rounded-md border border-border p-4">
				<div class="mb-2 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Input</h2>
					<Button variant="ghost" size="icon" onclick={() => copy(formatJson(executionInput))}><Copy size={13} /></Button>
				</div>
				<InspectablePayload value={executionInput} maxHeight="max-h-56" />
			</div>
			<div class="rounded-md border border-border p-4">
				<div class="mb-2 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Output</h2>
					<Button variant="ghost" size="icon" onclick={() => copy(formatJson(executionOutput))}><Copy size={13} /></Button>
				</div>
				<InspectablePayload value={executionOutput} maxHeight="max-h-56" />
			</div>
		</section>

		<Tabs bind:value={activeTab} class="mt-5 space-y-4">
			<TabsList>
				<TabsTrigger value="graph">Graph</TabsTrigger>
				<TabsTrigger value="history">History</TabsTrigger>
				<TabsTrigger value="agents">Agent Runs</TabsTrigger>
				<TabsTrigger value="relationships">Relationships</TabsTrigger>
				<TabsTrigger value="raw">Raw</TabsTrigger>
			</TabsList>

			<TabsContent value="graph">
				<div class="rounded-md border border-border p-4">
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-semibold">Workflow graph</h2>
						<Badge variant="outline">{detail.graph.source}</Badge>
					</div>
					{#if detail.graph.nodes.length === 0}
						<div class="flex min-h-64 items-center justify-center rounded border border-dashed border-border text-sm text-muted-foreground">
							No graph data is available for this execution.
						</div>
					{:else}
						<div class="flex min-h-64 items-center gap-3 overflow-x-auto rounded border border-border bg-muted/20 p-4">
							{#each detail.graph.nodes as node, index (node.id)}
								{@const nodeDetails = eventRuntimeDetails(node)}
								<button
									type="button"
									class="min-w-40 rounded-md border border-border bg-background p-3 text-left hover:bg-muted/40"
									onclick={() => { if (typeof node.eventId === 'number') selectReplayEvent(node.eventId); }}
								>
									<div class="flex items-center justify-between gap-2">
										<div class="text-[11px] uppercase tracking-wide text-muted-foreground">{node.kind}</div>
										{#if typeof node.eventId === 'number'}<Badge variant="outline">#{node.eventId}</Badge>{/if}
									</div>
									<div class="mt-1 truncate text-sm font-medium">{node.name}</div>
									{#if node.status || nodeDetails}
										<div class="mt-1 truncate text-xs text-muted-foreground">
											{[node.status, nodeDetails].filter(Boolean).join(' · ')}
										</div>
									{/if}
								</button>
								{#if index < detail.graph.nodes.length - 1}<div class="h-px min-w-8 bg-border"></div>{/if}
							{/each}
						</div>
					{/if}
				</div>
			</TabsContent>

			<TabsContent value="history">
				<div class="rounded-md border border-border p-4">
					<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
						<h2 class="text-sm font-semibold">Event history</h2>
						<div class="flex flex-wrap items-center gap-2">
							<Button variant="outline" size="sm" onclick={() => (sortNewestFirst = !sortNewestFirst)}>{sortNewestFirst ? 'Newest first' : 'Oldest first'}</Button>
							<Button variant="outline" size="sm" onclick={() => toggleAllHistory(true)}>Expand all</Button>
							<Button variant="outline" size="sm" onclick={() => toggleAllHistory(false)}>Collapse all</Button>
							<Button variant={failuresOnly ? 'default' : 'outline'} size="sm" onclick={() => (failuresOnly = !failuresOnly)}>Failures only</Button>
							<NativeSelect class="w-52" onchange={(event) => {
								const id = Number((event.currentTarget as HTMLSelectElement).value);
								if (Number.isFinite(id)) selectReplayEvent(id);
							}}>
								<option value="">Jump to</option>
								{#each detail.replayEvents as event, index (`${event.eventId}-${event.eventType}-${index}`)}
									<option value={event.eventId}>{event.label}</option>
								{/each}
							</NativeSelect>
						</div>
					</div>
					<div class="space-y-2">
						{#if sortedHistory.length === 0}
							<div class="py-12 text-center text-sm text-muted-foreground">No events found.</div>
						{:else}
							{#each sortedHistory as event, index (`${event.eventId ?? 'x'}-${event.eventType}-${event.timestamp ?? ''}-${index}`)}
								{@const key = `${event.eventId ?? 'x'}-${event.eventType}-${event.timestamp ?? ''}-${index}`}
								{@const runtimeDetails = eventRuntimeDetails(event)}
								<div class="rounded-md border border-border">
									<div class="flex flex-wrap items-center justify-between gap-3 p-3">
										<div class="flex min-w-0 items-center gap-3">
											<Badge variant={event.eventType.toLowerCase().includes('failed') ? 'destructive' : event.eventType.toLowerCase().includes('completed') ? 'secondary' : 'outline'}>
												{event.eventType}
											</Badge>
											<div class="min-w-0">
												<div class="truncate text-sm font-medium">{eventDisplayName(event) || workflowName}</div>
												<div class="text-xs text-muted-foreground">
													Event ID: {event.eventId ?? '-'} · {formatTime(event.timestamp)}
													{#if runtimeDetails} · {runtimeDetails}{/if}
												</div>
											</div>
										</div>
										<div class="flex items-center gap-2">
											{#if typeof event.eventId === 'number'}
												<Button variant="outline" size="sm" onclick={() => selectReplayEvent(event.eventId ?? 0)}>Run new from</Button>
											{/if}
											<Button variant="ghost" size="sm" onclick={() => (expandedEvents[key] = !expandedEvents[key])}>{expandedEvents[key] ? 'Collapse' : 'Expand'}</Button>
										</div>
									</div>
									{#if expandedEvents[key]}
										<div class="grid gap-3 border-t border-border p-3 lg:grid-cols-2">
											<div>
												<div class="mb-1 text-xs font-medium text-muted-foreground">Input</div>
												<InspectablePayload value={event.input} maxHeight="max-h-64" />
											</div>
											<div>
												<div class="mb-1 text-xs font-medium text-muted-foreground">Output</div>
												<InspectablePayload value={event.output ?? event.metadata ?? event.raw} maxHeight="max-h-64" />
											</div>
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				</div>
			</TabsContent>

			<TabsContent value="agents">
				<div class="grid gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
					<div class="overflow-hidden rounded-md border border-border">
						<Table class="w-full">
							<TableHeader>
								<TableRow class="border-b border-border bg-muted/50">
									<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Agent run</TableHead>
									<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</TableHead>
									<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody class="divide-y divide-border">
								{#if detail.agentRuns.length === 0}
									<TableRow>
										<TableCell colspan={3} class="py-12 text-center text-sm text-muted-foreground">
											This workflow did not schedule any durable agent child runs.
										</TableCell>
									</TableRow>
								{:else}
									{#each detail.agentRuns as run (run.id)}
										<TableRow class="hover:bg-muted/30">
											<TableCell class="px-4 py-3">
												<div class="text-sm font-medium">{run.nodeId}</div>
												<div class="mt-1 truncate font-mono text-[11px] text-muted-foreground">{run.daprInstanceId}</div>
											</TableCell>
											<TableCell class="px-4 py-3"><Badge variant={statusVariant(run.status)}>{run.status}</Badge></TableCell>
											<TableCell class="px-4 py-3">
												<Button
													variant={selectedAgentRunId === run.id ? 'default' : 'outline'}
													size="sm"
													disabled={agentLoading}
													onclick={() => {
														selectedAgentRunId = run.id;
														loadAgentRun(run.id);
													}}
												>
													Inspect
												</Button>
											</TableCell>
										</TableRow>
									{/each}
								{/if}
							</TableBody>
						</Table>
					</div>

					<div class="rounded-md border border-border p-4">
						<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
							<div>
								<h2 class="text-sm font-semibold">Durable agent replay</h2>
								<p class="mt-1 text-xs text-muted-foreground">Inspect the child agent workflow history and replay from a tool, LLM, or workflow event boundary.</p>
							</div>
							<div class="flex gap-2">
								<Button variant="outline" size="sm" disabled={!selectedAgentRunId || agentLoading} onclick={() => loadAgentRun()}>
									{#if agentLoading}<Loader2 size={13} class="mr-1.5 animate-spin" />{:else}<RefreshCw size={13} class="mr-1.5" />{/if}
									Load
								</Button>
								<Button variant="outline" size="sm" disabled={!agentDetail} onclick={openAgentReplayDialog}>
									<RotateCcw size={13} class="mr-1.5" />
									Run child from
								</Button>
							</div>
						</div>

						{#if agentActionError}
							<div class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{agentActionError}</div>
						{/if}

						{#if !agentDetail}
							<div class="flex min-h-72 items-center justify-center rounded border border-dashed border-border text-sm text-muted-foreground">
								Select an agent run, then load its durable history.
							</div>
						{:else}
							<div class="mb-4 grid gap-3 md:grid-cols-4">
								<div>
									<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Runtime</div>
									<div class="mt-1 text-sm">{agentDetail.serviceRuntime}</div>
								</div>
								<div>
									<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Status</div>
									<div class="mt-1"><Badge variant={statusVariant(agentDetail.status?.runtimeStatus ?? agentDetail.agentRun?.status)}>{agentDetail.status?.runtimeStatus ?? agentDetail.agentRun?.status ?? 'UNKNOWN'}</Badge></div>
								</div>
								<div>
									<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Events</div>
									<div class="mt-1 text-sm">{agentDetail.history.length}</div>
								</div>
								<div>
									<div class="text-[11px] uppercase tracking-wide text-muted-foreground">Checkpoints</div>
									<div class="mt-1 text-sm">{agentDetail.codeCheckpoints.length}</div>
								</div>
							</div>

							<div class="mb-4 flex flex-wrap gap-2">
								{#if isActive(agentDetail.status?.runtimeStatus ?? agentDetail.agentRun?.status)}
									<Button variant="outline" size="sm" disabled={agentActionPending !== null} onclick={() => performAgent('pause')}>Pause</Button>
									<Button variant="destructive" size="sm" disabled={agentActionPending !== null} onclick={() => performAgent('terminate')}>Terminate</Button>
								{:else if isSuspended(agentDetail.status?.runtimeStatus)}
									<Button variant="outline" size="sm" disabled={agentActionPending !== null} onclick={() => performAgent('resume')}>Resume</Button>
								{/if}
								<Button variant="destructive" size="sm" disabled={agentActionPending !== null || !isTerminal(agentDetail.status?.runtimeStatus ?? agentDetail.agentRun?.status)} onclick={() => performAgent('purge')}>Purge child state</Button>
							</div>

							{#if agentDetail.serviceError}
								<div class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">{agentDetail.serviceError}</div>
							{/if}

							<div class="grid gap-4 lg:grid-cols-2">
								<div>
									<div class="mb-2 text-xs font-medium text-muted-foreground">Agent input</div>
									<InspectablePayload value={agentDetail.status?.input} maxHeight="max-h-56" />
								</div>
								<div>
									<div class="mb-2 text-xs font-medium text-muted-foreground">Agent output</div>
									<InspectablePayload value={agentDetail.status?.outputs} maxHeight="max-h-56" />
								</div>
							</div>

							<div class="mt-4 space-y-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Replayable child events</h3>
									<NativeSelect class="w-64" bind:value={selectedAgentReplayLabel} onchange={(event) => {
										const value = (event.currentTarget as HTMLSelectElement).value;
										const replayEvent = agentDetail?.replayEvents.find((candidate) => candidate.label === value);
										if (replayEvent) selectAgentReplayEvent(replayEvent.eventId);
									}}>
										<option value="">Jump to event</option>
										{#each agentDetail.replayEvents as event, index (`${event.eventId}-${event.eventType}-${index}`)}
											<option value={event.label}>{event.label}</option>
										{/each}
									</NativeSelect>
								</div>
								{#if agentDetail.replayEvents.length === 0}
									<div class="rounded border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No replayable agent events found.</div>
								{:else}
									<div class="max-h-96 space-y-2 overflow-auto pr-1">
										{#each agentDetail.replayEvents as event, index (`${event.eventId}-${event.eventType}-${index}`)}
											<div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
												<div class="min-w-0">
													<div class="truncate text-sm font-medium">{event.name}</div>
													<div class="text-xs text-muted-foreground">Event #{event.eventId} · {event.eventType} · {formatTime(event.timestamp)}</div>
												</div>
												<Button variant="outline" size="sm" onclick={() => selectAgentReplayEvent(event.eventId)}>Run child from</Button>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			</TabsContent>

			<TabsContent value="relationships">
				<div class="overflow-hidden rounded-md border border-border">
					<Table class="w-full">
						<TableHeader>
							<TableRow class="border-b border-border bg-muted/50">
								<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Instance ID</TableHead>
								<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</TableHead>
								<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Relationship</TableHead>
								<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">App ID</TableHead>
								<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Start time</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody class="divide-y divide-border">
							{#if detail.relationships.length === 0}
								<TableRow>
									<TableCell colspan={5} class="py-12 text-center text-sm text-muted-foreground">
										This instance doesn't have any children and was not rerun.
									</TableCell>
								</TableRow>
							{:else}
								{#each detail.relationships as relationship (relationship.instanceId + relationship.relationship)}
									<TableRow class="hover:bg-muted/30">
										<TableCell class="px-4 py-3 font-mono text-xs">
											<a
												class="underline-offset-4 hover:underline"
												href={`/workflow-ops/${encodeURIComponent(relationship.appId)}/${encodeURIComponent(relationship.instanceId)}`}
											>
												{relationship.instanceId}
											</a>
										</TableCell>
										<TableCell class="px-4 py-3"><Badge variant={statusVariant(relationship.status)}>{relationship.status}</Badge></TableCell>
										<TableCell class="px-4 py-3 text-sm capitalize">{relationship.relationship}</TableCell>
										<TableCell class="px-4 py-3 font-mono text-xs text-muted-foreground">{relationship.appId}</TableCell>
										<TableCell class="px-4 py-3 text-sm text-muted-foreground">{formatTime(relationship.startedAt)}</TableCell>
									</TableRow>
								{/each}
							{/if}
						</TableBody>
					</Table>
				</div>
				<Button class="mt-3" variant="outline" href="/workflow-ops/executions">
					<ExternalLink size={13} class="mr-1.5" />
					See all executions
				</Button>
			</TabsContent>

			<TabsContent value="raw">
				{#if activeTab === 'raw'}
					<div class="grid gap-4 lg:grid-cols-2">
						<InspectablePayload value={detail.status} maxHeight="max-h-[520px]" class="border border-border" />
						<InspectablePayload value={detail.history} maxHeight="max-h-[520px]" class="border border-border" />
					</div>
				{/if}
			</TabsContent>
		</Tabs>

		<section class="mt-5 grid gap-4 lg:grid-cols-2">
			<div class="rounded-md border border-border p-4">
				<h2 class="flex items-center gap-2 text-sm font-semibold"><Radio size={14} />Raise Event</h2>
				<p class="mt-2 text-xs text-muted-foreground">Use for workflows waiting on an external event or approval.</p>
				<div class="mt-3 space-y-3">
					<Input placeholder="event name" bind:value={eventName} />
					<textarea class="min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" bind:value={eventDataJson} aria-label="Event data JSON"></textarea>
					<Button variant="outline" disabled={actionPending !== null || !isActive(runtimeStatus())} onclick={() => perform('event')}>Raise Event</Button>
				</div>
			</div>

			<div class="rounded-md border border-border p-4">
				<h2 class="flex items-center gap-2 text-sm font-semibold text-destructive"><Trash2 size={14} />Purge</h2>
				<p class="mt-2 text-xs text-muted-foreground">Purge removes Dapr TaskHub state. Keep this for terminal instances unless cleanup requires force.</p>
				<div class="mt-3 space-y-2">
					<label class="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" bind:checked={forcePurge} />Force cleanup</label>
					<label class="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" bind:checked={recursivePurge} />Recursive child purge</label>
					<Button variant="destructive" disabled={actionPending !== null || (!isTerminal(runtimeStatus()) && !forcePurge)} onclick={() => perform('purge')}>Purge Instance</Button>
				</div>
			</div>
		</section>
	</div>
</div>

<Dialog open={replayOpen} onOpenChange={(value) => (replayOpen = value)}>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>Run new workflow from event</DialogTitle>
			<DialogDescription>
				Choose a Dapr history event. Earlier successful work is replayed from durable history instead of rerunning.
			</DialogDescription>
		</DialogHeader>
		<div class="space-y-3">
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="replay-event">Select workflow event</label>
				<NativeSelect
					id="replay-event"
					bind:value={selectedReplayLabel}
					onchange={(event) => {
						const value = (event.currentTarget as HTMLSelectElement).value;
						const replayEvent = detail.replayEvents.find((candidate) => candidate.label === value);
						if (replayEvent) selectReplayEvent(replayEvent.eventId);
					}}
				>
					<option value="">From start</option>
					{#each detail.replayEvents as event, index (`${event.eventId}-${event.eventType}-${index}`)}
						<option value={event.label}>{event.label}</option>
					{/each}
				</NativeSelect>
			</div>
			{#if selectedReplayEvent}
				<div>
					<div class="mb-1 text-xs font-medium text-muted-foreground">Activity input</div>
					<InspectablePayload value={selectedReplayEvent.input} maxHeight="max-h-40" />
				</div>
			{/if}
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="new-instance">Workflow instance ID</label>
				<div class="flex gap-2">
					<Input id="new-instance" bind:value={newInstanceId} />
					<Button variant="outline" type="button" onclick={generateInstanceId}>Generate</Button>
				</div>
			</div>
			<div class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
				Your workflow application must be running for this operation to succeed.
			</div>
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="replay-checkpoint">Restore code checkpoint</label>
				<NativeSelect id="replay-checkpoint" bind:value={codeCheckpointId}>
					<option value="">Do not restore code state</option>
					{#each durableCodeCheckpoints as checkpoint}
						<option value={checkpoint.id}>
							#{checkpoint.seq ?? '-'} {checkpoint.toolName} · {checkpoint.fileCount} file{checkpoint.fileCount === 1 ? '' : 's'} · {checkpoint.afterSha?.slice(0, 8)}
						</option>
					{/each}
				</NativeSelect>
				{#if selectedCodeCheckpoint}
					<p class="mt-1 text-xs text-muted-foreground">
						The rerun input will include a restore directive for {selectedCodeCheckpoint.remoteRef}.
					</p>
				{:else if detail.codeCheckpoints.length > 0 && durableCodeCheckpoints.length === 0}
					<p class="mt-1 text-xs text-amber-600 dark:text-amber-400">
						This execution has code checkpoints, but none were pushed to durable Git storage.
					</p>
				{/if}
			</div>
			{#if selectedCodeCheckpoint}
				<div>
					<label class="mb-1 block text-xs font-medium text-muted-foreground" for="restore-mode">Restore target</label>
					<NativeSelect id="restore-mode" bind:value={restoreMode}>
						<option value="live">Existing sandbox</option>
						<option value="fresh">Fresh sandbox</option>
					</NativeSelect>
				</div>
			{/if}
			<label class="flex items-start gap-2 text-xs text-muted-foreground">
				<input type="checkbox" class="mt-0.5" bind:checked={overwriteInput} />
				<span>Override input. Leave this off for Dapr history replay.</span>
			</label>
			{#if overwriteInput}
				<textarea class="min-h-32 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" bind:value={inputJson} aria-label="Replay input JSON"></textarea>
			{/if}
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (replayOpen = false)}>Cancel</Button>
			<Button disabled={actionPending !== null} onclick={() => perform('rerun')}>
				{#if actionPending === 'rerun'}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
				Run new from
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>

<Dialog open={agentReplayOpen} onOpenChange={(value) => (agentReplayOpen = value)}>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>Run new agent child from event</DialogTitle>
			<DialogDescription>
				Choose a durable agent history event. Earlier agent work is replayed from Dapr history; code restore is applied before the replayed agent continues.
			</DialogDescription>
		</DialogHeader>
		<div class="space-y-3">
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="agent-replay-event">Select agent event</label>
				<NativeSelect
					id="agent-replay-event"
					bind:value={selectedAgentReplayLabel}
					onchange={(event) => {
						const value = (event.currentTarget as HTMLSelectElement).value;
						const replayEvent = agentDetail?.replayEvents.find((candidate) => candidate.label === value);
						if (replayEvent) selectAgentReplayEvent(replayEvent.eventId);
					}}
				>
					<option value="">From start</option>
					{#each agentDetail?.replayEvents ?? [] as event, index (`${event.eventId}-${event.eventType}-${index}`)}
						<option value={event.label}>{event.label}</option>
					{/each}
				</NativeSelect>
			</div>
			{#if selectedAgentReplayEvent}
				<div>
					<div class="mb-1 text-xs font-medium text-muted-foreground">Event input</div>
					<InspectablePayload value={selectedAgentReplayEvent.input} maxHeight="max-h-40" />
				</div>
			{/if}
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="new-agent-instance">Agent instance ID</label>
				<Input id="new-agent-instance" bind:value={agentNewInstanceId} />
			</div>
			<div>
				<label class="mb-1 block text-xs font-medium text-muted-foreground" for="agent-replay-checkpoint">Restore code checkpoint</label>
				<NativeSelect id="agent-replay-checkpoint" bind:value={agentCodeCheckpointId}>
					<option value="">Do not restore code state</option>
					{#each durableAgentCodeCheckpoints as checkpoint}
						<option value={checkpoint.id}>
							#{checkpoint.seq ?? '-'} {checkpoint.toolName} · {checkpoint.fileCount} file{checkpoint.fileCount === 1 ? '' : 's'} · {checkpoint.afterSha?.slice(0, 8)}
						</option>
					{/each}
				</NativeSelect>
				{#if selectedAgentCodeCheckpoint}
					<p class="mt-1 text-xs text-muted-foreground">
						The rerun input will restore {selectedAgentCodeCheckpoint.remoteRef}.
					</p>
				{:else if agentDetail && agentDetail.codeCheckpoints.length > 0 && durableAgentCodeCheckpoints.length === 0}
					<p class="mt-1 text-xs text-amber-600 dark:text-amber-400">
						This agent run has checkpoints, but none were pushed to durable Git storage.
					</p>
				{/if}
			</div>
			{#if selectedAgentCodeCheckpoint}
				<div>
					<label class="mb-1 block text-xs font-medium text-muted-foreground" for="agent-restore-mode">Restore target</label>
					<NativeSelect id="agent-restore-mode" bind:value={agentRestoreMode}>
						<option value="live">Existing sandbox</option>
						<option value="fresh">Fresh sandbox</option>
					</NativeSelect>
				</div>
			{/if}
			<label class="flex items-start gap-2 text-xs text-muted-foreground">
				<input type="checkbox" class="mt-0.5" bind:checked={agentOverwriteInput} />
				<span>Override input. Leave this off for Dapr history replay.</span>
			</label>
			{#if agentOverwriteInput}
				<textarea class="min-h-32 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" bind:value={agentInputJson} aria-label="Agent replay input JSON"></textarea>
			{/if}
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (agentReplayOpen = false)}>Cancel</Button>
			<Button disabled={agentActionPending !== null} onclick={() => performAgent('rerun')}>
				{#if agentActionPending === 'rerun'}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
				Run child from
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
