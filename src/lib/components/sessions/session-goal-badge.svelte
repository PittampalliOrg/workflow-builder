<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Target, Pause, Play, CheckCheck, Loader2, Plus } from '@lucide/svelte';

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
	let dialogOpen = $state(false);
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);

	// Dialog form state
	let objective = $state('');
	let tokenBudget = $state('');
	let maxIterations = $state('20');

	async function load() {
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`);
			if (!res.ok) return;
			goal = ((await res.json()) as { goal: Goal | null }).goal ?? null;
		} catch {
			/* transient fetch failure — keep the last known goal */
		}
	}

	$effect(() => {
		void sessionId;
		load();
		const timer = setInterval(load, 4000);
		return () => clearInterval(timer);
	});

	function openDialog(prefill?: Goal | null) {
		objective = prefill?.objective ?? '';
		tokenBudget = prefill?.tokenBudget ? String(prefill.tokenBudget) : '';
		maxIterations = String(prefill?.maxIterations ?? 20);
		errorMsg = null;
		dialogOpen = true;
	}

	async function submitGoal() {
		if (!objective.trim()) {
			errorMsg = 'Objective is required';
			return;
		}
		busy = true;
		errorMsg = null;
		try {
			const body: Record<string, unknown> = { objective: objective.trim() };
			const budget = Number.parseInt(tokenBudget, 10);
			if (Number.isFinite(budget) && budget > 0) body.tokenBudget = budget;
			const iters = Number.parseInt(maxIterations, 10);
			if (Number.isFinite(iters) && iters > 0) body.maxIterations = iters;
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				errorMsg = `Failed (${res.status}): ${await res.text().catch(() => '')}`.slice(0, 200);
				return;
			}
			goal = ((await res.json()) as { goal: Goal }).goal;
			dialogOpen = false;
		} finally {
			busy = false;
		}
	}

	async function patchStatus(status: 'paused' | 'complete') {
		busy = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status })
			});
			if (res.ok) goal = ((await res.json()) as { goal: Goal }).goal;
		} finally {
			busy = false;
		}
	}

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

<div class="space-y-2 rounded-lg border p-3" data-testid="session-goal-badge">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<Target class="size-3.5" />
			Goal
		</div>
		{#if goal && statusInfo}
			<Badge variant="outline" class={'text-[10px] ' + statusInfo.cls}>
				{statusInfo.text}
			</Badge>
		{/if}
	</div>

	{#if goal && statusInfo}
		<p class="line-clamp-3 text-sm" title={goal.objective}>{goal.objective}</p>
		<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
			<span
				>Tokens: {goal.tokensUsed.toLocaleString()} / {goal.tokenBudget === null
					? '∞'
					: goal.tokenBudget.toLocaleString()}</span
			>
			<span>Iterations: {goal.iterations} / {goal.maxIterations}</span>
			<span>Time: {goal.timeUsedSeconds}s</span>
		</div>
		<div class="flex flex-wrap gap-1.5 pt-1">
			{#if goal.status === 'active'}
				<Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={() => patchStatus('paused')}>
					<Pause class="size-3" /> Pause
				</Button>
				<Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={() => patchStatus('complete')}>
					<CheckCheck class="size-3" /> Mark complete
				</Button>
			{:else if goal.status === 'paused' || goal.status === 'budget_limited'}
				<Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={() => openDialog(goal)}>
					<Play class="size-3" /> Resume / adjust
				</Button>
				<Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={() => patchStatus('complete')}>
					<CheckCheck class="size-3" /> Mark complete
				</Button>
			{:else}
				<Button size="sm" variant="outline" class="h-7 text-xs" disabled={busy} onclick={() => openDialog(null)}>
					<Plus class="size-3" /> New goal
				</Button>
			{/if}
		</div>
	{:else}
		<p class="text-[11px] text-muted-foreground">
			Set an objective and the agent works toward it autonomously across turns until a completion
			audit passes, a budget exhausts, or you pause it.
		</p>
		<Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => openDialog(null)}>
			<Target class="size-3" /> Set goal
		</Button>
	{/if}
</div>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{goal && goal.status !== 'complete' ? 'Replace goal' : 'Set a goal'}</Dialog.Title>
			<Dialog.Description>
				The agent self-drives toward this objective: after each turn the system re-injects it until
				the agent verifies completion (via its update_goal tool), the token budget runs out, or the
				iteration cap is reached. Setting a new objective replaces the current goal and resets
				accounting.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3 py-2">
			<div class="space-y-1.5">
				<Label for="goal-objective" class="text-xs">Objective</Label>
				<Textarea
					id="goal-objective"
					bind:value={objective}
					rows={5}
					placeholder="State concrete deliverables or success criteria. For multi-step work, ask for ONE deliverable per turn — e.g. “Build X: 1) … 2) … 3) … Complete one numbered deliverable per turn, verify with real output, then call update_goal complete.”"
				/>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label for="goal-budget" class="text-xs">Token budget (optional)</Label>
					<Input
						id="goal-budget"
						bind:value={tokenBudget}
						type="number"
						min="1000"
						placeholder="e.g. 120000"
					/>
					<p class="text-[10px] text-muted-foreground">
						Counts new work (input + output), not cache reads. Exhaustion triggers one wrap-up turn.
					</p>
				</div>
				<div class="space-y-1.5">
					<Label for="goal-maxiter" class="text-xs">Max iterations</Label>
					<Input id="goal-maxiter" bind:value={maxIterations} type="number" min="1" max="100" />
					<p class="text-[10px] text-muted-foreground">Hard cap on autonomous continuation turns.</p>
				</div>
			</div>
			{#if errorMsg}
				<p class="text-xs text-destructive">{errorMsg}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (dialogOpen = false)} disabled={busy}>Cancel</Button>
			<Button onclick={submitGoal} disabled={busy}>
				{#if busy}<Loader2 class="size-3.5 animate-spin" />{/if}
				Start goal loop
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
