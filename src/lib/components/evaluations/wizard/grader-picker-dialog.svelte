<script lang="ts">
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import {
		Code2,
		FileText,
		Globe,
		Sparkles,
		Type
	} from '@lucide/svelte';
	import type { GraderType } from './wizard-store.svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (type: GraderType, mode?: 'labeler' | 'scorer') => void;
	}

	let { open, onOpenChange, onSelect }: Props = $props();

	type Tile = {
		type: GraderType;
		mode?: 'labeler' | 'scorer';
		title: string;
		desc: string;
		icon: typeof Type;
		live: boolean;
	};

	// Mirror OpenAI's grader catalog. "live" = backend runner exists today.
	const tiles: Tile[] = [
		{
			type: 'llm_judge',
			title: 'Kimi K3 judge',
			desc: 'Score each output against an editable rubric with Kimi K3.',
			icon: Sparkles,
			live: true
		},
		{
			type: 'score_model',
			mode: 'labeler',
			title: 'Model labeler',
			desc: "Use a model to classify your data and determine passing results.",
			icon: Sparkles,
			live: false
		},
		{
			type: 'score_model',
			mode: 'scorer',
			title: 'Model scorer',
			desc: "Use a model to assign a numeric score, within your specified range.",
			icon: Sparkles,
			live: false
		},
		{
			type: 'python',
			title: 'Python grader',
			desc: 'Executes Python code to evaluate your data, returning a numeric score.',
			icon: Code2,
			live: false
		},
		{
			type: 'string_check',
			title: 'String check',
			desc: 'Check for exact or partial matches against a reference value.',
			icon: Type,
			live: true
		},
		{
			type: 'text_similarity',
			title: 'Text similarity',
			desc: 'Use metrics like fuzzy match, BLEU, ROUGE, or cosine similarity.',
			icon: FileText,
			live: true
		},
		{
			type: 'endpoint',
			title: 'Endpoint grader',
			desc: 'POSTs samples to your HTTPS endpoint; expects a numeric score in response.',
			icon: Globe,
			live: false
		}
	];

	function pick(t: Tile) {
		onSelect(t.type, t.mode);
		onOpenChange(false);
	}
</script>

<Dialog {open} {onOpenChange}>
	<DialogContent class="sm:max-w-2xl">
		<DialogHeader>
			<DialogTitle>Add testing criteria</DialogTitle>
			<DialogDescription>
				Choose how this evaluation will judge each model output.
			</DialogDescription>
		</DialogHeader>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
			{#each tiles as tile (tile.title)}
				<button
					type="button"
					onclick={() => pick(tile)}
					class="border rounded-md p-3 text-left transition-colors hover:bg-muted/40 flex items-start gap-3"
				>
					<div class="size-8 rounded-md bg-muted flex items-center justify-center shrink-0">
						<tile.icon class="size-4 text-muted-foreground" />
					</div>
					<div class="min-w-0">
						<div class="font-medium text-sm flex items-center gap-2">
							{tile.title}
							{#if !tile.live}
								<span class="text-[10px] text-muted-foreground">UI only · runner coming</span>
							{/if}
						</div>
						<div class="text-xs text-muted-foreground mt-0.5">{tile.desc}</div>
					</div>
				</button>
			{/each}
		</div>
	</DialogContent>
</Dialog>
