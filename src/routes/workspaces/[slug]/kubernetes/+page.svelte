<script lang="ts">
	import { ExternalLink, RefreshCw } from "@lucide/svelte";

	import HeadlampLogo from "$lib/components/gitops/icons/HeadlampLogo.svelte";
	import { Button } from "$lib/components/ui/button";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	let frameKey = $state(0);

	function reloadFrame() {
		frameKey += 1;
	}
</script>

<svelte:head>
	<title>Kubernetes · Workflow Builder</title>
</svelte:head>

<div class="flex h-[calc(100vh-4rem)] min-h-[640px] flex-col bg-background">
	<header class="flex min-h-14 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<HeadlampLogo class="size-5 shrink-0" />
			<div class="min-w-0">
				<h1 class="truncate text-sm font-semibold">Kubernetes</h1>
				<p class="truncate font-mono text-[11px] text-muted-foreground">{data.path}</p>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button variant="outline" size="icon-sm" aria-label="Reload Kubernetes view" onclick={reloadFrame}>
				<RefreshCw class="size-3.5" />
			</Button>
			{#if data.externalHref}
				<Button
					variant="outline"
					size="sm"
					href={data.externalHref}
					target="_blank"
					rel="noreferrer"
				>
					<ExternalLink class="size-3.5" />
					External
				</Button>
			{/if}
		</div>
	</header>
	{#key frameKey}
		<iframe
			title="Kubernetes"
			src={data.iframeSrc}
			class="min-h-0 flex-1 border-0 bg-background"
			referrerpolicy="same-origin"
		></iframe>
	{/key}
</div>
