<script lang="ts">
	/**
	 * Collapsible side panel inside the Run Cockpit that lists the last N
	 * executions of the current workflow, highlights the one being viewed,
	 * and lets the user switch between runs without leaving the cockpit.
	 *
	 * Open/closed state is persisted in localStorage so it survives reloads.
	 * On narrow viewports the parent can render this inside a Sheet instead.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { ChevronLeft, ChevronRight, Loader2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	interface Execution {
		id: string;
		status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
		startedAt: string;
		completedAt: string | null;
		duration: string | null;
	}

	interface Props {
		slug: string;
		workflowId: string;
		/** Currently-viewed execution — rendered with a "current" marker. */
		currentExecutionId: string;
		/** Limit. Default 20. */
		limit?: number;
	}

	let { slug, workflowId, currentExecutionId, limit = 20 }: Props = $props();

	const STORAGE_KEY = 'run-cockpit:other-runs:open';
	let open = $state(true);
	let items = $state<Execution[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	onMount(async () => {
		if (typeof localStorage !== 'undefined') {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved === 'false') open = false;
		}
		await load();
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/workflows/${encodeURIComponent(workflowId)}/executions?limit=${limit}`,
			);
			if (!res.ok) {
				errorMessage = `Failed to load (${res.status})`;
				return;
			}
			const body = (await res.json()) as Execution[];
			items = body ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, String(open));
		}
	}

	/** Keyboard-accessible sibling navigation. Called from parent via
	 *  component.prev() / component.next(). */
	export function prev() {
		const idx = items.findIndex((e) => e.id === currentExecutionId);
		if (idx < 0 || idx >= items.length - 1) return;
		navigateTo(items[idx + 1]);
	}

	export function next() {
		const idx = items.findIndex((e) => e.id === currentExecutionId);
		if (idx <= 0) return;
		navigateTo(items[idx - 1]);
	}

	function navigateTo(exec: Execution) {
		goto(
			`/workspaces/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(
				workflowId,
			)}/runs/${encodeURIComponent(exec.id)}`,
			{ replaceState: true },
		);
	}

	/** Exposed for header "Other runs" toggle. */
	export function toggleOpen() {
		toggle();
	}

	/** Whether Prev can fire (there's a newer execution in the list). */
	export function canPrev(): boolean {
		const idx = items.findIndex((e) => e.id === currentExecutionId);
		return idx >= 0 && idx < items.length - 1;
	}

	/** Whether Next can fire (there's a more recent execution). */
	export function canNext(): boolean {
		const idx = items.findIndex((e) => e.id === currentExecutionId);
		return idx > 0;
	}

	function statusDotClass(status: Execution['status']): string {
		switch (status) {
			case 'running':
				return 'bg-blue-500 animate-pulse';
			case 'pending':
				return 'bg-amber-500';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			case 'cancelled':
				return 'bg-gray-400';
			default:
				return 'bg-muted-foreground';
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	function formatDuration(exec: Execution): string {
		const ms = exec.duration ? Number(exec.duration) : null;
		if (ms == null || !Number.isFinite(ms)) {
			if (exec.status === 'running') {
				const wall = Date.now() - new Date(exec.startedAt).getTime();
				return `${Math.floor(wall / 1000)}s`;
			}
			return '—';
		}
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return s ? `${m}m ${s}s` : `${m}m`;
	}
</script>

{#if open}
	<aside
		class="flex h-full w-[240px] shrink-0 flex-col border-r border-border bg-background"
		aria-label="Other runs of this workflow"
	>
		<header class="flex h-9 items-center justify-between border-b border-border px-3">
			<span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
				Other runs
			</span>
			<Button
				variant="ghost"
				size="icon"
				class="size-6"
				onclick={toggle}
				title="Collapse panel"
			>
				<ChevronLeft class="size-3.5" />
			</Button>
		</header>
		<div class="flex-1 overflow-y-auto p-1">
			{#if loading}
				<div class="flex items-center justify-center py-8 text-muted-foreground">
					<Loader2 class="size-4 animate-spin" />
				</div>
			{:else if errorMessage}
				<p class="px-3 py-4 text-[11px] text-red-500">{errorMessage}</p>
			{:else if items.length === 0}
				<p class="px-3 py-4 text-[11px] text-muted-foreground">No runs yet.</p>
			{:else if items.length === 1 && items[0].id === currentExecutionId}
				<p class="px-3 py-4 text-[11px] text-muted-foreground">This is the only run so far.</p>
			{:else}
				<ul class="flex flex-col gap-0.5">
					{#each items as exec (exec.id)}
						{@const isCurrent = exec.id === currentExecutionId}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors {isCurrent
									? 'bg-accent text-accent-foreground'
									: 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'}"
								onclick={() => navigateTo(exec)}
								title={`Started ${formatRelative(exec.startedAt)} · ${exec.status}`}
							>
								<span class="size-2 rounded-full shrink-0 {statusDotClass(exec.status)}"></span>
								<div class="min-w-0 flex-1">
									<div class="truncate font-mono text-[11px]">{exec.id.slice(0, 10)}</div>
									<div class="text-[10px] text-muted-foreground/80">
										{formatRelative(exec.startedAt)} · {formatDuration(exec)}
									</div>
								</div>
								{#if isCurrent}
									<span
										class="text-[9px] font-semibold uppercase tracking-wide text-primary"
										aria-label="Current"
									>
										now
									</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</aside>
{:else}
	<!-- Collapsed strip: a single column with an expand button. Keeps the
	     panel discoverable without consuming width. -->
	<aside
		class="flex h-full w-8 shrink-0 flex-col items-center border-r border-border bg-background py-2"
		aria-label="Expand other runs"
	>
		<Button
			variant="ghost"
			size="icon"
			class="size-6"
			onclick={toggle}
			title="Expand other runs"
		>
			<ChevronRight class="size-3.5" />
		</Button>
	</aside>
{/if}
