<script lang="ts">
	import {
		CheckCircle2,
		CirclePause,
		Clock,
		Filter,
		Loader2,
		MoreHorizontal,
		RefreshCw,
		Search,
		StopCircle,
		Workflow,
		XCircle
	} from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let search = $state('');
	let statusFilter = $state('all');
	let rootOnly = $state(false);
	let latestOnly = $state(false);
	let actionPending = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	const rows = $derived(
		data.overview.rows.filter((row) => {
			const needle = search.trim().toLowerCase();
			const statusOk = statusFilter === 'all' || effectiveStatus(row).toUpperCase() === statusFilter;
			if (!statusOk) return false;
			if (rootOnly && row.dapr?.parentInstanceId) return false;
			if (latestOnly && row.execution?.rerunSourceInstanceId) return false;
			if (!needle) return true;
			return `${row.instanceId} ${workflowName(row)} ${appId(row)} ${row.dapr?.message ?? ''}`
				.toLowerCase()
				.includes(needle);
		})
	);

	function appId(row: PageData['overview']['rows'][number]): string {
		return row.dapr?.appId || 'workflow-orchestrator';
	}

	function workflowName(row: PageData['overview']['rows'][number]): string {
		return row.workflow?.daprWorkflowName || row.workflow?.name || row.dapr?.workflowName || row.execution?.workflowName || 'Unknown';
	}

	function effectiveStatus(row: PageData['overview']['rows'][number]): string {
		if (row.runtimeStatus && row.runtimeStatus !== 'UNKNOWN') return row.runtimeStatus;
		if (row.dbStatus === 'success') return 'COMPLETED';
		if (row.dbStatus === 'running') return 'RUNNING';
		if (row.dbStatus === 'pending') return 'PENDING';
		if (row.dbStatus === 'error') return 'FAILED';
		if (row.dbStatus === 'cancelled') return 'TERMINATED';
		return 'UNKNOWN';
	}

	function statusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
		const normalized = (status ?? 'UNKNOWN').toUpperCase();
		if (['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(normalized)) return 'default';
		if (normalized === 'COMPLETED') return 'secondary';
		if (['FAILED', 'ERROR', 'TERMINATED', 'CANCELLED', 'CANCELED'].includes(normalized)) return 'destructive';
		return 'outline';
	}

	function statusIcon(status: string) {
		if (['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(status)) return Loader2;
		if (status === 'COMPLETED') return CheckCircle2;
		if (status === 'FAILED') return XCircle;
		if (status === 'SUSPENDED') return CirclePause;
		if (status === 'TERMINATED') return StopCircle;
		return Clock;
	}

	function formatTime(value: string | null | undefined): string {
		if (!value) return '-';
		return new Date(value).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function formatDuration(ms: number | null | undefined): string {
		if (ms == null) return '-';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
		return `${(ms / 3_600_000).toFixed(1)}h`;
	}

	function detailHref(row: PageData['overview']['rows'][number]): string {
		return `/workflow-ops/${encodeURIComponent(appId(row))}/${encodeURIComponent(row.instanceId)}`;
	}

	async function runOperation(instanceId: string, operation: 'pause' | 'resume' | 'terminate') {
		if (operation === 'terminate' && !confirm(`Terminate workflow instance ${instanceId}?`)) return;
		actionPending = `${operation}:${instanceId}`;
		actionError = null;
		try {
			const response = await fetch(`/api/workflow-ops/instances/${encodeURIComponent(instanceId)}/${operation}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(operation === 'terminate' ? { reason: 'Terminated from Workflow Ops' } : {})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body.message ?? `Failed to ${operation} workflow`);
			}
			location.reload();
		} catch (err) {
			actionError = err instanceof Error ? err.message : `Failed to ${operation} workflow`;
		} finally {
			actionPending = null;
		}
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-2">
			<Workflow size={16} class="text-muted-foreground" />
			<h1 class="text-sm font-semibold tracking-tight">Workflows</h1>
			<span class="text-xs text-muted-foreground">Project workflow store: Dapr</span>
		</div>
		<Button variant="outline" size="icon" onclick={() => location.reload()}>
			<RefreshCw size={14} />
		</Button>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mb-5 flex border-b border-border">
			<a href="/workflow-ops/names" class="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Workflows</a>
			<a href="/workflow-ops/executions" class="border-b-2 border-primary px-4 py-2 text-sm font-medium">All workflow executions</a>
		</div>

		<div class="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
			<div class="flex flex-1 flex-col gap-2 md:flex-row md:items-center">
				<label class="relative max-w-md flex-1">
					<span class="sr-only">Search</span>
					<Search size={14} class="absolute left-2.5 top-2.5 text-muted-foreground" />
					<Input class="pl-8" placeholder="Search" bind:value={search} />
				</label>
				<NativeSelect class="w-44" bind:value={statusFilter}>
					<option value="all">All statuses</option>
					<option value="RUNNING">Running</option>
					<option value="PENDING">Pending</option>
					<option value="SUSPENDED">Suspended</option>
					<option value="COMPLETED">Completed</option>
					<option value="FAILED">Failed</option>
					<option value="TERMINATED">Terminated</option>
				</NativeSelect>
				<Button variant="outline" size="sm">
					<Filter size={13} class="mr-1.5" />
					Filters
				</Button>
			</div>
			<div class="flex items-center gap-5">
				<label class="flex items-center gap-2 text-sm">
					<Switch bind:checked={rootOnly} size="sm" />
					<span>Root only</span>
				</label>
				<label class="flex items-center gap-2 text-sm">
					<Switch bind:checked={latestOnly} size="sm" />
					<span>Latest only</span>
				</label>
			</div>
		</div>

		{#if data.overview.orchestratorError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				Dapr workflow runtime unavailable: {data.overview.orchestratorError}
			</div>
		{/if}
		{#if actionError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{actionError}
			</div>
		{/if}

		<div class="overflow-hidden rounded-md border border-border">
			<Table class="w-full">
				<TableHeader>
					<TableRow class="border-b border-border bg-muted/50">
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Instance ID</TableHead>
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</TableHead>
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Name</TableHead>
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">App ID</TableHead>
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Start time</TableHead>
						<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Execution time</TableHead>
						<TableHead class="px-4 py-3 text-right text-xs font-medium text-muted-foreground"></TableHead>
					</TableRow>
				</TableHeader>
				<TableBody class="divide-y divide-border">
					{#if rows.length === 0}
						<TableRow>
							<TableCell colspan={7} class="py-12 text-center text-sm text-muted-foreground">No workflow executions matched the current filters.</TableCell>
						</TableRow>
					{:else}
						{#each rows as row (row.instanceId)}
							{@const status = effectiveStatus(row)}
							{@const Icon = statusIcon(status)}
							<TableRow class="transition-colors hover:bg-muted/30">
								<TableCell class="p-0 font-mono text-xs">
									<a class="block px-4 py-3 underline-offset-4 hover:underline" href={detailHref(row)}>{row.instanceId}</a>
								</TableCell>
								<TableCell class="p-0">
									<a class="block px-4 py-3" href={detailHref(row)}>
										<Badge variant={statusVariant(status)} class="gap-1">
											<Icon size={11} class={['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(status) ? 'animate-spin' : ''} />
											{status}
										</Badge>
									</a>
								</TableCell>
								<TableCell class="p-0 text-sm">
									<a class="block px-4 py-3" href={detailHref(row)}>{workflowName(row)}</a>
								</TableCell>
								<TableCell class="p-0 font-mono text-xs text-muted-foreground">
									<a class="block px-4 py-3" href={detailHref(row)}>{appId(row)}</a>
								</TableCell>
								<TableCell class="p-0 text-sm text-muted-foreground">
									<a class="block px-4 py-3" href={detailHref(row)}>{formatTime(row.startedAt)}</a>
								</TableCell>
								<TableCell class="p-0 text-sm text-muted-foreground">
									<a class="block px-4 py-3" href={detailHref(row)}>{formatDuration(row.durationMs)}</a>
								</TableCell>
								<TableCell class="px-4 py-3">
									<div class="flex justify-end gap-1">
										{#if ['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(status)}
											<Button variant="outline" size="sm" disabled={actionPending !== null} onclick={(event) => { event.stopPropagation(); runOperation(row.instanceId, 'pause'); }}>Pause</Button>
											<Button variant="outline" size="sm" disabled={actionPending !== null} onclick={(event) => { event.stopPropagation(); runOperation(row.instanceId, 'terminate'); }}>Terminate</Button>
										{:else if status === 'SUSPENDED'}
											<Button variant="outline" size="sm" disabled={actionPending !== null} onclick={(event) => { event.stopPropagation(); runOperation(row.instanceId, 'resume'); }}>Resume</Button>
										{:else}
											<Button variant="ghost" size="sm" href={`${detailHref(row)}#run-new-from`}>Run new from</Button>
										{/if}
										<Button variant="ghost" size="icon" aria-label="Actions">
											<MoreHorizontal size={14} />
										</Button>
									</div>
								</TableCell>
							</TableRow>
						{/each}
					{/if}
				</TableBody>
			</Table>
		</div>

		<div class="mt-3 text-xs text-muted-foreground">Total Rows: {rows.length}</div>
	</div>
</div>
