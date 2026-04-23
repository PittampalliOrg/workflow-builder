<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Loader2 } from 'lucide-svelte';
	import {
		Dialog,
		DialogContent,
		DialogHeader,
		DialogTitle,
		DialogDescription,
		DialogFooter
	} from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();
	let prompt = $state('');
	let isGenerating = $state(false);
	let errorMessage = $state('');
	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	async function generate() {
		if (!prompt.trim()) return;
		isGenerating = true;
		errorMessage = '';

		try {
			// Step 1: Generate workflow definition from prompt
			const genRes = await fetch('/api/workflows/generate-from-prompt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: prompt.trim() })
			});

			if (!genRes.ok) {
				const text = await genRes.text();
				throw new Error(text || `Generation failed (${genRes.status})`);
			}

			const generated = await genRes.json();

			// Step 2: Create the workflow in the database
			const createRes = await fetch('/api/workflows', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: generated.name,
					nodes: generated.nodes,
					edges: generated.edges
				})
			});

			if (!createRes.ok) {
				throw new Error('Failed to save generated workflow');
			}

			const workflow = await createRes.json();

			// Step 3: Navigate to the editor
			prompt = '';
			onClose();
			goto(`/workspaces/${slug}/workflows/${workflow.id}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Generation failed';
			console.error('AI generation failed:', err);
		} finally {
			isGenerating = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isGenerating) {
			generate();
		}
	}
</script>

<Dialog {open} onOpenChange={(v) => { if (!v) onClose(); }}>
	<DialogContent class="sm:max-w-md">
		<DialogHeader>
			<DialogTitle>Generate Workflow with AI</DialogTitle>
			<DialogDescription>
				Describe the workflow you want to create and AI will generate it for you.
			</DialogDescription>
		</DialogHeader>

		<div class="space-y-4">
			<div class="space-y-1.5">
				<Label for="ai-prompt">Prompt</Label>
				<Textarea
					id="ai-prompt"
					bind:value={prompt}
					onkeydown={handleKeydown}
					placeholder="e.g., A workflow that fetches data from an API, transforms it, and sends a notification email if conditions are met..."
					rows={4}
					disabled={isGenerating}
				/>
			</div>

			{#if errorMessage}
				<p class="text-sm text-destructive">{errorMessage}</p>
			{/if}
		</div>

		<DialogFooter>
			<Button variant="outline" onclick={onClose} disabled={isGenerating}>
				Cancel
			</Button>
			<Button onclick={generate} disabled={isGenerating || !prompt.trim()}>
				{#if isGenerating}
					<Loader2 size={14} class="animate-spin" />
					Generating...
				{:else}
					Generate
				{/if}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
