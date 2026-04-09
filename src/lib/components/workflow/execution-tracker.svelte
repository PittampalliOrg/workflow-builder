<script lang="ts">
	import { getContext } from 'svelte';
	import {
		createExecutionStream,
		createInitialExecutionStreamState,
		type ExecutionStreamStore,
		type ExecutionStreamState
	} from '$lib/stores/execution-stream.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import ExecutionCanvasSync from './execution-canvas-sync.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	let executionStream: ExecutionStreamStore | null = null;
	let executionState = $state<ExecutionStreamState>(createInitialExecutionStreamState());
	let stopExecutionStream = () => {};
	let lastExecutionId = '';

	function startTracking(executionId: string) {
		stopExecutionStream();
		executionStream?.dispose();
		executionState = createInitialExecutionStreamState();

		executionStream = createExecutionStream(executionId);
		stopExecutionStream = executionStream.subscribe((state) => {
			executionState = state;
		});
	}

	$effect(() => {
		const execId = store.selectedExecutionId;
		if (execId && execId !== lastExecutionId) {
			lastExecutionId = execId;
			startTracking(execId);
		}

		if (!execId) {
			lastExecutionId = '';
			stopExecutionStream();
			stopExecutionStream = () => {};
			executionStream?.dispose();
			executionStream = null;
			executionState = createInitialExecutionStreamState();
		}

		return () => {
			stopExecutionStream();
			stopExecutionStream = () => {};
			executionStream?.dispose();
			executionStream = null;
		};
	});
</script>

<ExecutionCanvasSync
	snapshot={executionState.snapshot}
	edges={store.edges}
	setEdges={(edges) => {
		store.edges = edges as typeof store.edges;
	}}
	onAutoCenter={() => {
		store.executionFollowSuppressUntil = Date.now() + 700;
	}}
/>
