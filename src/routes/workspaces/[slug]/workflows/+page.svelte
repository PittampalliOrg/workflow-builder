<script lang="ts">
	import type { PageData } from "./$types";
	import { page } from "$app/state";
	import { Workflow, Search, GitFork } from "@lucide/svelte";

	let { data }: { data: PageData } = $props();
	const slug = $derived(page.params.slug as string);

	let query = $state("");
	let runningOnly = $state(false);

	const runningCount = $derived(data.workflows.filter((w) => w.running).length);
	const filtered = $derived(
		data.workflows.filter((w) => {
			if (runningOnly && !w.running) return false;
			const q = query.trim().toLowerCase();
			if (!q) return true;
			return (
				(w.name ?? "").toLowerCase().includes(q) || w.id.toLowerCase().includes(q)
			);
		}),
	);

	function statusColor(status: string): string {
		switch (status) {
			case "success":
				return "text-green-600 bg-green-50 border-green-200";
			case "error":
			case "cancelled":
				return "text-red-600 bg-red-50 border-red-200";
			case "running":
			case "pending":
				return "text-blue-600 bg-blue-50 border-blue-200";
			default:
				return "text-gray-600 bg-gray-50 border-gray-200";
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return "just now";
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}
</script>

<svelte:head>
	<title>Workflows</title>
</svelte:head>

<div class="h-full overflow-y-auto p-6 space-y-6">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<Workflow class="size-6" /> Workflows
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				{data.workflows.length} workflow{data.workflows.length === 1 ? "" : "s"} in this workspace.
				{#if runningCount > 0}
					<button
						type="button"
						class="ml-1 inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300"
						onclick={() => (runningOnly = !runningOnly)}
						title="Show running only"
					>
						<span class="size-1.5 rounded-full bg-blue-500 animate-pulse"></span>
						{runningCount} running
					</button>
				{/if}
				Sorted by recent activity.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					type="text"
					bind:value={query}
					placeholder="Search workflows…"
					class="h-8 w-56 rounded-md border bg-background pl-7 pr-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
				/>
			</div>
			<button
				type="button"
				class="h-8 rounded-md border px-2.5 text-xs font-medium transition-colors {runningOnly
					? 'border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
					: 'text-muted-foreground hover:bg-muted'}"
				onclick={() => (runningOnly = !runningOnly)}
			>
				Running only
			</button>
		</div>
	</header>

	{#if data.workflows.length === 0}
		<div
			class="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground"
		>
			No workflows in this workspace yet. Create one from the workflow editor.
		</div>
	{:else}
		<div class="rounded-lg border bg-card overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/50 text-xs font-medium text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">Name</th>
						<th class="text-left px-4 py-2">Last active</th>
						<th class="text-left px-4 py-2">Recent activity</th>
						<th class="text-left px-4 py-2">Latest run</th>
						<th class="text-left px-4 py-2">Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#if filtered.length === 0}
						<tr><td colspan="6" class="px-4 py-8 text-center text-xs text-muted-foreground">
							No workflows match{runningOnly ? ' (running only)' : ''}{query ? ` “${query}”` : ''}.
						</td></tr>
					{/if}
					{#each filtered as wf}
						<tr class="border-t hover:bg-muted/40">
							<td class="px-4 py-3">
								<a
									href="/workspaces/{slug}/workflows/{wf.id}"
									class="font-medium text-primary hover:underline inline-flex items-center gap-1.5"
								>
									{#if wf.running}
										<span class="size-1.5 rounded-full bg-blue-500 animate-pulse" title="Running"></span>
									{/if}
									{wf.name || wf.id}
								</a>
								<div class="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
									<span class="font-mono">{wf.id}</span>
									{#if wf.forkCount > 0}
										<span
											class="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
											title="{wf.forkCount} fork/resume run{wf.forkCount === 1 ? '' : 's'}"
										>
											<GitFork class="size-2.5" />{wf.forkCount}
										</span>
									{/if}
								</div>
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground" title={wf.lastActivityAt}>
								{formatRelative(wf.lastActivityAt)}
							</td>
							<td class="px-4 py-3">
								{#if wf.recentRuns.length > 0}
									<div class="flex items-center gap-1.5">
										{#each wf.recentRuns as r (r.id)}
											{@const dot =
												r.status === 'success'
													? 'bg-emerald-500'
													: r.status === 'error'
														? 'bg-red-500'
														: r.status === 'running' || r.status === 'pending'
															? 'bg-blue-500 animate-pulse'
															: 'bg-gray-400'}
											<a
												href="/workspaces/{slug}/workflows/{wf.id}/runs/{r.id}"
												class="size-2.5 rounded-full {dot} hover:ring-2 hover:ring-primary/40 transition-shadow"
												title={`${r.status} · ${formatRelative(r.startedAt)}`}
												aria-label={`${r.status} ${formatRelative(r.startedAt)}`}
											></a>
										{/each}
									</div>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-4 py-3">
								{#if wf.latestExecution}
									<a
										href="/workspaces/{slug}/workflows/{wf.id}/runs/{wf.latestExecution.id}"
										class="text-xs text-primary hover:underline font-mono"
									>
										{wf.latestExecution.id.slice(0, 12)}…
									</a>
									<div class="text-[10px] text-muted-foreground mt-0.5">
										{formatRelative(wf.latestExecution.startedAt)}
									</div>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-4 py-3">
								{#if wf.latestExecution}
									<span
										class="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full border {statusColor(
											wf.latestExecution.status,
										)}"
									>
										{wf.latestExecution.status}
									</span>
								{:else}
									<span class="text-xs text-muted-foreground">never run</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-right text-xs">
								<a
									href="/workspaces/{slug}/workflows/{wf.id}"
									class="text-muted-foreground hover:text-primary hover:underline"
								>
									Edit →
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
