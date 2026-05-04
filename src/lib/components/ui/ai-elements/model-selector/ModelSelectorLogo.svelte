<script lang="ts">
	import { cn } from '$lib/components/ui/utils';
	import type { HTMLImgAttributes } from 'svelte/elements';

	type Props = Omit<HTMLImgAttributes, 'src' | 'alt'> & {
		provider: string;
	};

	let { provider, class: className, ...restProps }: Props = $props();
</script>

<img
	{...restProps}
	alt={`${provider} logo`}
	class={cn('size-4 shrink-0 rounded-[3px]', className)}
	height="16"
	src={`https://models.dev/logos/${provider}.svg`}
	width="16"
/>
