<script lang="ts">
	import { Handle, Position, type NodeProps } from "@xyflow/svelte";
	import {
		Database,
		Eye,
		Server,
		Send,
		Timer,
		Workflow as WorkflowIcon,
	} from "@lucide/svelte";
	import { DRASI_KIND_LABEL } from "$lib/drasi/catalog";
	import type { DrasiNodeKind, DrasiNodeSpec } from "$lib/types/drasi";

	let { data, selected }: NodeProps = $props();

	let spec = $derived(data.spec as DrasiNodeSpec);

	const KIND_ICONS: Record<DrasiNodeKind, typeof Server> = {
		system: Server,
		observer: Eye,
		source: Database,
		query: Timer,
		reaction: Send,
		workflow: WorkflowIcon,
	};

	let Icon = $derived(KIND_ICONS[spec.kind] ?? Server);
</script>

<div
	class="drasi-node"
	class:drasi-node--selected={selected}
	style="--drasi-accent: {spec.accent};"
	title="{spec.label} — {spec.subtitle}"
>
	<Handle type="target" position={Position.Left} />
	<div class="drasi-node__head">
		<span class="drasi-node__icon"><Icon size={12} /></span>
		<span class="drasi-node__kind">{DRASI_KIND_LABEL[spec.kind]}</span>
	</div>
	<div class="drasi-node__label">{spec.label}</div>
	<div class="drasi-node__status">
		<span class="drasi-node__dot" aria-hidden="true"></span>
		{spec.statusLine}
	</div>
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.drasi-node {
		width: 224px;
		border: 1.5px solid var(--border);
		border-left: 3px solid var(--drasi-accent);
		border-radius: calc(var(--radius) + 2px);
		background: color-mix(in oklch, var(--card) 92%, var(--drasi-accent) 5%);
		color: var(--card-foreground);
		padding: 7px 10px 8px;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.14),
			0 4px 14px -6px rgba(0, 0, 0, 0.28);
		font-size: 12px;
		cursor: pointer;
		transition:
			box-shadow 160ms ease,
			border-color 160ms ease,
			transform 160ms ease;
	}
	.drasi-node:hover {
		transform: translateY(-1px);
		border-color: color-mix(in oklch, var(--drasi-accent) 55%, var(--border));
	}
	.drasi-node--selected {
		border-color: var(--drasi-accent);
		box-shadow:
			0 0 0 2px color-mix(in oklch, var(--drasi-accent) 65%, transparent),
			0 2px 10px rgba(0, 0, 0, 0.25);
	}
	.drasi-node__head {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-bottom: 3px;
	}
	.drasi-node__icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--drasi-accent);
	}
	.drasi-node__kind {
		font-size: 9px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-foreground);
	}
	.drasi-node__label {
		font-weight: 600;
		font-size: 12px;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	.drasi-node__status {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: 4px;
		font-size: 10px;
		color: var(--muted-foreground);
	}
	.drasi-node__dot {
		width: 6px;
		height: 6px;
		border-radius: 9999px;
		background: var(--muted-foreground);
		opacity: 0.6;
		flex: none;
	}
	:global(.drasi-node .svelte-flow__handle) {
		width: 7px;
		height: 7px;
		background: var(--muted-foreground);
		border: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.drasi-node {
			transition: none;
		}
		.drasi-node:hover {
			transform: none;
		}
	}
</style>
