<script lang="ts">
	import { Anchor, Container, FileCode2, GitBranch } from "@lucide/svelte";

	import type { PipelineSubscription } from "$lib/gitops/pipeline-types";

	type Props = { subscription: PipelineSubscription; color?: string };
	let { subscription }: Props = $props();

	const icon = $derived(
		subscription.type === "git"
			? GitBranch
			: subscription.type === "chart"
				? Anchor
				: subscription.type === "image"
					? Container
					: FileCode2,
	);
</script>

<div class="flex h-[96px] w-[250px] flex-col justify-center gap-1.5 rounded-lg border bg-card/60 px-3 py-2 text-card-foreground shadow-sm">
	<div class="flex items-center gap-1.5">
		{#if icon}{@const Icon = icon}<Icon class="size-3.5 shrink-0 text-muted-foreground" />{/if}
		<span class="truncate text-xs font-medium">{subscription.name ?? subscription.type}</span>
	</div>
	<div class="truncate font-mono text-[0.62rem] text-muted-foreground" title={subscription.repoURL}>
		{subscription.repoURL}
	</div>
	<div class="text-[0.55rem] uppercase tracking-wide text-muted-foreground">{subscription.type}</div>
</div>
