<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { Server, Database, Cloud, User, Workflow, Coins, RefreshCcw, Snowflake } from '@lucide/svelte';
	import type { ServiceGraphNode, NodeInsight } from '$lib/types/service-graph';

	let { data, selected = false }: NodeProps = $props();
	let node = $derived(data.node as ServiceGraphNode);
	let insight = $derived((data.insight as NodeInsight | null) ?? null);
	let onCritical = $derived(Boolean(data.onCritical));

	const ICONS = {
		service: Server,
		db: Database,
		external: Cloud,
		user: User,
		step: Workflow
	} as const;
	let Icon = $derived(ICONS[node.kind] ?? Server);

	let ring = $derived.by(() => {
		if (node.status === 'error') return 'var(--destructive)';
		if (node.status === 'idle') return 'var(--border)';
		return 'color-mix(in oklch, var(--primary) 60%, var(--border))';
	});

	let errorPct = $derived(Math.round(node.red.errorRate * 100));
	let rateLabel = $derived(
		node.red.rate >= 1 || node.red.rate === 0
			? `${Math.round(node.red.rate)}`
			: node.red.rate.toFixed(2)
	);
	let latency = $derived(node.red.selfMs ?? node.red.p95);

	function fmtMs(ms: number): string {
		if (!ms) return '0ms';
		return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	}
	function fmtTokens(n: number): string {
		if (!n) return '0';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}
	function fmtCost(n: number): string {
		if (n > 0 && n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}

	let tooltip = $derived.by(() => {
		const lines = [
			node.label,
			`requests: ${node.red.total} (${rateLabel}/s)`,
			`errors: ${node.red.errors} (${errorPct}%)`,
			`latency: ${fmtMs(latency)}`
		];
		if (insight?.tokens) lines.push(`tokens: ${fmtTokens(insight.tokens.total)}`);
		if (insight?.costUsd != null) lines.push(`cost: ${fmtCost(insight.costUsd)}`);
		if (insight?.timing) {
			const t = insight.timing;
			lines.push(
				`timing: cold ${fmtMs(t.coldStartMs)} · cred ${fmtMs(t.credentialFetchMs)} · route ${fmtMs(t.routingMs)} · exec ${fmtMs(t.executionMs)}`
			);
		}
		if ((insight?.retries ?? 0) > 0) lines.push(`retries: ${insight?.retries}`);
		if (onCritical) lines.push('on critical path');
		return lines.join('\n');
	});

	let hasInsightRow = $derived(
		Boolean(insight?.tokens || insight?.costUsd != null || (insight?.retries ?? 0) > 0 || insight?.timing?.wasColdStart)
	);
</script>

<div
	class="wb-sg-node"
	style="border-color: {ring}; --sg-ring: {ring};"
	class:wb-sg-node--idle={node.status === 'idle'}
	class:wb-sg-node--selected={selected}
	class:wb-sg-node--critical={onCritical}
	title={tooltip}
>
	<Handle type="target" position={Position.Left} />
	<div class="wb-sg-node__head">
		<Icon size={15} />
		<span class="wb-sg-node__label">{node.label}</span>
		{#if onCritical}<span class="wb-sg-node__crit" title="critical path">★</span>{/if}
	</div>
	<div class="wb-sg-node__metrics">
		<span class="wb-sg-node__metric" title="request rate">⇢ {rateLabel}/s</span>
		<span class="wb-sg-node__metric" class:wb-sg-node__metric--err={errorPct > 0} title="error rate">
			⚠ {errorPct}%
		</span>
		<span class="wb-sg-node__metric" title="latency">⏱ {fmtMs(latency)}</span>
	</div>
	{#if hasInsightRow}
		<div class="wb-sg-node__insights">
			{#if insight?.tokens}
				<span class="wb-sg-node__metric" title="LLM tokens"><Coins size={10} /> {fmtTokens(insight.tokens.total)}</span>
			{/if}
			{#if insight?.costUsd != null}
				<span class="wb-sg-node__metric" title="LLM cost">{fmtCost(insight.costUsd)}</span>
			{/if}
			{#if (insight?.retries ?? 0) > 0}
				<span class="wb-sg-node__metric" title="retries"><RefreshCcw size={10} /> {insight?.retries}</span>
			{/if}
			{#if insight?.timing?.wasColdStart}
				<span class="wb-sg-node__metric" title="cold start"><Snowflake size={10} /></span>
			{/if}
		</div>
	{/if}
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
		cursor: pointer;
	}
	.wb-sg-node--idle {
		opacity: 0.55;
	}
	.wb-sg-node--selected {
		box-shadow: 0 0 0 2px var(--primary), 0 1px 6px rgba(0, 0, 0, 0.2);
	}
	.wb-sg-node--critical {
		border-style: dashed;
		box-shadow: 0 0 10px color-mix(in oklch, var(--primary) 45%, transparent);
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
	.wb-sg-node__crit {
		margin-left: auto;
		color: var(--primary);
		font-size: 11px;
	}
	.wb-sg-node__metrics,
	.wb-sg-node__insights {
		display: flex;
		gap: 8px;
		margin-top: 6px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		align-items: center;
	}
	.wb-sg-node__insights {
		margin-top: 3px;
		border-top: 1px dashed var(--border);
		padding-top: 3px;
	}
	.wb-sg-node__metric {
		display: inline-flex;
		align-items: center;
		gap: 2px;
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
