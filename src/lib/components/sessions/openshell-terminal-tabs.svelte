<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import SandboxTerminal from '$lib/components/sandbox/sandbox-terminal.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import { Plus, RotateCw, X } from '@lucide/svelte';

	interface Props {
		sessionId: string;
		sandboxName: string;
	}

	let { sessionId, sandboxName }: Props = $props();

	interface TerminalTab {
		id: string;
		name: string;
		terminalId: string;
	}

	const STORAGE_KEY = $derived(`openshell-session-terminal-tabs-${sessionId}`);

	let tabs = $state<TerminalTab[]>([]);
	let activeTabId = $state('');
	let storageReady = false;

	function createTerminalTab(label?: number): TerminalTab {
		const terminalNumber = label ?? nextTerminalNumber();
		return {
			id: crypto.randomUUID(),
			name: `Terminal ${terminalNumber}`,
			terminalId: crypto.randomUUID()
		};
	}

	function nextTerminalNumber(): number {
		let max = 0;
		for (const tab of tabs) {
			const match = /^Terminal (\d+)$/.exec(tab.name);
			if (match) max = Math.max(max, Number.parseInt(match[1], 10) || 0);
		}
		return max + 1;
	}

	function resetTabs() {
		const tab = createTerminalTab(1);
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
					typeof tab.terminalId === 'string'
			) &&
			typeof candidate.activeTabId === 'string'
		);
	}

	async function closeRemoteTerminal(terminalId: string) {
		await fetch(`/api/openshell/sessions/${encodeURIComponent(sessionId)}/close`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ terminalId })
		}).catch(() => {});
	}

	function addTab() {
		const tab = createTerminalTab();
		tabs = [...tabs, tab];
		activeTabId = tab.id;
	}

	function reconnectTab() {
		const index = tabs.findIndex((tab) => tab.id === activeTabId);
		if (index < 0) return;
		const previous = tabs[index];
		void closeRemoteTerminal(previous.terminalId);
		tabs = tabs.map((tab, i) =>
			i === index ? { ...tab, terminalId: crypto.randomUUID() } : tab
		);
	}

	function closeTab(id: string) {
		const closingTab = tabs.find((tab) => tab.id === id);
		if (!closingTab) return;
		if (tabs.length === 1) {
			const replacement = createTerminalTab();
			tabs = [replacement];
			activeTabId = replacement.id;
			void closeRemoteTerminal(closingTab.terminalId);
			return;
		}
		const nextTabs = tabs.filter((tab) => tab.id !== id);
		tabs = nextTabs;
		if (activeTabId === id) activeTabId = nextTabs[nextTabs.length - 1].id;
		void closeRemoteTerminal(closingTab.terminalId);
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			if (isStored(parsed) && parsed.tabs.length > 0) {
				tabs = parsed.tabs;
				activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
					? parsed.activeTabId
					: tabs[0].id;
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
				</div>
			{/each}
		</div>
		<span class="hidden max-w-[220px] truncate font-mono text-[11px] text-zinc-500 md:inline">
			{sandboxName}
		</span>
		<CopyIdButton value={sessionId} />
		<Button variant="ghost" size="icon" class="size-7" onclick={reconnectTab} title="Reconnect">
			<RotateCw class="size-3.5" />
		</Button>
		<Button variant="ghost" size="icon" class="size-7" onclick={addTab} title="New terminal">
			<Plus class="size-3.5" />
		</Button>
	</div>

	<div class="min-h-0 flex-1 overflow-hidden">
		{#each tabs as tab (tab.id)}
			<div class="h-full min-h-0 {activeTabId === tab.id ? 'flex flex-col' : 'hidden'}">
				<SandboxTerminal
					{sandboxName}
					sessionId={tab.terminalId}
					active={activeTabId === tab.id}
					wsPath={`/api/openshell/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(tab.terminalId)}`}
				/>
			</div>
		{/each}
	</div>
</div>
