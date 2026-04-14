<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { Schema, UiSchemaRoot } from '@sjsf/form';
	import JsonSchemaGeneratedForm from './json-schema-generated-form.svelte';

	interface Props {
		schema: Record<string, unknown> | null;
		value: unknown;
		onChange: (value: unknown) => void;
		title?: string | null;
		description?: string | null;
		jsonRows?: number;
		uiSchema?: UiSchemaRoot;
	}

	let {
		schema,
		value,
		onChange,
		title = null,
		description = null,
		jsonRows = 6,
		uiSchema = {}
	}: Props = $props();

	let mode = $state<'form' | 'json'>('form');
	let jsonDraft = $state('');
	let jsonError = $state<string | null>(null);
	let lastSerializedValue = $state('');

	function stableStringify(nextValue: unknown): string {
		try {
			return JSON.stringify(nextValue ?? {}, null, 2);
		} catch {
			return String(nextValue ?? '');
		}
	}

	function schemaKey(nextSchema: Record<string, unknown> | null): string {
		try {
			return JSON.stringify(nextSchema ?? {});
		} catch {
			return '';
		}
	}

	function applyJson(raw: string) {
		jsonDraft = raw;
		try {
			const parsed = raw.trim() ? JSON.parse(raw) : {};
			jsonError = null;
			lastSerializedValue = stableStringify(parsed);
			onChange(parsed);
		} catch (error) {
			jsonError = error instanceof Error ? error.message : 'Invalid JSON';
		}
	}

	$effect(() => {
		const nextSerialized = stableStringify(value);
		if (nextSerialized !== lastSerializedValue) {
			lastSerializedValue = nextSerialized;
			jsonDraft = nextSerialized;
			jsonError = null;
		}
	});
</script>

<div class="space-y-2">
	{#if title || description}
		<div class="space-y-0.5">
			{#if title}
				<p class="text-xs font-semibold">{title}</p>
			{/if}
			{#if description}
				<p class="text-[10px] text-muted-foreground">{description}</p>
			{/if}
		</div>
	{/if}

	<Tabs.Root bind:value={mode} class="min-h-0 gap-2">
		<Tabs.List class="h-7 w-full">
			<Tabs.Trigger value="form" class="text-xs">Form</Tabs.Trigger>
			<Tabs.Trigger value="json" class="text-xs">JSON</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="form" class="mt-0">
			{#if schema}
				{#key schemaKey(schema)}
					<svelte:boundary>
						<JsonSchemaGeneratedForm
							schema={schema as Schema}
							{value}
							{onChange}
							{uiSchema}
						/>

						{#snippet failed(error)}
							<Alert variant="destructive">
								<AlertDescription>
									Form rendering failed for this schema. Use the JSON tab for this value.
									{#if error instanceof Error && error.message}
										<span class="mt-1 block font-mono text-[10px]">{error.message}</span>
									{/if}
								</AlertDescription>
							</Alert>
						{/snippet}
					</svelte:boundary>
				{/key}
			{:else}
				<p class="rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
					No schema is available for this input.
				</p>
			{/if}
		</Tabs.Content>
		<Tabs.Content value="json" class="mt-0 space-y-2">
			{#if jsonError}
				<Alert variant="destructive">
					<AlertDescription>{jsonError}</AlertDescription>
				</Alert>
			{/if}
			<Textarea
				value={jsonDraft}
				oninput={(event) => applyJson(event.currentTarget.value)}
				rows={jsonRows}
				class="font-mono text-xs"
				placeholder={'{}'}
			/>
		</Tabs.Content>
	</Tabs.Root>
</div>
