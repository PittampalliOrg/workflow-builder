<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { ExternalLink, ShieldCheck, Trash2, Container } from '@lucide/svelte';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';

	let {
		environment,
		busy = false,
		onteardown
	}: {
		environment: DevEnvironmentSummary;
		busy?: boolean;
		onteardown: () => void;
	} = $props();

	const ready = $derived(environment.ready && environment.runStatus !== 'error');
	const dotClass = $derived(
		environment.runStatus === 'error'
			? 'bg-red-500'
			: ready
				? 'bg-emerald-500'
				: 'bg-amber-500 animate-pulse'
	);
	const statusLabel = $derived(
		environment.runStatus === 'error' ? 'error' : ready ? 'ready' : 'provisioning'
	);
</script>

<Card>
	<CardHeader class="pb-3">
		<div class="flex items-center justify-between gap-2">
			<CardTitle class="flex items-center gap-2 text-base">
				<span class="size-7 rounded-md bg-primary/10 flex items-center justify-center">
					<Container class="size-4 text-primary" />
				</span>
				{environment.service}
			</CardTitle>
			<div class="flex items-center gap-1.5">
				<span class="size-2 rounded-full {dotClass}"></span>
				<span class="text-xs text-muted-foreground">{statusLabel}</span>
			</div>
		</div>
	</CardHeader>
	<CardContent class="space-y-4 text-sm">
		<dl class="grid grid-cols-3 gap-x-3 gap-y-2">
			<dt class="text-muted-foreground">Pod IP</dt>
			<dd class="col-span-2 font-mono text-xs">
				{environment.podIP ?? '—'}{environment.port ? `:${environment.port}` : ''}
			</dd>
			<dt class="text-muted-foreground">Run</dt>
			<dd class="col-span-2 font-mono text-xs truncate">{environment.executionId}</dd>
			{#if environment.sandboxName}
				<dt class="text-muted-foreground">Sandbox</dt>
				<dd class="col-span-2 font-mono text-xs truncate">{environment.sandboxName}</dd>
			{/if}
		</dl>

		{#if environment.needsDapr}
			<div class="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
				<div class="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300 font-medium">
					<ShieldCheck class="size-4" /> Dapr-shadow isolation
				</div>
				<div class="flex flex-wrap gap-1.5">
					<Badge variant="outline" class="text-[10px] font-mono"
						>{environment.daprAppId ?? 'unique app-id'}</Badge
					>
					<Badge variant="outline" class="text-[10px]">pubsub-dev</Badge>
					<Badge variant="outline" class="text-[10px]">real DB</Badge>
				</div>
				<p class="text-xs text-muted-foreground">
					Own task hub + isolated pubsub stream/consumer; zero prod blast radius.
				</p>
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			{#if environment.browseUrl}
				<Button size="sm" variant="default" href={environment.browseUrl} target="_blank" rel="noreferrer">
					<ExternalLink class="size-3.5" /> Open preview
				</Button>
			{/if}
			<Button
				size="sm"
				variant="ghost"
				class="ml-auto text-muted-foreground hover:text-red-600"
				disabled={busy}
				onclick={onteardown}
			>
				<Trash2 class="size-3.5" /> Teardown
			</Button>
		</div>
	</CardContent>
</Card>
