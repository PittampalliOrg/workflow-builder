<script lang="ts">
	interface Props {
		publishedRuntime: Record<string, unknown> | null;
	}

	let { publishedRuntime }: Props = $props();

	let isPublished = $derived(
		publishedRuntime !== null &&
			Array.isArray(publishedRuntime.revisions) &&
			publishedRuntime.revisions.length > 0
	);
</script>

{#if isPublished}
	<span
		class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
	>
		Published
	</span>
{:else}
	<span
		class="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
	>
		Draft
	</span>
{/if}
