<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
	import { Loader2, RefreshCw, ChevronDown, ChevronRight, Activity } from 'lucide-svelte';

	interface Instance {
		instanceId: string;
		workflowId: string;
		workflowName: string;
		status: string;
		phase?: string;
		progress?: number;
		startedAt: string;
		completedAt?: string;
		duration?: string;
	}

	interface InstanceDetail {
		nodeStatuses?: Record<string, unknown>;
		phase?: string;
		progress?: number;
		[key: string]: unknown;
	}

	let instances: Instance[] = $state([]);
	let loading = $state(true);
	let statusFilter = $state('all');
	let autoRefresh = $state(false);
	let refreshInterval: ReturnType<typeof setInterval> | null = $state(null);
	let expandedId: string | null = $state(null);
	let expandedDetail: InstanceDetail | null = $state(null);
	let loadingDetail = $state(false);

	async function loadInstances() {
		loading = true;
		try {
			const params = new URLSearchParams({ limit: '50' });
			if (statusFilter !== 'all') params.set('status', statusFilter);
			const res = await fetch(`/api/monitor?${params.toString()}`);
			if (res.ok) {
				instances = await res.json();
			}
		} catch {
			// silently fail
		} finally {
			loading = false;
		}
	}

	async function loadDetail(instanceId: string) {
		if (expandedId === instanceId) {
			expandedId = null;
			expandedDetail = null;
			return;
		}
		expandedId = instanceId;
		expandedDetail = null;
		loadingDetail = true;
		try {
			const res = await fetch(`/api/monitor/${instanceId}`);
			if (res.ok) {
				expandedDetail = await res.json();
			}
		} catch {
			expandedDetail = null;
		} finally {
			loadingDetail = false;
		}
	}

	function toggleAutoRefresh() {
		autoRefresh = !autoRefresh;
		if (autoRefresh) {
			refreshInterval = setInterval(loadInstances, 5000);
		} else if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
	}

	function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'running':
			case 'RUNNING':
				return 'default';
			case 'success':
			case 'COMPLETED':
				return 'secondary';
			case 'error':
			case 'FAILED':
				return 'destructive';
			default:
				return 'outline';
		}
	}

	function truncateId(id: string): string {
		if (!id) return '';
		return id.length > 12 ? id.slice(0, 12) + '...' : id;
	}

	function formatTime(dateStr: string | undefined): string {
		if (!dateStr) return '-';
		return new Date(dateStr).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function formatDuration(duration: string | undefined, startedAt: string, completedAt?: string): string {
		if (duration) {
			const ms = parseInt(duration);
			if (isNaN(ms)) return duration;
			if (ms < 1000) return `${ms}ms`;
			if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
			return `${(ms / 60000).toFixed(1)}m`;
		}
		if (completedAt) {
			const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
			if (ms < 1000) return `${ms}ms`;
			if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
			return `${(ms / 60000).toFixed(1)}m`;
		}
		return '-';
	}

	// Load on mount
	$effect(() => {
		loadInstances();
		return () => {
			if (refreshInterval) clearInterval(refreshInterval);
		};
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Monitor</h1>
		<div class="flex items-center gap-2">
			<!-- Status filter -->
			<NativeSelect
				class="w-full"
				bind:value={statusFilter}
				onchange={() => loadInstances()}
			>
				<option value="all">All</option>
				<option value="running">Running</option>
				<option value="success">Completed</option>
				<option value="error">Error</option>
			</NativeSelect>

			<!-- Auto-refresh toggle -->
			<Button
				variant={autoRefresh ? 'default' : 'outline'}
				size="sm"
				onclick={toggleAutoRefresh}
			>
				{autoRefresh ? 'Auto: ON' : 'Auto: OFF'}
			</Button>

			<!-- Manual refresh -->
			<Button variant="outline" size="icon" onclick={() => loadInstances()}>
				<RefreshCw class="h-4 w-4" />
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		{#if loading && instances.length === 0}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		{:else if instances.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Activity class="mb-4 h-12 w-12 text-muted-foreground/50" />
				<h2 class="text-lg font-medium text-foreground">No workflow instances</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Execute a workflow to see its instance here.
				</p>
			</div>
		{:else}
			<div class="rounded-md border border-border">
				<Table class="w-full">
					<TableHeader>
						<TableRow class="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
							<TableHead class="w-8 px-4 py-3"></TableHead>
							<TableHead class="px-4 py-3">Instance ID</TableHead>
							<TableHead class="px-4 py-3">Workflow</TableHead>
							<TableHead class="px-4 py-3">Status</TableHead>
							<TableHead class="px-4 py-3">Started</TableHead>
							<TableHead class="px-4 py-3">Duration</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{#each instances as inst (inst.instanceId)}
							<TableRow
								class="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
								onclick={() => loadDetail(inst.instanceId)}
							>
								<TableCell class="px-4 py-3">
									{#if expandedId === inst.instanceId}
										<ChevronDown class="h-4 w-4 text-muted-foreground" />
									{:else}
										<ChevronRight class="h-4 w-4 text-muted-foreground" />
									{/if}
								</TableCell>
								<TableCell class="px-4 py-3 font-mono text-sm" title={inst.instanceId}>
									{truncateId(inst.instanceId)}
								</TableCell>
								<TableCell class="px-4 py-3 text-sm">{inst.workflowName}</TableCell>
								<TableCell class="px-4 py-3">
									<Badge variant={statusVariant(inst.status)}>
										{inst.status}
									</Badge>
								</TableCell>
								<TableCell class="px-4 py-3 text-sm text-muted-foreground">
									{formatTime(inst.startedAt)}
								</TableCell>
								<TableCell class="px-4 py-3 text-sm text-muted-foreground">
									{formatDuration(inst.duration, inst.startedAt, inst.completedAt)}
								</TableCell>
							</TableRow>
							{#if expandedId === inst.instanceId}
								<TableRow class="bg-muted/20">
									<TableCell colspan={6} class="px-8 py-4">
										{#if loadingDetail}
											<div class="flex items-center gap-2 text-sm text-muted-foreground">
												<Loader2 class="h-4 w-4 animate-spin" />
												Loading details...
											</div>
										{:else if expandedDetail}
											<div class="space-y-3">
												{#if expandedDetail.phase}
													<div class="text-sm">
														<span class="font-medium">Phase:</span>
														<span class="ml-2 text-muted-foreground">{expandedDetail.phase}</span>
													</div>
												{/if}
												{#if expandedDetail.progress != null}
													<div class="text-sm">
														<span class="font-medium">Progress:</span>
														<div class="mt-1 h-2 w-64 overflow-hidden rounded-full bg-muted">
															<div
																class="h-full rounded-full bg-primary transition-all"
																style="width: {expandedDetail.progress}%"
															></div>
														</div>
														<span class="mt-1 block text-xs text-muted-foreground">{expandedDetail.progress}%</span>
													</div>
												{/if}
												{#if expandedDetail.nodeStatuses}
													<div class="text-sm">
														<span class="font-medium">Node Statuses:</span>
														<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{JSON.stringify(expandedDetail.nodeStatuses, null, 2)}</pre>
													</div>
												{/if}
											</div>
										{:else}
											<p class="text-sm text-muted-foreground">
												No detail available from orchestrator.
											</p>
										{/if}
									</TableCell>
								</TableRow>
							{/if}
						{/each}
					</TableBody>
				</Table>
			</div>
		{/if}
	</div>
</div>
