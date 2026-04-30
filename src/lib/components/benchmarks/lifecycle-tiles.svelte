<script lang="ts">
	import { formatDuration } from './run-status-helpers';

	type Props = {
		turnCountP50: number | null;
		turnCountP90: number | null;
		ttftP50: number | null;
		ttftP90: number | null;
		toolCallsTotal: number;
		distinctTools: number;
	};

	const {
		turnCountP50,
		turnCountP90,
		ttftP50,
		ttftP90,
		toolCallsTotal,
		distinctTools
	}: Props = $props();

	function formatTurns(v: number | null): string {
		if (v === null) return '—';
		return v.toFixed(0);
	}
</script>

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
			Turns / instance
		</div>
		<div class="mt-1 text-xl font-semibold tabular-nums">
			{formatTurns(turnCountP50)}
			<span class="text-xs font-normal text-muted-foreground">P50</span>
		</div>
		<div class="mt-1 text-[11px] text-muted-foreground">
			P90 {formatTurns(turnCountP90)}
		</div>
	</div>
	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
			TTFT (first token)
		</div>
		<div class="mt-1 text-xl font-semibold tabular-nums">
			{ttftP50 === null ? '—' : formatDuration(ttftP50)}
			<span class="text-xs font-normal text-muted-foreground">P50</span>
		</div>
		<div class="mt-1 text-[11px] text-muted-foreground">
			P90 {ttftP90 === null ? '—' : formatDuration(ttftP90)}
		</div>
	</div>
	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
			Tool calls (run total)
		</div>
		<div class="mt-1 text-xl font-semibold tabular-nums">
			{toolCallsTotal.toLocaleString()}
		</div>
		<div class="mt-1 text-[11px] text-muted-foreground">
			{distinctTools} distinct tool{distinctTools === 1 ? '' : 's'}
		</div>
	</div>
	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
			Avg tools / turn
		</div>
		<div class="mt-1 text-xl font-semibold tabular-nums">
			{turnCountP50 && turnCountP50 > 0
				? (toolCallsTotal / turnCountP50).toFixed(1)
				: '—'}
		</div>
		<div class="mt-1 text-[11px] text-muted-foreground">
			using P50 turns
		</div>
	</div>
</div>
