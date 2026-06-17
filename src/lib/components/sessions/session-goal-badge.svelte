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
		/**
		 * Whether the runtime ALSO has a vendor-native `/goal` harness available
		 * (claude/codex). The evaluator/custom loop is the DEFAULT for every
		 * runtime; this only adds a hint that the user can opt into native `/goal`
		 * by prefixing the objective with `/goal `.
		 */
		nativeAvailable?: boolean;
	}

	let { sessionId, nativeAvailable = false }: Props = $props();

	type Goal = {
		objective: string;
		status: 'active' | 'paused' | 'budget_limited' | 'complete';
		tokensUsed: number;
		tokenBudget: number | null;
		timeUsedSeconds: number;
		iterations: number;
		maxIterations: number;
		acceptanceCriteria?: string[] | null;
		evidencePlan?: { commands?: string[] } | null;
	};

	let goal = $state<Goal | null>(null);
	let dialogOpen = $state(false);
	let busy = $state(false);
	let errorMsg = $state<string | null>(null);
	// Short-lived note when an objective prefixed with `/goal` was handed to the
	// vendor CLI's native harness instead of the evaluator loop.
	let nativeSentObjective = $state<string | null>(null);

	// Dialog form state
	let objective = $state('');
	let tokenBudget = $state('');
	let maxIterations = $state('20');
	let acceptanceCriteria = $state(''); // one criterion per line
	let evidenceCommands = $state(''); // one shell command per line

	function splitLines(value: string): string[] {
		return value
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

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
		acceptanceCriteria = (prefill?.acceptanceCriteria ?? []).join('\n');
		evidenceCommands = (prefill?.evidencePlan?.commands ?? []).join('\n');
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
			const criteria = splitLines(acceptanceCriteria);
			if (criteria.length) body.acceptanceCriteria = criteria;
			const commands = splitLines(evidenceCommands);
			if (commands.length) body.evidence = { commands };
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				errorMsg = `Failed (${res.status}): ${await res.text().catch(() => '')}`.slice(0, 200);
				return;
			}
			const data = (await res.json()) as { goal?: Goal; native?: boolean; objective?: string };
			if (data.native) {
				// Objective was prefixed `/goal` → handed to the vendor CLI's native loop.
				nativeSentObjective = data.objective ?? objective.trim();
				goal = null;
			} else {
				goal = data.goal ?? null;
				nativeSentObjective = null;
			}
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
			if (!res.ok) return;
			const data = (await res.json()) as { goal?: Goal; native?: boolean };
			if (data.native) nativeSentObjective = null;
			else if (data.goal) goal = data.goal;
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
			{#if goal.evidencePlan?.commands?.length}
				<span class="text-emerald-700 dark:text-emerald-300"
					>Evidence-verified ({goal.evidencePlan.commands.length})</span
				>
			{/if}
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
			Set an objective and the agent works toward it autonomously across turns. Declare evidence
			commands and completion is <strong>verified</strong> by running them in the workspace before the
			goal is marked done.{#if nativeAvailable}
				To use this CLI's native <code class="text-[10px]">/goal</code> instead, start the objective with
				<code class="text-[10px]">/goal</code>.{/if}
		</p>
		{#if nativeSentObjective}
			<p class="line-clamp-2 rounded bg-muted/50 px-2 py-1 text-[11px]" title={nativeSentObjective}>
				<span class="text-muted-foreground">Handed to native /goal:</span>
				<code class="text-[10px]">{nativeSentObjective}</code>
			</p>
		{/if}
		<Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => openDialog(null)}>
			<Target class="size-3" /> Set goal
		</Button>
	{/if}
</div>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{goal && goal.status !== 'complete' ? 'Replace goal' : 'Set a goal'}
			</Dialog.Title>
			<Dialog.Description>
				The agent self-drives toward this objective across turns. If you declare evidence commands,
				an independent evaluator runs them in the workspace and the goal completes only when they all
				pass (else the failing checks are fed back and it keeps working) — otherwise completion is
				self-judged via the agent's update_goal tool. Setting a new objective replaces the current
				goal and resets accounting.{#if nativeAvailable}
					Tip: start the objective with <code class="text-[10px]">/goal</code> to use this CLI's native
					goal harness instead.{/if}
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3 py-2">
			<div class="space-y-1.5">
				<Label for="goal-objective" class="text-xs">Objective</Label>
				<Textarea
					id="goal-objective"
					bind:value={objective}
					rows={4}
					placeholder="State concrete deliverables or success criteria. For multi-step work, ask for ONE deliverable per turn — e.g. “Build X: 1) … 2) … 3) … Complete one numbered deliverable per turn, verify with real output, then call update_goal complete.”"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="goal-acceptance" class="text-xs">Acceptance criteria (optional, one per line)</Label>
				<Textarea
					id="goal-acceptance"
					bind:value={acceptanceCriteria}
					rows={2}
					placeholder={'Human-readable success criteria, e.g.\nintToRoman(n) is correct for 1..3999\nromanToInt is the exact inverse'}
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="goal-evidence" class="text-xs">Evidence commands (optional, one per line)</Label>
				<Textarea
					id="goal-evidence"
					bind:value={evidenceCommands}
					rows={2}
					placeholder={'Deterministic checks run in the workspace; ALL must exit 0 to complete, e.g.\ncd /sandbox && npm test\ncd /sandbox && npm run lint'}
				/>
				<p class="text-[10px] text-muted-foreground">
					When set, completion is verified by running these in the agent's workspace (ground-truth) —
					not self-judged.
				</p>
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
