<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import SandboxTerminal from '$lib/components/sandbox/sandbox-terminal.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import { Plus, RotateCw, X } from '@lucide/svelte';

	interface Props {
		sessionId: string;
	}

	let { sessionId }: Props = $props();

	interface TerminalTab {
		id: string;
		name: string;
		/** main = the pinned Claude Code TUI PTY; shell = an extra bash PTY. */
		target: 'main' | 'shell';
		terminalId: string;
		/** Bumped to force a remount (reconnect) without changing terminalId
		 * for the pinned main tab — the TUI PTY survives and reattaches. */
		nonce: number;
	}

	const STORAGE_KEY = $derived(`cli-terminal-tabs-${sessionId}`);

	function mainTab(): TerminalTab {
		return { id: 'main', name: 'Claude Code', target: 'main', terminalId: 'main', nonce: 0 };
	}

	let tabs = $state<TerminalTab[]>([]);
	let activeTabId = $state('');
	let storageReady = false;

	function nextShellNumber(): number {
		let max = 0;
		for (const tab of tabs) {
			const match = /^Shell (\d+)$/.exec(tab.name);
			if (match) max = Math.max(max, Number.parseInt(match[1], 10) || 0);
		}
		return max + 1;
	}

	function createShellTab(): TerminalTab {
		return {
			id: crypto.randomUUID(),
			name: `Shell ${nextShellNumber()}`,
			target: 'shell',
			terminalId: crypto.randomUUID(),
			nonce: 0
		};
	}

	function resetTabs() {
		const tab = mainTab();
		tabs = [tab];
		activeTabId = tab.id;
	}

	function isStored(value: unknown): value is { tabs: TerminalTab[]; activeTabId: string } {
		if (!value || typeof value !== 'object') return false;
		const candidate = value as { tabs?: unknown; activeTabId?: unknown };
		return (
			Array.isArray(candidate.tabs) &&
			candidate.tabs.every(
				(tab) =>
					tab &&
					typeof tab.id === 'string' &&
					typeof tab.name === 'string' &&
					typeof tab.terminalId === 'string' &&
					(tab.target === 'main' || tab.target === 'shell')
			) &&
			typeof candidate.activeTabId === 'string'
		);
	}

	function addTab() {
		const tab = createShellTab();
		tabs = [...tabs, tab];
		activeTabId = tab.id;
	}

	function reconnectTab() {
		const index = tabs.findIndex((tab) => tab.id === activeTabId);
		if (index < 0) return;
		tabs = tabs.map((tab, i) =>
			i === index
				? {
						...tab,
						// Shell PTYs are disposable — a fresh terminalId gets a clean
						// shell. The main TUI must reattach to the SAME PTY, so only
						// the nonce changes there.
						terminalId: tab.target === 'shell' ? crypto.randomUUID() : tab.terminalId,
						nonce: tab.nonce + 1
					}
				: tab
		);
	}

	function closeTab(id: string) {
		const closingTab = tabs.find((tab) => tab.id === id);
		if (!closingTab || closingTab.target === 'main') return; // main tab is pinned
		const nextTabs = tabs.filter((tab) => tab.id !== id);
		tabs = nextTabs;
		if (activeTabId === id) activeTabId = nextTabs[nextTabs.length - 1]?.id ?? 'main';
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			if (isStored(parsed) && parsed.tabs.some((tab) => tab.target === 'main')) {
				// Normalize: main tab pinned first, identity fields enforced.
				const shells = parsed.tabs.filter((tab) => tab.target === 'shell');
				tabs = [mainTab(), ...shells.map((tab) => ({ ...tab, nonce: 0 }))];
				activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
					? parsed.activeTabId
					: 'main';
			} else {
				resetTabs();
			}
		} catch {
			resetTabs();
		}
		storageReady = true;
	});

	$effect(() => {
		if (!storageReady) return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeTabId }));
	});
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden rounded border border-border bg-zinc-950">
	<div class="flex h-9 items-center gap-2 border-b border-zinc-800 px-2">
		<div class="flex min-w-0 flex-1 overflow-x-auto">
			{#each tabs as tab (tab.id)}
				<div
					role="button"
					tabindex="0"
					onclick={() => (activeTabId = tab.id)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							activeTabId = tab.id;
						}
					}}
					class="flex h-8 items-center gap-1.5 border-r border-zinc-800 px-3 text-xs font-mono transition-colors {activeTabId === tab.id ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'}"
				>
					<span>{tab.name}</span>
					{#if tab.target === 'shell'}
						<button
							type="button"
							class="rounded p-0.5 hover:bg-zinc-700"
							onclick={(event) => {
								event.stopPropagation();
								closeTab(tab.id);
							}}
						>
							<X class="size-2.5" />
						</button>
					{/if}
				</div>
			{/each}
		</div>
		<CopyIdButton value={sessionId} />
		<Button variant="ghost" size="icon" class="size-7" onclick={reconnectTab} title="Reconnect">
			<RotateCw class="size-3.5" />
		</Button>
		<Button variant="ghost" size="icon" class="size-7" onclick={addTab} title="New shell">
			<Plus class="size-3.5" />
		</Button>
	</div>

	<div class="min-h-0 flex-1 overflow-hidden">
		{#each tabs as tab (tab.id)}
			<div class="h-full min-h-0 {activeTabId === tab.id ? 'flex flex-col' : 'hidden'}">
				{#key `${tab.terminalId}:${tab.nonce}`}
					<SandboxTerminal
						sandboxName={tab.target === 'main' ? 'claude-code' : 'shell'}
						sessionId={tab.terminalId}
						active={activeTabId === tab.id}
						wsPath={`/api/v1/sessions/${encodeURIComponent(sessionId)}/cli-terminal/${encodeURIComponent(tab.terminalId)}?target=${tab.target}`}
					/>
				{/key}
			</div>
		{/each}
	</div>
</div>
