<script lang="ts">
	/**
	 * Renders a provider-specific icon based on model name.
	 * Uses the Claude sparkle for Anthropic models and the OpenAI flower for OpenAI models.
	 * Falls back to a generic sparkle SVG for unknown providers.
	 */
	import { cn } from "$lib/components/ui/utils";

	let {
		model = '',
		size = 16,
		class: className = '',
	}: {
		model?: string;
		size?: number;
		class?: string;
	} = $props();

	let provider = $derived.by(() => {
		const m = model.toLowerCase();
		if (m.includes('anthropic') || m.includes('claude')) return 'anthropic';
		if (m.includes('openai') || m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('codex')) return 'openai';
		return 'generic';
	});
</script>

{#if provider === 'anthropic'}
	<img
		src="/icons/claude.svg"
		alt="Claude"
		width={size}
		height={size}
		class={cn("shrink-0", className)}
	/>
{:else if provider === 'openai'}
	<img
		src="/icons/openai.svg"
		alt="OpenAI"
		width={size}
		height={size}
		class={cn("shrink-0", className)}
	/>
{:else}
	<!-- Generic AI — sparkle icon -->
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={cn("shrink-0", className)}
		aria-label="AI"
	>
		<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
	</svg>
{/if}
