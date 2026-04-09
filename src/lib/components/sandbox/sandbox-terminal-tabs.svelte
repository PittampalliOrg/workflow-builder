<script lang="ts">
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
	}

	let tabs = $state<TerminalTab[]>([{ id: '1', name: 'Terminal 1' }]);
	let activeTabId = $state('1');
	let nextId = 2;

	function addTab() {
		const id = String(nextId++);
		tabs = [...tabs, { id, name: `Terminal ${id}` }];
		activeTabId = id;
	}

	function closeTab(id: string) {
		if (tabs.length <= 1) return;
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTabId === id) {
			activeTabId = tabs[tabs.length - 1].id;
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Tab bar -->
	<div class="flex items-center border-b border-border bg-zinc-950">
		<div class="flex flex-1 overflow-x-auto">
			{#each tabs as tab (tab.id)}
				<button
					onclick={() => (activeTabId = tab.id)}
					class="flex items-center gap-1.5 border-r border-zinc-800 px-3 py-1.5 text-xs font-mono transition-colors
						{activeTabId === tab.id ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'}"
				>
					<span>{tab.name}</span>
					{#if tabs.length > 1}
						<button
							onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
							class="ml-1 rounded p-0.5 hover:bg-zinc-700"
						>
							<X class="h-2.5 w-2.5" />
						</button>
					{/if}
				</button>
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
				<SandboxTerminal {sandboxName} />
			</div>
		{/each}
	</div>
</div>
