<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import {
		Sheet,
		SheetContent,
		SheetDescription,
		SheetHeader,
		SheetTitle
	} from '$lib/components/ui/sheet';
	import {
		AlertCircle,
		CheckCircle2,
		XCircle
	} from 'lucide-svelte';
	import type { RunDetail, GraderResult, ItemStatus } from './types';

	interface Props {
		run: RunDetail;
		selectedItemId: string | null;
		onClose: () => void;
		onSelect: (id: string) => void;
	}

	let { run, selectedItemId, onClose, onSelect }: Props = $props();

	const selectedItem = $derived(run.items.find((i) => i.id === selectedItemId) ?? null);
	const selectedIndex = $derived(
		selectedItem ? run.items.findIndex((i) => i.id === selectedItemId) : -1
	);

	function selectByIndex(idx: number) {
		if (run.items.length === 0) return;
		const wrapped = ((idx % run.items.length) + run.items.length) % run.items.length;
		onSelect(run.items[wrapped].id);
	}

	function onkeydown(e: KeyboardEvent) {
		if (selectedIndex < 0) return;
		// Skip when typing inside an editable element
		const target = e.target as HTMLElement;
		const tag = target?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
		if (e.key === 'ArrowDown' || e.key === 'j') {
			e.preventDefault();
			selectByIndex(selectedIndex + 1);
		} else if (e.key === 'ArrowUp' || e.key === 'k') {
			e.preventDefault();
			selectByIndex(selectedIndex - 1);
		}
	}

	function itemStatusBadge(status: ItemStatus) {
		const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
			status === 'passed'
				? 'default'
				: status === 'failed' || status === 'error' || status === 'cancelled'
					? 'destructive'
					: 'secondary';
		return { variant, label: status };
	}

	function shortJson(value: unknown, max = 60): string {
		if (value === undefined || value === null) return '—';
		try {
			const s = typeof value === 'string' ? value : JSON.stringify(value);
			return s.length > max ? `${s.slice(0, max)}…` : s;
		} catch {
			return String(value);
		}
	}

	function graderDisplayName(g: GraderResult, fallback: string): string {
		return g.name ?? fallback;
	}

	function rowIcon(status: ItemStatus) {
		if (status === 'passed') return { icon: CheckCircle2, color: 'text-green-600' };
		if (status === 'failed' || status === 'error' || status === 'cancelled')
			return { icon: XCircle, color: 'text-destructive' };
		return { icon: AlertCircle, color: 'text-muted-foreground' };
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

<Sheet open={selectedItemId !== null} onOpenChange={(o) => !o && onClose()}>
	<SheetContent
		side="right"
		class="w-[min(1100px,95vw)] data-[side=right]:sm:max-w-[min(1100px,95vw)] p-0 flex flex-col"
		{onkeydown}
	>
		{#if selectedItem}
			{@const itemBadge = itemStatusBadge(selectedItem.status)}
			<SheetHeader class="px-6 py-4 border-b">
				<SheetTitle class="flex items-center gap-2 text-sm">
					<span>Inspect</span>
					<Badge variant={itemBadge.variant} class="font-normal capitalize text-[10px]">
						{itemBadge.label}
					</Badge>
					<span class="text-muted-foreground text-xs">
						Row {selectedItem.rowIndex + 1} / {run.items.length}
					</span>
					<span class="ml-auto text-[10px] text-muted-foreground font-mono">↑↓ to navigate</span>
				</SheetTitle>
				<SheetDescription class="font-mono text-xs">{selectedItem.id}</SheetDescription>
			</SheetHeader>

			<div class="flex flex-1 min-h-0">
				<!-- Left rail: row navigation -->
				<aside class="w-[220px] border-r overflow-y-auto bg-muted/20">
					<div class="p-2 flex flex-col gap-0.5">
						{#each run.items as item (item.id)}
							{@const ic = rowIcon(item.status)}
							{@const Icon = ic.icon}
							{@const isSelected = item.id === selectedItemId}
							<button
								type="button"
								onclick={() => onSelect(item.id)}
								class="text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center gap-2
									{isSelected
									? 'bg-primary/10 border-l-2 border-primary pl-1.5'
									: 'hover:bg-muted/60 border-l-2 border-transparent pl-1.5'}"
							>
								<span class="text-muted-foreground tabular-nums w-6 shrink-0">
									{item.rowIndex + 1}
								</span>
								<Icon class="size-3 {ic.color} shrink-0" />
								<span class="font-mono text-[10px] truncate">
									{shortJson(item.input, 30)}
								</span>
							</button>
						{/each}
					</div>
				</aside>

				<!-- Right pane: details -->
				<div class="flex-1 min-w-0 overflow-y-auto p-6">
					<div class="flex flex-col gap-5">
						<!-- Input -->
						<section class="flex flex-col gap-1.5">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								Input
							</h3>
							<pre
								class="bg-muted p-3 rounded-md text-xs overflow-auto max-h-64 whitespace-pre break-normal font-mono leading-snug">{JSON.stringify(
									selectedItem.input,
									null,
									2
								)}</pre>
						</section>

						<!-- Expected -->
						{#if selectedItem.expectedOutput !== undefined && selectedItem.expectedOutput !== null}
							<section class="flex flex-col gap-1.5">
								<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Expected
								</h3>
								<pre
									class="bg-muted p-3 rounded-md text-xs overflow-auto max-h-48 whitespace-pre break-normal font-mono leading-snug">{JSON.stringify(
										selectedItem.expectedOutput,
										null,
										2
									)}</pre>
							</section>
						{/if}

						<!-- Output -->
						<section class="flex flex-col gap-1.5">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								Output
							</h3>
							<pre
								class="bg-muted p-3 rounded-md text-xs overflow-auto max-h-64 whitespace-pre break-normal font-mono leading-snug">{selectedItem.generatedOutput !==
									undefined && selectedItem.generatedOutput !== null
									? JSON.stringify(selectedItem.generatedOutput, null, 2)
									: '—'}</pre>
							{#if selectedItem.usage}
								<div class="text-[10px] text-muted-foreground font-mono mt-1">
									{Object.entries(selectedItem.usage)
										.map(([k, v]) => `${k}: ${v}`)
										.join(' · ')}
								</div>
							{/if}
						</section>

						<!-- Graders -->
						<section class="flex flex-col gap-2">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								Graders
							</h3>
							{#each Object.entries(selectedItem.graderResults ?? {}) as [gid, g] (gid)}
								{@const ic = gradePassedIcon(g)}
								<div class="border rounded-md p-3 flex flex-col gap-2">
									<div class="flex items-center gap-2">
										{#if ic}
											{@const Icon = ic.icon}
											<Icon class="size-4 {ic.color}" />
										{/if}
										<div class="font-medium text-sm">{graderDisplayName(g, gid)}</div>
										{#if typeof g.score === 'number'}
											<Badge variant="secondary" class="font-mono text-[10px] ml-auto">
												score {g.score.toFixed(3)}
											</Badge>
										{/if}
									</div>
									{#if g.error}
										<div class="text-xs text-destructive">{g.error}</div>
									{/if}
									{#if g.details}
										<pre
											class="bg-muted p-2 rounded text-[11px] overflow-auto max-h-48 whitespace-pre break-normal font-mono leading-snug">{JSON.stringify(
												g.details,
												null,
												2
											)}</pre>
									{/if}
								</div>
							{:else}
								<div class="text-xs text-muted-foreground">No grader results yet.</div>
							{/each}
						</section>

						<!-- Error / trace -->
						{#if selectedItem.error}
							<section class="flex flex-col gap-1.5">
								<h3 class="text-xs font-semibold uppercase tracking-wide text-destructive">
									Error
								</h3>
								<pre
									class="bg-destructive/10 border border-destructive/20 p-3 rounded-md text-xs overflow-auto max-h-48 whitespace-pre-wrap break-words font-mono leading-snug">{selectedItem.error}</pre>
							</section>
						{/if}
						{#if selectedItem.traceIds?.length}
							<section class="flex flex-col gap-1">
								<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Trace IDs
								</h3>
								<div class="flex flex-wrap gap-1">
									{#each selectedItem.traceIds as tid (tid)}
										<Badge variant="outline" class="font-mono text-[10px]">{tid}</Badge>
									{/each}
								</div>
							</section>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</SheetContent>
</Sheet>
