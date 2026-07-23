<script lang="ts">
	import { ArrowRight, Compass } from "@lucide/svelte";
	import * as Sheet from "$lib/components/ui/sheet";
	import { Badge } from "$lib/components/ui/badge";
	import { ScrollArea } from "$lib/components/ui/scroll-area";
	import { DRASI_KIND_LABEL, getEdge, getNode } from "$lib/drasi/catalog";
	import type { DrasiSelection } from "$lib/types/drasi";
	import ObservedChip from "./ObservedChip.svelte";

	let {
		open = $bindable(false),
		selection,
	}: {
		open: boolean;
		selection: DrasiSelection | null;
	} = $props();

	let node = $derived(selection?.kind === "node" ? getNode(selection.id) : null);
	let edge = $derived(selection?.kind === "edge" ? getEdge(selection.id) : null);
	let edgeSource = $derived(edge ? getNode(edge.source) : null);
	let edgeTarget = $derived(edge ? getNode(edge.target) : null);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-md">
		{#if node}
			<Sheet.Header class="gap-1 border-b p-5">
				<div class="flex items-center gap-2">
					<span
						class="size-2 rounded-full"
						style="background: {node.accent};"
						aria-hidden="true"
					></span>
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
						{DRASI_KIND_LABEL[node.kind]}
					</Badge>
					<ObservedChip status="unavailable" />
				</div>
				<Sheet.Title class="break-words text-base">{node.label}</Sheet.Title>
				<Sheet.Description class="text-xs">{node.subtitle}</Sheet.Description>
			</Sheet.Header>
			<ScrollArea class="min-h-0 flex-1">
				<div class="space-y-5 p-5">
					<p class="text-xs leading-relaxed text-muted-foreground">{node.summary}</p>

					<section aria-label="Configured">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Configured
						</h3>
						<dl class="space-y-1.5">
							{#each node.configured as field (field.label)}
								<div class="flex items-start justify-between gap-3 text-xs">
									<dt class="shrink-0 text-muted-foreground">{field.label}</dt>
									<dd
										class="text-right {field.mono
											? 'break-all font-mono text-[0.7rem]'
											: ''}"
									>
										{field.value}
									</dd>
								</div>
							{/each}
						</dl>
					</section>

					{#if node.tables?.length}
						<section aria-label={node.kind === "system" || node.kind === "observer" ? "Watched resource kinds" : "Source tables"}>
							<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
								{node.kind === "system" || node.kind === "observer"
									? "Watched resource kinds"
									: "Source tables"}
							</h3>
							<div class="flex flex-wrap gap-1">
								{#each node.tables as table (table)}
									<Badge variant="outline" class="h-5 px-1.5 font-mono text-[0.65rem]">
										{table}
									</Badge>
								{/each}
							</div>
						</section>
					{/if}

					{#if node.threshold}
						<section aria-label="Temporal condition">
							<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
								Temporal condition
							</h3>
							<p class="font-mono text-[0.7rem]">{node.threshold}</p>
						</section>
					{/if}

					{#if node.specExcerpt}
						<section aria-label="Spec excerpt">
							<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
								{node.specExcerpt.language === "cypher" ? "Cypher excerpt" : "Spec excerpt"}
							</h3>
							<pre
								class="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-[0.7rem] leading-relaxed"
							><code>{node.specExcerpt.code}</code></pre>
							<p class="mt-1 text-[0.65rem] text-muted-foreground">
								Configured excerpt, abridged for display.
							</p>
						</section>
					{/if}

					<section aria-label="Observed state">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Observed state
						</h3>
						<div class="flex items-center gap-2">
							<ObservedChip status="unavailable" />
						</div>
						<p class="mt-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
							No Drasi runtime is connected to this preview environment, so live
							readiness, result counts, and lag are unavailable. Latest observation:
							<span class="font-medium text-foreground">Unavailable</span>.
						</p>
					</section>

					<section aria-label="Next diagnostic action">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Next diagnostic action
						</h3>
						<p class="flex items-start gap-2 text-xs leading-relaxed">
							<Compass class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<span>{node.diagnostic}</span>
						</p>
					</section>
				</div>
			</ScrollArea>
		{:else if edge}
			<Sheet.Header class="gap-1 border-b p-5">
				<div class="flex items-center gap-2">
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">Connection</Badge>
					<ObservedChip status="unavailable" />
				</div>
				<Sheet.Title class="break-words text-base">
					{edgeSource?.label ?? edge.source}
				</Sheet.Title>
				<Sheet.Description class="flex flex-wrap items-center gap-1.5 text-xs">
					<span class="break-all font-mono text-[0.7rem]">{edge.source}</span>
					<ArrowRight class="size-3 shrink-0" />
					<span class="break-all font-mono text-[0.7rem]">{edge.target}</span>
				</Sheet.Description>
			</Sheet.Header>
			<ScrollArea class="min-h-0 flex-1">
				<div class="space-y-5 p-5">
					<section aria-label="What flows here">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							What flows here
						</h3>
						<p class="text-xs leading-relaxed text-muted-foreground">{edge.description}</p>
					</section>

					<section aria-label="Observed state">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Observed state
						</h3>
						<div class="flex items-center gap-2">
							<ObservedChip status="unavailable" />
						</div>
						<p class="mt-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
							Throughput, lag, and delivery health require a connected Drasi runtime.
							Latest observation: <span class="font-medium text-foreground">Unavailable</span>.
						</p>
					</section>

					<section aria-label="Next diagnostic action">
						<h3 class="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
							Next diagnostic action
						</h3>
						<p class="flex items-start gap-2 text-xs leading-relaxed">
							<Compass class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<span>{edge.diagnostic}</span>
						</p>
					</section>
				</div>
			</ScrollArea>
		{:else}
			<Sheet.Header class="gap-1 border-b p-5">
				<Sheet.Title class="text-base">Nothing selected</Sheet.Title>
				<Sheet.Description class="text-xs">
					Select a node or edge on the map to inspect it.
				</Sheet.Description>
			</Sheet.Header>
		{/if}
	</Sheet.Content>
</Sheet.Root>
