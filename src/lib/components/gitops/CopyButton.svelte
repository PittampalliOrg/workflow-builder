<script lang="ts">
	import { Check, Copy } from "@lucide/svelte";

	type Props = {
		value: string | null | undefined;
		label?: string;
	};

	let { value, label }: Props = $props();

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	async function copy() {
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard API unavailable (non-secure origin, permissions denied).
			// Fall back to an obscure old-school selection trick.
			const input = document.createElement("input");
			input.value = value;
			document.body.appendChild(input);
			input.select();
			try {
				document.execCommand("copy");
				copied = true;
				if (resetTimer) clearTimeout(resetTimer);
				resetTimer = setTimeout(() => (copied = false), 1500);
			} finally {
				document.body.removeChild(input);
			}
		}
	}
</script>

<button
	type="button"
	class="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
	onclick={copy}
	disabled={!value}
	aria-label={label ?? "Copy"}
	title={copied ? "Copied!" : label ?? "Copy"}
>
	{#if copied}
		<Check class="size-3 text-emerald-500" />
	{:else}
		<Copy class="size-3" />
	{/if}
</button>
