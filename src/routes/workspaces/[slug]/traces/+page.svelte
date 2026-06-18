<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import TraceList from '$lib/components/observability/trace-list.svelte';

	const slug = $derived(page.params.slug);
	const sessionId = $derived(page.url.searchParams.get('sessionId'));

	function clearSession() {
		goto(`/workspaces/${slug}/traces`);
	}
</script>

<svelte:head><title>Traces</title></svelte:head>

<div class="h-full">
	<TraceList detailBase={`/workspaces/${slug}/traces`} {sessionId} onClearSession={clearSession} />
</div>
