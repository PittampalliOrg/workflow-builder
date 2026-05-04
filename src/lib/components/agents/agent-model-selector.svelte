<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { AGENT_MODEL_OPTIONS, agentModelOptionFor } from '$lib/agents/model-options';
	import { Button } from '$lib/components/ui/button';
	import * as ModelSelector from '$lib/components/ui/ai-elements/model-selector';
	import { cn } from '$lib/components/ui/utils';

	type ModelGroup = {
		heading: string;
		providers: string[];
	};

	const MODEL_GROUPS: ModelGroup[] = [
		{ heading: 'Anthropic', providers: ['anthropic'] },
		{ heading: 'OpenAI', providers: ['openai'] },
		{ heading: 'Microsoft Foundry', providers: ['foundry'] },
		{ heading: 'Together AI', providers: ['together'] },
		{ heading: 'NVIDIA NIM', providers: ['nvidia'] },
		{ heading: 'Google AI', providers: ['googleai'] },
		{ heading: 'DeepSeek', providers: ['deepseek'] },
		{ heading: 'Open Models', providers: ['huggingface', 'mistral'] },
		{ heading: 'Local', providers: ['echo'] }
	];

	let {
		value = null,
		unsupportedValue = null,
		placeholder = 'Select model',
		triggerClass = '',
		disabled = false,
		onSelect
	}: {
		value?: string | null;
		unsupportedValue?: string | null;
		placeholder?: string;
		triggerClass?: string;
		disabled?: boolean;
		onSelect: (modelSpec: string) => void | Promise<void>;
	} = $props();

	let open = $state(false);
	let search = $state('');
	const selectedOption = $derived(agentModelOptionFor(value));
	const unsupported = $derived(unsupportedValue?.trim() || null);
	const triggerLabel = $derived(selectedOption?.label ?? unsupported ?? placeholder);
	const triggerLogo = $derived(selectedOption?.iconProvider ?? 'generic');
	const groupedOptions = $derived.by(() =>
		MODEL_GROUPS.map((group) => ({
			...group,
			options: AGENT_MODEL_OPTIONS.filter((option) => group.providers.includes(option.provider))
		})).filter((group) => group.options.length > 0)
	);

	function choose(modelSpec: string) {
		open = false;
		search = '';
		void onSelect(modelSpec);
	}
</script>

<ModelSelector.Root bind:open>
	<ModelSelector.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				type="button"
				variant="outline"
				class={cn('w-full justify-between gap-2 overflow-hidden', triggerClass)}
				{disabled}
			>
				<span class="flex min-w-0 items-center gap-2">
					<ModelSelector.Logo provider={triggerLogo} />
					<ModelSelector.Name>{triggerLabel}</ModelSelector.Name>
				</span>
				<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
			</Button>
		{/snippet}
	</ModelSelector.Trigger>

	<ModelSelector.Dialog
		bind:open
		bind:value={search}
		title="Select model"
		description="Search models by provider, family, or model id"
	>
		{#if unsupported}
			<ModelSelector.Group heading="Current model">
				<ModelSelector.Item value={unsupported} disabled class="items-start gap-2">
					<ModelSelector.Logo provider="generic" class="mt-0.5" />
					<span class="flex min-w-0 flex-col">
						<span class="text-sm font-medium">Unsupported runtime model</span>
						<span class="truncate font-mono text-[11px] text-muted-foreground">{unsupported}</span>
					</span>
				</ModelSelector.Item>
			</ModelSelector.Group>
		{/if}

		{#each groupedOptions as group (group.heading)}
			<ModelSelector.Group heading={group.heading}>
				{#each group.options as model (model.value)}
					<ModelSelector.Item
						value={`${model.label} ${model.value} ${group.heading}`}
						data-checked={selectedOption?.value === model.value}
						onSelect={() => choose(model.value)}
						class="items-start gap-2"
					>
						<ModelSelector.Logo provider={model.iconProvider} class="mt-0.5" />
						<span class="flex min-w-0 flex-col">
							<ModelSelector.Name>{model.label}</ModelSelector.Name>
							<span class="truncate font-mono text-[11px] text-muted-foreground">{model.value}</span>
						</span>
					</ModelSelector.Item>
				{/each}
			</ModelSelector.Group>
		{/each}
	</ModelSelector.Dialog>
</ModelSelector.Root>
