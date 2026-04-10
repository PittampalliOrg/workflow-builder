<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Plus, X } from 'lucide-svelte';
	import SandboxTerminal from './sandbox-terminal.svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	interface TerminalTab {
		id: string;
		name: string;
		sessionId: string;
	}

	interface StoredTerminalTabs {
		tabs: TerminalTab[];
		activeTabId: string;
	}

	const STORAGE_KEY = $derived(`sandbox-terminal-tabs-${sandboxName}`);

	let tabs = $state<TerminalTab[]>([]);
	let activeTabId = $state('');
	let storageReady = false;

	function createTerminalTab(label?: number): TerminalTab {
		const terminalNumber = label ?? nextTerminalNumber();
		return {
			id: crypto.randomUUID(),
			name: `Terminal ${terminalNumber}`,
			sessionId: crypto.randomUUID()
		};
	}

	function nextTerminalNumber(): number {
		let max = 0;
		for (const tab of tabs) {
			const match = /^Terminal (\d+)$/.exec(tab.name);
			if (match) {
				max = Math.max(max, Number.parseInt(match[1], 10) || 0);
			}
		}
		return max + 1;
	}

	function resetTabs() {
		const tab = createTerminalTab(1);
		tabs = [tab];
		activeTabId = tab.id;
	}

	function isStoredTerminalTabs(value: unknown): value is StoredTerminalTabs {
		if (!value || typeof value !== 'object') return false;
		const candidate = value as StoredTerminalTabs;
		return (
			Array.isArray(candidate.tabs) &&
			candidate.tabs.every(
				(tab) =>
					tab &&
					typeof tab.id === 'string' &&
					typeof tab.name === 'string' &&
					typeof tab.sessionId === 'string'
			) &&
			typeof candidate.activeTabId === 'string'
		);
	}

	async function closeRemoteSession(sessionId: string) {
		try {
			await fetch(
				`/api/sandboxes/${encodeURIComponent(sandboxName)}/terminal/${encodeURIComponent(sessionId)}`,
				{ method: 'DELETE' }
			);
		} catch (error) {
			console.error('Failed to close terminal session:', error);
		}
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) {
				resetTabs();
			} else {
				const parsed = JSON.parse(raw);
				if (isStoredTerminalTabs(parsed) && parsed.tabs.length > 0) {
					tabs = parsed.tabs;
					activeTabId = parsed.tabs.some((tab) => tab.id === parsed.activeTabId)
						? parsed.activeTabId
						: parsed.tabs[0].id;
				} else {
					resetTabs();
				}
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

	function addTab() {
		const tab = createTerminalTab();
		tabs = [...tabs, tab];
		activeTabId = tab.id;
	}

	function closeTab(id: string) {
		const closingTab = tabs.find((tab) => tab.id === id);
		if (!closingTab) return;
		if (tabs.length === 1) {
			const replacement = createTerminalTab();
			tabs = [replacement];
			activeTabId = replacement.id;
			void closeRemoteSession(closingTab.sessionId);
			return;
		}
		const nextTabs = tabs.filter((tab) => tab.id !== id);
		tabs = nextTabs;
		if (activeTabId === id) {
			activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)].id;
		}
		void closeRemoteSession(closingTab.sessionId);
	}

	function activateTabFromKey(event: KeyboardEvent, id: string) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activeTabId = id;
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Tab bar -->
	<div class="flex items-center border-b border-border bg-zinc-950">
		<div class="flex flex-1 overflow-x-auto">
			{#each tabs as tab (tab.id)}
				<div
					role="button"
					tabindex="0"
					onclick={() => (activeTabId = tab.id)}
					onkeydown={(event) => activateTabFromKey(event, tab.id)}
					class="flex items-center gap-1.5 border-r border-zinc-800 px-3 py-1.5 text-xs font-mono transition-colors
						{activeTabId === tab.id ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'}"
				>
					<span>{tab.name}</span>
					<button
						onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
						class="ml-1 rounded p-0.5 hover:bg-zinc-700"
					>
						<X class="h-2.5 w-2.5" />
					</button>
				</div>
			{/each}
		</div>
		<button
			onclick={addTab}
			class="px-2 py-1.5 text-zinc-500 hover:text-zinc-300"
			title="New terminal"
		>
			<Plus class="h-3.5 w-3.5" />
		</button>
	</div>

	<!-- Terminal panels -->
	<div class="flex-1 overflow-hidden">
		{#each tabs as tab (tab.id)}
			<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
				<SandboxTerminal
					{sandboxName}
					sessionId={tab.sessionId}
					active={activeTabId === tab.id}
				/>
			</div>
		{/each}
	</div>
</div>
