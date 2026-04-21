<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { formatDistanceToNow } from 'date-fns';
	import { Loader2, CheckCircle2, XCircle, Clock, ExternalLink, Bot } from 'lucide-svelte';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Badge } from '$lib/components/ui/badge';
	import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
	import { wsPath } from '$lib/utils/workspace-path';

	let workflowId = $derived(page.params.workflowId);
	let workflowName = $state<string>('');

	async function fetchWorkflowName() {
		try {
			const res = await fetch(`/api/workflows/${workflowId}`);
			if (res.ok) {
				const data = await res.json();
				workflowName = data?.name ?? '';
			}
		} catch {
			// Fall back to id-only label.
		}
	}

	interface Execution {
		id: string;
		status: string;
		startTime?: string;
		createdAt?: string;
		startedAt?: string;
		endTime?: string;
		completedAt?: string;
		/** Set by /runs-summary: bridge-spawned sessions for this run. */
		sessionIds?: string[];
		/** Set by /runs-summary: agents those sessions used. */
		agents?: Array<{ id: string; name: string }>;
	}

	let executions = $state<Execution[]>([]);
	let isLoading = $state(true);
	let error = $state<string | null>(null);

	const hasRunning = $derived(
		executions.some(
			(e) => e.status === 'RUNNING' || e.status === 'running' || e.status === 'PENDING'
		)
	);

	async function fetchExecutions() {
		try {
			const res = await fetch(`/api/workflows/${workflowId}/runs-summary`);
			if (!res.ok) throw new Error('Failed to fetch executions');
			const data = await res.json();
			executions = Array.isArray(data) ? data : data.executions ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load executions';
		} finally {
			isLoading = false;
		}
	}

	function renderAgents(agents: Execution['agents']): string {
		if (!agents || agents.length === 0) return '';
		if (agents.length <= 2) return agents.map((a) => a.name).join(', ');
		return `${agents[0].name}, ${agents[1].name} +${agents.length - 2} more`;
	}

	function formatDuration(exec: Execution): string {
		const start = exec.startTime ?? exec.startedAt ?? exec.createdAt;
		if (!start) return '-';
		const startDate = new Date(start);
		const end = exec.endTime ?? exec.completedAt;
		const endDate = end ? new Date(end) : new Date();
		const ms = endDate.getTime() - startDate.getTime();
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}

	function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status.toUpperCase()) {
			case 'RUNNING':
			case 'PENDING':
				return 'default';
			case 'COMPLETED':
			case 'SUCCESS':
				return 'secondary';
			case 'FAILED':
			case 'ERROR':
				return 'destructive';
			default:
				return 'outline';
		}
	}

	// Initial fetch
	$effect(() => {
		fetchExecutions();
		fetchWorkflowName();
	});

	// Auto-refresh when running executions exist
	let refreshInterval: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		if (hasRunning) {
			refreshInterval = setInterval(fetchExecutions, 5000);
		} else if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
	});

	onDestroy(() => {
		if (refreshInterval) clearInterval(refreshInterval);
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center gap-4 border-b border-border px-6">
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
					<Breadcrumb.Page class="text-xs font-semibold">Runs</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
		<a
			href={`/workspaces/default/sessions?source=workflow&q=${workflowId}`}
			class="ml-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
			title="Sessions spawned by any run of this workflow"
		>
			Sessions
			<ExternalLink class="size-3" />
		</a>
		{#if hasRunning}
			<span class="flex items-center gap-1 text-xs text-muted-foreground">
				<span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
				Auto-refreshing
			</span>
		{/if}
	</header>

	<div class="flex-1 overflow-auto p-6">
		{#if isLoading}
			<div class="flex items-center justify-center py-12">
				<Loader2 size={24} class="animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<div class="flex flex-col items-center justify-center py-12 gap-2">
				<XCircle size={24} class="text-red-500" />
				<p class="text-sm text-muted-foreground">{error}</p>
			</div>
		{:else if executions.length === 0}
			<div class="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
				<Clock size={24} />
				<p class="text-sm">No executions yet for this workflow.</p>
			</div>
		{:else}
			<div class="rounded-lg border border-border overflow-hidden">
				<Table class="w-full">
					<TableHeader>
						<TableRow class="border-b border-border bg-muted/50">
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Execution ID</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Agent</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Session</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Started</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Duration</TableHead>
							<TableHead class="px-4 py-3 text-right text-xs font-medium text-muted-foreground"></TableHead>
						</TableRow>
					</TableHeader>
					<TableBody class="divide-y divide-border">
						{#each executions as exec (exec.id)}
							{@const startStr = exec.startTime ?? exec.startedAt ?? exec.createdAt}
							<TableRow
								class="hover:bg-muted/30 transition-colors cursor-pointer"
								onclick={() => goto(`/workflows/${workflowId}/runs/${exec.id}`)}
							>
								<TableCell class="px-4 py-3">
									<code class="text-xs">{exec.id.slice(0, 8)}</code>
								</TableCell>
								<TableCell class="px-4 py-3">
									<Badge variant={statusVariant(exec.status)} class="flex w-fit items-center gap-1">
										{#if exec.status === 'RUNNING' || exec.status === 'running' || exec.status === 'PENDING'}
											<Loader2 size={12} class="animate-spin" />
										{:else if exec.status.toUpperCase() === 'COMPLETED' || exec.status.toUpperCase() === 'SUCCESS'}
											<CheckCircle2 size={12} />
										{:else if exec.status.toUpperCase() === 'FAILED' || exec.status.toUpperCase() === 'ERROR'}
											<XCircle size={12} />
										{:else}
											<Clock size={12} />
										{/if}
										{exec.status}
									</Badge>
								</TableCell>
								<TableCell class="px-4 py-3 text-sm">
									{#if exec.agents && exec.agents.length > 0}
										<div class="flex items-center gap-1.5 text-muted-foreground">
											<Bot size={12} />
											<span class="truncate max-w-[200px]" title={exec.agents.map((a) => a.name).join(', ')}>
												{renderAgents(exec.agents)}
											</span>
										</div>
									{:else}
										<span class="text-xs italic text-muted-foreground/60">—</span>
									{/if}
								</TableCell>
								<TableCell class="px-4 py-3 text-sm">
									{#if exec.sessionIds && exec.sessionIds.length === 1}
										<a
											href={wsPath(null, `sessions/${exec.sessionIds[0]}`)}
											onclick={(e) => e.stopPropagation()}
											class="text-xs text-primary hover:underline"
										>
											{exec.sessionIds[0].slice(0, 8)}
										</a>
									{:else if exec.sessionIds && exec.sessionIds.length > 1}
										<span class="text-xs text-muted-foreground" title={exec.sessionIds.join('\n')}>
											{exec.sessionIds.length} sessions
										</span>
									{:else}
										<span class="text-xs italic text-muted-foreground/60">—</span>
									{/if}
								</TableCell>
								<TableCell class="px-4 py-3 text-sm text-muted-foreground">
									{#if startStr}
										{formatDistanceToNow(new Date(startStr), { addSuffix: true })}
									{:else}
										-
									{/if}
								</TableCell>
								<TableCell class="px-4 py-3 text-sm text-muted-foreground">
									{formatDuration(exec)}
								</TableCell>
								<TableCell class="px-4 py-3 text-right">
									<ExternalLink size={14} class="text-muted-foreground" />
								</TableCell>
							</TableRow>
						{/each}
					</TableBody>
				</Table>
			</div>
		{/if}
	</div>
</div>
