<script lang="ts">
	import * as Command from '$lib/components/ui/command';
	import * as Dialog from '$lib/components/ui/dialog';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		value = $bindable(''),
		title = 'Model Selector',
		description = 'Search for a model',
		children
	}: {
		open?: boolean;
		value?: string;
		title?: string;
		description?: string;
		children?: Snippet;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b px-4 py-3">
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>
		<Command.Root bind:value class="rounded-none p-0">
			<Command.Input placeholder={description} class="h-9" />
			<Command.List class="max-h-[430px] p-1">
				<Command.Empty>No models found.</Command.Empty>
				{@render children?.()}
			</Command.List>
		</Command.Root>
	</Dialog.Content>
</Dialog.Root>
