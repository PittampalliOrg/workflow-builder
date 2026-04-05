<script lang="ts">
	import ActivityExplorer from '$lib/components/activity-explorer/activity-explorer.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Activity Explorer</title>
</svelte:head>

<ActivityExplorer snapshot={data.catalog} />
