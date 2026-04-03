<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	onMount(() => {
		goto('/workflows');
	});
</script>

<div class="flex h-full items-center justify-center">
	<p class="text-muted-foreground">Redirecting to workflows...</p>
</div>
