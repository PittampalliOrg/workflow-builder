<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Target } from '@lucide/svelte';

	interface Props {
		sessionId: string;
	}

	let { sessionId }: Props = $props();

	type Goal = {
		objective: string;
		status: 'active' | 'paused' | 'budget_limited' | 'complete';
		tokensUsed: number;
		tokenBudget: number | null;
		timeUsedSeconds: number;
		iterations: number;
		maxIterations: number;
	};

	let goal = $state<Goal | null>(null);

	async function load() {
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`);
			if (!res.ok) return;
			const data = (await res.json()) as { goal: Goal | null };
			goal = data.goal ?? null;
		} catch {
			/* transient fetch failure — keep the last known goal */
		}
	}

	// Fetch on mount + poll for live token/iteration/status updates. The goal
	// loop is driven server-side; polling keeps the badge current without
	// coupling to the page's SSE plumbing. Stops when the component unmounts.
	$effect(() => {
		void sessionId;
		load();
		const timer = setInterval(load, 4000);
		return () => clearInterval(timer);
	});

	const statusInfo = $derived.by(() => {
		switch (goal?.status) {
			case 'active':
				return {
					text: 'Active',
					cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30'
				};
			case 'paused':
				return {
					text: 'Paused',
					cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
				};
			case 'budget_limited':
				return {
					text: 'Budget limited',
					cls: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30'
				};
			case 'complete':
				return {
					text: 'Complete',
					cls: 'bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30'
				};
			default:
				return null;
		}
	});
</script>

{#if goal && statusInfo}
	<div class="space-y-2 rounded-lg border p-3" data-testid="session-goal-badge">
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<Target class="size-3.5" />
				Goal
			</div>
			<Badge variant="outline" class={'text-[10px] ' + statusInfo.cls}>
				{statusInfo.text}
			</Badge>
		</div>
		<p class="line-clamp-3 text-sm" title={goal.objective}>{goal.objective}</p>
		<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
			<span
				>Tokens: {goal.tokensUsed.toLocaleString()} / {goal.tokenBudget === null
					? '∞'
					: goal.tokenBudget.toLocaleString()}</span
			>
			<span>Iterations: {goal.iterations} / {goal.maxIterations}</span>
			<span>Time: {goal.timeUsedSeconds}s</span>
		</div>
	</div>
{/if}
