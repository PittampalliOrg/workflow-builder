<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { Check, Copy } from 'lucide-svelte';

	interface Props {
		/** Three code blocks: curl, python, typescript — caller renders the exact request. */
		curl: string;
		python: string;
		typescript: string;
	}

	let { curl, python, typescript }: Props = $props();

	let tab = $state<'curl' | 'python' | 'typescript'>('curl');
	let copiedTab = $state<string | null>(null);

	async function copyCurrent() {
		const src = tab === 'curl' ? curl : tab === 'python' ? python : typescript;
		try {
			await navigator.clipboard.writeText(src);
			copiedTab = tab;
			setTimeout(() => {
				if (copiedTab === tab) copiedTab = null;
			}, 1500);
		} catch {
			/* no clipboard permission */
		}
	}
</script>

<Tabs value={tab} onValueChange={(v) => (tab = v as typeof tab)}>
	<div class="flex items-center justify-between mb-2">
		<TabsList class="h-8">
			<TabsTrigger value="curl" class="text-xs">cURL</TabsTrigger>
			<TabsTrigger value="python" class="text-xs">Python</TabsTrigger>
			<TabsTrigger value="typescript" class="text-xs">TypeScript</TabsTrigger>
		</TabsList>
		<Button variant="ghost" size="sm" onclick={copyCurrent} class="h-7 text-xs">
			{#if copiedTab === tab}
				<Check class="size-3" /> Copied
			{:else}
				<Copy class="size-3" /> Copy
			{/if}
		</Button>
	</div>
	<TabsContent value="curl">
		<pre class="bg-muted rounded p-3 text-[11px] overflow-x-auto font-mono"><code>{curl}</code></pre>
	</TabsContent>
	<TabsContent value="python">
		<pre class="bg-muted rounded p-3 text-[11px] overflow-x-auto font-mono"><code>{python}</code></pre>
	</TabsContent>
	<TabsContent value="typescript">
		<pre
			class="bg-muted rounded p-3 text-[11px] overflow-x-auto font-mono"><code>{typescript}</code></pre>
	</TabsContent>
</Tabs>
