<script lang="ts">
	import { Anchor, Boxes, Container, ExternalLink, GitBranch, Warehouse } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Sheet, SheetContent, SheetHeader, SheetTitle } from "$lib/components/ui/sheet";
	import { healthVisual, promotionVisual } from "$lib/gitops/kargo-status";
	import type { PipelineModel } from "$lib/gitops/pipeline-types";
	import type { PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import { relativeTime, shortDigest, shortSha, shortTag } from "$lib/utils/gitops-display";

	type Props = {
		model: PipelineModel;
		selection: PipelineSelection;
		freightId?: string | null;
		links?: { argoCdBase?: string; ghcrOrg?: string; stacksRepo?: string };
		onClose: () => void;
	};
	let { model, selection, freightId = null, links = {}, onClose }: Props = $props();

	const stage = $derived(
		selection?.kind === "stage"
			? (model.stages.find((s) => `stage/${s.name}` === selection.id) ?? null)
			: null,
	);
	const warehouse = $derived(
		selection?.kind === "warehouse"
			? (model.warehouses.find((w) => `warehouse/${w.name}` === selection.id) ?? null)
			: stage
				? (model.warehouses.find((w) => w.name === stage.warehouse) ?? null)
				: null,
	);
	const freight = $derived(
		freightId
			? (model.freights.find((f) => f.id === freightId) ?? null)
			: warehouse
				? (model.freights.find((f) => f.warehouse === warehouse.name) ?? null)
				: null,
	);
	// Env stages of the selected warehouse (shown when a warehouse / collapsed lane is selected).
	const warehouseStages = $derived(
		warehouse && !stage ? model.stages.filter((s) => s.warehouse === warehouse.name) : [],
	);

	const open = $derived(Boolean(selection) || Boolean(freightId));

	const title = $derived(
		stage
			? `${stage.warehouse} · ${stage.env}`
			: warehouse
				? warehouse.name
				: freight
					? freight.alias
					: "Details",
	);

	const ghcrOrg = $derived(links.ghcrOrg ?? "https://github.com/orgs/PittampalliOrg/packages/container/package");
	const argoBase = $derived((links.argoCdBase ?? "").replace(/\/+$/, ""));

	function argoUrl(env: string, name: string): string | null {
		if (!argoBase) return null;
		return `${argoBase}/applications/argocd/${env}-${name}`;
	}
	const stageArgoUrl = $derived(stage ? argoUrl(stage.env, stage.warehouse) : null);
	function isExternal(href: string | null | undefined): boolean {
		return Boolean(href && !href.startsWith("/"));
	}
</script>

<Sheet {open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
	<SheetContent side="right" class="w-[420px] overflow-y-auto sm:max-w-[420px]">
		<SheetHeader class="space-y-1">
			<SheetTitle class="flex items-center gap-2 text-sm">
				{#if warehouse?.kind === "bundle"}
					<Boxes class="size-4" style={warehouse.color ? `color:${warehouse.color}` : ""} />
				{:else}
					<Warehouse class="size-4" style={warehouse?.color ? `color:${warehouse.color}` : ""} />
				{/if}
				<span class="truncate">{title}</span>
			</SheetTitle>
		</SheetHeader>

		<div class="mt-3 space-y-4 text-xs">
			{#if stage}
				{@const health = healthVisual(stage.health)}
				{@const promo = promotionVisual(stage.promotionPhase)}
				{@const Icon = health.icon}
				<section class="space-y-2">
					<div class="flex items-center gap-2">
						<span class="flex items-center gap-1 font-medium" style={`color:${health.color}`}>
							{#if Icon}<Icon class={health.spin ? "size-3.5 animate-spin" : "size-3.5"} />{/if}
							{health.label}
						</span>
						{#if stage.dormant}<Badge variant="outline" class="h-5 border-dashed px-1.5 text-[0.6rem]">dormant</Badge>{/if}
					</div>

					<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
						<dt class="text-muted-foreground">Environment</dt>
						<dd>{stage.env}</dd>
						{#if stage.syncStatus}
							<dt class="text-muted-foreground">Sync</dt>
							<dd>{stage.syncStatus}</dd>
						{/if}
						{#if stage.desiredTag}
							<dt class="text-muted-foreground">Desired</dt>
							<dd class="truncate font-mono" title={stage.desiredTag}>{stage.desiredTag}</dd>
						{/if}
						{#if stage.liveTag}
							<dt class="text-muted-foreground">Live</dt>
							<dd class="truncate font-mono" title={stage.liveTag}>{stage.liveTag}</dd>
						{/if}
						{#if stage.drift}
							<dt class="text-muted-foreground">Drift</dt>
							<dd>{stage.drift}</dd>
						{/if}
						{#if promo}
							<dt class="text-muted-foreground">Promotion</dt>
							<dd>{promo.label}</dd>
						{/if}
						{#if stage.gate}
							<dt class="text-muted-foreground">Gate</dt>
							<dd>{stage.gate.label}{stage.gate.phase ? ` · ${stage.gate.phase}` : ""}</dd>
						{/if}
						{#if stage.promoterBranch}
							<dt class="text-muted-foreground">Branch</dt>
							<dd class="truncate font-mono" title={stage.promoterBranch}>{stage.promoterBranch}</dd>
						{/if}
						{#if stage.promoterHydratedSha}
							<dt class="text-muted-foreground">Hydrated</dt>
							<dd class="font-mono">{shortSha(stage.promoterHydratedSha)}</dd>
						{/if}
						{#if stage.updatedAt}
							<dt class="text-muted-foreground">Updated</dt>
							<dd>{relativeTime(stage.updatedAt)}</dd>
						{/if}
					</dl>

					{#if stage.rollup}
						<div class="flex flex-wrap gap-1">
							<Badge variant="secondary" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.synced} synced</Badge>
							{#if stage.rollup.drift > 0}<Badge variant="outline" class="h-5 border-amber-400 px-1.5 text-[0.6rem] text-amber-700 dark:text-amber-300">{stage.rollup.drift} drift</Badge>{/if}
							{#if stage.rollup.degraded > 0}<Badge variant="destructive" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.degraded} degraded</Badge>{/if}
							<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.total} total</Badge>
						</div>
					{/if}

					{#if stageArgoUrl}
						<a class="inline-flex items-center gap-1 text-primary hover:underline" href={stageArgoUrl} target="_blank" rel="noreferrer">
							ArgoCD application <ExternalLink class="size-3" />
						</a>
					{/if}
				</section>
			{/if}

			{#if warehouse}
				<section class="space-y-2 border-t pt-3">
					<div class="flex items-center justify-between">
						<span class="font-semibold">Warehouse</span>
						<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem]">{warehouse.subsystem}</Badge>
					</div>
					<div class="space-y-1">
						{#each warehouse.subscriptions as sub (sub.id)}
							<div class="flex items-center gap-1.5 truncate font-mono text-[0.66rem] text-muted-foreground" title={sub.repoURL}>
								{#if sub.type === "git"}<GitBranch class="size-3 shrink-0" />{:else if sub.type === "chart"}<Anchor class="size-3 shrink-0" />{:else}<Container class="size-3 shrink-0" />{/if}
								{sub.repoURL}
							</div>
						{/each}
					</div>

					{#if warehouseStages.length > 0}
						<div class="space-y-1 pt-1">
							<span class="text-[0.62rem] font-medium uppercase tracking-wide text-muted-foreground">Stages</span>
							{#each warehouseStages as st (st.name)}
								{@const v = healthVisual(st.health)}
								{@const Icon = v.icon}
								<div class="flex items-center gap-2 text-[0.66rem] {st.dormant ? 'opacity-60' : ''}">
									<span class="w-14 shrink-0 font-medium">{st.env}</span>
									<span class="flex items-center gap-1" style={`color:${v.color}`}>
										{#if Icon}<Icon class={v.spin ? "size-3 animate-spin" : "size-3"} />{/if}{v.label}
									</span>
									{#if st.desiredTag}
										<span class="ml-auto truncate font-mono text-[0.6rem] text-muted-foreground">{shortTag(st.desiredTag)}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if warehouse.dependedOnBy?.length}
						<div class="text-[0.66rem] text-muted-foreground">
							<span class="font-medium text-foreground">Depended on by:</span>
							{#each warehouse.dependedOnBy as dep}<div>· {dep}</div>{/each}
						</div>
					{/if}
					{#if warehouse.dependsOn?.length}
						<div class="text-[0.66rem] text-muted-foreground">
							<span class="font-medium text-foreground">Depends on:</span> {warehouse.dependsOn.join(", ")}
						</div>
					{/if}
					{#if warehouse.kind === "service"}
						<a class="inline-flex items-center gap-1 text-primary hover:underline" href={`${ghcrOrg}/${warehouse.name}`} target="_blank" rel="noreferrer">
							GHCR package <ExternalLink class="size-3" />
						</a>
					{/if}
				</section>
			{/if}

			{#if freight}
				<section class="space-y-2 border-t pt-3">
					<span class="font-semibold">Freight</span>
					<div class="font-mono text-[0.66rem] text-muted-foreground">{freight.alias}</div>
					<div class="space-y-1">
						{#each freight.artifacts as art}
							{#if art.kind === "image"}
								<div class="flex items-center gap-1.5 text-[0.66rem]"><Container class="size-3 shrink-0 text-muted-foreground" /> <span class="truncate font-mono" title={art.tag ?? ""}>{art.tag ?? "image"}</span></div>
								{#if art.digest}<div class="truncate pl-4 font-mono text-[0.6rem] text-muted-foreground" title={art.digest}>{shortDigest(art.digest)}</div>{/if}
							{:else if art.kind === "git"}
								<div class="flex items-center gap-1.5 text-[0.66rem]"><GitBranch class="size-3 shrink-0 text-muted-foreground" /> <span class="truncate font-mono">{art.sha ? shortSha(art.sha) : "config"}</span></div>
								{#if art.message}<div class="pl-4 text-[0.6rem] text-muted-foreground">{art.message}</div>{/if}
							{/if}
						{/each}
					</div>
					{#if freight.createdAt}<div class="text-[0.62rem] text-muted-foreground">created {relativeTime(freight.createdAt)}</div>{/if}
				</section>
			{/if}
		</div>
	</SheetContent>
</Sheet>
