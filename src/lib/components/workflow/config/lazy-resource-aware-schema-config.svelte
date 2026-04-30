<script lang="ts">
	import { onMount, type Component } from 'svelte';

	let props = $props();
	let ComponentImpl = $state<Component<Record<string, unknown>> | null>(null);
	let loadError = $state<string | null>(null);

	onMount(() => {
		let cancelled = false;
		import('./resource-aware-schema-config.svelte')
			.then((module) => {
				if (!cancelled) {
					ComponentImpl = module.default as unknown as Component<Record<string, unknown>>;
				}
			})
			.catch((error) => {
				if (!cancelled) {
					loadError = error instanceof Error ? error.message : 'Failed to load schema editor.';
				}
			});
		return () => {
			cancelled = true;
		};
	});
</script>

{#if ComponentImpl}
	<ComponentImpl {...props} />
{:else if loadError}
	<div class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
		{loadError}
	</div>
{:else}
	<div class="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
		Loading schema editor...
	</div>
{/if}
