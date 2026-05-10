<script lang="ts">
	import { ExternalLink } from "@lucide/svelte";

	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import type { CommitStatusEntry } from "$lib/server/promoter/types";

	type Props = {
		check: CommitStatusEntry;
	};

	let { check }: Props = $props();
</script>

<div class="flex items-center gap-1.5 text-[0.7rem]">
	<StatusIcon phase={check.phase} size="xs" />
	<span class="font-mono">{check.key}</span>
	{#if check.description}
		<span class="truncate text-muted-foreground" title={check.description}>
			· {check.description}
		</span>
	{/if}
	{#if check.url}
		<a
			href={check.url}
			target="_blank"
			rel="noreferrer"
			class="ml-auto inline-flex shrink-0 items-center gap-0.5 text-primary hover:underline"
			title="Open check details"
		>
			<ExternalLink class="size-2.5" />
		</a>
	{/if}
</div>
