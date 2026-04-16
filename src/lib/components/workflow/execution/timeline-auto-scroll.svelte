<script lang="ts">
	import { tick } from 'svelte';
	import { getChatContainerContext } from '$lib/components/ui/prompt-kit/chat-container';

	interface Props {
		active: boolean;
		itemCount: number;
		executionId: string;
	}

	let { active, itemCount, executionId }: Props = $props();

	const context = getChatContainerContext();
	let previousExecutionId: string | null = null;
	let previousItemCount = 0;
	let initialScrollDone = false;

	function scheduleScroll(behavior: ScrollBehavior) {
		void tick().then(() => {
			requestAnimationFrame(() => {
				context.scrollToBottom(behavior);
			});
		});
	}

	$effect(() => {
		if (executionId !== previousExecutionId) {
			previousExecutionId = executionId;
			previousItemCount = 0;
			initialScrollDone = false;
		}

		if (!active || itemCount <= 0) return;

		if (!initialScrollDone) {
			initialScrollDone = true;
			previousItemCount = itemCount;
			scheduleScroll('instant');
			return;
		}

		if (itemCount !== previousItemCount) {
			const wasPinned = context.isAtBottom;
			previousItemCount = itemCount;
			if (wasPinned) {
				scheduleScroll('smooth');
			}
		}
	});
</script>
