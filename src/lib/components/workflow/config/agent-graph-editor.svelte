<script lang="ts">
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		type ColorMode,
		type NodeTypes,
		type OnConnect
	} from '@xyflow/svelte';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Dialog, DialogContent } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import AgentLoopNode from './agent-loop-node.svelte';
	import {
		AGENT_GRAPH_VERSION,
		cloneAgentGraph,
		createDefaultAgentGraph,
		humanizeStepType,
		SIMPLE_AGENT_STEP_TYPES,
		type AgentGraphDefinition,
		type AgentGraphNode,
		type AgentGraphEdge,
		type AgentStepType
	} from '$lib/types/agent-graph';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface Props {
		open: boolean;
		graph: AgentGraphDefinition;
		onClose: () => void;
		onSave: (graph: AgentGraphDefinition) => void;
	}

	let { open, graph, onClose, onSave }: Props = $props();

	const nodeTypes: NodeTypes = {
		agentLoop: AgentLoopNode
	};

	function decorateNodes(nodes: AgentGraphNode[]): AgentGraphNode[] {
		return nodes.map((node) => ({
			...node,
			type: 'agentLoop'
		}));
	}

	function cloneEdges(edges: AgentGraphEdge[]): AgentGraphEdge[] {
		return edges.map((edge) => ({ ...edge }));
	}

	let draftNodes = $state.raw<AgentGraphNode[]>(decorateNodes(createDefaultAgentGraph().nodes));
	let draftEdges = $state.raw<AgentGraphDefinition['edges']>(cloneEdges(createDefaultAgentGraph().edges));
	let selectedNodeId = $state<string | null>(null);
	let newStepType = $state<AgentStepType>('tool_batch');
	let configDraft = $state('{}');
	let initializedForOpen = $state(false);
	let canvasColorMode = $state<ColorMode>('light');

	function syncCanvasColorMode() {
		if (typeof document === 'undefined') return;
		canvasColorMode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
	}

	onMount(() => {
		syncCanvasColorMode();
		if (typeof document === 'undefined') return;
		const observer = new MutationObserver(() => syncCanvasColorMode());
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class']
		});
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!open) {
			initializedForOpen = false;
			return;
		}
		if (!initializedForOpen) {
			const nextDraft = cloneAgentGraph(graph);
			draftNodes = decorateNodes(nextDraft.nodes);
			draftEdges = cloneEdges(nextDraft.edges);
			selectedNodeId = nextDraft.nodes[0]?.id ?? null;
			configDraft = JSON.stringify(nextDraft.nodes[0]?.data?.config || {}, null, 2);
			initializedForOpen = true;
		}
	});

	let selectedNode = $derived(
		selectedNodeId ? draftNodes.find((node) => node.id === selectedNodeId) ?? null : null
	);

	$effect(() => {
		if (selectedNode) {
			const nextConfigDraft = JSON.stringify(selectedNode.data?.config || {}, null, 2);
			if (configDraft !== nextConfigDraft) {
				configDraft = nextConfigDraft;
			}
		}
	});

	const onConnect: OnConnect = (connection) => {
		if (!connection.source || !connection.target) return;
		const edgeId = `${connection.source}->${connection.target}`;
		if (draftEdges.some((edge) => edge.id === edgeId)) return;
		draftEdges = [...draftEdges, { id: edgeId, source: connection.source, target: connection.target }];
	};

	function addNode() {
		const nextY =
			draftNodes.length > 0
				? Math.max(...draftNodes.map((node) => node.position.y)) + 120
				: 80;
		const id = crypto.randomUUID();
		const nextNode: AgentGraphNode = {
			id,
			type: 'agentLoop',
			position: { x: 120, y: nextY },
			data: {
				label: humanizeStepType(newStepType),
				stepType: newStepType,
				config: {}
			}
		};
		const nextEdges =
			selectedNodeId && draftNodes.some((node) => node.id === selectedNodeId)
				? [...draftEdges, { id: `${selectedNodeId}->${id}`, source: selectedNodeId, target: id }]
				: draftEdges;
		draftNodes = [...draftNodes, nextNode];
		draftEdges = nextEdges;
		selectedNodeId = id;
	}

	function removeSelectedNode() {
		if (!selectedNodeId) return;
		const removedId = selectedNodeId;
		draftNodes = draftNodes.filter((node) => node.id !== removedId);
		draftEdges = draftEdges.filter((edge) => edge.source !== removedId && edge.target !== removedId);
		selectedNodeId = draftNodes[0]?.id ?? null;
	}

	function updateSelectedNode(updates: Record<string, unknown>) {
		if (!selectedNodeId) return;
		draftNodes = draftNodes.map((node) =>
			node.id === selectedNodeId
				? {
						...node,
						data: {
							...node.data,
							...updates
						}
					}
				: node
		);
	}

	function saveConfigDraft() {
		try {
			const parsed = JSON.parse(configDraft) as Record<string, unknown>;
			updateSelectedNode({ config: parsed });
		} catch {
			// Keep invalid JSON local until the user fixes it.
		}
	}

	function buildDraftGraph(): AgentGraphDefinition {
		return cloneAgentGraph({
			version: AGENT_GRAPH_VERSION,
			nodes: draftNodes,
			edges: draftEdges
		});
	}
