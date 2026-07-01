<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { MessageCircle, X } from '@lucide/svelte';

	/**
	 * Bottom-right sticky feedback chip, matches CMA's "Claude is active in this
	 * tab group" chip. Clicking opens a GitHub issue prefilled with the current
	 * path so the reporter doesn't have to retype where they saw the problem.
	 * Dismissible via the X; dismissal persists to localStorage for 24h.
	 */

	const DISMISS_KEY = 'feedback-widget-dismissed-until';
	let dismissed = $state(false);

	function isDismissed(): boolean {
		if (typeof localStorage === 'undefined') return false;
		const until = Number.parseInt(localStorage.getItem(DISMISS_KEY) ?? '0', 10);
		return Number.isFinite(until) && until > Date.now();
	}

	function dismiss() {
		dismissed = true;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(DISMISS_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
		}
	}

	function openFeedback() {
		const path =
			typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
		const url = new URL('https://github.com/PittampalliOrg/workflow-builder/issues/new');
		url.searchParams.set('title', `Feedback from ${path}`);
		url.searchParams.set(
			'body',
			`**Page:** ${path}\n**UA:** ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}\n\n---\n\n<!-- your feedback -->`
		);
		window.open(url.toString(), '_blank', 'noreferrer');
	}

	$effect(() => {
		dismissed = isDismissed();
	});
</script>

{#if !dismissed}
	<div class="fixed bottom-4 right-4 z-40">
		<div
			class="flex items-center gap-1 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs shadow-md backdrop-blur"
		>
			<Button
				variant="ghost"
				size="sm"
				class="h-6 gap-1.5 px-2 text-xs"
				onclick={openFeedback}
			>
				<MessageCircle class="size-3" />
				Feedback
			</Button>
			<button
				type="button"
				class="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
				aria-label="Dismiss feedback widget"
				onclick={dismiss}
			>
				<X class="size-3" />
			</button>
		</div>
	</div>
{/if}
