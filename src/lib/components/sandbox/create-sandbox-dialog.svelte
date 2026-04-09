<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Loader2 } from 'lucide-svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onCreated?: () => void;
	}

	let { open = $bindable(), onOpenChange, onCreated }: Props = $props();

	let name = $state('');
	let provider = $state('claude');
	let creating = $state(false);
	let error = $state<string | null>(null);

	async function create() {
		if (!name.trim() || creating) return;
		creating = true;
		error = null;

		try {
			const res = await fetch('/api/sandboxes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), provider })
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				error = data.error ?? 'Failed to create sandbox';
				return;
			}
			name = '';
			onOpenChange(false);
			onCreated?.();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create sandbox';
		} finally {
			creating = false;
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Create Sandbox</Dialog.Title>
			<Dialog.Description>Create a new OpenShell sandbox environment.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4 py-4">
			<div class="flex flex-col gap-1.5">
				<label for="sandbox-name" class="text-sm font-medium">Name</label>
				<input
					id="sandbox-name"
					type="text"
					bind:value={name}
					placeholder="my-sandbox"
					class="rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<label for="sandbox-provider" class="text-sm font-medium">Provider</label>
				<NativeSelect bind:value={provider}>
					<option value="claude">Claude</option>
					<option value="nvidia">NVIDIA</option>
					<option value="openai">OpenAI</option>
					<option value="github">GitHub</option>
					<option value="ollama">Ollama (local)</option>
				</NativeSelect>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
			<Button onclick={create} disabled={!name.trim() || creating}>
				{#if creating}
					<Loader2 class="mr-2 h-4 w-4 animate-spin" />
				{/if}
				Create
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
