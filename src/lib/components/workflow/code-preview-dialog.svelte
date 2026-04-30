<script lang="ts">
	import { Copy, Download, Save, Loader2 } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Badge } from '$lib/components/ui/badge';

	type Language = 'typescript' | 'python';

	interface Props {
		open: boolean;
		workflowId: string;
		workflowName: string;
		onClose: () => void;
	}

	const { open, workflowId, workflowName, onClose }: Props = $props();

	let language = $state<Language>('typescript');
	let inlineFunctions = $state(true);
	let loading = $state(false);
	let saving = $state(false);
	let source = $state('');
	let warnings = $state<string[]>([]);
	let filename = $state('workflow.ts');
	let compositionGraph = $state<{ activitySlugs: string[]; hasFork: boolean; hasSwitch: boolean; hasDurableAgent: boolean } | null>(null);

	$effect(() => {
		if (open && workflowId) {
			void loadPreview();
		}
	});

	async function loadPreview() {
		loading = true;
		try {
			const params = new URLSearchParams({
				language: language === 'typescript' ? 'ts' : 'py',
				inlineFunctions: inlineFunctions ? 'true' : 'false',
				format: 'json',
			});
			const res = await fetch(`/api/workflows/${workflowId}/export?${params}`);
			if (!res.ok) {
				const msg = await res.text().catch(() => 'Failed to load preview');
				toast.error('Preview failed', { description: msg });
				source = '';
				return;
			}
			const data = await res.json();
			source = data.source ?? '';
			warnings = data.warnings ?? [];
			filename = data.filename ?? filename;
			compositionGraph = data.compositionGraph ?? null;
		} catch (err) {
			toast.error('Preview failed', { description: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(source);
			toast.success('Copied to clipboard');
		} catch (err) {
			toast.error('Copy failed', { description: (err as Error).message });
		}
	}

	function downloadFile() {
		const blob = new Blob([source], {
			type: language === 'typescript' ? 'text/typescript' : 'text/x-python',
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
	}

	async function saveAsCodeFunction() {
		saving = true;
		try {
			const params = new URLSearchParams({
				language: language === 'typescript' ? 'ts' : 'py',
				inlineFunctions: inlineFunctions ? 'true' : 'false',
			});
			const res = await fetch(`/api/workflows/${workflowId}/export?${params}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			if (!res.ok) {
				const msg = await res.text().catch(() => 'Save failed');
				toast.error('Save failed', { description: msg });
				return;
			}
			const data = await res.json();
			toast.success(`Saved as code function "${data.name}"`, {
				description: `${data.warnings?.length ?? 0} warning(s). role=workflow.`,
			});
			onClose();
		} catch (err) {
			toast.error('Save failed', { description: (err as Error).message });
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={(v) => !v && onClose()}>
	<Dialog.Content
		class="!max-w-[min(96vw,1100px)] flex max-h-[90vh] flex-col gap-3"
	>
		<Dialog.Header class="shrink-0">
			<Dialog.Title>Export workflow as code</Dialog.Title>
			<Dialog.Description>
				Emit "{workflowName}" as a runnable {language === 'typescript' ? 'TypeScript' : 'Python'} file.
				Inlined code functions become direct calls; other activities dispatch through the shim to function-router.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3">
			<div class="flex items-center gap-2">
				<Label class="text-xs">Language</Label>
				<div class="flex gap-1">
					<Button
						variant={language === 'typescript' ? 'default' : 'outline'}
						size="sm"
						class="h-7 text-xs"
						onclick={() => {
							language = 'typescript';
							void loadPreview();
						}}
					>
						TypeScript
					</Button>
					<Button
						variant={language === 'python' ? 'default' : 'outline'}
						size="sm"
						class="h-7 text-xs"
						onclick={() => {
							language = 'python';
							void loadPreview();
						}}
					>
						Python
					</Button>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<Switch
					checked={inlineFunctions}
					onCheckedChange={(v) => {
						inlineFunctions = v;
						void loadPreview();
					}}
				/>
				<Label class="whitespace-nowrap text-xs">Inline code functions</Label>
			</div>
			{#if compositionGraph}
				<div class="ml-auto flex flex-wrap gap-1">
					<Badge variant="outline" class="text-[10px]">
						{compositionGraph.activitySlugs.length} activit{compositionGraph.activitySlugs.length === 1 ? 'y' : 'ies'}
					</Badge>
					{#if compositionGraph.hasSwitch}
						<Badge variant="outline" class="text-[10px]">switch</Badge>
					{/if}
					{#if compositionGraph.hasFork}
						<Badge variant="outline" class="text-[10px]">fork</Badge>
					{/if}
					{#if compositionGraph.hasDurableAgent}
						<Badge variant="outline" class="text-[10px]">agent turn</Badge>
					{/if}
				</div>
			{/if}
		</div>

		{#if warnings.length > 0}
			<div
				class="max-h-32 shrink-0 overflow-y-auto rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs"
			>
				<div class="mb-1 font-medium text-amber-600 dark:text-amber-400">
					{warnings.length} warning{warnings.length === 1 ? '' : 's'}
				</div>
				<ul class="list-disc space-y-0.5 pl-4 text-muted-foreground">
					{#each warnings as warning (warning)}
						<li>{warning}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div
			class="relative min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 font-mono text-xs"
		>
			{#if loading}
				<div class="absolute inset-0 flex items-center justify-center">
					<Loader2 class="animate-spin text-muted-foreground" size={16} />
				</div>
			{:else}
				<pre class="p-3 whitespace-pre">{source}</pre>
			{/if}
		</div>

		<Dialog.Footer class="flex shrink-0 flex-wrap items-center justify-between gap-2">
			<div class="min-w-0 truncate text-xs text-muted-foreground">
				Target filename: <code class="rounded bg-muted px-1.5 py-0.5">{filename}</code>
			</div>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="outline" size="sm" onclick={copyToClipboard} disabled={loading || !source}>
					<Copy size={12} /> Copy
				</Button>
				<Button variant="outline" size="sm" onclick={downloadFile} disabled={loading || !source}>
					<Download size={12} /> Download
				</Button>
				<Button size="sm" onclick={saveAsCodeFunction} disabled={saving || loading || !source}>
					{#if saving}
						<Loader2 class="animate-spin" size={12} />
					{:else}
						<Save size={12} />
					{/if}
					Save as code function
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
