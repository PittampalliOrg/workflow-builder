<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { AlertTriangle, CheckCircle2, ShieldCheck } from '@lucide/svelte';
	import type { CapacityCoverageSummary } from '$lib/types/capacity';

	type Props = {
		coverage: CapacityCoverageSummary | null | undefined;
	};

	let { coverage }: Props = $props();

	const managedCount = $derived(coverage?.counts.kueue_managed ?? 0);
	const gapCount = $derived(coverage?.counts.gap ?? 0);
	const supplementalCount = $derived(coverage?.counts.supplemental_lease ?? 0);
	const required136 = $derived(coverage?.kubernetes136.filter((feature) => feature.required) ?? []);
</script>

<section class="rounded-md border bg-card p-4">
	<header class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<ShieldCheck class="size-4 text-muted-foreground" />
			<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Capacity Coverage
			</h2>
		</div>
		<div class="flex flex-wrap gap-1.5">
			<Badge variant="outline" class="font-mono text-[10px]">
				{managedCount} Kueue-managed
			</Badge>
			<Badge variant="outline" class="font-mono text-[10px]">
				{supplementalCount} supplemental leases
			</Badge>
			<Badge
				variant="outline"
				class="font-mono text-[10px] {gapCount > 0 ? 'border-amber-500/50 text-amber-700 dark:text-amber-300' : ''}"
			>
				{gapCount} gaps
			</Badge>
		</div>
	</header>

	{#if !coverage}
		<p class="mt-3 text-xs text-muted-foreground">Coverage summary unavailable.</p>
	{:else}
		<div class="mt-3 grid gap-3 lg:grid-cols-[1.6fr_1fr]">
			<div class="min-w-0">
				<div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
					{#each coverage.paths.filter((path) => path.status === 'kueue_managed') as path (path.id)}
						<div class="rounded border px-2.5 py-2 text-xs">
							<div class="flex items-center justify-between gap-2">
								<span class="truncate font-medium" title={path.label}>{path.label}</span>
								<CheckCircle2 class="size-3.5 shrink-0 text-emerald-500" />
							</div>
							<div class="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
								{#if path.queue}
									<span class="rounded bg-muted px-1.5 py-0.5 font-mono">{path.queue}</span>
								{/if}
								{#if path.priorityClass}
									<span class="rounded bg-muted px-1.5 py-0.5 font-mono">{path.priorityClass}</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>

				{#if coverage.gaps.length > 0}
					<div class="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2">
						<div class="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
							<AlertTriangle class="size-3.5" />
							Pod-producing paths need capacity ownership
						</div>
						<ul class="mt-2 space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
							{#each coverage.gaps as path (path.id)}
								<li>
									<span class="font-medium">{path.label}</span>
									<span class="text-amber-700/80 dark:text-amber-300/80"> — {path.evidence}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>

			<div class="rounded border px-3 py-2">
				<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
					Kubernetes 1.36 Readiness
				</h3>
				<ul class="mt-2 space-y-2">
					{#each coverage.kubernetes136 as feature (feature.id)}
						<li class="text-xs">
							<div class="flex items-center justify-between gap-2">
								<span class="font-medium">{feature.label}</span>
								<Badge variant="outline" class="font-mono text-[10px]">
									{feature.status.replace(/_/g, ' ')}
								</Badge>
							</div>
							<p class="mt-0.5 text-[11px] leading-snug text-muted-foreground">
								{feature.message}
							</p>
						</li>
					{/each}
				</ul>
				{#if required136.some((feature) => feature.status !== 'available' && feature.status !== 'configured')}
					<p class="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
						Required 1.36 signals need live verification on this cluster.
					</p>
				{/if}
			</div>
		</div>
	{/if}
</section>
