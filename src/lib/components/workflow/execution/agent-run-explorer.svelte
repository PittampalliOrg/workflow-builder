<script lang="ts">
	import {
		SvelteFlow,
		Controls,
		Background,
		BackgroundVariant,
		type NodeTypes,
		type EdgeTypes
	} from '@xyflow/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '$lib/components/ui/card';
	import DefaultNode from '$lib/components/workflow/nodes/default-node.svelte';
	import AnimatedEdge from '$lib/components/workflow/edges/animated-edge.svelte';
	import {
		buildAgentLoopGraph,
		eventsForAgentRun
	} from '$lib/utils/agent-subflow';
	import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';

	interface Props {
		agentRuns: ExecutionAgentRun[];
		agentEvents: ExecutionTimelineEvent[];
		selectedRunId: string | null;
		onSelectRun?: (runId: string) => void;
	}

	let {
		agentRuns,
		agentEvents,
		selectedRunId = null,
		onSelectRun
	}: Props = $props();

	const nodeTypes: NodeTypes = { default: DefaultNode } satisfies NodeTypes;
	const edgeTypes: EdgeTypes = { default: AnimatedEdge, animated: AnimatedEdge } satisfies EdgeTypes;

	const selectedRun = $derived.by(
		() =>
			agentRuns.find((run) => run.id === selectedRunId) ??
			agentRuns.find((run) => run.status === 'running') ??
			agentRuns[0] ??
			null
	);

	const selectedEvents = $derived.by(() => eventsForAgentRun(selectedRun, agentEvents));
	const graph = $derived.by(() => buildAgentLoopGraph(selectedRun, agentEvents));

	function badgeVariant(status: ExecutionAgentRun['status']) {
		switch (status) {
			case 'completed':
				return 'secondary';
			case 'failed':
				return 'destructive';
			case 'running':
				return 'default';
			default:
				return 'outline';
		}
	}

	function formatTime(value: string | null): string {
		if (!value) return '—';
		return new Date(value).toLocaleTimeString();
	}

	function toolNameOf(event: ExecutionTimelineEvent): string {
		return String(
			event.toolName ??
			event.data.toolName ??
			event.data.tool_name ??
			event.data.name ??
			'unknown'
		);
	}

	function eventSummary(event: ExecutionTimelineEvent): string {
		// Legacy vocabulary
		if (event.type === 'tool_call_start') {
			return `Tool ${toolNameOf(event)} started`;
		}
		if (event.type === 'tool_call_end') {
			return `Tool ${toolNameOf(event)} completed`;
		}
		if (event.type === 'tool_call_error') {
			return `Tool ${toolNameOf(event)} failed`;
		}
		if (event.type === 'llm_start') {
			return `Model ${(event.data.model ?? event.data.modelName ?? 'unknown') as string} started`;
		}
		if (event.type === 'llm_complete') {
			return 'Model response complete';
		}
		if (event.type === 'turn_started') {
			return 'Agent began a new loop iteration';
		}
		if (event.type === 'run_complete') return 'Agent run completed';
		if (event.type === 'run_error') return `Agent run failed: ${String(event.data.error ?? 'unknown error')}`;

		// CMA Tier 1/2/3 vocabulary
		if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use' || event.type === 'agent.custom_tool_use') {
			return `Tool ${toolNameOf(event)} started`;
		}
		if (event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result' || event.type === 'agent.custom_tool_result') {
			const isErr = (event.data as { is_error?: boolean }).is_error === true;
			return `Tool ${toolNameOf(event)} ${isErr ? 'failed' : 'completed'}`;
		}
		if (event.type === 'agent.message') return 'Model response complete';
		if (event.type === 'agent.thinking') return 'Agent produced a thinking block';
		if (event.type === 'agent.message_delta') return 'Streaming response…';
		if (event.type === 'agent.thinking_delta') return 'Streaming thinking…';
		if (event.type === 'agent.tool_input_delta') return `Composing tool input for ${toolNameOf(event)}…`;
		if (event.type === 'agent.llm_usage') {
			const d = event.data as { input_tokens?: number; output_tokens?: number };
			return `LLM usage: in=${d.input_tokens ?? '?'} out=${d.output_tokens ?? '?'}`;
		}
		if (event.type === 'hook.decision') {
			const d = event.data as { hook_event?: string; decision?: string };
			return `Hook ${d.hook_event ?? ''} → ${d.decision ?? 'ran'}`;
		}
		if (event.type === 'mcp.tool_call') {
			const d = event.data as { tool_name?: string; server?: string; success?: boolean };
			return `MCP ${d.tool_name ?? 'tool'}${d.server ? `@${d.server}` : ''} ${d.success === false ? 'failed' : 'ok'}`;
		}
		if (event.type === 'agent.circuit_breaker_tripped') return 'Circuit breaker tripped';
		if (event.type === 'session.turn_timeout') return 'Session turn timed out';
		if (event.type === 'agent.thread_images_compacted') return 'Thread images compacted';

		return event.type;
	}
