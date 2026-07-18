<script lang="ts">
	import { ArrowRight, Box, Moon, CircleAlert } from '@lucide/svelte';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		DRIFT_STATUS_META,
		pinVersionChip,
		runningVersionChip,
		shortSha
	} from '$lib/components/dev/preview-drift-view';
	import type { PreviewDriftEntry } from '$lib/types/dev-previews';

	let {
		entry,
		loading = false,
		mainHeadSha = null
	}: {
		/** The preview's drift entry; null while the overview has no row for it. */
		entry: Pick<PreviewDriftEntry, 'services' | 'syncGeneration'> | null;
		/** True while the drift overview is still on its first load. */
		loading?: boolean;
		/** workflow-builder main HEAD (tooltip context). */
		mainHeadSha?: string | null;
	} = $props();

	const rows = $derived(entry?.services ?? []);
</script>

{#if loading && !entry}
	<div class="space-y-1.5 rounded-md border bg-muted/10 p-2.5" aria-hidden="true">
		{#each Array(2) as _, index (index)}
			<div class="flex items-center gap-3">
				<Skeleton class="h-3.5 w-28" />
				<Skeleton class="h-3.5 flex-1" />
				<Skeleton class="h-3.5 w-16" />
			</div>
		{/each}
	</div>
{:else if entry && rows.length > 0}
	<div class="overflow-hidden rounded-md border bg-muted/10">
		<TooltipProvider>
			<ul class="divide-y">
				{#each rows as row (row.service)}
					{@const meta = DRIFT_STATUS_META[row.driftStatus]}
					{@const running = runningVersionChip(row)}
					{@const pin = pinVersionChip(row)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 text-[11px]"
					>
						<span class="inline-flex min-w-0 basis-32 items-center gap-1.5 font-medium">
							<Box class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="truncate" title={row.service}>{row.service}</span>
						</span>

						<span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
							{#if running}
								<span
									class="inline-flex max-w-56 items-center gap-1 rounded border bg-background px-1.5 py-px font-mono text-[10px] {row.running?.ready === false ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'}"
									title={running.title}
								>
									<span class="truncate">{running.label}</span>
									{#if row.running?.ready === false}
										<CircleAlert class="size-2.5 shrink-0" aria-label="container not ready" />
									{/if}
								</span>
								{#if entry.syncGeneration}
									<span
										class="rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground"
										title="Latest live-sync generation">gen {entry.syncGeneration}</span
									>
								{/if}
							{:else}
								<span
									class="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-px text-[10px] text-muted-foreground"
									title={row.runningUnavailableReason ?? 'running image unavailable'}
								>
									{#if row.runningUnavailableReason === 'slept'}
										<Moon class="size-2.5" aria-hidden="true" /> slept
									{:else}
										not observed
									{/if}
								</span>
							{/if}

							{#if pin}
								<ArrowRight class="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
								<span
									class="inline-flex max-w-56 items-center rounded border border-transparent bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
									title={pin.title}
								>
									<span class="truncate">pin {pin.label}</span>
								</span>
							{/if}
						</span>

						<Tooltip>
							<TooltipTrigger
								class="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[10px] font-medium {meta.badgeClass}"
								aria-label={`${row.service} drift: ${meta.label}`}
							>
								<span class="size-1.5 rounded-full {meta.dotClass}" aria-hidden="true"></span>
								{meta.label}
							</TooltipTrigger>
							<TooltipContent side="left">
								<p class="max-w-[260px] text-xs font-medium">{meta.label}</p>
								<p class="max-w-[260px] text-xs text-muted-foreground">{meta.description}</p>
								{#if row.runningUnavailableReason && row.runningUnavailableReason !== 'slept'}
									<p class="mt-1 max-w-[260px] text-xs text-muted-foreground">
										Runtime: {row.runningUnavailableReason}
									</p>
								{/if}
								{#if mainHeadSha}
									<p class="mt-1 max-w-[260px] font-mono text-[10px] text-muted-foreground">
										main {shortSha(mainHeadSha)}
									</p>
								{/if}
							</TooltipContent>
						</Tooltip>
					</li>
				{/each}
			</ul>
		</TooltipProvider>
	</div>
{/if}
