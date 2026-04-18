<script lang="ts" module>
	/**
	 * Tiny JSON syntax highlighter. Renders a `<pre>` where string values,
	 * keys, numbers, booleans, and null get distinct colours. Not a
	 * full-fidelity highlighter — enough to match CMA's colourful JSON body
	 * on the session debug panel.
	 */
	export function highlightJson(value: unknown): string {
		const json = JSON.stringify(value, null, 2) ?? 'null';
		// biome-ignore lint/security/noGlobalEval: pure pattern-based HTML escape
		const escaped = json
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		return escaped.replace(
			/("(\\.|[^"\\])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
			(match) => {
				let cls = 'text-amber-300';
				if (/^"/.test(match)) {
					cls = /:$/.test(match) ? 'text-sky-300' : 'text-emerald-300';
				} else if (/true|false/.test(match)) {
					cls = 'text-purple-300';
				} else if (/null/.test(match)) {
					cls = 'text-muted-foreground';
				}
				return `<span class="${cls}">${match}</span>`;
			},
		);
	}
</script>

<script lang="ts">
	interface Props {
		value: unknown;
		class?: string;
	}
	let { value, class: klass = '' }: Props = $props();
	const html = $derived(highlightJson(value));
</script>

<pre
	class="overflow-x-auto rounded bg-muted/40 p-3 text-[11px] leading-relaxed {klass}"
>{@html html}</pre>
