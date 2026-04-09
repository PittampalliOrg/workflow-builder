<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Terminal, Trash2, ExternalLink, Loader2, Play } from 'lucide-svelte';
	import SandboxPhaseBadge from './sandbox-phase-badge.svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	interface Props {
		sandbox: Sandbox;
		children: import('svelte').Snippet;
	}

	let { sandbox, children }: Props = $props();

	// Lazy-fetch detail data on first hover
	let detail = $state.raw<Record<string, unknown> | null>(null);
	let loading = $state(false);
	let fetched = false;
	let recentLogs = $state.raw<Array<{ type: string; message: string }>>([]);

	async function fetchDetail() {
		if (fetched) return;
		fetched = true;
		loading = true;
		try {
			const [detailRes, logsRes] = await Promise.allSettled([
				fetch(`/api/sandboxes/${encodeURIComponent(sandbox.name)}`).then((r) =>
					r.ok ? r.json() : null
				),
				fetch(`/api/sandboxes/${encodeURIComponent(sandbox.name)}/logs?limit=3`).then((r) =>
					r.ok ? r.json() : []
				)
			]);
			detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
			recentLogs = logsRes.status === 'fulfilled' ? (logsRes.value ?? []) : [];
		} catch {
			// silent
		} finally {
			loading = false;
		}
	}

	function formatAge(createdAt: string | undefined): string {
		if (!createdAt) return '';
		const ms = Date.now() - new Date(createdAt).getTime();
		if (ms < 60000) return 'just now';
		const mins = Math.floor(ms / 60000);
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	// Mini terminal
	let quickCmd = $state('');
	let quickOutput = $state<string | null>(null);
	let quickRunning = $state(false);
	let quickExitCode = $state<number | null>(null);

	async function runQuickCommand() {
		if (!quickCmd.trim() || quickRunning) return;
		quickRunning = true;
		quickOutput = null;
		quickExitCode = null;
		try {
			const res = await fetch(
				`/api/sandboxes/${encodeURIComponent(sandbox.name)}/exec`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: quickCmd.trim(), timeout: 10 })
				}
			);
			if (res.ok) {
				const data = await res.json();
				quickOutput = (data.stdout ?? '') + (data.stderr ? `\n${data.stderr}` : '');
				quickExitCode = data.exitCode ?? null;
			} else {
				quickOutput = 'Error: ' + res.statusText;
			}
		} catch (err) {
			quickOutput = 'Error: ' + (err instanceof Error ? err.message : 'unknown');
		} finally {
			quickRunning = false;
		}
	}

	function onQuickKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			runQuickCommand();
		}
	}

	let deleting = $state(false);

	async function deleteSandbox() {
		deleting = true;
		try {
			await fetch(`/api/sandboxes/${encodeURIComponent(sandbox.name)}`, { method: 'DELETE' });
		} catch {
			// silent
		} finally {
			deleting = false;
		}
	}
</script>

<Popover.Root>
	<Popover.Trigger
		onmouseenter={fetchDetail}
		class="cursor-pointer"
	>
		{@render children()}
	</Popover.Trigger>
	<Popover.Content side="right" align="start" class="w-80 p-0">
		<div class="space-y-3 p-4">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<span class="font-mono text-sm font-semibold">{sandbox.name}</span>
				<SandboxPhaseBadge phase={sandbox.phase} />
			</div>

			<!-- Metadata -->
			<div class="space-y-1.5 text-xs text-muted-foreground">
				<div class="flex items-center justify-between">
					<span>Type</span>
					<Badge variant="outline" class="text-[10px]">{sandbox.type ?? 'openshell'}</Badge>
				</div>
				{#if sandbox.createdAt}
					<div class="flex items-center justify-between">
						<span>Created</span>
						<span>{formatAge(sandbox.createdAt)}</span>
					</div>
				{/if}
				{#if detail}
					{#if detail.namespace}
						<div class="flex items-center justify-between">
							<span>Namespace</span>
							<span class="font-mono">{detail.namespace}</span>
						</div>
					{/if}
					{#if detail.id}
						<div class="flex items-center justify-between">
							<span>ID</span>
							<span class="font-mono truncate max-w-[160px]" title={String(detail.id)}>{String(detail.id).slice(0, 12)}...</span>
						</div>
					{/if}
				{:else if loading}
					<div class="flex items-center gap-1.5">
						<Loader2 class="h-3 w-3 animate-spin" />
						<span>Loading...</span>
					</div>
				{/if}
			</div>

			<!-- Mini Terminal -->
			<div class="rounded bg-zinc-950 overflow-hidden">
				<div class="flex items-center gap-1 px-2 py-1.5">
					<span class="font-mono text-[10px] text-zinc-500">$</span>
					<input
						type="text"
						bind:value={quickCmd}
						onkeydown={onQuickKeydown}
						placeholder="Quick command..."
						disabled={quickRunning}
						class="flex-1 bg-transparent font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600"
					/>
					<button
						onclick={runQuickCommand}
						disabled={quickRunning || !quickCmd.trim()}
						class="text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
					>
						{#if quickRunning}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<Play class="h-3 w-3" />
						{/if}
					</button>
				</div>
				{#if quickOutput !== null}
					<div class="border-t border-zinc-800 px-2 py-1.5 max-h-24 overflow-auto">
						<pre class="font-mono text-[10px] leading-relaxed text-zinc-400 whitespace-pre-wrap">{quickOutput}</pre>
						{#if quickExitCode !== null && quickExitCode !== 0}
							<span class="font-mono text-[10px] text-red-400">(exit {quickExitCode})</span>
						{/if}
					</div>
				{:else if recentLogs.length > 0}
					<div class="border-t border-zinc-800 px-2 py-1.5">
						{#each recentLogs as log}
							<div class="truncate font-mono text-[10px] text-zinc-500">
								{log.message ?? log.type}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Actions -->
			<div class="flex items-center gap-1.5 border-t border-border pt-3">
				<Button variant="outline" size="sm" class="flex-1 text-xs" href="/sandboxes/{encodeURIComponent(sandbox.name)}">
					<Terminal class="mr-1 h-3 w-3" />
					Open Terminal
				</Button>
				<Button variant="outline" size="sm" class="flex-1 text-xs" href="/sandboxes/{encodeURIComponent(sandbox.name)}">
					<ExternalLink class="mr-1 h-3 w-3" />
					Details
				</Button>
				<Button
					variant="outline"
					size="icon"
					class="h-7 w-7 text-destructive hover:text-destructive"
					onclick={deleteSandbox}
					disabled={deleting}
				>
					{#if deleting}
						<Loader2 class="h-3 w-3 animate-spin" />
					{:else}
						<Trash2 class="h-3 w-3" />
					{/if}
				</Button>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>
