<script lang="ts">
	import { setContext, getContext, onMount } from 'svelte';
	import { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import { applySpec } from '$lib/helpers/ai-spec-applier';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import type { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';
	import { getTask } from '$lib/helpers/spec-mutations';
	import { getNodeIdForTaskName, getTaskNameFromNodeId } from '$lib/helpers/workflow-action-spec';
	import WorkflowCanvas from '$lib/components/workflow/workflow-canvas.svelte';
	import WorkflowToolbar from '$lib/components/workflow/workflow-toolbar.svelte';
	import RightPanel from '$lib/components/workflow/right-panel.svelte';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import { ListOrdered, MessagesSquare } from 'lucide-svelte';
	import { page } from '$app/state';

	const store = createWorkflowStore();
	setContext('workflow', store);

	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
	const aiAssistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');
	const buildWorkflow = getContext<ReturnType<typeof createBuildWorkflowStore>>('build-workflow');

	let workflowId = $derived(page.params.workflowId);
	let slug = $derived(page.params.slug as string);

	// Context-aware tab switching: when a node is selected, open Properties tab
	$effect(() => {
		if (store.selectedNode) {
			ui.openRightPanel('properties');
		}
	});

	// Build→Runs bridge: when build agent completes, switch to Runs tab
	$effect(() => {
		const execId = buildWorkflow.executionId;
		if (execId && (buildWorkflow.phase === 'complete' || buildWorkflow.phase === 'failed')) {
			ui.openRightPanel('runs');
		}
	});

	// Auto-apply spec from build agent → updates canvas in real-time
	let lastAppliedSpecVersion = 0;
	$effect(() => {
		const version = buildWorkflow.specVersion;
		const spec = buildWorkflow.currentSpec;
		if (!spec || version === lastAppliedSpecVersion) return;
		lastAppliedSpecVersion = version;

		// Apply spec to store (rebuilds graph → canvas updates)
		applySpec(store, spec).then((result) => {
			if (result.errors.length > 0) {
				console.warn('[Build→Canvas] Spec apply warnings:', result.errors);
			}
		});
	});

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
				store.loadWorkflow(data.id, data.name, data.nodes || [], data.edges || [], data.spec || null);
			})
			.catch((err) => {
				console.error('Failed to load workflow:', err);
			})
			.finally(() => {
				store.isLoading = false;
			});
	});

	// Sync workflow context (spec) to AI assistant store
	$effect(() => {
		if (store.workflowId) {
			const selectedTaskName = getTaskNameFromNodeId(store.selectedNodeId);
			const selectedTask = store.spec && selectedTaskName ? getTask(store.spec, selectedTaskName) : null;
			aiAssistant.setWorkflowContext({
				workflowId: store.workflowId,
				workflowName: store.workflowName,
				spec: store.spec,
				selectedNodeId: store.selectedNodeId,
				selectedTaskName,
				selectedNodeLabel: (store.selectedNode?.data?.label as string | undefined) ?? null,
				selectedNodeType: (store.selectedNode?.data?.type as string | undefined) ?? store.selectedNode?.type ?? null,
				selectedTask,
			});
		}
	});

	// Load AI chat history for this workflow
	$effect(() => {
		if (workflowId) {
			aiAssistant.loadHistory(workflowId);
		}
	});

	// Handle AI spec apply event
	async function handleApplySpec(event: Event) {
		const detail = (event as CustomEvent).detail as {
			spec: Record<string, unknown>;
			messageId: string;
			changedTaskNames?: string[];
		};
		const result = await applySpec(store, detail.spec);
		if (result.success) {
			aiAssistant.markApplied(detail.messageId);
			aiAssistant.dismissSpec();
			const firstChangedTask = detail.changedTaskNames?.[0];
			const changedNodeId = firstChangedTask ? getNodeIdForTaskName(store.nodes, firstChangedTask) : null;
			if (changedNodeId) {
				store.selectedNodeId = changedNodeId;
				ui.openRightPanel('properties');
			}
			const { toast } = await import('svelte-sonner');
			toast.success('Spec applied to canvas');
		}
		if (result.errors.length > 0) {
			console.warn('AI spec apply warnings:', result.errors);
		}
		if (!result.success) {
			aiAssistant.markApplyFailed(detail.messageId, result.errors);
			const { toast } = await import('svelte-sonner');
			toast.error('Failed to apply spec: ' + result.errors.join(', '));
		}
	}

	onMount(() => {
		window.addEventListener('ai-assistant:apply-spec', handleApplySpec);
		return () => {
			window.removeEventListener('ai-assistant:apply-spec', handleApplySpec);
			aiAssistant.clearWorkflowContext();
		};
	});
</script>

<div class="flex h-full flex-col">
	<!-- Breadcrumb strip above the toolbar. Provides cross-links to the run
	     list and workflow-driven sessions so users can move between the
	     editor, runs, and sessions without hunting through menus. -->
	<div class="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-1.5">
		<AppBreadcrumb
			items={[
				{ label: 'Workspace', href: `/workspaces/${slug}` },
				{ label: 'Workflows', href: `/workspaces/${slug}/workflows` },
				{
					label: store.workflowName || 'Workflow',
					truncate: true
				}
			]}
		/>
		<div class="flex items-center gap-1 text-xs">
			<a
				href={`/workspaces/${slug}/runs?workflowId=${workflowId}`}
				class="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent"
				title="All runs for this workflow"
			>
				<ListOrdered class="size-3.5" /> Runs
			</a>
			<a
				href={`/workspaces/${slug}/sessions?source=workflow&workflowId=${workflowId}`}
				class="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent"
				title="Sessions spawned by this workflow"
			>
				<MessagesSquare class="size-3.5" /> Sessions
			</a>
		</div>
	</div>

	<WorkflowToolbar />

	<div class="relative flex flex-1 overflow-hidden">
		<div class="flex-1">
			<WorkflowCanvas />
		</div>

		{#if ui.rightPanelOpen}
			<RightPanel />
		{/if}
	</div>
</div>
