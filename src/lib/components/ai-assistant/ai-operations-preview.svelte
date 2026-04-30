<script lang="ts">
	import { getContext } from 'svelte';
	import { Check, X, FileCode, AlertTriangle, Wand2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { AiAssistantOperationResult, createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';

	interface Props {
		spec?: Record<string, unknown>;
		result?: AiAssistantOperationResult;
		messageId: string;
	}

	let { spec, result, messageId }: Props = $props();
	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	// Summarize what changed in the spec — handle `do` at root or inside document
	function getDoArray(): Array<Record<string, unknown>> {
		if (Array.isArray(spec?.do)) return spec.do as Array<Record<string, unknown>>;
		const doc = spec?.document as Record<string, unknown> | undefined;
		if (doc && Array.isArray(doc.do)) return doc.do as Array<Record<string, unknown>>;
		return [];
	}

	let taskCount = $derived(getDoArray().length);

	let taskNames = $derived.by(() => {
		return getDoArray().map((entry) => Object.keys(entry)[0]).filter(Boolean);
	});

	let specName = $derived((spec?.document as Record<string, unknown>)?.title || (spec?.document as Record<string, unknown>)?.name || 'Untitled');
	let operationCount = $derived(result?.operations?.length ?? 0);
	let changedTasks = $derived(result?.changedTaskNames ?? []);
	let validationErrors = $derived([
		...(result?.validation?.errors ?? []),
		...(result?.canvasApplyErrors ?? []),
	]);
	let status = $derived.by(() => {
		if (!result) return 'pending';
		if (result.canvasApplyStatus === 'failed') return 'apply-failed';
		if (result.canvasApplyStatus === 'applied') return 'applied';
		if (result.needsClarification) return 'needs-input';
		if (!result.validation.valid) return 'blocked';
		if (result.autoApply && result.validation.valid) return 'applying';
		return 'ready';
	});

	function operationLabel(operation: Record<string, unknown>): string {
		const op = String(operation.op || 'operation').replace(/_/g, ' ');
		const taskName = operation.taskName || operation.newTaskName;
		return taskName ? `${op}: ${taskName}` : op;
	}

	function handleApply() {
		if (!spec) return;
		window.dispatchEvent(
			new CustomEvent('ai-assistant:apply-spec', {
				detail: { spec, messageId },
			}),
		);
	}

	function handleDismiss() {
		assistant.dismissSpec();
	}
</script>

<div class="rounded-lg border border-border bg-card p-2.5 space-y-2">
	<div class="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
		{#if result}
			<Wand2 size={10} />
			Workflow Changes
		{:else}
			<FileCode size={10} />
			Workflow Spec
		{/if}
	</div>

	{#if result}
		<div class="space-y-1.5 text-[10px]">
			<div class="flex items-center gap-1.5">
				{#if status === 'applied'}
					<Check size={11} class="text-emerald-600" />
					<span class="font-medium">Applied {operationCount} change{operationCount !== 1 ? 's' : ''}</span>
				{:else if status === 'applying'}
					<FileCode size={11} class="text-muted-foreground" />
					<span class="font-medium">Applying {operationCount} change{operationCount !== 1 ? 's' : ''}</span>
				{:else if status === 'needs-input'}
					<AlertTriangle size={11} class="text-amber-600" />
					<span class="font-medium">Needs clarification</span>
				{:else if status === 'apply-failed'}
					<AlertTriangle size={11} class="text-destructive" />
					<span class="font-medium">Canvas apply failed</span>
				{:else if status === 'blocked'}
					<AlertTriangle size={11} class="text-destructive" />
					<span class="font-medium">Not applied</span>
				{:else}
					<FileCode size={11} class="text-muted-foreground" />
					<span class="font-medium">Validated changes</span>
				{/if}
			</div>

			{#if changedTasks.length > 0}
				<div class="text-muted-foreground">
					Changed: {changedTasks.join(' → ')}
				</div>
			{/if}

			{#if result.toolCalls && result.toolCalls.length > 0}
				<div class="text-muted-foreground">
					Checked: {result.toolCalls.join(', ')}
				</div>
			{/if}

			{#if operationCount > 0}
				<div class="space-y-0.5 rounded-md bg-muted/50 p-1.5">
					{#each result.operations as operation}
						<div>{operationLabel(operation)}</div>
					{/each}
				</div>
			{/if}

			{#if validationErrors.length > 0}
				<div class="rounded-md border border-destructive/30 bg-destructive/5 p-1.5 text-destructive">
					{validationErrors.join(' ')}
				</div>
			{/if}
		</div>
	{:else}
		<div class="space-y-1 text-[10px]">
			<div class="flex items-center gap-1.5">
				<span class="text-muted-foreground">Name:</span>
				<span class="font-medium">{specName}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<span class="text-muted-foreground">Tasks:</span>
				<span>{taskCount}</span>
			</div>
			{#if taskNames.length > 0}
				<div class="text-muted-foreground">
					{taskNames.join(' → ')}
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-1.5 pt-1">
			<Button size="sm" class="h-6 text-[10px] px-2.5 gap-1" onclick={handleApply}>
				<Check size={10} />
				Apply Spec
			</Button>
			<Button variant="outline" size="sm" class="h-6 text-[10px] px-2.5 gap-1" onclick={handleDismiss}>
				<X size={10} />
				Dismiss
			</Button>
		</div>
	{/if}
</div>
