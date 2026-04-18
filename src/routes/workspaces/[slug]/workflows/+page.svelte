<script lang="ts">
	import type { PageData } from "./$types";
	import { Workflow } from "@lucide/svelte";

	let { data }: { data: PageData } = $props();

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

<div class="p-6 space-y-6">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<Workflow class="size-6" /> Workflows
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Visual workflows scoped to this workspace. Click a workflow to open
				the editor, or a run to view its detail.
			</p>
		</div>
		<a
			href="/workflows"
			class="text-sm text-primary hover:underline"
			data-testid="link-all-workflows"
		>
			All workflows →
		</a>
	</header>

	{#if data.workflows.length === 0}
		<div
			class="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground"
		>
			No workflows in this workspace yet. Create one from the
			<a href="/workflows" class="text-primary hover:underline">Workflows</a>
			editor.
		</div>
	{:else}
		<div class="rounded-lg border bg-card overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/50 text-xs font-medium text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">Name</th>
						<th class="text-left px-4 py-2">Last updated</th>
						<th class="text-left px-4 py-2">Latest run</th>
						<th class="text-left px-4 py-2">Status</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.workflows as wf}
						<tr class="border-t hover:bg-muted/40">
							<td class="px-4 py-3">
								<a
									href="/workflows/{wf.id}"
									class="font-medium text-primary hover:underline"
								>
									{wf.name || wf.id}
								</a>
								<div class="text-xs text-muted-foreground mt-0.5 font-mono">
									{wf.id}
								</div>
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">
								{formatRelative(wf.updatedAt)}
							</td>
							<td class="px-4 py-3">
								{#if wf.latestExecution}
									<a
										href="/workflows/{wf.id}/runs/{wf.latestExecution.id}"
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
									href="/workflows/{wf.id}"
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
