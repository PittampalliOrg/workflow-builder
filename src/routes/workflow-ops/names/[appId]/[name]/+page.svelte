<script lang="ts">
	import { ArrowLeft, Check, Copy, Filter, Loader2, Play, RefreshCw, RotateCcw } from 'lucide-svelte';
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
	const summary = $derived(data.workflowType.summary);
	const graph = $derived(data.workflowType.graph);
	let latestOnly = $state(false);
	let selected = $state<Record<string, boolean>>({});
	let bulkOpen = $state(false);
	let bulkPending = $state(false);
	let bulkError = $state<string | null>(null);
	let bulkMessage = $state<string | null>(null);
	let bulkEventId = $state(0);
	let bulkOverrideInput = $state(false);
	let bulkInputJson = $state('{\n  \n}');

	const executions = $derived(
		data.workflowType.executions.filter((row) => !latestOnly || !row.execution?.rerunSourceInstanceId)
	);
	const selectedInstanceIds = $derived(executions.filter((row) => selected[row.instanceId]).map((row) => row.instanceId));

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

	function status(row: PageData['workflowType']['executions'][number]): string {
		if (row.runtimeStatus && row.runtimeStatus !== 'UNKNOWN') return row.runtimeStatus;
		if (row.dbStatus === 'success') return 'COMPLETED';
		if (row.dbStatus === 'running') return 'RUNNING';
		if (row.dbStatus === 'pending') return 'PENDING';
		if (row.dbStatus === 'error') return 'FAILED';
		if (row.dbStatus === 'cancelled') return 'TERMINATED';
		return 'UNKNOWN';
	}

	function statusVariant(value: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (['RUNNING', 'PENDING', 'CONTINUED_AS_NEW'].includes(value)) return 'default';
		if (value === 'COMPLETED') return 'secondary';
		if (['FAILED', 'TERMINATED', 'CANCELLED', 'CANCELED'].includes(value)) return 'destructive';
		return 'outline';
	}

	function statusSegments() {
		const counts = summary.statusCounts;
		return [
			{ label: 'Running', value: counts.running + counts.pending, class: 'bg-blue-500' },
			{ label: 'Suspended', value: counts.suspended, class: 'bg-amber-500' },
			{ label: 'Success', value: counts.completed, class: 'bg-emerald-500' },
			{ label: 'Failed', value: counts.failed + counts.terminated, class: 'bg-red-500' },
			{ label: 'Unknown', value: counts.unknown, class: 'bg-muted-foreground' }
		].filter((segment) => segment.value > 0);
	}

	async function runBulkReplay() {
		bulkPending = true;
		bulkError = null;
		bulkMessage = null;
		try {
			const response = await fetch(
				`/api/workflow-ops/workflows/${encodeURIComponent(summary.appId)}/${encodeURIComponent(summary.name)}/rerun`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						instanceIds: selectedInstanceIds,
						fromEventId: bulkEventId,
						overwriteInput: bulkOverrideInput,
						inputJson: bulkInputJson,
						reason: 'Bulk replay requested from Workflow Ops'
					})
				}
			);
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.message ?? 'Failed to replay selected executions');
			const failures = Array.isArray(body.results) ? body.results.filter((item: { success?: boolean }) => !item.success) : [];
			bulkMessage = failures.length
				? `${selectedInstanceIds.length - failures.length} replay requests started, ${failures.length} failed.`
				: `${selectedInstanceIds.length} replay request${selectedInstanceIds.length === 1 ? '' : 's'} started.`;
			bulkOpen = false;
		} catch (err) {
			bulkError = err instanceof Error ? err.message : 'Failed to replay selected executions';
		} finally {
			bulkPending = false;
		}
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex min-w-0 items-center gap-3">
			<Button variant="ghost" size="icon" href="/workflow-ops/names">
				<ArrowLeft size={15} />
			</Button>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<h1 class="truncate text-sm font-semibold tracking-tight">{summary.name}</h1>
					<Badge variant="outline">{summary.version ?? 'Non-versioned'}</Badge>
				</div>
				<div class="truncate font-mono text-[11px] text-muted-foreground">App ID: {summary.appId}</div>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" href="/workflows">
				<Play size={13} class="mr-1.5" />
				Start new
			</Button>
			<Button variant="outline" size="icon" onclick={() => location.reload()}>
				<RefreshCw size={14} />
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
			<a class="hover:text-foreground" href="/workflow-ops/names">Workflows</a>
			<span>/</span>
			<span class="text-foreground">{summary.name}</span>
		</div>

		{#if data.workflowType.orchestratorError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				Dapr workflow runtime unavailable: {data.workflowType.orchestratorError}
			</div>
		{/if}
		{#if bulkMessage}
			<div class="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">{bulkMessage}</div>
		{/if}

		<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
			<section class="rounded-md border border-border p-4">
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Workflow graph</h2>
					<Badge variant="outline">{graph.source}</Badge>
				</div>
				{#if graph.nodes.length === 0}
					<div class="flex min-h-52 items-center justify-center rounded border border-dashed border-border text-sm text-muted-foreground">
						No graph data is available yet.
					</div>
				{:else}
					<div class="flex min-h-52 items-center gap-3 overflow-x-auto rounded border border-border bg-muted/20 p-4">
						{#each graph.nodes as node, index (node.id)}
							<div class="min-w-36 rounded-md border border-border bg-background p-3">
								<div class="text-[11px] uppercase tracking-wide text-muted-foreground">{node.kind}</div>
								<div class="mt-1 truncate text-sm font-medium">{node.name}</div>
							</div>
							{#if index < graph.nodes.length - 1}
								<div class="h-px min-w-8 bg-border"></div>
							{/if}
						{/each}
					</div>
				{/if}
			</section>

			<section class="rounded-md border border-border p-4">
				<h2 class="text-sm font-semibold">Execution Status Breakdown</h2>
				<div class="mt-3 flex items-baseline gap-2">
					<span class="text-xs uppercase text-muted-foreground">Total</span>
					<span class="text-2xl font-semibold">{summary.totalExecutions}</span>
				</div>
				<div class="mt-4 h-3 overflow-hidden rounded bg-muted">
					{#each statusSegments() as segment}
						<div class="{segment.class} inline-block h-full" title={`${segment.label}: ${segment.value}`} style={`width: ${(segment.value / Math.max(1, summary.statusCounts.total)) * 100}%`}></div>
					{/each}
				</div>
				<div class="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
					<div>Success: {summary.statusCounts.completed}</div>
					<div>Failed: {summary.statusCounts.failed}</div>
					<div>Running: {summary.statusCounts.running}</div>
					<div>Suspended: {summary.statusCounts.suspended}</div>
				</div>
			</section>
		</div>

		<section class="mt-5">
			<div class="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div class="flex items-center gap-2">
					<h2 class="text-sm font-semibold">Executions</h2>
					<Button variant="outline" size="sm">
						<Filter size={13} class="mr-1.5" />
						Filters
					</Button>
					<label class="flex items-center gap-2 text-sm">
						<Switch bind:checked={latestOnly} size="sm" />
						<span>Latest only</span>
					</label>
				</div>
				<div class="flex items-center gap-2">
					<Button variant="outline" size="sm" disabled={selectedInstanceIds.length === 0} onclick={() => (bulkOpen = true)}>
						<RotateCcw size={13} class="mr-1.5" />
						Rerun selected ({selectedInstanceIds.length})
					</Button>
					<Button variant="outline" size="icon" onclick={() => location.reload()}>
						<RefreshCw size={14} />
					</Button>
				</div>
			</div>

			<div class="overflow-hidden rounded-md border border-border">
				<Table class="w-full">
					<TableHeader>
						<TableRow class="border-b border-border bg-muted/50">
							<TableHead class="w-10 px-4 py-3"></TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Instance ID</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Version</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Start time</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Execution time</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody class="divide-y divide-border">
						{#if executions.length === 0}
							<TableRow>
								<TableCell colspan={6} class="py-12 text-center text-sm text-muted-foreground">No executions are available for this workflow.</TableCell>
							</TableRow>
						{:else}
							{#each executions as row (row.instanceId)}
								{@const currentStatus = status(row)}
								<TableRow class="transition-colors hover:bg-muted/30">
									<TableCell class="px-4 py-3" onclick={(event) => event.stopPropagation()}>
										<input type="checkbox" bind:checked={selected[row.instanceId]} aria-label={`Select ${row.instanceId}`} />
									</TableCell>
									<TableCell class="p-0 font-mono text-xs">
										<a
											class="block px-4 py-3 underline-offset-4 hover:underline"
											href={`/workflow-ops/${encodeURIComponent(summary.appId)}/${encodeURIComponent(row.instanceId)}`}
										>
											{row.instanceId}
										</a>
									</TableCell>
									<TableCell class="p-0">
										<a class="block px-4 py-3" href={`/workflow-ops/${encodeURIComponent(summary.appId)}/${encodeURIComponent(row.instanceId)}`}>
											<Badge variant={statusVariant(currentStatus)}>{currentStatus}</Badge>
										</a>
									</TableCell>
									<TableCell class="p-0 text-sm text-muted-foreground">
										<a class="block px-4 py-3" href={`/workflow-ops/${encodeURIComponent(summary.appId)}/${encodeURIComponent(row.instanceId)}`}>{row.dapr?.workflowVersion ?? 'Non-versioned'}</a>
									</TableCell>
									<TableCell class="p-0 text-sm text-muted-foreground">
										<a class="block px-4 py-3" href={`/workflow-ops/${encodeURIComponent(summary.appId)}/${encodeURIComponent(row.instanceId)}`}>{formatTime(row.startedAt)}</a>
									</TableCell>
									<TableCell class="p-0 text-sm text-muted-foreground">
										<a class="block px-4 py-3" href={`/workflow-ops/${encodeURIComponent(summary.appId)}/${encodeURIComponent(row.instanceId)}`}>{formatDuration(row.durationMs)}</a>
									</TableCell>
								</TableRow>
							{/each}
						{/if}
					</TableBody>
				</Table>
			</div>
			<div class="mt-3 text-xs text-muted-foreground">Total Rows: {executions.length}</div>
		</section>
	</div>
</div>

<Dialog open={bulkOpen} onOpenChange={(value) => (bulkOpen = value)}>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>Confirm bulk rerun</DialogTitle>
			<DialogDescription>
				Rerun {selectedInstanceIds.length} selected workflow execution{selectedInstanceIds.length === 1 ? '' : 's'} from a Dapr history event.
			</DialogDescription>
		</DialogHeader>
		{#if bulkError}
			<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{bulkError}</div>
		{/if}
		<div class="space-y-3">
			<div class="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
				All selected reruns use each original run's input unless input override is enabled. Make sure the workflow application is running.
			</div>
			<label class="block text-xs font-medium text-muted-foreground" for="bulk-event">Event ID</label>
			<Input id="bulk-event" type="number" min="0" bind:value={bulkEventId} />
			<label class="flex items-start gap-2 text-xs text-muted-foreground">
				<input type="checkbox" class="mt-0.5" bind:checked={bulkOverrideInput} />
				<span>Override input for all selected reruns</span>
			</label>
			{#if bulkOverrideInput}
				<textarea
					class="min-h-32 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
					bind:value={bulkInputJson}
					aria-label="Bulk rerun input JSON"
				></textarea>
			{/if}
			<div class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
				Choosing an event ID that does not exist on every selected execution can produce partial failures.
			</div>
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (bulkOpen = false)}>Cancel</Button>
			<Button disabled={bulkPending || selectedInstanceIds.length === 0} onclick={runBulkReplay}>
				{#if bulkPending}
					<Loader2 size={14} class="animate-spin" />
				{:else}
					<Check size={14} />
				{/if}
				Rerun selected
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
