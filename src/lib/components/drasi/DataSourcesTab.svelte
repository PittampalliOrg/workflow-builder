<script lang="ts">
	import { ArrowUpRight, Database, Eye } from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { listSourceRows } from "$lib/drasi/catalog";
	import ObservedChip from "./ObservedChip.svelte";

	let { onInspect }: { onInspect: (nodeId: string) => void } = $props();

	const sources = listSourceRows();
</script>

<div class="min-h-0 flex-1 overflow-auto">
	<div class="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3 @max-md:gap-2 @max-md:p-3">
		{#each sources as source (source.nodeId)}
			<section
				class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground @max-md:p-3"
				aria-label={source.label}
			>
				<div class="flex items-start justify-between gap-2">
					<div class="flex min-w-0 items-center gap-2">
						{#if source.kind === "k8s-observer"}
							<Eye class="size-4 shrink-0 text-muted-foreground" />
						{:else}
							<Database class="size-4 shrink-0 text-muted-foreground" />
						{/if}
						<div class="min-w-0">
							<h3 class="break-all font-mono text-xs font-semibold">{source.label}</h3>
							<p class="text-[0.7rem] text-muted-foreground">{source.subtitle}</p>
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 shrink-0 gap-1 px-2 text-xs"
						onclick={() => onInspect(source.nodeId)}
						aria-label="Inspect {source.label}"
					>
						Inspect
						<ArrowUpRight class="size-3" />
					</Button>
				</div>

				<dl class="space-y-1.5 text-xs">
					<div class="flex items-center justify-between gap-3">
						<dt class="text-muted-foreground">Readiness</dt>
						<dd><ObservedChip status="unavailable" /></dd>
					</div>
					<div class="flex items-center justify-between gap-3">
						<dt class="text-muted-foreground">Phase distribution</dt>
						<dd class="text-muted-foreground">Unavailable</dd>
					</div>
				</dl>

				{#if source.scope?.length}
					<div>
						<h4 class="mb-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Observer scope
						</h4>
						<div class="flex flex-wrap gap-1">
							{#each source.scope as kind (kind)}
								<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">{kind}</Badge>
							{/each}
						</div>
					</div>
				{/if}

				<div>
					<h4 class="mb-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
						{source.kind === "k8s-observer" ? "Projection tables" : "Table coverage"}
					</h4>
					<div class="flex flex-wrap gap-1">
						{#each source.tables as table (table)}
							<Badge
								variant="outline"
								class="h-auto min-h-5 max-w-full break-all px-1.5 py-0.5 font-mono text-[0.65rem]"
							>
								{table}
							</Badge>
						{/each}
					</div>
				</div>

				{#if source.note}
					<p class="text-[0.7rem] leading-relaxed text-muted-foreground">{source.note}</p>
				{/if}

				<p class="mt-auto border-t pt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
					Readiness and phase distribution come from a live Drasi runtime. None is
					connected here, so those values are
					<span class="font-medium text-foreground">Unavailable</span>.
				</p>
			</section>
		{/each}
	</div>

	<p
		class="border-t px-5 py-2 text-[0.7rem] leading-relaxed text-muted-foreground @max-md:px-3"
	>
		A transition timestamp records when a resource changed — it is not a heartbeat and
		does not prove observer health or CDC freshness.
	</p>
</div>