</script>

<Dialog {open} onOpenChange={(value) => !value && onClose()}>
	<DialogContent
		showCloseButton={false}
		class="!h-[min(94vh,920px)] !w-[min(99vw,1600px)] !max-w-[min(99vw,1600px)] sm:!max-w-[min(99vw,1600px)] overflow-hidden p-0"
	>
		<div class="flex h-full min-h-0 flex-col">
		<div class="flex shrink-0 items-center justify-between border-b px-4 py-3">
			<div>
				<h3 class="text-sm font-semibold">Agent Graph</h3>
				<p class="text-xs text-muted-foreground">
					Configure the durable agent loop as a constrained subgraph.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<Button variant="outline" onclick={onClose}>Cancel</Button>
				<Button onclick={() => onSave(buildDraftGraph())}>Save Graph</Button>
				<Button variant="ghost" size="icon-sm" onclick={onClose} aria-label="Close dialog">
					×
				</Button>
			</div>
		</div>

		<div class="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_360px] 2xl:grid-cols-[240px_minmax(0,1fr)_400px]">
			<div class="space-y-3 overflow-y-auto border-r p-3">
				<div class="space-y-1.5">
					<Label for="agent-step-type">Add Step</Label>
					<NativeSelect
						id="agent-step-type"
						class="w-full"
						value={newStepType}
						onchange={(event) => {
							newStepType = event.currentTarget.value as AgentStepType;
						}}
					>
						{#each SIMPLE_AGENT_STEP_TYPES as stepType}
							<option value={stepType}>{humanizeStepType(stepType)}</option>
						{/each}
					</NativeSelect>
				</div>
				<Button class="w-full justify-start gap-2" variant="outline" onclick={addNode}>
					<Plus size={14} />
					Add Step
				</Button>
				<Button
					class="w-full justify-start gap-2"
					variant="outline"
					disabled={!selectedNode}
					onclick={removeSelectedNode}
				>
					<Trash2 size={14} />
					Delete Step
				</Button>
				<div class="rounded-md border p-2 text-xs text-muted-foreground">
					Connect nodes directly on the canvas to define a single durable agent loop. Persisted
					graph data is stored on the `durable/run` task body.
				</div>
			</div>

			<div class="min-w-0 bg-slate-50 dark:bg-slate-950/95">
				<SvelteFlow
					{nodeTypes}
					bind:nodes={draftNodes}
					bind:edges={draftEdges}
					colorMode={canvasColorMode}
					fitView
					defaultEdgeOptions={{
						style: 'stroke: rgba(103, 232, 249, 0.45); stroke-width: 2;'
					}}
					onconnect={onConnect}
					onnodeclick={({ node }) => {
						selectedNodeId = node.id;
					}}
				>
					<Controls />
					<MiniMap
						pannable
						zoomable
						maskColor={canvasColorMode === 'dark' ? 'rgba(2, 6, 23, 0.78)' : 'rgba(255, 255, 255, 0.74)'}
						nodeColor={(node) => (node.id === selectedNodeId ? '#67e8f9' : '#334155')}
					/>
					<Background
						variant={BackgroundVariant.Dots}
						gap={20}
						size={1}
					/>
				</SvelteFlow>
			</div>

			<div class="space-y-3 overflow-y-auto border-l p-3">
				{#if selectedNode}
					<div class="space-y-1.5">
						<Label for="agent-node-label">Label</Label>
						<Input
							id="agent-node-label"
							value={String(selectedNode.data?.label || '')}
							oninput={(event) => updateSelectedNode({ label: event.currentTarget.value })}
						/>
					</div>
					<div class="space-y-1.5">
						<Label for="agent-node-kind">Step Type</Label>
						<NativeSelect
							id="agent-node-kind"
							class="w-full"
							value={String(selectedNode.data?.stepType || 'tool_batch')}
							onchange={(event) =>
								updateSelectedNode({ stepType: event.currentTarget.value as AgentStepType })}
						>
							{#each SIMPLE_AGENT_STEP_TYPES as stepType}
								<option value={stepType}>{humanizeStepType(stepType)}</option>
							{/each}
						</NativeSelect>
					</div>
					<div class="space-y-1.5">
						<Label for="agent-node-config">Config (JSON)</Label>
						<Textarea
							id="agent-node-config"
							rows={12}
							value={configDraft}
							oninput={(event) => {
								configDraft = event.currentTarget.value;
								saveConfigDraft();
							}}
						/>
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">
						Select a node to edit its label, step type, and step-specific single-loop config.
					</p>
				{/if}
			</div>
		</div>
		</div>
	</DialogContent>
</Dialog>
