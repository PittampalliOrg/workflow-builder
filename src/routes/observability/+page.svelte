<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import TraceList from '$lib/components/observability/trace-list.svelte';

	// Legacy global (user-scoped) traces view. The primary, workspace-scoped
	// viewer lives at /workspaces/[slug]/traces; this stays for direct links.
	const sessionId = $derived(page.url.searchParams.get('sessionId'));
</script>

<svelte:head><title>Traces</title></svelte:head>

<div class="h-full">
	<TraceList detailBase="/observability" {sessionId} onClearSession={() => goto('/observability')} />
</div>
