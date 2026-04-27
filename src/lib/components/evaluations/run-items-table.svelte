<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import {
		AlertCircle,
		CheckCircle2,
		XCircle
	} from 'lucide-svelte';
	import type { RunDetail, RunItem, GraderResult, ItemStatus } from './types';

	interface Props {
		run: RunDetail;
		onSelectItem: (id: string) => void;
	}

	let { run, onSelectItem }: Props = $props();

	// Walk items to derive a graderId → friendly name map. Same logic the
	// run-detail page used inline; extracted here so the eval-detail Data tab
	// can reuse it.
	const graderNames = $derived.by(() => {
		const names = new Map<string, string>();
		for (const item of run.items ?? []) {
			for (const [gid, result] of Object.entries(item.graderResults ?? {})) {
				if (!names.has(gid) && result?.name) names.set(gid, result.name);
			}
		}
		return names;
	});

	function nameFor(gid: string): string {
		return graderNames.get(gid) ?? gid;
	}

	const graderColumns = $derived.by(() => {
		const pg = run.summary?.perGrader;
		if (!pg || typeof pg !== 'object') {
			// Fallback: collect from items if summary.perGrader hasn't populated yet
			const ids = new Set<string>();
			for (const item of run.items ?? []) {
				for (const gid of Object.keys(item.graderResults ?? {})) ids.add(gid);
			}
			return [...ids];
		}
		return Object.keys(pg as Record<string, unknown>);
	});

	function itemStatusBadge(status: ItemStatus) {
		const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
			status === 'passed'
				? 'default'
				: status === 'failed' || status === 'error' || status === 'cancelled'
					? 'destructive'
					: 'secondary';
		return { variant, label: status };
	}

	function shortJson(value: unknown, max = 80): string {
		if (value === undefined || value === null) return '—';
		const s = previewValue(value);
		return s.length > max ? `${s.slice(0, max)}…` : s;
	}

	function previewValue(value: unknown): string {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) return `Array(${value.length})`;
		if (value && typeof value === 'object') {
			const record = value as Record<string, unknown>;
			if (typeof record.preview === 'string') return record.preview;
			const pairs: string[] = [];
			for (const key of [
				'taskId',
				'suite',
				'entryPoint',
				'phase',
				'success',
				'testFileSha256',
				'workflowOutput',
				'prompt'
			]) {
				if (record[key] !== undefined) pairs.push(`${key}: ${previewAtom(record[key])}`);
				if (pairs.length >= 3) break;
			}
			if (pairs.length) return `{ ${pairs.join(', ')} }`;
			return `{ ${Object.keys(record).slice(0, 4).join(', ')}${Object.keys(record).length > 4 ? ', …' : ''} }`;
		}
		return String(value);
	}

	function previewAtom(value: unknown): string {
		if (typeof value === 'string') return JSON.stringify(value.length > 36 ? `${value.slice(0, 36)}…` : value);
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) return `Array(${value.length})`;
		if (value && typeof value === 'object') {
			const record = value as Record<string, unknown>;
			if (record.exitCode !== undefined) return `{ exitCode: ${record.exitCode} }`;
			if (record.passed !== undefined) return `{ passed: ${record.passed} }`;
			return '{…}';
		}
		return String(value);
	}

	function gradePassedIcon(g: GraderResult | undefined) {
		if (!g) return null;
		if (g.skipped) return { icon: AlertCircle, color: 'text-muted-foreground' };
		if (g.error) return { icon: XCircle, color: 'text-destructive' };
		return g.passed
			? { icon: CheckCircle2, color: 'text-green-600' }
			: { icon: XCircle, color: 'text-destructive' };
	}
</script>

<section class="flex flex-col gap-2">
	<div class="flex items-baseline justify-between">
		<h2 class="text-sm font-semibold">Items</h2>
		<span class="text-xs text-muted-foreground">{run.items.length} rows</span>
	</div>
	<div class="border rounded-md overflow-x-auto">
		<table class="w-full min-w-max text-sm">
			<thead class="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
				<tr class="border-b">
					<th class="px-3 py-2 text-left font-medium w-10">#</th>
					<th class="px-3 py-2 text-left font-medium">Status</th>
					<th class="px-3 py-2 text-left font-medium">Input</th>
					<th class="px-3 py-2 text-left font-medium">Expected</th>
					<th class="px-3 py-2 text-left font-medium">Output</th>
					{#each graderColumns as gid (gid)}
						<th class="px-3 py-2 text-left font-medium text-[10px]" title={gid}>
							{nameFor(gid)}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each run.items as item (item.id)}
					{@const itemBadge = itemStatusBadge(item.status)}
					<tr
						class="hover:bg-muted/30 transition-colors cursor-pointer"
						onclick={() => onSelectItem(item.id)}
					>
						<td class="px-3 py-2 text-xs text-muted-foreground tabular-nums">
							{item.rowIndex}
						</td>
						<td class="px-3 py-2">
							<Badge variant={itemBadge.variant} class="font-normal capitalize text-[10px]">
								{itemBadge.label}
							</Badge>
						</td>
						<td class="px-3 py-2 text-xs font-mono max-w-[200px] truncate">
							{shortJson(item.input)}
						</td>
						<td class="px-3 py-2 text-xs font-mono max-w-[160px] truncate">
							{shortJson(item.expectedOutput)}
						</td>
						<td class="px-3 py-2 text-xs font-mono max-w-[200px] truncate">
							{shortJson(item.generatedOutput)}
						</td>
						{#each graderColumns as gid (gid)}
							{@const g = item.graderResults?.[gid]}
							{@const ic = gradePassedIcon(g)}
							<td class="px-3 py-2">
								{#if ic}
									{@const Icon = ic.icon}
									<Icon class="size-4 {ic.color}" />
								{:else}
									<span class="text-muted-foreground text-xs">—</span>
								{/if}
							</td>
						{/each}
					</tr>
				{:else}
					<tr>
						<td colspan="99" class="px-3 py-12 text-center text-sm text-muted-foreground">
							No items yet.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>
