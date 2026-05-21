<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { Server, Database, Cloud, User, Workflow } from '@lucide/svelte';
	import type { ServiceGraphNode } from '$lib/types/service-graph';

	let { data }: NodeProps = $props();
	let node = $derived(data.node as ServiceGraphNode);

	const ICONS = {
		service: Server,
		db: Database,
		external: Cloud,
		user: User,
		step: Workflow
	} as const;
	let Icon = $derived(ICONS[node.kind] ?? Server);

	// Border reflects worst observed status (Grafana colors error edges/nodes red).
	let ring = $derived.by(() => {
		if (node.status === 'error') return 'var(--destructive)';
		if (node.status === 'idle') return 'var(--border)';
		return 'color-mix(in oklch, var(--primary) 60%, var(--border))';
	});

	let errorPct = $derived(Math.round(node.red.errorRate * 100));
	// rate is req/s (windowed) or a raw count (single execution).
	let rateLabel = $derived(
		node.red.rate >= 1 || node.red.rate === 0
			? `${Math.round(node.red.rate)}`
			: node.red.rate.toFixed(2)
	);
	let latency = $derived(node.red.selfMs ?? node.red.p95);
	function fmtMs(ms: number): string {
		if (!ms) return '0ms';
		if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.round(ms)}ms`;
	}
</script>

<div
	class="wb-sg-node"
	style="border-color: {ring}; --sg-ring: {ring};"
	class:wb-sg-node--idle={node.status === 'idle'}
	title={`${node.label}\nrequests: ${node.red.total} (${rateLabel}/s)\nerrors: ${node.red.errors} (${errorPct}%)\nlatency: ${fmtMs(latency)}`}
>
	<Handle type="target" position={Position.Left} />
	<div class="wb-sg-node__head">
		<Icon size={15} />
		<span class="wb-sg-node__label">{node.label}</span>
	</div>
	<div class="wb-sg-node__metrics">
		<span class="wb-sg-node__metric" title="request rate">⇢ {rateLabel}/s</span>
		<span
			class="wb-sg-node__metric"
			class:wb-sg-node__metric--err={errorPct > 0}
			title="error rate"
		>
			⚠ {errorPct}%
		</span>
		<span class="wb-sg-node__metric" title="latency">⏱ {fmtMs(latency)}</span>
	</div>
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.wb-sg-node {
		min-width: 168px;
		max-width: 220px;
		border: 2px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		color: var(--card-foreground);
		padding: 8px 10px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
		font-size: 12px;
	}
	.wb-sg-node--idle {
		opacity: 0.55;
	}
	.wb-sg-node__head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--sg-ring);
	}
	.wb-sg-node__label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--card-foreground);
	}
	.wb-sg-node__metrics {
		display: flex;
		gap: 8px;
		margin-top: 6px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		font-size: 11px;
	}
	.wb-sg-node__metric--err {
		color: var(--destructive);
		font-weight: 600;
	}
	:global(.wb-sg-node .svelte-flow__handle) {
		width: 7px;
		height: 7px;
		background: var(--muted-foreground);
		border: none;
	}
</style>
