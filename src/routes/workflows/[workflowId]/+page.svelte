<script lang="ts">
	import { setContext } from 'svelte';
	import { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import WorkflowCanvas from '$lib/components/workflow/workflow-canvas.svelte';
	import WorkflowToolbar from '$lib/components/workflow/workflow-toolbar.svelte';
	import SidePanel from '$lib/components/workflow/side-panel.svelte';
	import { page } from '$app/state';

	const store = createWorkflowStore();
	setContext('workflow', store);

	let workflowId = $derived(page.params.workflowId);

	// Show the side panel when a node is selected or runs panel is toggled
	const showSidePanel = $derived(!!store.selectedNode || store.showRunsPanel);

	// Load workflow data
	$effect(() => {
		if (!workflowId) return;
		store.isLoading = true;

		fetch(`/api/workflows/${workflowId}`)
			.then((res) => {
				if (!res.ok) throw new Error('Failed to load workflow');
				return res.json();
			})
			.then((data) => {
				store.loadWorkflow(data.id, data.name, data.nodes || [], data.edges || []);
			})
			.catch((err) => {
				console.error('Failed to load workflow:', err);
			})
			.finally(() => {
				store.isLoading = false;
			});
	});
</script>

<div class="flex h-full flex-col">
	<WorkflowToolbar />

	<div class="relative flex flex-1 overflow-hidden">
		<div class="flex-1">
			<WorkflowCanvas />
		</div>

		{#if showSidePanel}
			<SidePanel />
		{/if}
	</div>
</div>
