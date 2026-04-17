<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { DollarSign, Download, Info } from 'lucide-svelte';

	type CostPayload = {
		range: { start: string; end: string };
		totalCost: number;
		priceBook: Array<{ model: string; inputPerMillion: number; outputPerMillion: number }>;
		byAgent: Array<{ agentId: string; agentName: string; sessions: number; cost: number }>;
		byModel: Array<{
			model: string;
			sessions: number;
			inputTokens: number;
			outputTokens: number;
			cost: number;
		}>;
	};

	let data = $state<CostPayload | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let rangeDays = $state(30);

	let apiKeyFilter = $derived(page.url.searchParams.get('api_key'));

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const end = new Date();
			const start = new Date(end.getTime() - rangeDays * 24 * 60 * 60 * 1000);
			const params = new URLSearchParams({
				start: start.toISOString(),
				end: end.toISOString()
			});
			if (apiKeyFilter) params.set('api_key', apiKeyFilter);
			const res = await fetch(`/api/v1/cost?${params}`);
			if (!res.ok) {
				errorMessage = `Failed to load cost (${res.status})`;
				return;
			}
			data = (await res.json()) as CostPayload;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function setRange(days: number) {
		rangeDays = days;
		void load();
	}

	function exportCsv() {
		if (!data) return;
		const lines = [
			'model,sessions,inputTokens,outputTokens,costUsd',
			...data.byModel.map(
				(m) => `${m.model},${m.sessions},${m.inputTokens},${m.outputTokens},${m.cost.toFixed(4)}`
			)
		];
		const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `cost-${rangeDays}d.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function fmtUsd(n: number): string {
		if (n < 0.01 && n > 0) return '<$0.01';
		if (n >= 1000) return `$${n.toFixed(0)}`;
		return `$${n.toFixed(2)}`;
	}

	function fmt(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return n.toLocaleString();
	}

	onMount(load);
</script>

<div class="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<DollarSign class="size-6" /> Cost
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Cost estimates based on token usage × model catalog pricing.
			</p>
			{#if apiKeyFilter}
				<Badge variant="outline" class="mt-2">Filtered by API key: {apiKeyFilter}</Badge>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<div class="flex items-center rounded border h-9">
				{#each [7, 30, 90] as days (days)}
					<button
						type="button"
						class="px-3 text-sm h-full {rangeDays === days
							? 'bg-accent'
							: 'hover:bg-accent/50'}"
						onclick={() => setRange(days)}
					>
						{days}d
					</button>
				{/each}
			</div>
			<Button variant="outline" onclick={exportCsv} disabled={!data}>
				<Download class="size-4" /> Export
			</Button>
		</div>
	</header>

	<Alert>
		<Info class="size-4" />
		<AlertDescription class="text-xs">
			Prices are estimates using the public model catalog rates. Actual billing may differ due to
			prompt caching, volume discounts, or provider-specific pricing tiers.
		</AlertDescription>
	</Alert>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading}
		<Skeleton class="h-24" />
		<Skeleton class="h-64" />
	{:else if data}
		<Card>
			<CardHeader class="pb-2">
				<CardDescription class="text-[11px] uppercase tracking-wide">
					Estimated cost — last {rangeDays} days
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div class="text-4xl font-semibold">{fmtUsd(data.totalCost)}</div>
				<div class="text-xs text-muted-foreground mt-1">
					Across {data.byAgent.length} agent{data.byAgent.length === 1 ? '' : 's'} ·
					{data.byModel.length} model{data.byModel.length === 1 ? '' : 's'}
				</div>
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="text-base">By model</CardTitle>
				<CardDescription>Token usage and cost broken down per model.</CardDescription>
			</CardHeader>
			<CardContent>
				{#if data.byModel.length === 0}
					<p class="text-sm text-muted-foreground text-center py-8">
						No sessions yet in this period.
					</p>
				{:else}
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
								<th class="pb-2 font-medium">Model</th>
								<th class="pb-2 font-medium text-right">Sessions</th>
								<th class="pb-2 font-medium text-right">Tokens in</th>
								<th class="pb-2 font-medium text-right">Tokens out</th>
								<th class="pb-2 font-medium text-right">Cost</th>
							</tr>
						</thead>
						<tbody>
							{#each data.byModel as row (row.model)}
								<tr class="border-b last:border-0">
									<td class="py-2 font-mono text-xs">{row.model}</td>
									<td class="py-2 text-right">{row.sessions}</td>
									<td class="py-2 text-right">{fmt(row.inputTokens)}</td>
									<td class="py-2 text-right">{fmt(row.outputTokens)}</td>
									<td class="py-2 text-right font-medium">{fmtUsd(row.cost)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="text-base">By agent</CardTitle>
				<CardDescription>Top agents by cost.</CardDescription>
			</CardHeader>
			<CardContent>
				{#if data.byAgent.length === 0}
					<p class="text-sm text-muted-foreground text-center py-8">
						No sessions yet in this period.
					</p>
				{:else}
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
								<th class="pb-2 font-medium">Agent</th>
								<th class="pb-2 font-medium text-right">Sessions</th>
								<th class="pb-2 font-medium text-right">Cost</th>
							</tr>
						</thead>
						<tbody>
							{#each data.byAgent as row (row.agentId)}
								<tr class="border-b last:border-0">
									<td class="py-2">
										<a
											href="/agents/{row.agentId}"
											class="hover:underline text-primary truncate block max-w-[500px]"
										>
											{row.agentName}
										</a>
									</td>
									<td class="py-2 text-right">{row.sessions}</td>
									<td class="py-2 text-right font-medium">{fmtUsd(row.cost)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="text-base">Price book</CardTitle>
				<CardDescription>Per-million-token pricing used for these estimates.</CardDescription>
			</CardHeader>
			<CardContent>
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
							<th class="pb-2 font-medium">Model</th>
							<th class="pb-2 font-medium text-right">Input / 1M</th>
							<th class="pb-2 font-medium text-right">Output / 1M</th>
						</tr>
					</thead>
					<tbody>
						{#each data.priceBook as row (row.model)}
							<tr class="border-b last:border-0">
								<td class="py-2 font-mono">{row.model}</td>
								<td class="py-2 text-right">${row.inputPerMillion.toFixed(2)}</td>
								<td class="py-2 text-right">${row.outputPerMillion.toFixed(2)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</CardContent>
		</Card>
	{/if}
</div>
