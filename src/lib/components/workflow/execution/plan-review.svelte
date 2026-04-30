<script lang="ts">
	import { Check, X, FileText, Clock, Loader2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';

	interface PlanArtifact {
		id: string;
		status: string;
		goal: string;
		planMarkdown: string | null;
		planJson: unknown;
		nodeId: string;
		createdAt: string;
		updatedAt: string;
	}

	interface Props {
		executionId: string;
		workflowId: string;
		executionStatus: string;
		/** Plan text extracted from the agent_plan step output */
		planText: string | null;
		/** Existing plan artifacts from the database */
		artifacts: PlanArtifact[];
		onArtifactsChange?: () => void;
	}

	let {
		executionId,
		workflowId,
		executionStatus,
		planText,
		artifacts = [],
		onArtifactsChange
	}: Props = $props();

	let isSubmitting = $state(false);
	let actionError = $state<string | null>(null);

	let latestArtifact = $derived(artifacts[0] ?? null);
	let hasArtifact = $derived(artifacts.length > 0);
	let displayPlan = $derived(latestArtifact?.planMarkdown || planText || null);

	function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'approved':
				return 'default';
			case 'draft':
				return 'secondary';
			case 'executed':
				return 'default';
			case 'failed':
			case 'superseded':
				return 'destructive';
			default:
				return 'outline';
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'draft':
				return 'Pending Review';
			case 'approved':
				return 'Approved';
			case 'executed':
				return 'Executed';
			case 'superseded':
				return 'Superseded';
			case 'failed':
				return 'Failed';
			default:
				return status;
		}
	}

	async function savePlanArtifact(): Promise<void> {
		if (!planText) return;
		isSubmitting = true;
		actionError = null;
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/plan-artifacts`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						goal: 'Implementation plan from planning agent',
						planMarkdown: planText,
						planJson: { raw: planText },
						nodeId: 'agent_plan',
						workflowId
					})
				}
			);
			if (!res.ok) throw new Error(`Failed to save: ${res.statusText}`);
			onArtifactsChange?.();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to save plan';
		} finally {
			isSubmitting = false;
		}
	}

	async function updateStatus(newStatus: string): Promise<void> {
		if (!latestArtifact) return;
		isSubmitting = true;
		actionError = null;
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/plan-artifacts`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						artifactId: latestArtifact.id,
						status: newStatus
					})
				}
			);
			if (!res.ok) throw new Error(`Failed to update: ${res.statusText}`);
			onArtifactsChange?.();
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to update status';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<div class="space-y-4">
	{#if !displayPlan}
		<div class="flex flex-col items-center justify-center py-16 text-center">
			<FileText size={32} class="mb-3 text-muted-foreground/50" />
			<p class="text-sm text-muted-foreground">No plan generated for this execution</p>
			{#if executionStatus === 'running'}
				<p class="mt-1 text-xs text-muted-foreground/70">
					The planning agent is still running...
				</p>
			{/if}
		</div>
	{:else}
		<!-- Status bar -->
		{#if hasArtifact && latestArtifact}
			<div
				class="flex items-center justify-between rounded-lg border px-4 py-2.5
					{latestArtifact.status === 'approved'
					? 'border-green-500/30 bg-green-500/5'
					: latestArtifact.status === 'draft'
						? 'border-yellow-500/30 bg-yellow-500/5'
						: 'border-border bg-muted/30'}"
			>
				<div class="flex items-center gap-2">
					{#if latestArtifact.status === 'approved'}
						<Check size={14} class="text-green-500" />
					{:else if latestArtifact.status === 'draft'}
						<Clock size={14} class="text-yellow-500" />
					{:else}
						<FileText size={14} class="text-muted-foreground" />
					{/if}
					<Badge variant={statusVariant(latestArtifact.status)}>
						{statusLabel(latestArtifact.status)}
					</Badge>
					<span class="text-xs text-muted-foreground">
						{new Date(latestArtifact.updatedAt).toLocaleString()}
					</span>
				</div>

				{#if latestArtifact.status === 'draft'}
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={isSubmitting}
							onclick={() => updateStatus('superseded')}
						>
							<X size={12} class="mr-1" /> Reject
						</Button>
						<Button
							size="sm"
							disabled={isSubmitting}
							onclick={() => updateStatus('approved')}
						>
							{#if isSubmitting}
								<Loader2 size={12} class="mr-1 animate-spin" />
							{:else}
								<Check size={12} class="mr-1" />
							{/if}
							Approve Plan
						</Button>
					</div>
				{/if}
			</div>
		{:else if planText}
			<!-- Plan exists but not saved as artifact yet -->
			<div
				class="flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-2.5"
			>
				<div class="flex items-center gap-2">
					<FileText size={14} class="text-blue-400" />
					<span class="text-xs text-muted-foreground">
						Plan generated — save to enable review
					</span>
				</div>
				<Button size="sm" disabled={isSubmitting} onclick={savePlanArtifact}>
					{#if isSubmitting}
						<Loader2 size={12} class="mr-1 animate-spin" />
					{:else}
						<FileText size={12} class="mr-1" />
					{/if}
					Save Plan
				</Button>
			</div>
		{/if}

		{#if actionError}
			<div class="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
				{actionError}
			</div>
		{/if}

		<!-- Plan content -->
		<div class="rounded-lg border bg-card">
			<div class="border-b px-4 py-2">
				<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Implementation Plan
				</h3>
			</div>
			<div class="max-h-[65vh] overflow-auto p-4">
				<pre
					class="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-foreground/90"
				>{displayPlan}</pre>
			</div>
		</div>
	{/if}
</div>
