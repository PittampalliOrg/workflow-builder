<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from '@lucide/svelte';
	import type { WorkloadSnapshot, WorkloadStatus } from '$lib/server/kueueviz';
	import WorkloadStatusBadge from './workload-status-badge.svelte';

	type Props = {
		workloads: WorkloadSnapshot[];
		emptyMessage?: string;
		onSelect?: (workload: WorkloadSnapshot) => void;
	};

	let {
		workloads,
		emptyMessage = 'No workloads admitted into Kueue.',
		onSelect = undefined
	}: Props = $props();

	let textFilter = $state('');
	let statusFilter = $state<WorkloadStatus | 'all'>('all');
	let namespaceFilter = $state<string>('all');
	let queueFilter = $state<string>('all');
	let showInactive = $state(false);
	let sortKey = $state<'name' | 'namespace' | 'queueName' | 'status' | 'creationTimestamp' | 'totalPods'>(
		'creationTimestamp'
	);
	let sortDir = $state<'asc' | 'desc'>('desc');

	const namespaces = $derived(
		Array.from(new Set(workloads.map((w) => w.namespace))).filter(Boolean).sort()
	);
	const queues = $derived(
		Array.from(new Set(workloads.map((w) => w.queueName).filter(Boolean))).sort()
	);

	const statuses: Array<{ value: WorkloadStatus | 'all'; label: string }> = [
		{ value: 'all', label: 'All' },
		{ value: 'admitted', label: 'Admitted' },
		{ value: 'reserving', label: 'Reserving' },
		{ value: 'pending', label: 'Pending' },
		{ value: 'finished', label: 'Finished' },
		{ value: 'evicted', label: 'Evicted' },
		{ value: 'failed', label: 'Failed' }
	];

	const filtered = $derived.by(() => {
		const needle = textFilter.trim().toLowerCase();
		return workloads.filter((wl) => {
			if (!showInactive && (wl.status === 'finished' || wl.status === 'failed' || wl.status === 'evicted')) {
				return false;
			}
			if (statusFilter !== 'all' && wl.status !== statusFilter) return false;
			if (namespaceFilter !== 'all' && wl.namespace !== namespaceFilter) return false;
			if (queueFilter !== 'all' && wl.queueName !== queueFilter) return false;
			if (needle) {
				const haystack = `${wl.name} ${wl.namespace} ${wl.queueName} ${wl.clusterQueueName ?? ''}`.toLowerCase();
				if (!haystack.includes(needle)) return false;
			}
			return true;
		});
	});

	const sorted = $derived.by(() => {
		const arr = filtered.slice();
		arr.sort((a, b) => {
			const av = a[sortKey];
			const bv = b[sortKey];
			if (typeof av === 'number' && typeof bv === 'number') {
				return sortDir === 'asc' ? av - bv : bv - av;
			}
			const as = String(av ?? '');
			const bs = String(bv ?? '');
			return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
		});
		return arr;
	});

	function toggleSort(key: typeof sortKey): void {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = 'desc';
		}
	}

	function ageDisplay(iso: string): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '—';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	function clearFilters(): void {
		textFilter = '';
		statusFilter = 'all';
		namespaceFilter = 'all';
		queueFilter = 'all';
		showInactive = false;
	}

	const hasFilters = $derived(
		Boolean(textFilter) ||
			statusFilter !== 'all' ||
			namespaceFilter !== 'all' ||
			queueFilter !== 'all' ||
			showInactive
	);
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative flex-1 min-w-[200px]">
			<Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				bind:value={textFilter}
				placeholder="Filter by name, namespace, or queue…"
				class="pl-7 h-8 text-xs"
			/>
		</div>
		<select
			bind:value={statusFilter}
			class="h-8 rounded-md border border-input bg-background px-2 text-xs"
		>
			{#each statuses as opt (opt.value)}
				<option value={opt.value}>{opt.label}</option>
			{/each}
		</select>
		<select
			bind:value={namespaceFilter}
			class="h-8 rounded-md border border-input bg-background px-2 text-xs"
		>
			<option value="all">All namespaces</option>
			{#each namespaces as ns (ns)}
				<option value={ns}>{ns}</option>
			{/each}
		</select>
		<select
			bind:value={queueFilter}
			class="h-8 rounded-md border border-input bg-background px-2 text-xs"
		>
			<option value="all">All queues</option>
			{#each queues as q (q)}
				<option value={q}>{q}</option>
			{/each}
		</select>
		<label class="flex items-center gap-1.5 text-xs">
			<input type="checkbox" bind:checked={showInactive} class="rounded" />
			Show finished
		</label>
		{#if hasFilters}
			<Button variant="ghost" size="sm" class="h-8" onclick={clearFilters}>
				<X class="size-3" /> Clear
			</Button>
		{/if}
		<span class="ml-auto text-[11px] text-muted-foreground tabular-nums">
			{sorted.length} of {workloads.length}
		</span>
	</div>

	<Table>
		<TableHeader>
			<TableRow>
				<TableHead class="w-[110px]">
					<button class="flex items-center gap-1 font-medium" onclick={() => toggleSort('status')}>
						Status
						{#if sortKey === 'status'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
				<TableHead>
					<button class="flex items-center gap-1 font-medium" onclick={() => toggleSort('name')}>
						Workload
						{#if sortKey === 'name'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
				<TableHead class="hidden md:table-cell">
					<button class="flex items-center gap-1 font-medium" onclick={() => toggleSort('namespace')}>
						Namespace
						{#if sortKey === 'namespace'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
				<TableHead>
					<button class="flex items-center gap-1 font-medium" onclick={() => toggleSort('queueName')}>
						Queue
						{#if sortKey === 'queueName'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
				<TableHead class="hidden lg:table-cell text-right">
					<button class="ml-auto flex items-center gap-1 font-medium" onclick={() => toggleSort('totalPods')}>
						Pods
						{#if sortKey === 'totalPods'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
				<TableHead class="text-right">
					<button class="ml-auto flex items-center gap-1 font-medium" onclick={() => toggleSort('creationTimestamp')}>
						Age
						{#if sortKey === 'creationTimestamp'}
							{#if sortDir === 'asc'}
								<ArrowUp class="size-3" />
							{:else}
								<ArrowDown class="size-3" />
							{/if}
						{:else}
							<ArrowUpDown class="size-3 opacity-40" />
						{/if}
					</button>
				</TableHead>
			</TableRow>
		</TableHeader>
		<TableBody>
			{#if sorted.length === 0}
				<TableRow>
					<TableCell colspan={6} class="py-10 text-center text-xs text-muted-foreground">
						{hasFilters ? 'No workloads match the active filters.' : emptyMessage}
					</TableCell>
				</TableRow>
			{:else}
				{#each sorted as wl (wl.uid || `${wl.namespace}/${wl.name}`)}
					<TableRow
						class={onSelect ? 'cursor-pointer hover:bg-muted/40' : ''}
						onclick={() => onSelect?.(wl)}
					>
						<TableCell><WorkloadStatusBadge status={wl.status} /></TableCell>
						<TableCell>
							<div class="flex flex-col">
								<span class="font-mono text-xs truncate max-w-[260px]" title={wl.name}>{wl.name}</span>
								{#if wl.labels['agent-app-id']}
									<span class="text-[10px] text-muted-foreground font-mono truncate max-w-[260px]" title={wl.labels['agent-app-id']}>
										{wl.labels['agent-app-id']}
									</span>
								{:else if wl.labels['benchmark-instance-id']}
									<span class="text-[10px] text-muted-foreground font-mono truncate max-w-[260px]" title={wl.labels['benchmark-instance-id']}>
										inst: {wl.labels['benchmark-instance-id']}
									</span>
								{/if}
							</div>
						</TableCell>
						<TableCell class="hidden md:table-cell text-xs text-muted-foreground">{wl.namespace}</TableCell>
						<TableCell class="text-xs">
							<div class="flex flex-col">
								<span class="font-mono">{wl.queueName || '—'}</span>
								{#if wl.clusterQueueName && wl.clusterQueueName !== wl.queueName}
									<span class="text-[10px] text-muted-foreground font-mono">→ {wl.clusterQueueName}</span>
								{/if}
							</div>
						</TableCell>
						<TableCell class="hidden lg:table-cell text-right text-xs tabular-nums">
							{wl.totalPods}
						</TableCell>
						<TableCell class="text-right text-xs tabular-nums">{ageDisplay(wl.creationTimestamp)}</TableCell>
					</TableRow>
				{/each}
			{/if}
		</TableBody>
	</Table>
</div>
