<script lang="ts">
	import type { TimelineEdge } from "$lib/promoter/timeline-view";

	type Props = {
		edges: TimelineEdge[];
		container: HTMLElement | null;
		// Trigger recompute when this changes
		revision: number;
	};

	let { edges, container, revision }: Props = $props();

	type Path = { d: string; sha: string };

	let paths = $state<Path[]>([]);
	let bbox = $state({ width: 0, height: 0 });

	function recompute() {
		if (!container || edges.length === 0) {
			paths = [];
			bbox = { width: 0, height: 0 };
			return;
		}

		const containerRect = container.getBoundingClientRect();
		bbox = { width: containerRect.width, height: containerRect.height };
		const next: Path[] = [];

		for (const edge of edges) {
			const fromEl = container.querySelector<HTMLElement>(`[data-id="${cssEscape(edge.fromId)}"]`);
			const toEl = container.querySelector<HTMLElement>(`[data-id="${cssEscape(edge.toId)}"]`);
			if (!fromEl || !toEl) continue;

			const fromRect = fromEl.getBoundingClientRect();
			const toRect = toEl.getBoundingClientRect();

			const x1 = fromRect.right - containerRect.left;
			const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
			const x2 = toRect.left - containerRect.left;
			const y2 = toRect.top + toRect.height / 2 - containerRect.top;

			// Cubic bezier with mid control points pulled horizontally for a smooth S-curve.
			const dx = (x2 - x1) * 0.5;
			const c1x = x1 + dx;
			const c1y = y1;
			const c2x = x2 - dx;
			const c2y = y2;
			next.push({
				d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
				sha: edge.dryShaFull,
			});
		}

		paths = next;
	}

	function cssEscape(value: string): string {
		// Lightweight CSS.escape polyfill for selector-safe IDs.
		return value.replace(/(["\\#.:?[\]()/])/g, "\\$1");
	}

	$effect(() => {
		void revision;
		void edges;
		if (typeof window === "undefined") return;
		const id = window.requestAnimationFrame(() => recompute());
		return () => window.cancelAnimationFrame(id);
	});

	$effect(() => {
		if (typeof window === "undefined" || !container) return;
		const observer = new ResizeObserver(() => recompute());
		observer.observe(container);
		const onScroll = () => recompute();
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			observer.disconnect();
			container.removeEventListener("scroll", onScroll);
		};
	});
</script>

{#if paths.length > 0 && bbox.width > 0}
	<svg
		class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
		viewBox={`0 0 ${bbox.width} ${bbox.height}`}
		preserveAspectRatio="none"
		aria-hidden="true"
	>
		{#each paths as path, i (i + path.sha)}
			<path
				d={path.d}
				class="stroke-emerald-400/70 dark:stroke-emerald-500/60"
				fill="none"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-dasharray="4 3"
			/>
		{/each}
	</svg>
{/if}
