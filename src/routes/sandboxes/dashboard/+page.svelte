<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Loader2, RefreshCw, Container, ArrowLeft } from '@lucide/svelte';

	interface Stats {
		total: number;
		byPhase: Record<string, number>;
		executions24h: number;
		avgAgeMinutes: number;
	}

	let stats = $state<Stats | null>(null);
	let loading = $state(true);
	let webhookUrl = $state(localStorage.getItem('sandbox-webhook-url') ?? '');
	let webhookEvents = $state<string[]>(
		JSON.parse(localStorage.getItem('sandbox-webhook-events') ?? '["READY","ERROR","DELETING"]')
	);

	async function loadStats() {
		loading = true;
		try {
			const res = await fetch('/api/sandboxes/stats');
			if (res.ok) stats = await res.json();
		} catch {
			// silent
		} finally {
			loading = false;
		}
	}

	function saveWebhookConfig() {
		localStorage.setItem('sandbox-webhook-url', webhookUrl);
		localStorage.setItem('sandbox-webhook-events', JSON.stringify(webhookEvents));
	}

	function toggleWebhookEvent(event: string) {
		if (webhookEvents.includes(event)) {
			webhookEvents = webhookEvents.filter((e) => e !== event);
		} else {
			webhookEvents = [...webhookEvents, event];
		}
		saveWebhookConfig();
	}

	function formatAge(mins: number): string {
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		return `${hrs}h ${mins % 60}m`;
	}

	$effect(() => {
		loadStats();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-3">
			<a href="/sandboxes" class="text-muted-foreground hover:text-foreground">
				<ArrowLeft class="h-4 w-4" />
			</a>
			<h1 class="text-sm font-semibold tracking-tight">Sandbox Dashboard</h1>
		</div>
		<Button variant="outline" size="icon" class="h-8 w-8" onclick={loadStats}>
			<RefreshCw class="h-3.5 w-3.5" />
		</Button>
	</header>

	<div class="flex-1 overflow-auto p-6">
		{#if loading && !stats}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		{:else if stats}
			<!-- Metrics Strip -->
			<div class="grid grid-cols-4 gap-4 mb-8">
				<div class="rounded-lg border border-border p-4">
					<p class="text-xs text-muted-foreground">Active Sandboxes</p>
					<p class="text-2xl font-bold mt-1">{stats.total}</p>
				</div>
				<div class="rounded-lg border border-border p-4">
					<p class="text-xs text-muted-foreground">Executions (24h)</p>
					<p class="text-2xl font-bold mt-1">{stats.executions24h}</p>
				</div>
				<div class="rounded-lg border border-border p-4">
					<p class="text-xs text-muted-foreground">Avg Sandbox Age</p>
					<p class="text-2xl font-bold mt-1">{formatAge(stats.avgAgeMinutes)}</p>
				</div>
				<div class="rounded-lg border border-border p-4">
					<p class="text-xs text-muted-foreground">GC Threshold</p>
					<p class="text-2xl font-bold mt-1">4h</p>
				</div>
			</div>

			<!-- Phase Distribution -->
			<div class="rounded-lg border border-border p-4 mb-8">
				<h3 class="text-sm font-semibold mb-4">Phase Distribution</h3>
				<div class="flex items-end gap-3 h-32">
					{#each Object.entries(stats.byPhase) as [phase, count]}
						{@const maxCount = Math.max(...Object.values(stats.byPhase))}
						{@const height = maxCount > 0 ? (count / maxCount) * 100 : 0}
						<div class="flex flex-col items-center gap-1 flex-1">
							<span class="text-xs font-mono">{count}</span>
							<div
								class="w-full rounded-t transition-all {phase === 'READY' ? 'bg-green-500' : phase === 'ERROR' ? 'bg-red-500' : phase === 'PROVISIONING' ? 'bg-yellow-500' : 'bg-muted-foreground/30'}"
								style="height: {height}%"
							></div>
							<span class="text-[10px] text-muted-foreground">{phase}</span>
						</div>
					{/each}
				</div>
			</div>

			<!-- Webhook Configuration -->
			<div class="rounded-lg border border-border p-4">
				<h3 class="text-sm font-semibold mb-3">Webhook Notifications</h3>
				<p class="text-xs text-muted-foreground mb-3">
					Send HTTP POST when sandbox phase changes.
				</p>
				<div class="space-y-3">
					<div>
						<label for="webhook-url" class="text-xs font-medium">Webhook URL</label>
						<input
							id="webhook-url"
							type="url"
							bind:value={webhookUrl}
							onblur={saveWebhookConfig}
							placeholder="https://hooks.slack.com/services/..."
							class="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
						/>
					</div>
					<div>
						<label class="text-xs font-medium">Events</label>
						<div class="flex flex-wrap gap-2 mt-1">
							{#each ['PROVISIONING', 'READY', 'ERROR', 'DELETING'] as event}
								<button
									onclick={() => toggleWebhookEvent(event)}
									class="rounded-full border px-3 py-1 text-xs transition-colors {webhookEvents.includes(event) ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-foreground/30'}"
								>
									{event}
								</button>
							{/each}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
