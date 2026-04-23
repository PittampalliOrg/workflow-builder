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
	import { ChevronLeft, ChevronRight, Download } from 'lucide-svelte';

	type UsagePayload = {
		range: { start: string; end: string };
		groupBy: string;
		totals: {
			tokensIn: number;
			tokensOut: number;
			cacheReadTokens: number;
			cacheCreateTokens: number;
			sessionCount: number;
			toolCalls: number;
		};
		daily: Array<{ day: string; tokensIn: number; tokensOut: number }>;
		byAgent: Array<{
			agentId: string;
			agentName: string | null;
			tokensIn: number;
			tokensOut: number;
			sessions: number;
		}>;
	};

	let data = $state<UsagePayload | null>(null);
	let loading = $state(true);
	const slug = $derived(page.params.slug as string);
	let errorMessage = $state<string | null>(null);
	let viewDate = $state(new Date());

	let monthStart = $derived(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1));
	let monthEnd = $derived(
		new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0, 23, 59, 59)
	);
	let monthLabel = $derived(
		viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
	);

	let maxDailyTokens = $derived.by(() => {
		if (!data) return 1;
		let max = 0;
		for (const d of data.daily) {
			const sum = d.tokensIn + d.tokensOut;
			if (sum > max) max = sum;
		}
		return max || 1;
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const params = new URLSearchParams({
				start: monthStart.toISOString(),
				end: monthEnd.toISOString()
			});
			const res = await fetch(`/api/v1/usage?${params}`);
			if (!res.ok) {
				errorMessage = `Failed to load usage (${res.status})`;
				return;
			}
			data = (await res.json()) as UsagePayload;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function prevMonth() {
		viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
		void load();
	}

	function nextMonth() {
		const next = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
		if (next > new Date()) return;
		viewDate = next;
		void load();
	}

	function exportCsv() {
		if (!data) return;
		const lines = [
			'day,tokensIn,tokensOut',
			...data.daily.map((d) => `${d.day},${d.tokensIn},${d.tokensOut}`)
		];
		const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `usage-${monthLabel.replace(' ', '-').toLowerCase()}.csv`;
		a.click();
		URL.revokeObjectURL(url);
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
			<h1 class="text-2xl font-semibold">Usage</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Token usage, session counts, and tool activity. Includes usage from API and UI sessions.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex items-center gap-1 rounded border px-1 h-9">
				<Button variant="ghost" size="icon" class="size-7" onclick={prevMonth}>
					<ChevronLeft class="size-4" />
				</Button>
				<span class="text-sm font-medium px-2 min-w-[120px] text-center">{monthLabel}</span>
				<Button variant="ghost" size="icon" class="size-7" onclick={nextMonth}>
					<ChevronRight class="size-4" />
				</Button>
			</div>
			<Button variant="outline" onclick={exportCsv} disabled={!data}>
				<Download class="size-4" /> Export
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-24" />
			{/each}
		</div>
		<Skeleton class="h-64" />
	{:else if data}
		<!-- Totals row -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Total tokens in
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{fmt(data.totals.tokensIn)}</div>
					<div class="text-xs text-muted-foreground">
						{fmt(data.totals.cacheReadTokens)} read from cache
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Total tokens out
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{fmt(data.totals.tokensOut)}</div>
					<div class="text-xs text-muted-foreground">
						{data.totals.sessionCount} session{data.totals.sessionCount === 1 ? '' : 's'}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Tool calls
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{fmt(data.totals.toolCalls)}</div>
					<div class="text-xs text-muted-foreground">built-in + MCP + custom</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Cache creation
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{fmt(data.totals.cacheCreateTokens)}</div>
					<div class="text-xs text-muted-foreground">written during this period</div>
				</CardContent>
			</Card>
		</div>

		<!-- Token usage chart (simple stacked bars) -->
		<Card>
			<CardHeader>
				<CardTitle class="text-base">Token usage</CardTitle>
				<CardDescription>Daily totals across all agents + sessions in this period.</CardDescription>
			</CardHeader>
			<CardContent>
				{#if data.daily.length === 0 || data.totals.tokensOut + data.totals.tokensIn === 0}
					<p class="text-sm text-muted-foreground text-center py-12">No data for this period.</p>
				{:else}
					<div class="flex items-end gap-1 h-48 overflow-x-auto">
						{#each data.daily as d}
							{@const total = d.tokensIn + d.tokensOut}
							{@const pctIn = total > 0 ? (d.tokensIn / maxDailyTokens) * 100 : 0}
							{@const pctOut = total > 0 ? (d.tokensOut / maxDailyTokens) * 100 : 0}
							<div class="flex flex-col items-center gap-1 min-w-[24px]" title="{d.day}: {fmt(d.tokensIn)} in, {fmt(d.tokensOut)} out">
								<div class="flex flex-col justify-end h-40 w-4">
									<div class="bg-primary w-full" style="height: {pctOut}%"></div>
									<div class="bg-primary/40 w-full" style="height: {pctIn}%"></div>
								</div>
								<span class="text-[9px] text-muted-foreground">
									{new Date(d.day).getDate()}
								</span>
							</div>
						{/each}
					</div>
					<div class="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
						<span class="flex items-center gap-1">
							<span class="inline-block size-3 bg-primary"></span>
							Output
						</span>
						<span class="flex items-center gap-1">
							<span class="inline-block size-3 bg-primary/40"></span>
							Input
						</span>
					</div>
				{/if}
			</CardContent>
		</Card>

		<!-- By-agent breakdown -->
		<Card>
			<CardHeader>
				<CardTitle class="text-base">By agent</CardTitle>
				<CardDescription>Top agents by output tokens.</CardDescription>
			</CardHeader>
			<CardContent>
				{#if data.byAgent.length === 0}
					<p class="text-sm text-muted-foreground text-center py-8">No sessions yet in this period.</p>
				{:else}
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
								<th class="pb-2 font-medium">Agent</th>
								<th class="pb-2 font-medium text-right">Sessions</th>
								<th class="pb-2 font-medium text-right">Tokens in</th>
								<th class="pb-2 font-medium text-right">Tokens out</th>
							</tr>
						</thead>
						<tbody>
							{#each data.byAgent as row (row.agentId)}
								<tr class="border-b last:border-0">
									<td class="py-2">
										<a
											href="/workspaces/{slug}/agents/{row.agentId}"
											class="hover:underline text-primary truncate block max-w-[400px]"
										>
											{row.agentName ?? row.agentId}
										</a>
										{#if row.agentName}
											<code class="block text-[10px] text-muted-foreground truncate max-w-[400px]">
												{row.agentId}
											</code>
										{/if}
									</td>
									<td class="py-2 text-right">{row.sessions}</td>
									<td class="py-2 text-right">{fmt(row.tokensIn)}</td>
									<td class="py-2 text-right font-medium">{fmt(row.tokensOut)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="pb-2">
				<CardTitle class="text-sm">Rate limits</CardTitle>
				<CardDescription class="text-xs">
					Track per-model and per-key rate-limit consumption.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<a href="/workspaces/{slug}/settings/limits" class="text-sm text-primary hover:underline">
					View rate limits →
				</a>
			</CardContent>
		</Card>
	{/if}
</div>
