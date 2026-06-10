<script lang="ts">
	import { Handle, Position } from "@xyflow/svelte";

	import type { PipelineNodeData } from "$lib/gitops/pipeline-layout";

	import LaneNodeBody from "./LaneNodeBody.svelte";
	import StageNodeBody from "./StageNodeBody.svelte";
	import SubscriptionNodeBody from "./SubscriptionNodeBody.svelte";
	import WarehouseNodeBody from "./WarehouseNodeBody.svelte";

	type Props = { data: PipelineNodeData; selected?: boolean };
	let { data, selected = false }: Props = $props();

	const EDGE_GAP = 16;
	const HANDLE_STYLE = "background:transparent;border:none;width:6px;height:6px;";

	// Stage nodes get one target + source handle per requested-freight origin,
	// id'd by the origin warehouse name and sorted by that warehouse's post-layout
	// y so edges enter top-to-bottom without crossing (ported from Kargo).
	const sortedOrigins = $derived(
		data.kind === "stage" && data.stage
			? [...data.stage.requestedFreight].sort(
					(a, b) => (data.warehouseY?.[a.origin] ?? 0) - (data.warehouseY?.[b.origin] ?? 0),
				)
			: [],
	);

	function handleTop(idx: number, count: number): string {
		return `calc(50% + ${-((count - 1) * EDGE_GAP) / 2 + idx * EDGE_GAP}px)`;
	}
</script>

{#if data.kind === "stage" && data.stage}
	{#each sortedOrigins as req, idx (req.origin)}
		<Handle
			id={req.origin}
			type="target"
			position={Position.Left}
			style={`top:${handleTop(idx, sortedOrigins.length)};left:1px;${HANDLE_STYLE}`}
		/>
	{/each}
	<StageNodeBody
		stage={data.stage}
		color={data.color}
		{selected}
		highlight={Boolean(data.highlight)}
		freightRing={Boolean(data.freightRing)}
	/>
	{#each sortedOrigins as req, idx (req.origin)}
		<Handle
			id={req.origin}
			type="source"
			position={Position.Right}
			style={`top:${handleTop(idx, sortedOrigins.length)};right:4px;${HANDLE_STYLE}`}
		/>
	{/each}
	<Handle type="source" position={Position.Right} style={`top:50%;right:4px;${HANDLE_STYLE}`} />
{:else if data.kind === "warehouse" && data.warehouse}
	<Handle
		id={data.warehouse.name}
		type="target"
		position={Position.Left}
		style={`top:50%;left:2px;${HANDLE_STYLE}`}
	/>
	<WarehouseNodeBody warehouse={data.warehouse} color={data.color} {selected} />
	<Handle
		id={data.warehouse.name}
		type="source"
		position={Position.Right}
		style={`top:50%;right:4px;${HANDLE_STYLE}`}
	/>
{:else if data.kind === "subscription" && data.subscription}
	<Handle type="target" position={Position.Left} style={`top:50%;left:2px;${HANDLE_STYLE}`} />
	<SubscriptionNodeBody subscription={data.subscription} color={data.color} />
	<Handle type="source" position={Position.Right} style={`top:50%;right:4px;${HANDLE_STYLE}`} />
{:else if data.kind === "lane" && data.warehouse}
	<Handle
		id={data.warehouse.name}
		type="target"
		position={Position.Left}
		style={`top:50%;left:2px;${HANDLE_STYLE}`}
	/>
	<LaneNodeBody warehouse={data.warehouse} stages={data.stages ?? []} color={data.color} {selected} />
{/if}
