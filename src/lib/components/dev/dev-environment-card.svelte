<script lang="ts" module>
	export interface DevEnvironmentSummary {
		executionId: string;
		workspaceRef: string;
		service: string;
		browseUrl: string | null;
		podIP: string | null;
		port: number | null;
		syncUrl: string | null;
		ready: boolean;
		needsDapr: boolean;
		daprAppId: string | null;
		sandboxName: string | null;
		sessionId: string | null;
		sessionUrl: string | null;
		runStatus: string | null;
		createdAt: string;
	}
</script>

<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader } from '$lib/components/ui/card';
	import {
		Container,
		ExternalLink,
		Loader2,
		MessagesSquare,
		Trash2,
		ShieldCheck
	} from '@lucide/svelte';

	let {
		environment,
		slug,
		busy = false,
		busyLabel = null,
		services = [],
		onopen,
		onteardown
	}: {
		environment: DevEnvironmentSummary;
		slug: string;
		busy?: boolean;
		busyLabel?: string | null;
		/** B5: every per-service preview of the execution (multi-service session). */
		services?: DevEnvironmentSummary[];
		onopen: (e: DevEnvironmentSummary) => void;
		onteardown: (e: DevEnvironmentSummary) => void;
	} = $props();

	const multiService = $derived(services.length > 1);

	const ready = $derived(environment.ready && environment.runStatus !== 'error');
	const dotClass = $derived(
		busy
			? 'bg-amber-500 animate-pulse'
			: environment.runStatus === 'error'
			? 'bg-red-500'
			: ready
				? 'bg-emerald-500'
				: 'bg-amber-500 animate-pulse'
	);
	const statusLabel = $derived(
		busy
			? 'tearing down'
			: environment.runStatus === 'error'
			? 'error'
			: ready
				? 'ready'
				: 'provisioning'
	);

	function relative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}
</script>

<Card class="overflow-hidden transition-shadow hover:shadow-md">
	<CardHeader class="pb-2">
		<div class="flex items-start justify-between gap-2">
			<button
				type="button"
				class="flex items-center gap-2 text-left min-w-0"
				onclick={() => onopen(environment)}
			>
				<span class="size-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
					<Container class="size-4 text-primary" />
				</span>
				<span class="min-w-0">
					<span class="block font-medium truncate hover:underline"
						>{multiService ? services.map((s) => s.service).join(' + ') : environment.service}</span
					>
					<span class="block text-xs text-muted-foreground">{relative(environment.createdAt)}</span>
				</span>
			</button>
			<div class="flex items-center gap-1.5 shrink-0">
				<span class="size-2 rounded-full {dotClass}"></span>
				<span class="text-xs text-muted-foreground">{statusLabel}</span>
			</div>
		</div>
	</CardHeader>
	<CardContent class="space-y-3">
		{#if busy && busyLabel}
			<div
				class="flex min-h-8 items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
				role="status"
				aria-live="polite"
			>
				<Loader2 class="size-3.5 shrink-0 motion-safe:animate-spin" />
				<span>{busyLabel}</span>
			</div>
		{/if}
		{#if multiService}
			<div class="flex flex-wrap items-center gap-1.5">
				{#each services as svc (svc.service)}
					<Badge variant="outline" class="text-[10px] gap-1">
						<span
							class="size-1.5 rounded-full {svc.ready ? 'bg-emerald-500' : 'bg-amber-500'}"
						></span>
						{svc.service}
					</Badge>
				{/each}
			</div>
		{/if}
		<div class="flex flex-wrap items-center gap-1.5">
			{#if environment.needsDapr}
				<Badge
					variant="outline"
					class="text-[10px] gap-1 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-transparent"
				>
					<ShieldCheck class="size-3" /> Dapr-shadow
				</Badge>
			{/if}
			{#if environment.daprAppId}
				<Badge variant="outline" class="text-[10px] font-mono">{environment.daprAppId}</Badge>
			{/if}
			{#if environment.podIP}
				<Badge variant="outline" class="text-[10px] font-mono text-muted-foreground"
					>{environment.podIP}{environment.port ? `:${environment.port}` : ''}</Badge
				>
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button size="sm" variant="default" onclick={() => onopen(environment)}>Open</Button>
			{#if environment.browseUrl}
				<Button size="sm" variant="outline" href={environment.browseUrl} target="_blank" rel="noreferrer">
					<ExternalLink class="size-3.5" /> Preview
				</Button>
			{/if}
			{#if environment.sessionUrl}
				<Button size="sm" variant="ghost" href={environment.sessionUrl}>
					<MessagesSquare class="size-3.5" /> Session
				</Button>
			{/if}
			<Button
				size="sm"
				variant="ghost"
				class="ml-auto text-muted-foreground hover:text-red-600"
				disabled={busy}
				onclick={() => onteardown(environment)}
			>
				{#if busy}
					<Loader2 class="size-3.5 motion-safe:animate-spin" /> Teardown…
				{:else}
					<Trash2 class="size-3.5" /> Teardown
				{/if}
			</Button>
		</div>
	</CardContent>
</Card>
