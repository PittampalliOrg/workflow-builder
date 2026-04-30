<script lang="ts">
	type Slice = { reason: string; count: number };
	type Props = {
		data: Slice[];
		class?: string;
	};

	const { data, class: className = '' }: Props = $props();

	const total = $derived(data.reduce((a, b) => a + b.count, 0));

	// Termination semantics:
	//   end_turn — clean exit, agent decided it was done. Green.
	//   max_iters — ran out of turn budget. Amber.
	//   circuit_breaker_empty / circuit_breaker_failure — call_llm bailed.
	//     Red because they almost always indicate an SDK/provider issue.
	//   session_turn_timeout — session_workflow's turn timer fired. Red.
	//   agent_error — uncaught exception in agent_workflow. Red.
	//   cancelled / unknown — gray.
	function colorFor(reason: string): string {
		switch (reason) {
			case 'end_turn':
				return 'rgb(16 185 129)';
			case 'max_iters':
				return 'rgb(245 158 11)';
			case 'circuit_breaker_empty':
			case 'circuit_breaker_failure':
			case 'session_turn_timeout':
			case 'agent_error':
				return 'rgb(239 68 68)';
			case 'cancelled':
				return 'rgb(156 163 175)';
			default:
				return 'rgb(100 116 139)';
		}
	}

	type Arc = {
		reason: string;
		color: string;
		count: number;
		pct: number;
		offset: number;
		len: number;
	};

	const arcs = $derived.by<Arc[]>(() => {
		if (total === 0) return [];
		const circumference = 2 * Math.PI * 40;
		let offset = 0;
		return data.map((s) => {
			const pct = s.count / total;
			const len = circumference * pct;
			const a: Arc = {
				reason: s.reason,
				color: colorFor(s.reason),
				count: s.count,
				pct,
				offset,
				len
			};
			offset += len;
			return a;
		});
	});
</script>

<div class="rounded-md border border-border bg-background p-4 {className}">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			By termination
		</h3>
		<span class="text-[10px] text-muted-foreground">{total} reported</span>
	</div>
	{#if total === 0}
		<p class="py-6 text-center text-xs text-muted-foreground">
			No termination data yet — runs predating Phase B won't have it.
		</p>
	{:else}
		<div class="flex items-center gap-4">
			<svg viewBox="0 0 100 100" class="h-28 w-28 shrink-0 -rotate-90">
				<circle
					cx="50"
					cy="50"
					r="40"
					fill="none"
					stroke="rgb(229 231 235)"
					stroke-width="14"
					class="dark:[stroke:rgb(45_55_72)]"
				/>
				{#each arcs as a (a.reason)}
					<circle
						cx="50"
						cy="50"
						r="40"
						fill="none"
						stroke={a.color}
						stroke-width="14"
						stroke-dasharray={`${a.len} ${2 * Math.PI * 40 - a.len}`}
						stroke-dashoffset={`${-a.offset}`}
					/>
				{/each}
			</svg>
			<ul class="flex-1 space-y-1 text-xs">
				{#each arcs as a (a.reason)}
					<li class="flex items-center justify-between gap-2">
						<span class="flex min-w-0 items-center gap-2">
							<span
								class="block h-2.5 w-2.5 shrink-0 rounded-sm"
								style:background-color={a.color}
								aria-hidden="true"
							></span>
							<span class="truncate font-mono">{a.reason}</span>
						</span>
						<span class="shrink-0 tabular-nums">
							<span class="font-semibold">{a.count}</span>
							<span class="text-muted-foreground">({Math.round(a.pct * 100)}%)</span>
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
