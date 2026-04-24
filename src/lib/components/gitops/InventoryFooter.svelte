<script lang="ts">
	import { Clock3, Database } from "lucide-svelte";

	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = {
		inventory: DeploymentMetadataResponse["inventory"];
		generatedAt: string | null;
	};

	let { inventory, generatedAt }: Props = $props();
</script>

<footer class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-[0.7rem] text-muted-foreground">
	<div class="flex items-center gap-1.5">
		<Database class="size-3" />
		<span>Hub inventory</span>
		{#if inventory.sourceUrl}
			<span class="max-w-[28rem] truncate font-mono" title={inventory.sourceUrl}>
				{inventory.sourceUrl}
			</span>
		{:else}
			<span>(no WORKFLOW_BUILDER_GITOPS_INVENTORY_URL set)</span>
		{/if}
	</div>
	<div class="flex items-center gap-1.5">
		<Clock3 class="size-3" />
		<span>
			{inventory.data
				? `hub generated ${relativeTime(inventory.data.generatedAt)}`
				: "no hub data"}
		</span>
	</div>
	<div>
		<span>fetched {relativeTime(inventory.fetchedAt ?? generatedAt)}</span>
	</div>
	{#if inventory.error}
		<div class="text-destructive">
			<span>error:</span>
			<span class="font-mono">{inventory.error}</span>
		</div>
	{/if}
</footer>
