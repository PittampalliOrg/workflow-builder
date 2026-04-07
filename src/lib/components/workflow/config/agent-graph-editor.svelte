<script lang="ts">
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		type OnConnect
	} from '@xyflow/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Dialog, DialogContent } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		cloneAgentGraph,
		createDefaultAgentGraph,
		humanizeStepType,
		SIMPLE_AGENT_STEP_TYPES,
		type AgentGraphDefinition,
		type AgentGraphNode,
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

	let draft = $state<AgentGraphDefinition>(createDefaultAgentGraph());
	let selectedNodeId = $state<string | null>(null);
	let newStepType = $state<AgentStepType>('tool_batch');
	let configDraft = $state('{}');

	$effect(() => {
		if (open) {
			draft = cloneAgentGraph(graph);
			selectedNodeId = draft.nodes[0]?.id ?? null;
			configDraft = JSON.stringify(draft.nodes[0]?.data?.config || {}, null, 2);
		}
	});

	let selectedNode = $derived(
		selectedNodeId ? draft.nodes.find((node) => node.id === selectedNodeId) ?? null : null
	);

	$effect(() => {
		if (selectedNode) {
			configDraft = JSON.stringify(selectedNode.data?.config || {}, null, 2);
		}
	});

	const onConnect: OnConnect = (connection) => {
		if (!connection.source || !connection.target) return;
		const edgeId = `${connection.source}->${connection.target}`;
		if (draft.edges.some((edge) => edge.id === edgeId)) return;
		draft = {
			...draft,
			edges: [...draft.edges, { id: edgeId, source: connection.source, target: connection.target }]
		};
	};

	function addNode() {
		const nextY =
			draft.nodes.length > 0
				? Math.max(...draft.nodes.map((node) => node.position.y)) + 120
				: 80;
		const id = crypto.randomUUID();
		const nextNode: AgentGraphNode = {
			id,
			position: { x: 120, y: nextY },
			data: {
				label: humanizeStepType(newStepType),
				stepType: newStepType,
				config: {}
			}
		};
		const nextEdges =
			selectedNodeId && draft.nodes.some((node) => node.id === selectedNodeId)
				? [...draft.edges, { id: `${selectedNodeId}->${id}`, source: selectedNodeId, target: id }]
				: draft.edges;
		draft = {
			...draft,
			nodes: [...draft.nodes, nextNode],
			edges: nextEdges
		};
		selectedNodeId = id;
	}

	function removeSelectedNode() {
		if (!selectedNodeId) return;
		draft = {
			...draft,
			nodes: draft.nodes.filter((node) => node.id !== selectedNodeId),
			edges: draft.edges.filter(
				(edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId
			)
		};
		selectedNodeId = draft.nodes[0]?.id ?? null;
	}

	function updateSelectedNode(updates: Record<string, unknown>) {
		if (!selectedNodeId) return;
		draft = {
			...draft,
			nodes: draft.nodes.map((node) =>
				node.id === selectedNodeId
					? {
							...node,
							data: {
								...node.data,
								...updates
							}
						}
					: node
			)
		};
	}

	function saveConfigDraft() {
		try {
			const parsed = JSON.parse(configDraft) as Record<string, unknown>;
			updateSelectedNode({ config: parsed });
		} catch {
			// Keep invalid JSON local until the user fixes it.
		}
	}
</script>

<Dialog {open} onOpenChange={(value) => !value && onClose()}>
	<DialogContent class="max-w-6xl p-0 overflow-hidden">
		<div class="flex items-center justify-between border-b px-4 py-3">
			<div>
				<h3 class="text-sm font-semibold">Agent Graph</h3>
				<p class="text-xs text-muted-foreground">
					Configure the durable agent loop as a constrained subgraph.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<Button variant="outline" onclick={onClose}>Cancel</Button>
				<Button onclick={() => onSave(draft)}>Save Graph</Button>
			</div>
		</div>

		<div class="grid h-[70vh] grid-cols-[220px_1fr_280px]">
			<div class="border-r p-3 space-y-3">
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
					graph data is stored on the `openshell/run` task body.
				</div>
			</div>

			<div class="bg-muted/20">
				<SvelteFlow
					bind:nodes={draft.nodes}
					bind:edges={draft.edges}
					fitView
					onconnect={onConnect}
					onnodeclick={({ node }) => {
						selectedNodeId = node.id;
					}}
				>
					<Controls />
					<MiniMap />
					<Background variant={BackgroundVariant.Dots} gap={16} size={1} />
				</SvelteFlow>
			</div>

			<div class="border-l p-3 space-y-3">
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
	</DialogContent>
</Dialog>
