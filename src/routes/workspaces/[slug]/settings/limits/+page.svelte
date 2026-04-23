<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Gauge, ExternalLink, Activity } from 'lucide-svelte';

	type LivePayload = {
		activeSessions: number;
		byModel: Array<{
			model: string;
			sessionsLastHour: number;
			tokensInLastHour: number;
			tokensOutLastHour: number;
			tokensInLastMinute: number;
			tokensOutLastMinute: number;
		}>;
		asOf: string;
	};

	let live = $state<LivePayload | null>(null);
	let loading = $state(true);
	const slug = $derived(page.params.slug as string);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/v1/limits/live');
			if (!res.ok) {
				errorMessage = `Failed to load live usage (${res.status})`;
				return;
			}
			live = (await res.json()) as LivePayload;
			errorMessage = null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function fmt(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return n.toLocaleString();
	}

	onMount(() => {
		void load();
		// Auto-refresh every 15s — light enough at this scope, responsive
		// enough to watch a burst roll in.
		timer = setInterval(() => void load(), 15_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold flex items-center gap-2">
			<Gauge class="size-4" /> Limits
		</h2>
		<p class="text-xs text-muted-foreground mt-1">
			Rate and spend limits for this workspace.
		</p>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<Card>
		<CardHeader class="pb-2">
			<div class="flex items-center justify-between">
				<div>
					<CardTitle class="text-base flex items-center gap-2">
						<Activity class="size-4" /> Live workspace load
					</CardTitle>
					<CardDescription class="text-xs">
						Sampled every 15s from session + event records. Not a hard ceiling — providers
						still enforce their own RPM/TPM.
					</CardDescription>
				</div>
				{#if live}
					<Badge variant="outline" class="text-[10px] font-mono">
						{live.activeSessions} running
					</Badge>
				{/if}
			</div>
		</CardHeader>
		<CardContent>
			{#if loading && !live}
				<div class="py-8 text-xs text-muted-foreground text-center">Measuring…</div>
			{:else if live && live.byModel.length === 0}
				<div class="py-6 text-xs text-muted-foreground text-center">
					No activity in the last hour.
				</div>
			{:else if live}
				<table class="w-full text-xs">
					<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
						<tr>
							<th class="pb-2 font-medium">Model</th>
							<th class="pb-2 font-medium text-right">Sessions (1h)</th>
							<th class="pb-2 font-medium text-right">In / min</th>
							<th class="pb-2 font-medium text-right">Out / min</th>
							<th class="pb-2 font-medium text-right">In (1h)</th>
							<th class="pb-2 font-medium text-right">Out (1h)</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each live.byModel as row (row.model)}
							<tr>
								<td class="py-2 font-mono">{row.model}</td>
								<td class="py-2 text-right">{row.sessionsLastHour}</td>
								<td class="py-2 text-right text-muted-foreground">{fmt(row.tokensInLastMinute)}</td>
								<td class="py-2 text-right font-medium">{fmt(row.tokensOutLastMinute)}</td>
								<td class="py-2 text-right text-muted-foreground">{fmt(row.tokensInLastHour)}</td>
								<td class="py-2 text-right">{fmt(row.tokensOutLastHour)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</CardContent>
	</Card>

	<Alert>
		<AlertDescription class="text-xs">
			Self-hosted rate limiting is governed by the underlying LLM providers. See
			<a href="/workspaces/{slug}/usage" class="text-primary hover:underline">
				Usage <ExternalLink class="inline size-3" />
			</a>
			for cumulative monthly consumption.
		</AlertDescription>
	</Alert>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Rate limits (per LLM provider)</CardTitle>
			<CardDescription>
				Provider-side settings — Anthropic / Google / OpenAI each have their own quotas
				tied to your API keys in Azure Key Vault.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<table class="w-full text-xs">
				<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
					<tr>
						<th class="pb-2 font-medium">Model</th>
						<th class="pb-2 font-medium text-right">RPM</th>
						<th class="pb-2 font-medium text-right">TPM (input)</th>
						<th class="pb-2 font-medium text-right">TPM (output)</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					<tr>
						<td class="py-2">anthropic/claude-opus-4-7</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
					</tr>
					<tr>
						<td class="py-2">anthropic/claude-sonnet-4-6</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
					</tr>
				</tbody>
			</table>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Session limits</CardTitle>
			<CardDescription>
				Active session cap + per-session token ceiling. Enforced by the workflow-orchestrator.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<ul class="text-xs space-y-1 text-muted-foreground">
				<li>Concurrent sessions per workspace: unlimited (Dapr workflow capacity)</li>
				<li>Per-session max turns: 120 (default); configurable via agent config</li>
				<li>Per-session timeout: 120 minutes (default); configurable via agent config</li>
				<li>Idle session sweeper: runs daily via K8s CronJob</li>
			</ul>
		</CardContent>
	</Card>
</div>