</script>

<div class="grid h-full gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
	<Card class="min-h-0 overflow-hidden">
		<CardHeader class="pb-3">
			<CardTitle>Child Runs</CardTitle>
			<CardDescription>Each Claude node executes as a nested durable child run.</CardDescription>
		</CardHeader>
		<CardContent class="space-y-2 overflow-y-auto">
			{#if agentRuns.length > 0}
				{#each agentRuns as run (run.id)}
					<button
						type="button"
						class={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40 ${selectedRun?.id === run.id ? 'border-primary bg-muted/30' : 'border-border'}`}
						onclick={() => onSelectRun?.(run.id)}
					>
						<div class="flex items-center justify-between gap-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">{run.nodeId}</p>
								<p class="truncate text-xs text-muted-foreground">{run.mode} · {run.daprInstanceId}</p>
							</div>
							<Badge variant={badgeVariant(run.status)} class="shrink-0 text-[10px]">
								{run.status}
							</Badge>
						</div>
						<div class="mt-2 grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
							<p>Started: {formatTime(run.createdAt)}</p>
							<p>Finished: {formatTime(run.completedAt)}</p>
						</div>
					</button>
				{/each}
			{:else}
				<div class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
					No child agent runs recorded.
				</div>
			{/if}
		</CardContent>
	</Card>

	<div class="grid min-h-0 gap-4 lg:grid-rows-[minmax(0,1fr)_18rem]">
		<Card class="min-h-0 overflow-hidden">
			<CardHeader class="pb-3">
				<CardTitle>Agent Loop</CardTitle>
				<CardDescription>
					{#if selectedRun}
						Visualized from child-run events so you can see turns, model calls, and tool execution as a subflow.
					{:else}
						Select a child run to inspect its loop structure.
					{/if}
				</CardDescription>
			</CardHeader>
			<CardContent class="h-[34rem]">
				{#if selectedRun}
					<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<Badge variant={badgeVariant(selectedRun.status)}>{selectedRun.status}</Badge>
						<span>Node: <code>{selectedRun.nodeId}</code></span>
						<span>Mode: <code>{selectedRun.mode}</code></span>
						{#if selectedRun.workspaceRef}
							<span>Workspace: <code>{selectedRun.workspaceRef}</code></span>
						{/if}
					</div>
					<div class="h-[29rem] overflow-hidden rounded-lg border border-border">
						<SvelteFlow
							nodes={graph.nodes}
							edges={graph.edges}
							{nodeTypes}
							{edgeTypes}
							nodesDraggable={false}
							nodesConnectable={false}
							elementsSelectable={false}
							fitView
							minZoom={0.2}
							maxZoom={1.5}
						>
							<Controls />
							<Background variant={BackgroundVariant.Dots} gap={20} size={1} />
						</SvelteFlow>
					</div>
				{:else}
					<div class="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
						No agent run selected
					</div>
				{/if}
			</CardContent>
		</Card>

		<Card class="min-h-0 overflow-hidden">
			<CardHeader class="pb-3">
				<CardTitle>Agent Activity Feed</CardTitle>
				<CardDescription>Raw event stream for the selected child run.</CardDescription>
			</CardHeader>
			<CardContent class="h-[14rem] overflow-y-auto">
				{#if selectedRun && selectedEvents.length > 0}
					<div class="space-y-2">
						{#each selectedEvents as event (event.id)}
							<div class="rounded-md border border-border px-3 py-2">
								<div class="flex items-center justify-between gap-2">
									<p class="text-xs font-medium">{eventSummary(event)}</p>
									<span class="text-[10px] text-muted-foreground">{formatTime(event.timestamp)}</span>
								</div>
								<p class="mt-1 text-[10px] text-muted-foreground">
									{event.type}
									{#if event.phase}
										· {event.phase}
									{/if}
									{#if event.toolName}
										· {event.toolName}
									{/if}
								</p>
							</div>
						{/each}
					</div>
				{:else if selectedRun}
					<div class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
						No events recorded for this child run yet.
					</div>
				{:else}
					<div class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
						Select a child run to inspect its event feed.
					</div>
				{/if}
			</CardContent>
		</Card>
	</div>
</div>
