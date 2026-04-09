<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Save, X, Loader2 } from 'lucide-svelte';

	interface Props {
		sandboxName: string;
		filePath: string;
		initialContent: string;
		onClose: () => void;
		onSaved?: () => void;
	}

	let { sandboxName, filePath, initialContent, onClose, onSaved }: Props = $props();

	let content = $state(initialContent);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state<string | null>(null);

	const isDirty = $derived(content !== initialContent);

	async function save() {
		saving = true;
		error = null;
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'write', path: filePath, content })
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				error = data.error ?? 'Failed to save';
				return;
			}
			saved = true;
			setTimeout(() => (saved = false), 2000);
			onSaved?.();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			if (isDirty) save();
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Toolbar -->
	<div class="flex items-center justify-between border-b border-border px-3 py-1.5 bg-muted/30">
		<div class="flex items-center gap-2">
			<span class="font-mono text-xs text-muted-foreground truncate max-w-[300px]">{filePath}</span>
			{#if isDirty}
				<span class="text-xs text-yellow-500">modified</span>
			{/if}
			{#if saved}
				<span class="text-xs text-green-500">saved</span>
			{/if}
			{#if error}
				<span class="text-xs text-destructive">{error}</span>
			{/if}
		</div>
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={save} disabled={!isDirty || saving}>
				{#if saving}
					<Loader2 class="mr-1 h-3 w-3 animate-spin" />
				{:else}
					<Save class="mr-1 h-3 w-3" />
				{/if}
				Save
			</Button>
			<Button variant="ghost" size="icon" class="h-7 w-7" onclick={onClose}>
				<X class="h-3.5 w-3.5" />
			</Button>
		</div>
	</div>

	<!-- Editor -->
	<textarea
		bind:value={content}
		onkeydown={onKeydown}
		class="flex-1 resize-none bg-[#0d1117] p-4 font-mono text-xs leading-5 text-zinc-100 outline-none"
		spellcheck="false"
	></textarea>
</div>
